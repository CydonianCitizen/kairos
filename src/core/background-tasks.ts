import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { launchShell, validateShell, type BashResult, type ShellInvocationBuilder, type ShellProcess } from './shell-runner.js';

export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
export interface TaskInfo {
  id: string; command: string; status: TaskStatus; startedAt: string; endedAt?: string; pid?: number;
  exitCode: number | null; timedOut: boolean; truncated: boolean; error?: string;
}
export interface TaskLog extends TaskInfo { stdout: string; stderr: string }
interface OwnedTask { info: TaskInfo; process: ShellProcess; result?: BashResult; finished: Promise<void> }

export class BackgroundTasks extends EventEmitter<{ change: [TaskInfo[]] }> {
  private readonly tasks = new Map<string, OwnedTask>();
  private readonly starts = new Set<Promise<TaskInfo>>();
  private readonly startupControllers = new Set<AbortController>();
  private readonly completed: string[] = [];
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly workspace: string, private readonly bashPath?: string, private readonly invocation?: ShellInvocationBuilder,
    private readonly beforeStart?: () => void) { super(); }

  get running(): boolean { return this.starts.size > 0 || [...this.tasks.values()].some(task => task.info.status === 'running'); }

  async start(command: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<TaskInfo> {
    this.beforeStart?.();
    validateShell(command, options.timeoutMs ?? 30000);
    options.signal?.throwIfAborted();
    if (this.closed) throw new Error('Background task manager is closed');
    if (this.starts.size + [...this.tasks.values()].filter(task => task.info.status === 'running').length >= 8) throw new Error('Background task limit reached (8 running tasks)');
    const controller = new AbortController();
    this.startupControllers.add(controller);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const pending = this.startNow(command, { ...options, signal });
    this.starts.add(pending);
    try { return await pending; }
    finally { this.starts.delete(pending); this.startupControllers.delete(controller); }
  }

  private async startNow(command: string, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<TaskInfo> {
    const process = await launchShell(this.workspace, this.bashPath, command, { ...options, invocation: this.invocation, beforeSpawn: this.beforeStart });
    if (options.signal?.aborted || this.closed) {
      await process.stop();
      options.signal?.throwIfAborted();
      throw new Error('Background task manager is closed');
    }
    // A turn cancellation governs startup only, once the task has been handed to its supervisor.
    process.releaseSignal();
    const info: TaskInfo = { id: randomUUID(), command, status: 'running', startedAt: new Date().toISOString(), pid: process.pid, exitCode: null, timedOut: false, truncated: false };
    const task: OwnedTask = { info, process, finished: Promise.resolve() };
    this.tasks.set(info.id, task);
    task.finished = process.result.then(result => {
      task.result = result;
      Object.assign(info, { exitCode: result.exitCode, timedOut: result.timedOut, truncated: result.truncated, ...(result.error ? { error: result.error } : {}),
        endedAt: new Date().toISOString(), status: result.timedOut ? 'timed_out' : result.aborted ? 'cancelled' : result.error || result.exitCode !== 0 ? 'failed' : 'completed' });
      this.completed.push(info.id);
      while (this.completed.length > 50) this.tasks.delete(this.completed.shift()!);
      this.emit('change', this.list());
    });
    this.emit('change', this.list());
    return { ...info };
  }

  private snapshot(task: OwnedTask): TaskInfo {
    const result = task.result ?? task.process.output();
    return { ...task.info, truncated: result.truncated, timedOut: result.timedOut };
  }

  list(): TaskInfo[] { return [...this.tasks.values()].map(task => this.snapshot(task)); }

  private requested(ids: string[]): OwnedTask[] {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw new Error('Expected between 1 and 100 task IDs');
    return ids.map(id => {
      if (typeof id !== 'string' || !this.tasks.has(id)) throw new Error(`Unknown background task: ${String(id)}`);
      return this.tasks.get(id)!;
    });
  }

  logs(ids: string[]): TaskLog[] {
    return this.requested(ids).map(task => {
      const result = task.result ?? task.process.output();
      return { ...this.snapshot(task), stdout: result.stdout, stderr: result.stderr };
    });
  }

  async stop(ids: string[]): Promise<TaskInfo[]> {
    const tasks = this.requested(ids);
    await Promise.all(tasks.map(async task => { await task.process.stop(); await task.finished; }));
    return tasks.map(task => ({ ...task.info }));
  }

  close(): Promise<void> {
    this.closed = true;
    for (const controller of this.startupControllers) controller.abort(new Error('Background task manager is closed'));
    return this.closing ??= (async () => {
      await Promise.allSettled([...this.starts]);
      await Promise.all([...this.tasks.values()].map(async task => { await task.process.stop(); await task.finished; }));
    })();
  }
}

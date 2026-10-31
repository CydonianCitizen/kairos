import { randomUUID } from 'node:crypto';
import { readFile, writeFile, realpath, stat, access, rename, link, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, dirname, join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createTwoFilesPatch } from 'diff';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

export interface Edit { path: string; old_text: string; new_text: string }
export type FileResult = { path: string; ok: true; content?: string; diff?: string } | { path: string; ok: false; error: string };
export interface BashResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean; error?: string; aborted?: boolean }
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const FS_TOOL_SCHEMAS: ChatCompletionTool[] = [
  { type: 'function', function: { name: 'read_files_batch', description: 'Read multiple UTF-8 files relative to the workspace.', parameters: {
    type: 'object', properties: { paths: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } } }, required: ['paths'], additionalProperties: false,
  } } },
  { type: 'function', function: { name: 'apply_edits_batch', description: 'Apply exact unique replacements in order. Empty old_text creates a new file only. Each edit returns its own result; no batch rollback.', parameters: {
    type: 'object', properties: { edits: { type: 'array', minItems: 1, maxItems: 100, items: {
      type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'], additionalProperties: false,
    } } }, required: ['edits'], additionalProperties: false,
  } } },
  { type: 'function', function: { name: 'run_bash', description: 'Execute a Bash command in the workspace. This is arbitrary shell execution, not a sandbox.', parameters: {
    type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 } }, required: ['command'], additionalProperties: false,
  } } },
];

export class FsTools {
  private editQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly workspace: string, private readonly bashPath?: string) {}

  private async path(name: string, creating = false): Promise<string> {
    if (typeof name !== 'string' || !name.trim() || isAbsolute(name)) throw new Error('Expected a non-empty relative workspace path');
    const root = await realpath(this.workspace);
    const candidate = resolve(root, name);
    const inside = (target: string) => { const rel = relative(root, target); return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel); };
    if (!inside(candidate)) throw new Error('Path is outside the workspace');
    // Resolve symlinks too. For creation, the parent must already exist.
    const canonical = await realpath(creating ? dirname(candidate) : candidate);
    if (!inside(canonical)) throw new Error('Symlink points outside the workspace');
    return creating ? join(canonical, basename(candidate)) : canonical;
  }

  private async write(file: string, content: string, creating: boolean, signal?: AbortSignal): Promise<void> {
    const mode = creating ? undefined : (await stat(file)).mode;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode });
      signal?.throwIfAborted();
      // Linking a new file is atomic and fails if another writer created the target.
      if (creating) await link(temporary, file);
      else await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  }

  private validateBatch(items: unknown): asserts items is unknown[] {
    if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw new Error('Batch must contain 1–100 entries');
  }

  async read_files_batch(paths: string[]): Promise<FileResult[]> {
    this.validateBatch(paths);
    return Promise.all(paths.map(async path => {
      try {
        const file = await this.path(path);
        const info = await stat(file);
        if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Expected a regular file no larger than 1 MiB');
        return { path, ok: true as const, content: await readFile(file, 'utf8') };
      } catch (error) { return { path, ok: false as const, error: errorText(error) }; }
    }));
  }

  apply_edits_batch(edits: Edit[], signal?: AbortSignal): Promise<FileResult[]> {
    this.validateBatch(edits);
    const work = this.editQueue.then(async () => {
      const results: FileResult[] = [];
      for (const edit of edits) {
        try {
          signal?.throwIfAborted();
          if (!edit || typeof edit.old_text !== 'string' || typeof edit.new_text !== 'string') throw new Error('Invalid edit');
          const file = await this.path(edit.path, edit.old_text === '');
          signal?.throwIfAborted();
          let before = '';
          let after = edit.new_text;
          if (edit.old_text === '') {
            await this.write(file, edit.new_text, true, signal);
          } else {
            const original = await readFile(file, 'utf8');
            before = original;
            const index = original.indexOf(edit.old_text);
            if (index < 0 || original.indexOf(edit.old_text, index + 1) >= 0) throw new Error('old_text must match exactly once');
            signal?.throwIfAborted();
            after = original.slice(0, index) + edit.new_text + original.slice(index + edit.old_text.length);
            await this.write(file, after, false, signal);
          }
          results.push({ path: edit.path, ok: true, diff: createTwoFilesPatch(edit.old_text === '' ? '/dev/null' : `a/${edit.path}`, `b/${edit.path}`, before, after) });
        } catch (error) { results.push({ path: edit?.path, ok: false, error: errorText(error) }); }
      }
      return results;
    });
    this.editQueue = work.catch(() => undefined);
    return work;
  }

  private async shell(): Promise<string> {
    if (this.bashPath || process.env.BASH_PATH) return this.bashPath ?? process.env.BASH_PATH!;
    if (process.platform === 'win32') {
      for (const base of [process.env.ProgramFiles, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) {
        if (!base) continue;
        const bash = join(base, 'Git', 'bin', 'bash.exe');
        try { await access(bash); return bash; } catch { /* Try the next installation. */ }
      }
      throw new Error('Install Git Bash or set BASH_PATH to bash.exe');
    }
    return 'bash';
  }

  async run_bash(command: string, timeoutMs = 30000, signal?: AbortSignal): Promise<BashResult> {
    if (typeof command !== 'string' || !command.trim()) throw new Error('command must be non-empty');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('timeoutMs must be between 1 and 300000');
    try {
      signal?.throwIfAborted();
      const shell = await this.shell();
      const cwd = await realpath(this.workspace);
      signal?.throwIfAborted();
      return await new Promise<BashResult>(resolveResult => {
        const result: BashResult = { stdout: '', stderr: '', exitCode: null, timedOut: false, truncated: false };
        const child = spawn(shell, ['--noprofile', '--norc', '-c', command], { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        for (const key of ['stdout', 'stderr'] as const) {
          child[key].setEncoding('utf8');
          child[key].on('data', (data: string) => {
            const room = 15000 - result[key].length;
            if (data.length > room) result.truncated = true;
            result[key] += data.slice(0, room);
          });
        }
        const terminate = () => {
          if (!child.pid) return;
          if (process.platform === 'win32') {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => child.kill('SIGKILL'));
          } else {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          }
        };
        const cancel = () => { result.aborted = true; terminate(); };
        const timer = setTimeout(() => { result.timedOut = true; terminate(); }, timeoutMs);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
        child.on('error', error => { cleanup(); result.error = errorText(error); resolveResult(result); });
        child.on('close', code => { cleanup(); result.exitCode = code; resolveResult(result); });
      });
    } catch (error) { return { stdout: '', stderr: '', exitCode: null, timedOut: false, truncated: false, error: errorText(error), aborted: signal?.aborted }; }
  }
}

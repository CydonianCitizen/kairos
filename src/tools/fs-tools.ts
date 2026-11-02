import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, realpath, stat, lstat, chmod, rename, link, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, dirname, join, basename } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { UndoStore, type UndoBefore, type UndoEntry, type UndoPlanEntry } from '../core/undo-store.js';
import { BackgroundTasks } from '../core/background-tasks.js';
import { launchShell, validateShell, ShellStartupError, type BashResult, type ShellInvocationBuilder } from '../core/shell-runner.js';
import { disposeWindowsShellJobs } from '../core/windows-shell-job.js';
import { SearchTools, type FindFilesOptions, type FindFilesResult, type SearchTextOptions, type SearchTextResult } from './search-tools.js';

export type WorkspaceScope = 'none' | 'read-only' | 'workspace' | 'full';
export interface Edit { path: string; old_text: string; new_text: string }
export type FileResult = { path: string; ok: true; content?: string; diff?: string; warning?: string } | { path: string; ok: false; error: string; mutated?: boolean };
export interface PreparedEdits { preview: FileResult[]; paths?: string[]; apply(signal?: AbortSignal): Promise<FileResult[]> }
export interface FsToolsOptions { undoDirectory?: string; shellInvocation?: ShellInvocationBuilder; scope?: WorkspaceScope }
interface Snapshot { file: string; data: Buffer | null; mode: number; identity: string }
interface PlannedFile { original: Snapshot; current: Buffer | null; aliases: Set<string>; stages: { hash: string; mode: number }[] }
interface PlannedEdit { edit: Edit; file: PlannedFile; after: Buffer; creating: boolean }
interface UndoPlan { id: string; entries: UndoEntry[]; recovering: boolean; snapshots: Snapshot[]; preview: FileResult[] }
export type { BashResult } from '../core/shell-runner.js';
export { SearchTools, type FindFilesOptions, type FindFilesResult, type SearchTextOptions, type SearchTextResult, type TextMatch } from './search-tools.js';
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

export const FS_TOOL_SCHEMAS: ChatCompletionTool[] = [
  { type: 'function', function: { name: 'read_files_batch', description: 'Read multiple UTF-8 files relative to the workspace.', parameters: {
    type: 'object', properties: { paths: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } } }, required: ['paths'], additionalProperties: false,
  } } },
  { type: 'function', function: { name: 'apply_edits_batch', description: 'Apply exact unique replacements in order. Empty old_text creates a new file only. Each edit returns its own result; no batch rollback.', parameters: {
    type: 'object', properties: { edits: { type: 'array', minItems: 1, maxItems: 100, items: {
      type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'], additionalProperties: false,
    } } }, required: ['edits'], additionalProperties: false,
  } } },
  { type: 'function', function: { name: 'run_bash', description: 'Execute Bash in the workspace under host permissions and optional isolation. background:true returns a supervised task ID.', parameters: {
    type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 }, background: { type: 'boolean', description: 'Return a supervised task ID immediately; inspect or stop it through background_tasks_batch.' } }, required: ['command'], additionalProperties: false,
  } } },
  { type: 'function', function: { name: 'find_files', description: 'Find file paths in the workspace matching a glob pattern (e.g. "**/*.json", "src/**/*.tsx"), respecting .gitignore.', parameters: {
    type: 'object', properties: {
      pattern: { type: 'string', description: 'Glob pattern to search for (e.g. "**/*.ts", "*config*"). Defaults to "**/*".' },
      patterns: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: 'Multiple glob patterns to search in batch.' },
      directory: { type: 'string', description: 'Subdirectory to restrict search within (optional, defaults to workspace root).' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum number of file paths to return (default: 100).' },
    }, additionalProperties: false,
  } } },
  { type: 'function', function: { name: 'search_text', description: 'Search for text or regular expression across workspace files, respecting .gitignore. Returns matching file paths, 1-based line numbers, and matching text.', parameters: {
    type: 'object', properties: {
      query: { type: 'string', description: 'Search query string or regex pattern.' },
      isRegex: { type: 'boolean', description: 'Whether query is a regular expression (default: false).' },
      caseSensitive: { type: 'boolean', description: 'Whether search is case-sensitive (default: false).' },
      filePattern: { type: 'string', description: 'Glob pattern to restrict search to specific files (e.g. "*.ts", "src/**").' },
      directory: { type: 'string', description: 'Subdirectory to restrict search within (optional, defaults to workspace root).' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum number of matches to return (default: 100).' },
    }, required: ['query'], additionalProperties: false,
  } } },
];

export class FsTools {
  readonly background: BackgroundTasks;
  private readonly search: SearchTools;
  private editQueue: Promise<unknown> = Promise.resolve();
  private readonly undo?: UndoStore;
  private undoOwner?: string;
  private scope: WorkspaceScope = 'workspace';
  constructor(private readonly workspace: string, private readonly bashPath?: string, private readonly options: FsToolsOptions = {}) {
    this.scope = options.scope ?? 'workspace';
    this.search = new SearchTools(workspace);
    if (options.undoDirectory) this.undo = new UndoStore(workspace, options.undoDirectory);
    this.background = new BackgroundTasks(workspace, bashPath, options.shellInvocation, () => this.assertWritable('Shell execution'));
  }

  getScope(): WorkspaceScope { return this.scope; }
  assertWritable(operation = 'Filesystem modification'): void {
    if (this.scope === 'none' || this.scope === 'read-only') throw new Error(`${operation} is disabled (scope: ${this.scope})`);
  }
  setScope(scope: WorkspaceScope): void {
    if (!['none', 'read-only', 'workspace', 'full'].includes(scope)) throw new Error(`Invalid workspace scope: ${scope}`);
    this.scope = scope;
  }

  setUndoOwner(owner: string | undefined): void {
    if (owner !== undefined && (typeof owner !== 'string' || !owner.trim() || owner.length > 256 || /[\u0000-\u001f]/.test(owner))) throw new Error('Invalid undo owner');
    this.undoOwner = owner;
  }

  private async path(name: string, creating = false): Promise<string> {
    if (this.scope === 'none') throw new Error('Filesystem access is disabled (scope: none)');
    if (typeof name !== 'string' || !name.trim()) throw new Error('Expected a non-empty path');
    if (this.scope === 'full') {
      const root = await realpath(this.workspace);
      const candidate = isAbsolute(name) ? resolve(name) : resolve(root, name);
      try {
        const canonical = await realpath(creating ? dirname(candidate) : candidate);
        return creating ? join(canonical, basename(candidate)) : canonical;
      } catch {
        return candidate;
      }
    }
    if (isAbsolute(name)) throw new Error('Expected a non-empty relative workspace path');
    const root = await realpath(this.workspace);
    const candidate = resolve(root, name);
    const inside = (target: string) => { const rel = relative(root, target); return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel); };
    if (!inside(candidate)) throw new Error('Path is outside the workspace');
    // Resolve symlinks too. For creation, the parent must already exist.
    const canonical = await realpath(creating ? dirname(candidate) : candidate);
    if (!inside(canonical)) throw new Error('Symlink points outside the workspace');
    return creating ? join(canonical, basename(candidate)) : canonical;
  }

  private async write(file: string, content: string | Buffer, creating: boolean, signal?: AbortSignal, restoredMode?: number, beforeCommit?: () => Promise<void>, onPublication?: () => void): Promise<void> {
    this.assertWritable();
    const mode = restoredMode ?? (creating ? undefined : (await stat(file)).mode);
    const temporary = `${file}.${randomUUID()}.tmp`;
    let committed = false;
    try {
      await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode });
      if (mode !== undefined) await chmod(temporary, mode & 0o7777);
      await beforeCommit?.();
      signal?.throwIfAborted();
      this.assertWritable();
      // Linking a new file is atomic and fails if another writer created the target.
      onPublication?.();
      if (creating) await link(temporary, file);
      else await rename(temporary, file);
      committed = true;
    } finally {
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !committed) { onPublication?.(); throw error; }
      });
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
    return this.queue(async () => (await this.prepare(edits, signal)).applyNow(signal));
  }

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.editQueue.then(operation);
    this.editQueue = work.catch(() => undefined);
    return work;
  }

  private async snapshot(file: string): Promise<Snapshot> {
    let info;
    try { info = await lstat(file); }
    catch (error) { if (absent(error)) return { file, data: null, mode: 0, identity: 'absent' }; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a regular file, not a symlink');
    const data = await readFile(file);
    const after = await lstat(file);
    const identity = (value: typeof info) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}:${value.mode}`;
    if (identity(info) !== identity(after)) throw new Error('File changed while reading its snapshot');
    return { file, data, mode: info.mode & 0o7777, identity: identity(info) };
  }

  private same(a: Snapshot, b: Snapshot, identity = true): boolean {
    return a.file === b.file && a.mode === b.mode && (!identity || a.identity === b.identity) &&
      (a.data === null ? b.data === null : b.data !== null && hash(a.data) === hash(b.data));
  }

  private before(snapshot: Snapshot): UndoBefore | null {
    return snapshot.data === null ? null : { data: snapshot.data.toString('base64'), mode: snapshot.mode };
  }

  async prepare_edits_batch(edits: Edit[], signal?: AbortSignal): Promise<PreparedEdits> {
    const prepared = await this.prepare(edits, signal);
    return { preview: prepared.preview, paths: prepared.paths, apply: applySignal => this.queue(() => prepared.applyNow(applySignal ?? signal)) };
  }

  private async prepare(edits: Edit[], signal?: AbortSignal): Promise<PreparedEdits & { applyNow(signal?: AbortSignal): Promise<FileResult[]> }> {
    this.assertWritable();
    this.validateBatch(edits);
    const files = new Map<string, PlannedFile>();
    const operations: (PlannedEdit | undefined)[] = [];
    const preview: FileResult[] = [];
    for (const supplied of edits) {
      const edit = supplied && { ...supplied };
      try {
        signal?.throwIfAborted();
        if (!edit || typeof edit.old_text !== 'string' || typeof edit.new_text !== 'string') throw new Error('Invalid edit');
        const candidate = await this.path(edit.path, true);
        const canonical = await realpath(candidate).catch(error => { if (absent(error)) return candidate; throw error; });
        // Keep the ordinary containment check for existing final-component symlinks too.
        if (canonical !== candidate) await this.path(edit.path);
        let file = files.get(canonical);
        if (!file) {
          const original = await this.snapshot(canonical);
          file = { original, current: original.data, aliases: new Set(), stages: [] }; files.set(canonical, file);
        }
        file.aliases.add(edit.path);
        const before = file.current?.toString('utf8') ?? '';
        let after = edit.new_text;
        if (edit.old_text === '') {
          if (file.current !== null) throw new Error('File already exists; empty old_text creates a new file only');
        } else {
          if (file.current === null) throw new Error('File does not exist');
          const index = before.indexOf(edit.old_text);
          if (index < 0 || before.indexOf(edit.old_text, index + 1) >= 0) throw new Error('old_text must match exactly once');
          after = before.slice(0, index) + edit.new_text + before.slice(index + edit.old_text.length);
        }
        const data = Buffer.from(after);
        signal?.throwIfAborted();
        operations.push({ edit, file, after: data, creating: edit.old_text === '' });
        file.current = data;
        file.stages.push({ hash: hash(data), mode: file.original.data === null ? -1 : file.original.mode });
        preview.push({ path: edit.path, ok: true, diff: createTwoFilesPatch(edit.old_text === '' ? '/dev/null' : `a/${edit.path}`, `b/${edit.path}`, before, after) });
      } catch (error) { operations.push(undefined); preview.push({ path: edit?.path, ok: false, error: errorText(error) }); }
    }
    let used = false;
    const applyNow = async (applySignal?: AbortSignal): Promise<FileResult[]> => {
      const failed = (error: unknown) => preview.map(result => ({ path: result.path, ok: false as const, error: errorText(error) }));
      if (used) return failed(new Error('This edit preview has already been applied or invalidated'));
      used = true;
      const touched = [...files.values()].filter(file => file.stages.length);
      try {
        this.assertWritable();
        applySignal?.throwIfAborted();
        for (const file of touched) {
          for (const alias of file.aliases) {
            const candidate = await this.path(alias, true);
            const current = await realpath(candidate).catch(error => { if (absent(error)) return candidate; throw error; });
            if (current !== file.original.file) throw new Error('Edit preview is stale: target path changed');
          }
          if (!this.same(file.original, await this.snapshot(file.original.file))) throw new Error('Edit preview is stale: file content or identity changed');
        }
      } catch (error) { return failed(error); }
      const root = await realpath(this.workspace);
      const plans: UndoPlanEntry[] = touched.map(file => ({ path: relative(root, file.original.file), before: this.before(file.original), stages: file.stages }));
      let transaction;
      try { transaction = touched.length ? await this.undo?.begin(plans, this.undoOwner === undefined ? {} : { owner: this.undoOwner }) : undefined; }
      catch (error) { return failed(new Error(`Cannot create undo journal before editing: ${errorText(error)}`)); }
      const succeeded = new Map<PlannedFile, Snapshot>();
      const applied = new Map<PlannedFile, { data: Buffer; mode: number }>();
      const blocked = new Set<PlannedFile>();
      const results: FileResult[] = [];
      for (let index = 0; index < operations.length; index++) {
        const operation = operations[index];
        if (!operation) { results.push(preview[index]!); continue; }
        let mutationPossible = false;
        try {
          applySignal?.throwIfAborted();
          if (blocked.has(operation.file)) throw new Error('A preceding edit to this file failed; prepare a new preview');
          const expected = succeeded.get(operation.file) ?? operation.file.original;
          if (await this.path(relative(root, expected.file), true) !== expected.file) throw new Error('Edit target path changed after preview');
          if (!this.same(expected, await this.snapshot(expected.file))) throw new Error('Edit target changed after preview');
          await this.write(expected.file, operation.after, operation.creating, applySignal, undefined, async () => {
            if (await this.path(relative(root, expected.file), true) !== expected.file || !this.same(expected, await this.snapshot(expected.file))) throw new Error('Edit target changed while staging the approved replacement');
          }, () => { mutationPossible = true; });
          // Record the actual successful transition before any fallible post-write inspection.
          applied.set(operation.file, { data: operation.after, mode: expected.data === null ? -1 : expected.mode });
          const current = await this.snapshot(expected.file);
          if (!current.data || hash(current.data) !== hash(operation.after)) throw new Error('Edit target changed after writing; undo will refuse to overwrite it');
          applied.set(operation.file, { data: operation.after, mode: current.mode });
          succeeded.set(operation.file, current);
          results.push(preview[index]!);
        } catch (error) {
          blocked.add(operation.file);
          results.push({ path: operation.edit.path, ok: false, error: errorText(error), ...(mutationPossible ? { mutated: true } : {}) });
        }
      }
      const committed: UndoEntry[] = [...applied].map(([file, result]) => ({
        path: relative(root, file.original.file), before: this.before(file.original), afterHash: hash(result.data), afterMode: result.mode,
      }));
      try { await transaction?.commit(committed); }
      catch (error) {
        return results.map(result => result.ok ? { ...result, warning: `Edits applied; durable write-ahead undo recovery retained: ${errorText(error)}` } : result);
      }
      return results;
    };
    const root = await realpath(this.workspace);
    return { preview, paths: [...files.values()].filter(file => file.stages.length).map(file => relative(root, file.original.file)), apply: applyNow, applyNow };
  }

  private async undoSnapshot(name: string): Promise<Snapshot> {
    const root = await realpath(this.workspace);
    const file = await this.path(name, true);
    let cursor = root;
    for (const part of relative(root, resolve(root, name)).split(/[\\/]/)) {
      cursor = join(cursor, part);
      try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Undo refuses symlink paths'); }
      catch (error) { if (!absent(error)) throw error; }
    }
    return this.snapshot(file);
  }

  private matchesBefore(snapshot: Snapshot, before: UndoBefore | null): boolean {
    return before === null ? snapshot.data === null : snapshot.data !== null && hash(snapshot.data) === hash(Buffer.from(before.data, 'base64')) && snapshot.mode === before.mode;
  }

  private async latestUndo(): Promise<Pick<UndoPlan, 'id' | 'entries' | 'recovering'> | undefined> {
    const batches = await this.undo?.records() ?? [];
    const interrupted = batches.find(batch => batch.undoing);
    if (interrupted) return { id: interrupted.id, entries: interrupted.undoing!, recovering: true };
    for (const batch of batches) {
      if (batch.committed) { if (batch.committed.length) return { id: batch.id, entries: batch.committed, recovering: false }; continue; }
      const entries: UndoEntry[] = [];
      for (const entry of batch.entries) {
        const current = await this.undoSnapshot(entry.path);
        const beforeHash = entry.before === null ? null : hash(Buffer.from(entry.before.data, 'base64'));
        if (current.data === null && beforeHash === null || current.data !== null && hash(current.data) === beforeHash && current.mode === entry.before?.mode) continue;
        if (current.data === null || !entry.stages.some(stage => stage.hash === hash(current.data!) && (stage.mode === -1 || stage.mode === current.mode))) throw new Error(`Pending undo journal cannot recover changed file: ${entry.path}`);
        entries.push({ path: entry.path, before: entry.before, afterHash: hash(current.data), afterMode: current.mode });
      }
      if (entries.length) return { id: batch.id, entries, recovering: false };
    }
    return undefined;
  }

  private async undoPlan(): Promise<UndoPlan | undefined> {
    const batch = await this.latestUndo();
    if (!batch) return undefined;
    return this.planUndo(batch);
  }

  private async planUndo(batch: Pick<UndoPlan, 'id' | 'entries' | 'recovering'>): Promise<UndoPlan> {
    const snapshots: Snapshot[] = [];
    for (const entry of batch.entries) {
      const current = await this.undoSnapshot(entry.path);
      const after = current.data !== null && hash(current.data) === entry.afterHash && (entry.afterMode === -1 || current.mode === entry.afterMode);
      if (!after && !(batch.recovering && this.matchesBefore(current, entry.before))) throw new Error(`Undo refused: file changed since the agent edit: ${entry.path}`);
      snapshots.push(current);
    }
    return { ...batch, entries: batch.entries.map((entry, index) => ({ ...entry, afterMode: entry.afterMode === -1 ? snapshots[index]!.mode : entry.afterMode })),
      snapshots, preview: batch.entries.map((entry, index) => ({ path: entry.path, ok: true,
      diff: createTwoFilesPatch(`a/${entry.path}`, entry.before === null ? '/dev/null' : `b/${entry.path}`,
        snapshots[index]!.data?.toString('utf8') ?? '', entry.before === null ? '' : Buffer.from(entry.before.data, 'base64').toString('utf8')) })) };
  }

  async previewUndo(): Promise<FileResult[]> {
    return (await this.prepare_undo()).preview;
  }

  async prepare_undo(signal?: AbortSignal): Promise<PreparedEdits> {
    const prepared = await this.prepareUndoNow(signal);
    return { preview: prepared.preview, paths: prepared.preview.filter(result => result.ok).map(result => result.path), apply: applySignal => this.queue(() => prepared.applyNow(applySignal ?? signal)) };
  }

  async prepare_rewind(owners: string[], signal?: AbortSignal): Promise<PreparedEdits> {
    let plan: UndoPlan | undefined; let signature = ''; let sources: string[] = []; let recovering = false;
    let owner: string | undefined;
    let approvedOwners: string[] = [];
    const sourceOutcomes: Record<string, UndoEntry[]> = {};
    const failure = (error: unknown, paths: string[] = ['']): FileResult[] => paths.map(path => ({ path, ok: false, error: errorText(error) }));
    try {
      this.assertWritable();
      signal?.throwIfAborted();
      if (!Array.isArray(owners) || owners.some(owner => typeof owner !== 'string' || !owner.trim())) throw new Error('Invalid rewind owners');
      owner = owners[0];
      approvedOwners = [...new Set(owners)];
      const batches = await this.undo?.records() ?? []; signature = JSON.stringify(batches);
      const selectedOwners = new Set(owners);
      // A retained aggregate owns its sources until its final marker is durable.
      const covered = new Set(batches.flatMap(batch => batch.sources ?? []));
      const active = batches.filter(batch => !covered.has(batch.id));
      const selected = active.filter(batch => batch.owner !== undefined && selectedOwners.has(batch.owner));
      const interrupted = active.find(batch => batch.undoing);
      if (interrupted) {
        if (selected.length !== 1 || selected[0]!.id !== interrupted.id) throw new Error('Complete the interrupted undo before rewinding another range');
        plan = await this.planUndo({ id: interrupted.id, entries: interrupted.undoing!, recovering: true }); recovering = true;
      } else {
        const aggregate = new Map<string, UndoEntry>(); const earliest = new Map<string, string>();
        for (const batch of selected) {
          signal?.throwIfAborted();
          let entries = batch.committed;
          if (!entries) {
            entries = [];
            for (const entry of batch.entries) {
              const newer = aggregate.get(entry.path);
              const outcome = newer ? newer.before : this.before(await this.undoSnapshot(entry.path));
              if (outcome === null && entry.before === null || outcome !== null && entry.before !== null && outcome.data === entry.before.data && outcome.mode === entry.before.mode) continue;
              if (outcome === null || !entry.stages.some(stage => stage.hash === hash(Buffer.from(outcome.data, 'base64')) && (stage.mode === -1 || stage.mode === outcome.mode))) throw new Error(`Pending rewind journal cannot prove the file state: ${entry.path}`);
              entries.push({ path: entry.path, before: entry.before, afterHash: hash(Buffer.from(outcome.data, 'base64')), afterMode: outcome.mode });
            }
            sourceOutcomes[batch.id] = entries;
          }
          for (const entry of entries) {
            const newer = aggregate.get(entry.path);
            if (newer) {
              if (newer.before === null || hash(Buffer.from(newer.before.data, 'base64')) !== entry.afterHash || entry.afterMode !== -1 && newer.before.mode !== entry.afterMode) throw new Error(`Rewind refused: edit chain changed between turns: ${entry.path}`);
              newer.before = entry.before;
            } else aggregate.set(entry.path, { ...entry });
            earliest.set(entry.path, batch.id);
          }
        }
        if (aggregate.size > 100) throw new Error('Rewind range exceeds 100 distinct files');
        for (const batch of active.filter(batch => !selected.includes(batch))) {
          for (const entry of batch.committed ?? batch.entries) {
            const first = earliest.get(entry.path);
            if (first && batch.id > first) throw new Error(`Rewind refused: another edit owner changed the file: ${entry.path}`);
          }
        }
        if (aggregate.size) {
          plan = await this.planUndo({ id: '', entries: [...aggregate.values()], recovering: false });
          const root = await realpath(this.workspace);
          if (new Set(plan.snapshots.map(snapshot => process.platform === 'win32' ? snapshot.file.toLowerCase() : snapshot.file)).size !== plan.entries.length) throw new Error('Rewind journal contains aliased target paths');
          plan.entries = plan.entries.map((entry, index) => ({ ...entry, path: relative(root, plan!.snapshots[index]!.file) }));
          sources = selected.map(batch => batch.id);
        }
      }
    } catch (error) { return { preview: failure(error), paths: [], apply: async () => failure(error) }; }
    const bound = plan; let used = false;
    const paths = bound?.entries.map(entry => entry.path) ?? [];
    // The approval surface is detached from the private restore plan.
    const preview = Object.freeze((bound?.preview ?? []).map(result => Object.freeze({ ...result }))) as unknown as FileResult[];
    return { preview, paths: [...paths], apply: applySignal => this.queue(async () => {
      if (used) return failure(new Error('This rewind preview has already been applied or invalidated'), paths);
      used = true; if (!bound) return [];
      const currentSignal = applySignal ?? signal;
      try {
        this.assertWritable();
        currentSignal?.throwIfAborted();
        if (JSON.stringify(await this.undo!.records()) !== signature) throw new Error('Rewind preview is stale: the edit journal changed');
        for (let index = 0; index < bound.entries.length; index++) {
          if (!this.same(bound.snapshots[index]!, await this.undoSnapshot(bound.entries[index]!.path))) throw new Error(`Rewind preview is stale: target changed: ${bound.entries[index]!.path}`);
        }
        if (recovering) return this.restore(bound, currentSignal);
        const transaction = await this.undo!.begin(bound.entries.map(entry => ({ path: entry.path, before: entry.before, stages: [{ hash: entry.afterHash, mode: entry.afterMode }] })), { owner, owners: approvedOwners, sources, ...(Object.keys(sourceOutcomes).length ? { sourceOutcomes } : {}) });
        await transaction.commit(bound.entries);
        return this.restore({ ...bound, id: transaction.id }, currentSignal);
      } catch (error) { return failure(error, paths); }
    }) };
  }

  private async prepareUndoNow(signal?: AbortSignal): Promise<{ preview: FileResult[]; applyNow(signal?: AbortSignal): Promise<FileResult[]> }> {
    let plan: UndoPlan | undefined;
    try { this.assertWritable(); signal?.throwIfAborted(); plan = await this.undoPlan(); }
    catch (error) {
      const preview: FileResult[] = [{ path: '', ok: false, error: errorText(error) }];
      return { preview, applyNow: async () => preview };
    }
    let used = false;
    return { preview: plan?.preview ?? [], applyNow: async applySignal => {
      if (!plan) return [];
      if (used) return plan.entries.map(entry => ({ path: entry.path, ok: false, error: 'This undo preview has already been applied or invalidated' }));
      used = true;
      return this.restore(plan, applySignal);
    } };
  }

  private async restore(plan: UndoPlan, signal?: AbortSignal): Promise<FileResult[]> {
    const restored: number[] = [];
    let mutationPossible = false;
    try {
      this.assertWritable();
      signal?.throwIfAborted();
      if ((await this.latestUndo())?.id !== plan.id) throw new Error('Undo preview is stale: the latest journaled batch changed');
      // Validate every target before changing any of them, including a preview approved earlier.
      const preflight = async () => {
        for (let index = 0; index < plan.entries.length; index++) {
          signal?.throwIfAborted();
          if (!this.same(plan.snapshots[index]!, await this.undoSnapshot(plan.entries[index]!.path))) throw new Error(`Undo preview is stale: target changed: ${plan.entries[index]!.path}`);
        }
      };
      await preflight();
      // The synced immutable intent survives a crash during restore or during its rollback.
      await this.undo!.markUndoing(plan.id, plan.entries);
      await preflight();
      for (let index = 0; index < plan.entries.length; index++) {
        signal?.throwIfAborted();
        const entry = plan.entries[index]!; const current = plan.snapshots[index]!;
        if (!this.same(current, await this.undoSnapshot(entry.path))) throw new Error(`Undo target changed during restore: ${entry.path}`);
        if (this.matchesBefore(current, entry.before)) continue;
        if (entry.before === null) { this.assertWritable(); mutationPossible = true; await unlink(current.file); }
        else await this.write(current.file, Buffer.from(entry.before.data, 'base64'), false, signal, entry.before.mode, async () => {
          if (!this.same(current, await this.undoSnapshot(entry.path))) throw new Error(`Undo target changed while staging restore: ${entry.path}`);
        }, () => { mutationPossible = true; });
        restored.push(index);
      }
      await this.undo!.markUndone(plan.id);
      return plan.preview;
    } catch (error) {
      const failures: string[] = [];
      for (const index of restored.reverse()) {
        const snapshot = plan.snapshots[index]!; const entry = plan.entries[index]!;
        try {
          const current = await this.undoSnapshot(entry.path);
          if (!this.matchesBefore(current, entry.before)) throw new Error(`File changed during undo rollback: ${entry.path}`);
          await this.write(current.file, snapshot.data!, entry.before === null, undefined, snapshot.mode, async () => {
            if (!this.same(current, await this.undoSnapshot(entry.path))) throw new Error(`File changed while staging undo rollback: ${entry.path}`);
          }, () => { mutationPossible = true; });
        } catch (rollback) { failures.push(errorText(rollback)); }
      }
      return plan.entries.map(entry => ({ path: entry.path, ok: false,
        error: `${errorText(error)}${failures.length ? `; rollback failed: ${failures.join('; ')}` : '; pre-undo file states preserved'}`,
        ...(mutationPossible ? { mutated: true } : {}) }));
    }
  }

  undoLast(signal?: AbortSignal): Promise<FileResult[]> {
    return this.queue(async () => (await this.prepareUndoNow(signal)).applyNow(signal));
  }

  async run_bash(command: string, timeoutMs = 30000, signal?: AbortSignal): Promise<BashResult> {
    if (this.scope === 'none' || this.scope === 'read-only') {
      return { stdout: '', stderr: '', exitCode: 1, timedOut: false, truncated: false, error: `Shell execution is disabled (scope: ${this.scope})` };
    }
    validateShell(command, timeoutMs);
    try {
      return await (await launchShell(this.workspace, this.bashPath, command, { timeoutMs, signal, invocation: this.options.shellInvocation, beforeSpawn: () => this.assertWritable('Shell execution') })).result;
    } catch (error) {
      if (error instanceof ShellStartupError) return { ...error.result, error: error.result.error ?? error.message };
      return { stdout: '', stderr: '', exitCode: null, timedOut: false, truncated: false, error: errorText(error), aborted: signal?.aborted };
    }
  }

  async find_files(options?: FindFilesOptions): Promise<FindFilesResult> {
    if (this.scope === 'none') throw new Error('Filesystem access is disabled (scope: none)');
    return this.search.find_files(options);
  }

  async search_text(options: SearchTextOptions): Promise<SearchTextResult> {
    if (this.scope === 'none') throw new Error('Filesystem access is disabled (scope: none)');
    return this.search.search_text(options);
  }

  async close(): Promise<void> { await this.background.close(); if (process.platform === 'win32') await disposeWindowsShellJobs(); }
}

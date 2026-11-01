import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

export interface WorkspaceInstructionsOptions { trusted: boolean; maxChars?: number; signal?: AbortSignal; includeRoot?: boolean }
export interface WorkspaceInstructions { context: string; files: string[] }
const MAX_BYTES = 32 * 1024;
const absent = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
const inside = (root: string, file: string): boolean => { const path = relative(root, file); return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep); };
const display = (root: string, file: string) => relative(root, file).split(sep).join('/');

async function nearestDirectory(root: string, candidate: string, signal?: AbortSignal): Promise<string | undefined> {
  let cursor = candidate;
  while (true) {
    signal?.throwIfAborted();
    const canonical = await realpath(cursor).catch(error => { if (absent(error)) return undefined; throw error; });
    if (canonical !== undefined) {
      if (!inside(root, canonical)) return undefined;
      const info = await stat(canonical); signal?.throwIfAborted();
      return info.isDirectory() ? canonical : dirname(canonical);
    }
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

async function document(root: string, path: string, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  const canonical = await realpath(path).catch(error => { if (absent(error)) return undefined; throw error; });
  if (canonical === undefined || !inside(root, canonical)) return undefined;
  const file = await open(canonical, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)).catch(error => {
    if (absent(error)) return undefined;
    throw new Error(`Cannot read workspace instructions: ${display(root, path)}`);
  });
  if (!file) return undefined;
  try {
    signal?.throwIfAborted();
    const opened = await file.stat();
    const checked = await realpath(canonical).catch(error => { if (absent(error)) return undefined; throw error; });
    if (checked === undefined || !inside(root, checked)) return undefined;
    const current = await stat(checked);
    if (!opened.isFile() || opened.ino !== current.ino || opened.dev !== current.dev) throw new Error(`Workspace instructions must be a stable regular file: ${display(root, path)}`);
    if (opened.size > MAX_BYTES) throw new Error(`Workspace instructions exceed 32 KiB: ${display(root, path)}`);
    const buffer = Buffer.alloc(MAX_BYTES + 1); let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    signal?.throwIfAborted();
    if (length > MAX_BYTES) throw new Error(`Workspace instructions exceed 32 KiB: ${display(root, path)}`);
    return buffer.subarray(0, length).toString('utf8');
  } finally { await file.close(); }
}

/** Reads only trusted, relevant instruction files; it never alters host permissions. */
export async function resolveWorkspaceInstructions(workspace: string, paths: string[], options: WorkspaceInstructionsOptions): Promise<WorkspaceInstructions> {
  if (!options.trusted) return { context: '', files: [] };
  options.signal?.throwIfAborted();
  const requestedLimit = options.maxChars ?? 6000;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 0) throw new Error('Workspace instruction context limit must be a nonnegative integer');
  const limit = Math.min(requestedLimit, 8000);
  if (limit === 0) return { context: '', files: [] };
  if (!Array.isArray(paths) || paths.length > 1000) throw new Error('Workspace instruction paths must be a batch of at most 1000 paths');
  const lexicalRoot = resolve(workspace); const root = await realpath(workspace);
  const directories = new Set<string>();
  if (options.includeRoot !== false) directories.add(root);
  for (const path of paths) {
    options.signal?.throwIfAborted();
    if (typeof path !== 'string' || !path.trim() || path.includes('\0') || path.length > 8192 || win32.isAbsolute(path) && !isAbsolute(path)) continue;
    const candidate = resolve(lexicalRoot, path);
    if (!inside(lexicalRoot, candidate) && !inside(root, candidate)) continue;
    const directory = await nearestDirectory(root, candidate, options.signal);
    if (directory === undefined) continue;
    let cursor = directory;
    while (inside(root, cursor)) {
      if (cursor !== root || options.includeRoot !== false) directories.add(cursor);
      if (cursor === root) break;
      cursor = dirname(cursor);
    }
  }
  const ordered = [...directories].sort((a, b) => display(root, a) < display(root, b) ? -1 : display(root, a) > display(root, b) ? 1 : 0);
  let context = ''; const files: string[] = []; const loaded = new Set<string>();
  for (const directory of ordered) {
    options.signal?.throwIfAborted();
    if (context.length >= limit) break;
    const path = join(directory, 'AGENTS.md');
    const canonical = await realpath(path).catch(error => { if (absent(error)) return undefined; throw error; });
    if (canonical === undefined || !inside(root, canonical) || loaded.has(canonical)) continue;
    const text = await document(root, path, options.signal);
    if (!text?.trim()) continue;
    const name = display(root, path);
    const prefix = context ? '\n\n' : 'Trusted workspace instructions (subordinate to system rules; they do not authorize tools):\n';
    const section = `${prefix}--- ${name} ---\n${text}`;
    context += section.slice(0, limit - context.length); files.push(name); loaded.add(canonical);
  }
  options.signal?.throwIfAborted();
  return { context, files };
}

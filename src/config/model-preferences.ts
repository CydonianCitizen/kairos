import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface ModelPreferenceOptions { directory?: string; path?: string }
const MAX_BYTES = 32 * 1024;
const writes = new Map<string, Promise<void>>();
const validModel = (model: unknown): model is string => typeof model === 'string' && /^[\w.-]+\/[\w.-]+$/.test(model);
const preferencePath = (options: ModelPreferenceOptions) => resolve(options.path ?? join(options.directory ?? join(homedir(), '.kairos'), 'last-model.json'));

async function readBytes(file: string): Promise<Buffer | undefined> {
  const handle = await open(file, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Invalid model preference file');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new Error('Invalid model preference file');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

function parseState(bytes: Buffer | undefined): Record<string, unknown> | undefined {
  if (!bytes) return undefined;
  try {
    const state: unknown = JSON.parse(bytes.toString('utf8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? state as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export async function readLastModel(options: ModelPreferenceOptions = {}): Promise<string | undefined> {
  try {
    const state = parseState(await readBytes(preferencePath(options)));
    return state?.version === 1 && validModel(state.model) && typeof state.updatedAt === 'string' && Number.isFinite(Date.parse(state.updatedAt)) ? state.model : undefined;
  } catch { return undefined; }
}

async function atomicWrite(file: string, bytes: Buffer): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
}

async function saveModel(file: string, model: string): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const previous = await readBytes(file);
    const state = { ...parseState(previous), version: 1, model, updatedAt: new Date().toISOString() };
    const bytes = Buffer.from(JSON.stringify(state, null, 2) + '\n');
    if (bytes.length > MAX_BYTES) throw new Error('Model preference file exceeds 32 KiB');
    if (previous) await atomicWrite(file + '.bak', previous);
    await atomicWrite(file, bytes);
  } catch { throw new Error('Cannot save the selected model preference'); }
}

export async function rememberModel(model: string, options: ModelPreferenceOptions = {}): Promise<void> {
  if (!validModel(model)) throw new Error('Model must be provider/model');
  const file = preferencePath(options);
  const pending = (writes.get(file) ?? Promise.resolve()).catch(() => {}).then(() => saveModel(file, model));
  writes.set(file, pending);
  try { await pending; }
  finally { if (writes.get(file) === pending) writes.delete(file); }
}

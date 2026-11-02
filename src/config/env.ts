import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { config, parse } from 'dotenv';

const MAX_ENV_BYTES = 1024 * 1024;

export function personalEnvPath(): string {
  return join(homedir(), '.kairos', '.env');
}

export function loadEnvironment(workspace: string): void {
  config({
    path: [join(workspace, '.env'), join(homedir(), '.kairos', '.env')],
    override: false,
    quiet: true,
    debug: false,
  });
}

async function checkFile(file: string): Promise<boolean> {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return false;
  if (!info.isFile() || info.size > MAX_ENV_BYTES) throw new Error('Unsafe personal environment file');
  return true;
}

async function readPersonalEnv(file: string): Promise<Buffer | undefined> {
  if (!await checkFile(file)) return undefined;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_ENV_BYTES) throw new Error('Unsafe personal environment file');
    const bytes = Buffer.alloc(MAX_ENV_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_ENV_BYTES) throw new Error('Oversized personal environment file');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

function replaceApiKey(previous: Buffer | undefined, key: string): Buffer {
  const text = previous?.toString('utf8') ?? '';
  if (previous && !Buffer.from(text).equals(previous)) throw new Error('Invalid personal environment encoding');
  let found = false;
  // Match every assignment so key-like lines inside other quoted values stay intact.
  const assignments = /^([ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*(?:=[ \t]*|:[ \t]+))((?:"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|`(?:\\`|[^`])*`)|[^#\r\n]*)/gm;
  let updated = text.replace(assignments, (assignment: string, prefix: string, name: string, value: string) => {
    if (name !== 'NVIDIA_API_KEY') return assignment;
    found = true;
    return prefix + key + (value.match(/[ \t]+$/)?.[0] ?? '');
  });
  if (!found) {
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    updated += (text && !text.endsWith('\n') ? newline : '') + `NVIDIA_API_KEY=${key}${newline}`;
  }
  const before = parse(text); const after = parse(updated);
  if (after.NVIDIA_API_KEY !== key || Object.entries(before).some(([name, value]) => name !== 'NVIDIA_API_KEY' && after[name] !== value)) {
    throw new Error('Cannot safely update personal environment');
  }
  const bytes = Buffer.from(updated);
  if (bytes.length > MAX_ENV_BYTES) throw new Error('Oversized personal environment file');
  return bytes;
}

async function stageFile(file: string, bytes: Buffer): Promise<string> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    return temporary;
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function savePersonalApiKey(value: string, options: { directory?: string } = {}): Promise<void> {
  const key = value.trim();
  if (!/^[A-Za-z0-9._/-]{1,4096}$/.test(key)) throw new Error('Invalid NVIDIA API key');
  const directory = options.directory ?? join(homedir(), '.kairos');
  const file = join(directory, '.env'); const backup = file + '.bak';
  let stagedEnv: string | undefined; let stagedBackup: string | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const previous = await readPersonalEnv(file);
    await checkFile(backup);
    const updated = replaceApiKey(previous, key);
    stagedEnv = await stageFile(file, updated);
    if (previous) stagedBackup = await stageFile(backup, previous);
    await checkFile(file); await checkFile(backup);
    if (stagedBackup) { await rename(stagedBackup, backup); stagedBackup = undefined; }
    await rename(stagedEnv, file); stagedEnv = undefined;
  } catch { throw new Error('Cannot save the NVIDIA API key in the personal configuration'); }
  finally {
    for (const temporary of [stagedEnv, stagedBackup]) if (temporary) await unlink(temporary).catch(() => {});
  }
}

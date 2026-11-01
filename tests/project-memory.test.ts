import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { ProjectMemory } from '../src/core/project-memory.js';

let root: string;
let workspace: string;
let directory: string;
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children: ChildProcess[] = [];
let modules: string;
let modulePath: string;
beforeAll(async () => {
  const cache = join(repository, 'node_modules/.cache/kairos-tests');
  await mkdir(cache, { recursive: true });
  modules = await mkdtemp(join(cache, 'project-memory-modules-'));
  await writeFile(join(modules, 'package.json'), '{"type":"module"}');
  await promisify(execFile)(process.execPath, [join(repository, 'node_modules/typescript/bin/tsc'), '--ignoreConfig',
    '--target', 'ES2022', '--module', 'NodeNext', '--skipLibCheck', '--strict', '--types', 'node',
    '--rootDir', join(repository, 'src'), '--outDir', modules, join(repository, 'src/core/project-memory.ts')], { cwd: repository });
  modulePath = join(modules, 'core/project-memory.js');
}, 20000);
afterAll(async () => {
  const cache = join(repository, 'node_modules/.cache/kairos-tests');
  if (!resolve(modules).startsWith(cache + sep + 'project-memory-modules-')) throw new Error('Unexpected module directory');
  await rm(modules, { recursive: true, force: true });
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kairos-memory-'));
  workspace = join(root, 'workspace'); directory = join(root, 'memory');
  await mkdir(workspace);
});
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve()); child.kill();
  })));
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'kairos-memory-')) throw new Error('Unexpected test directory');
  await rm(root, { recursive: true, force: true });
});
interface ChildResult { type: 'result'; ok: boolean; error?: string }
it('rejects a cancelled approved proposal without creating memory files',async()=>{
 const memory=new ProjectMemory(workspace,{directory});const prepared=await memory.prepare([{action:'add',text:'Prefer focused checks.'}]);const abort=new AbortController();abort.abort(new Error('Memory proposal cancelled'));
 await expect(prepared.apply(abort.signal)).rejects.toThrow('cancelled');expect(await memory.list()).toEqual([]);
 await expect(stat(directory)).rejects.toMatchObject({code:'ENOENT'});
});
function launchMemory(text: string, mode = 'add', lock?: string) {
  const child = spawn(process.execPath, [join(repository, 'tests/fixtures/project-memory-process.mjs')], {
    cwd: repository, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, KAIROS_MEMORY_MODULE: modulePath, KAIROS_MEMORY_WORKSPACE: workspace,
      KAIROS_MEMORY_DIRECTORY: directory, KAIROS_MEMORY_TEXT: text, KAIROS_MEMORY_MODE: mode, KAIROS_MEMORY_LOCK: lock },
  });
  children.push(child);
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const ready = new Promise<void>((resolve, reject) => {
    child.on('message', message => { if ((message as { type: string }).type === 'ready') resolve(); });
    child.once('error', reject);
    child.once('exit', code => { if (code) reject(new Error(`Memory fixture failed before ready: ${stderr}`)); });
  });
  const result = new Promise<ChildResult>((resolve, reject) => {
    let received = false;
    child.on('message', message => { if ((message as { type: string }).type === 'result') { received = true; resolve(message as ChildResult); } });
    child.once('error', reject);
    child.once('exit', () => { if (!received && mode !== 'hold') reject(new Error(`Memory fixture exited before reporting: ${stderr}`)); });
  });
  return { child, ready, result };
}
async function memoryFile(): Promise<string> {
  const names = await readdir(directory);
  expect(names).toHaveLength(1);
  return join(directory, names[0]!, 'notes.json');
}

it('persists stable notes through new instances, edits, deduplication and removals', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  expect(await memory.list()).toEqual([]);
  const added = await memory.update([{ action: 'add', text: 'Use ESM imports with .js extensions.' }]);
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ text: 'Use ESM imports with .js extensions.' });
  const reopened = new ProjectMemory(workspace, { directory });
  expect(await reopened.list()).toEqual(added);
  expect(await reopened.update([{ action: 'add', text: '  Use ESM imports with .js extensions.  ' }])).toEqual(added);
  const edited = await reopened.update([{ action: 'update', id: added[0]!.id, text: 'Use NodeNext ESM imports.' }]);
  expect(edited[0]).toMatchObject({ id: added[0]!.id, createdAt: added[0]!.createdAt, text: 'Use NodeNext ESM imports.' });
  expect(await new ProjectMemory(workspace, { directory }).context()).toContain('Use NodeNext ESM imports.');
  expect(await reopened.update([{ action: 'remove', id: added[0]!.id }])).toEqual([]);
  expect(await reopened.context()).toBe('');
});

it('validates the complete batch before changing any stored bytes', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  await memory.update([{ action: 'add', text: 'Keep edits small.' }]);
  const file = await memoryFile(); const before = await readFile(file, 'utf8');
  await expect(memory.update([{ action: 'add', text: 'This must not be saved.' }, { action: 'remove', id: 'missing' }])).rejects.toThrow(/memory|note/i);
  expect(await readFile(file, 'utf8')).toBe(before);
  await expect(memory.update([{ action: 'add', text: 'x'.repeat(2001) }])).rejects.toThrow(/2000/);
  expect(await readFile(file, 'utf8')).toBe(before);
});

it('prepares a read-only proposal and commits only its bound preview', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  const prepared = await memory.prepare([{ action: 'add', text: 'Use the graph before broad reads.' }]);
  expect(prepared.preview).toHaveLength(1);
  expect(await memory.list()).toEqual([]);
  await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  const proposed = structuredClone(prepared.preview);
  prepared.preview[0]!.text = 'A caller cannot alter the approved proposal.';
  expect(await prepared.apply()).toEqual(proposed);
  expect(await new ProjectMemory(workspace, { directory }).list()).toEqual(proposed);
});

it('rejects a stale approval while preserving a newer manual update', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  const [note] = await memory.update([{ action: 'add', text: 'Original convention.' }]);
  const proposal = await memory.prepare([{ action: 'update', id: note!.id, text: 'Proposed convention.' }]);
  await new ProjectMemory(workspace, { directory }).update([{ action: 'update', id: note!.id, text: 'New human convention.' }]);
  await expect(proposal.apply()).rejects.toThrow(/changed|stale/i);
  expect((await memory.list())[0]?.text).toBe('New human convention.');
});

it('rejects invalid proposal contents and total bytes before showing a preview', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  await expect(memory.prepare([{ action: 'add', text: 'password=not-for-memory' }])).rejects.toThrow(/credentials/i);
  await expect(memory.prepare([{ action: 'remove', id: '00000000-0000-4000-8000-000000000000' }])).rejects.toThrow(/does not exist/);
  await expect(memory.prepare(Array.from({ length: 20 }, (_, i) => ({ action: 'add' as const, text: `Convention ${i}: ${'字'.repeat(1000)}` })))).rejects.toThrow(/32 KiB/);
  expect(await memory.list()).toEqual([]);
});

it('keeps the prior committed bytes in a private backup and clear survives restart', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  const [note] = await memory.update([{ action: 'add', text: 'Prefer focused checks.' }]);
  const file = await memoryFile(); const before = await readFile(file, 'utf8');
  await memory.update([{ action: 'update', id: note!.id, text: 'Run focused checks before the full suite.' }]);
  expect(await readFile(file + '.bak', 'utf8')).toBe(before);
  if (process.platform !== 'win32') {
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(file + '.bak')).mode & 0o777).toBe(0o600);
    expect((await stat(join(file, '..'))).mode & 0o777).toBe(0o700);
  }
  await memory.clear();
  expect(await new ProjectMemory(workspace, { directory }).list()).toEqual([]);
});

it('serializes concurrent updates across fresh instances without losing notes', async () => {
  await Promise.all(Array.from({ length: 12 }, (_, i) => new ProjectMemory(workspace, { directory }).update([{ action: 'add', text: `Remember convention ${i}.` }])));
  const notes = await new ProjectMemory(workspace, { directory }).list();
  expect(notes).toHaveLength(12);
  expect(new Set(notes.map(note => note.id)).size).toBe(12);
});

it('retains every acknowledged add from simultaneous independent CLI processes', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  await memory.update([{ action: 'add', text: 'Initial convention.' }]);
  const processes = Array.from({ length: 12 }, (_, i) => launchMemory(`Child convention ${i}.`));
  await Promise.all(processes.map(process => process.ready));
  for (const process of processes) process.child.send('go');
  const results = await Promise.all(processes.map(process => process.result));
  expect(results).toEqual(Array.from({ length: 12 }, () => ({ type: 'result', ok: true })));
  const notes = await memory.list();
  expect(notes).toHaveLength(13);
  expect(notes.map(note => note.text).sort()).toEqual(['Initial convention.', ...Array.from({ length: 12 }, (_, i) => `Child convention ${i}.`)].sort());
}, 20000);

it('rejects a prepared update after a different process commits new memory', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  const [note] = await memory.update([{ action: 'add', text: 'Original convention.' }]);
  const proposal = await memory.prepare([{ action: 'update', id: note!.id, text: 'Proposed convention.' }]);
  const other = launchMemory('A newer child-process convention.'); await other.ready; other.child.send('go');
  expect(await other.result).toEqual({ type: 'result', ok: true });
  await expect(proposal.apply()).rejects.toThrow(/changed|stale/i);
  expect((await memory.list()).map(note => note.text)).toEqual(['Original convention.', 'A newer child-process convention.']);
}, 10000);

it('bounds waiting without stealing a live lock and leaves readonly operations available', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  await memory.update([{ action: 'add', text: 'Keep the active owner safe.' }]);
  const file = await memoryFile(); const owner = JSON.stringify({ version: 1, pid: process.pid, id: randomUUID() });
  await writeFile(file + '.lock', owner, { mode: 0o600 });
  expect(await memory.list()).toHaveLength(1);
  expect(await memory.context()).toContain('Keep the active owner safe.');
  expect((await memory.prepare([{ action: 'add', text: 'A read-only proposal.' }])).preview).toHaveLength(2);
  const contender = launchMemory('A waiting convention.'); await contender.ready; contender.child.send('go');
  const result = await contender.result;
  expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/memory.*(?:busy|in use|lock)/i) });
  expect(await readFile(file + '.lock', 'utf8')).toBe(owner);
  expect(await memory.list()).toHaveLength(1);
}, 12000);

it('fails closed on invalid lock owners without changing notes or the lock', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  await memory.update([{ action: 'add', text: 'Preserve committed notes.' }]);
  const file = await memoryFile(); const original = await readFile(file, 'utf8');
  const corrupt = '{"version":1,"pid":-1,"id":"invalid","private":"do-not-echo"}';
  await writeFile(file + '.lock', corrupt);
  await expect(memory.clear()).rejects.toThrow(/lock.*invalid|invalid.*lock/i);
  await expect(memory.update([{ action: 'add', text: 'A blocked convention.' }])).rejects.toThrow(/lock.*invalid|invalid.*lock/i);
  const proposal = await memory.prepare([{ action: 'add', text: 'Another blocked convention.' }]);
  await expect(proposal.apply()).rejects.toThrow(/lock.*invalid|invalid.*lock/i);
  expect(await readFile(file + '.lock', 'utf8')).toBe(corrupt);
  expect(await readFile(file, 'utf8')).toBe(original);
});

it('reopens safely after a dead owner and elects one recovery writer', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  await memory.update([{ action: 'add', text: 'Committed before the crash.' }]);
  const file = await memoryFile();
  const held = launchMemory('', 'hold', file + '.lock'); await held.ready;
  const dead = JSON.parse(await readFile(file + '.lock', 'utf8')) as { pid: number; id: string };
  await writeFile(`${file}.lock.recovery-${dead.id}-0`, JSON.stringify({ version: 1, pid: dead.pid, id: randomUUID() }));
  const exited = new Promise<void>(resolve => held.child.once('exit', () => resolve())); held.child.kill(); await exited;
  const processes = Array.from({ length: 6 }, (_, i) => launchMemory(`Recovered convention ${i}.`));
  await Promise.all(processes.map(process => process.ready));
  for (const process of processes) process.child.send('go');
  expect((await Promise.all(processes.map(process => process.result))).every(result => result.ok)).toBe(true);
  expect(await new ProjectMemory(workspace, { directory }).list()).toHaveLength(7);
  await expect(readFile(file + '.lock')).rejects.toMatchObject({ code: 'ENOENT' });
}, 15000);

it('bounds note count, total persisted bytes and injected context', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  await memory.update(Array.from({ length: 50 }, (_, i) => ({ action: 'add' as const, text: `Convention ${i}.` })));
  await expect(memory.update([{ action: 'add', text: 'Convention fifty.' }])).rejects.toThrow(/50/);
  expect((await memory.context(80)).length).toBeLessThanOrEqual(80);
  await memory.clear();
  await expect(memory.update(Array.from({ length: 20 }, (_, i) => ({ action: 'add' as const, text: `Convention ${i}: ${'字'.repeat(1000)}` })))).rejects.toThrow(/32 KiB/);
  expect(await memory.list()).toEqual([]);
});

it.each([
  'NVIDIA_API_KEY=nvapi-super-secret-1234567890',
  'nvapi-abcdefghijklmnopqrstuvwxyz0123456789',
  'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
  'password = "do-not-store-this"',
  '{"api_key":"super-secret-value"}',
  'AWS_SECRET_ACCESS_KEY=super-secret-value',
  'https://user:secret@example.test/path',
  '-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlMTIzNDU2',
  'abcdefghijklmno.abcdefghijklmnop.abcdefghijklmnop',
  '```ts\nconst x = 42;\n```',
  'export function readKey() { return process.env.NVIDIA_API_KEY; }',
])('rejects source or sensitive note content without echoing it: %s', async text => {
  const memory = new ProjectMemory(workspace, { directory });
  let error: unknown;
  try { await memory.update([{ action: 'add', text }]); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain(text);
  expect(await memory.list()).toEqual([]);
});

it('does not replace corrupt or unavailable memory with an empty store', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  await memory.update([{ action: 'add', text: 'Preserve human changes.' }]);
  const file = await memoryFile();
  await writeFile(file, '{ malformed private content');
  await expect(memory.list()).rejects.toThrow(/corrupt/i);
  await expect(memory.clear()).rejects.toThrow(/corrupt/i);
  expect(await readFile(file, 'utf8')).toBe('{ malformed private content');
  const unavailable = join(root, 'not-directory'); await writeFile(unavailable, 'blocked');
  await expect(new ProjectMemory(workspace, { directory: unavailable }).update([{ action: 'add', text: 'Safe note.' }])).rejects.toThrow(/memory/i);
});

it('refuses to reset a missing primary file when a committed backup remains', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  await memory.update([{ action: 'add', text: 'First convention.' }]);
  await memory.update([{ action: 'add', text: 'Second convention.' }]);
  const file = await memoryFile(); const backup = await readFile(file + '.bak', 'utf8');
  await rm(file);
  await expect(memory.update([{ action: 'add', text: 'Do not silently reset.' }])).rejects.toThrow(/memory/i);
  expect(await readFile(file + '.bak', 'utf8')).toBe(backup);
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves committed notes when a backup cannot be created safely', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  await memory.update([{ action: 'add', text: 'Committed convention.' }]);
  const file = await memoryFile(); const original = await readFile(file, 'utf8');
  await mkdir(file + '.bak');
  await expect(memory.update([{ action: 'add', text: 'Must not replace committed data.' }])).rejects.toThrow(/memory/i);
  expect(await readFile(file, 'utf8')).toBe(original);
});

it('rejects unexpected persisted fields instead of returning unsafe data', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  await memory.update([{ action: 'add', text: 'Keep notes concise.' }]);
  const file = await memoryFile(); const record = JSON.parse(await readFile(file, 'utf8'));
  record.notes[0].password = 'hidden-secret';
  await writeFile(file, JSON.stringify(record));
  await expect(memory.list()).rejects.toThrow(/corrupt/i);
});

it('allows environment-variable references without recording their values', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  expect((await memory.update([{ action: 'add', text: 'Load NVIDIA_API_KEY from the environment; use the official SDK.' }]))[0]?.text).toContain('NVIDIA_API_KEY');
});

it('isolates different workspaces and shares identity through a workspace symlink', async () => {
  const other = join(root, 'other'); await mkdir(other);
  await new ProjectMemory(workspace, { directory }).update([{ action: 'add', text: 'Only the first workspace sees this.' }]);
  expect(await new ProjectMemory(other, { directory }).list()).toEqual([]);
  const alias = join(root, 'alias');
  await symlink(await realpath(workspace), alias, process.platform === 'win32' ? 'junction' : 'dir');
  expect((await new ProjectMemory(alias, { directory }).list())[0]?.text).toBe('Only the first workspace sees this.');
});

it('rejects a redirected memory directory without reading or overwriting its target', async () => {
  const memory = new ProjectMemory(workspace, { directory });
  await memory.update([{ action: 'add', text: 'Retain this.' }]);
  const file = await memoryFile(); const target = join(root, 'redirected-memory');
  await mkdir(target); await writeFile(join(target, 'notes.json'), await readFile(file));
  const storage = join(file, '..');
  await rm(storage, { recursive: true });
  await symlink(await realpath(target), storage, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(memory.clear()).rejects.toThrow(/memory/i);
  expect((JSON.parse(await readFile(join(target, 'notes.json'), 'utf8')).notes as unknown[])).toHaveLength(1);
});

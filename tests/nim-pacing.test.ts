import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const key = 'nvapi-process-test-secret-never-save';
type Event = { type: string; at: number; pid: number; reason?: string; result?: { ok: boolean; error?: string } };
const children: ChildProcess[] = [];
let modulePath: string;
beforeAll(async () => {
  const cache = join(root, 'node_modules/.cache/kairos-tests');
  await mkdir(cache, { recursive: true });
  const modules = await mkdtemp(join(cache, 'nim-pacing-modules-'));
  await writeFile(join(modules, 'package.json'), '{"type":"module"}');
  await promisify(execFile)(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--ignoreConfig',
    '--target', 'ES2022', '--module', 'NodeNext', '--skipLibCheck', '--esModuleInterop',
    '--rootDir', join(root, 'src'), '--outDir', modules, join(root, 'src/core/nim-client.ts')], { cwd: root });
  modulePath = join(modules, 'core/nim-client.js');
}, 20000);
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve()); child.kill();
  })));
});

function launch(directory: string, mode = 'complete', hold = 0, apiKey = key) {
  const events: Event[] = [];
  let stderr = '';
  const child = spawn(process.execPath, [join(root, 'tests/fixtures/nim-pacing-process.mjs')], {
    cwd: root, env: { ...process.env, NIM_CLIENT_MODULE: modulePath, NIM_RATE_DIRECTORY: directory,
      NIM_TEST_KEY: apiKey, NIM_TEST_MODE: mode, NIM_HOLD_MS: String(hold) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  let pending = '';
  child.stdout!.on('data', chunk => {
    pending += chunk;
    const lines = pending.split('\n'); pending = lines.pop()!;
    for (const line of lines) if (line) events.push(JSON.parse(line));
  });
  child.stderr!.on('data', chunk => { stderr += chunk; });
  return { child, events, async event(type: string, reason?: string): Promise<Event> {
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      const event = events.find(event => event.type === type && (!reason || event.reason === reason));
      if (event) return event;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture exited before ${type}: ${stderr} ${events.findLast(event=>event.type==='result')?.result?.error??''}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Fixture timed out waiting for ${type}: ${stderr}`);
  } };
}
async function directory() { return mkdtemp(join(tmpdir(), 'nim-pacing-test-')); }

describe('NIM pacing across independent processes', () => {
  it('keeps a lease until a streamed response finishes, excluding a second process', async () => {
    const location = await directory();
    const a = launch(location, 'stream', 1900); const first = await a.event('start');
    const b = launch(location); const second = await b.event('start');
    const end = await a.event('end');
    expect(second.at).toBeGreaterThanOrEqual(end.at);
    expect(second.at - first.at).toBeGreaterThanOrEqual(1600);
    expect((await b.event('result')).result?.ok).toBe(true);
  }, 15000);

  it('paces the next dispatch after a failed HTTP request and stores no raw credentials', async () => {
    const location = await directory();
    const a = launch(location, 'error'); const first = await a.event('start'); await a.event('result');
    const b = launch(location); const second = await b.event('start'); await b.event('result');
    expect(second.at - first.at).toBeGreaterThanOrEqual(1600);
    const names = await readdir(location);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toContain(key);
      expect(await readFile(join(location, name), 'utf8')).not.toContain(key);
    }
  }, 15000);

  it('recovers a crashed owner and crashed reaper without forgetting dispatch cooldown', async () => {
    const location = await directory();
    const a = launch(location, 'complete', 60000); const first = await a.event('start');
    a.child.kill();
    await new Promise(resolve => a.child.once('exit', resolve));
    const hash = createHash('sha256').update(key).digest('hex');
    const dead = JSON.parse(await readFile(join(location, `${hash}.lock`), 'utf8'));
    await writeFile(join(location, `${hash}.lock.recovery-${dead.id}-0`),
      JSON.stringify({ version: 1, pid: a.child.pid, id: randomUUID() }));
    const b = launch(location); const second = await b.event('start');
    expect(second.at - first.at).toBeGreaterThanOrEqual(1600);
    expect((await b.event('result')).result?.ok).toBe(true);
  }, 15000);

  it('elects one reaper when several processes race to recover the same crashed owner', async () => {
    const location = await directory();
    const a = launch(location, 'complete', 60000); await a.event('start');
    a.child.kill(); await new Promise(resolve => a.child.once('exit', resolve));
    const contenders = [launch(location, 'stream', 200), launch(location, 'stream', 200), launch(location, 'stream', 200)];
    const starts = (await Promise.all(contenders.map(process => process.event('start')))).sort((a, b) => a.at - b.at);
    expect(starts[1]!.at - starts[0]!.at).toBeGreaterThanOrEqual(1600);
    expect(starts[2]!.at - starts[1]!.at).toBeGreaterThanOrEqual(1600);
    expect((await Promise.all(contenders.map(process => process.event('result')))).every(event => event.result?.ok)).toBe(true);
  }, 15000);

  it('never steals an ancient lease whose owner PID is still alive', async () => {
    const location = await directory();
    const hash = createHash('sha256').update(key).digest('hex');
    const path = join(location, `${hash}.lock`);
    const owner = JSON.stringify({ version: 1, pid: process.pid, id: randomUUID() });
    await writeFile(path, owner); await utimes(path, new Date(0), new Date(0));
    const a = launch(location); await a.event('wait', 'pacing'); a.child.send('abort');
    expect((await a.event('result')).result).toMatchObject({ ok: false, error: 'Request cancelled' });
    expect(a.events.some(event => event.type === 'start')).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(owner);
  }, 15000);

  it('cancels a waiting process without interrupting the live owner', async () => {
    const location = await directory();
    const a = launch(location, 'stream', 2200); await a.event('start');
    const b = launch(location); await b.event('wait', 'pacing'); b.child.send('abort');
    expect((await b.event('result')).result).toMatchObject({ ok: false, error: 'Request cancelled' });
    expect(b.events.some(event => event.type === 'start')).toBe(false);
    const c = launch(location); const next = await c.event('start');
    expect(next.at).toBeGreaterThanOrEqual((await a.event('end')).at);
    expect((await a.event('result')).result?.ok).toBe(true);
  }, 15000);

  it('retains a persisted 429 backoff when its owner is cancelled', async () => {
    const location = await directory();
    const a = launch(location, 'retry'); const first = await a.event('start');
    await a.event('wait', 'retry'); a.child.send('abort');
    expect((await a.event('result')).result).toMatchObject({ ok: false, error: 'Request cancelled' });
    const b = launch(location); const second = await b.event('start');
    expect(second.at - first.at).toBeGreaterThanOrEqual(5000);
    expect((await b.event('result')).result?.ok).toBe(true);
  }, 15000);

  it('aborts an active stream and retains its dispatch cooldown for the next process', async () => {
    const location = await directory();
    const a = launch(location, 'stream', 60000); const first = await a.event('start');
    a.child.send('abort');
    expect((await a.event('result')).result).toMatchObject({ ok: false, error: 'Request cancelled' });
    const b = launch(location); const second = await b.event('start');
    expect(second.at - first.at).toBeGreaterThanOrEqual(1600);
    expect((await b.event('result')).result?.ok).toBe(true);
  }, 15000);

  it('fails closed on corrupt persisted state before making an HTTP request', async () => {
    const location = await directory();
    const hash = createHash('sha256').update(key).digest('hex');
    await writeFile(join(location, `${hash}.json`), '{broken');
    const a = launch(location); const result = (await a.event('result')).result;
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/coordinator.*corrupt/i) });
    expect(a.events.some(event => event.type === 'start')).toBe(false);
  }, 15000);
});

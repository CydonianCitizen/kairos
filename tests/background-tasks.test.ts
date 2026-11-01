import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { FsTools } from '../src/tools/fs-tools.js';
import { windowsShellJob } from '../src/core/windows-shell-job.js';

let root: string;
let tools: FsTools;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'kairos-background-')); tools = new FsTools(root); });
afterEach(async () => { await tools.close(); await rm(root, { recursive: true, force: true }); }, 20000);

async function settled(id: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const task = tools.background.list().find(task => task.id === id)!;
    if (task.status !== 'running') return task;
    await delay(20);
  }
  throw new Error('Background task did not finish');
}

it('returns a stable task ID before completion and keeps the task after the turn signal aborts', async () => {
  expect(tools.background).toBeDefined();
  const controller = new AbortController();
  const task = await tools.background.start('printf ready; sleep 1; printf finished', { signal: controller.signal });
  expect(task).toMatchObject({ id: expect.any(String), status: 'running', command: 'printf ready; sleep 1; printf finished' });
  controller.abort();
  expect(tools.background.running).toBe(true);
  expect(await settled(task.id)).toMatchObject({ id: task.id, status: 'completed', exitCode: 0 });
  expect(tools.background.logs([task.id])[0]).toMatchObject({ stdout: 'readyfinished', stderr: '' });
}, 15000);

it('captures failure and bounds stdout and stderr independently', async () => {
  const task = await tools.background.start("printf '%20000s' x; printf '%20000s' y >&2; exit 7");
  expect(await settled(task.id)).toMatchObject({ status: 'failed', exitCode: 7, truncated: true });
  const logs = tools.background.logs([task.id])[0]!;
  expect(logs.stdout).toHaveLength(15000);
  expect(logs.stderr).toHaveLength(15000);
});

it('emits task metadata on start and completion without streaming captured output into events', async () => {
  const changes: unknown[][] = [];
  tools.background.on('change', tasks => { changes.push(tasks); });
  const task = await tools.background.start('printf private-output');
  await settled(task.id);
  expect(changes[0]).toMatchObject([{ id: task.id, status: 'running' }]);
  expect(changes.at(-1)).toMatchObject([{ id: task.id, status: 'completed' }]);
  expect(JSON.stringify(changes)).not.toContain('"stdout"');
});

it('returns bounded live logs before completion without exposing mutable task records', async () => {
  const task = await tools.background.start('printf live; sleep 20');
  for (let attempt = 0; attempt < 100 && !tools.background.logs([task.id])[0]?.stdout; attempt++) await delay(20);
  const logs = tools.background.logs([task.id])[0]!;
  expect(logs).toMatchObject({ status: 'running', stdout: 'live' });
  logs.status = 'failed';
  expect(tools.background.list()[0]?.status).toBe('running');
  await tools.background.stop([task.id]);
});

it('times out an owned process tree and stops writing before returning terminal status', async () => {
  await writeFile(join(root, 'heartbeat'), '');
  const command = "while :; do printf x >> heartbeat; sleep 0.05; done & wait";
  const task = await tools.background.start(command, { timeoutMs: 2000 });
  expect(await settled(task.id)).toMatchObject({ status: 'timed_out', timedOut: true });
  const content = await readFile(join(root, 'heartbeat'), 'utf8');
  await delay(200);
  expect(await readFile(join(root, 'heartbeat'), 'utf8')).toBe(content);
}, 10000);

it('preflights every ID before stopping any task and waits for stopped process trees', async () => {
  const first = await tools.background.start('sleep 20');
  const second = await tools.background.start('sleep 20');
  await expect(tools.background.stop([first.id, 'unknown'])).rejects.toThrow(/task/i);
  expect(tools.background.list().find(task => task.id === first.id)?.status).toBe('running');
  const stopped = await tools.background.stop([first.id, second.id]);
  expect(stopped.map(task => task.status)).toEqual(['cancelled', 'cancelled']);
  expect(tools.background.running).toBe(false);
  expect(await tools.background.stop([first.id])).toMatchObject([{ status: 'cancelled' }]);
});

it.each(['', '; exit 0'])('owns background shell jobs after the command returns (%s) and prevents their later effects on stop', async ending => {
  const task = await tools.background.start(`(sleep 1; printf orphan > orphan.txt) & printf parent-finished${ending}`);
  for (let attempt = 0; attempt < 100 && !tools.background.logs([task.id])[0]?.stdout; attempt++) await delay(10);
  await delay(100);
  await tools.background.stop([task.id]);
  await expect(readFile(join(root, 'orphan.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('supervises nested Bash descendants with redirected streams', async () => {
  const command = "bash --noprofile --norc -c '(sleep 1; printf orphan > orphan.txt) >/dev/null 2>&1 &' ; printf parent-finished";
  const task = await tools.background.start(command);
  for (let attempt = 0; attempt < 200 && !tools.background.logs([task.id])[0]?.stdout; attempt++) await delay(10);
  await delay(100);
  expect(tools.background.list().find(entry => entry.id === task.id)?.status).toBe('running');
  await tools.background.stop([task.id]);
  await delay(1100);
  await expect(readFile(join(root, 'orphan.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.runIf(process.platform === 'win32')('keeps detached native descendants in the Windows job after their parent exits', async () => {
  await writeFile(join(root, 'detached-parent.mjs'), `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync("detached.txt", "orphan"), 1000)'], { detached: true, stdio: 'ignore' });
child.unref(); process.stdout.write('parent-finished');`);
  const owned = new FsTools(root, undefined, { shellInvocation: ({ cwd }) => ({ file: process.execPath, args: ['detached-parent.mjs'], cwd }) });
  try {
    const task = await owned.background.start('detached native fixture');
    for (let attempt = 0; attempt < 200 && !owned.background.logs([task.id])[0]?.stdout; attempt++) await delay(10);
    await delay(100);
    expect(owned.background.list()[0]?.status).toBe('running');
    await owned.background.stop([task.id]);
    await delay(1100);
    await expect(readFile(join(root, 'detached.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await owned.close(); }
});

it.runIf(process.platform === 'win32')('terminates the owned Windows job if its Node host exits without cleanup', async () => {
  await writeFile(join(root, 'crash-child.mjs'), `import { writeFileSync } from 'node:fs';
writeFileSync('child-started.txt', 'started'); process.stdout.write('child-started');
setTimeout(() => writeFileSync('after-crash.txt', 'orphan'), 1000);`);
  await writeFile(join(root, 'crash-host.mjs'), `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
const fields = process.env.KAIROS_TEST_JOB_PAYLOAD.split('.'); fields[4] = Buffer.from(String(process.pid)).toString('base64');
const env = { ...process.env, KAIROS_OWNED_SHELL_JOB: fields.join('.') };
for (const key of ['KAIROS_TEST_JOB_PAYLOAD', 'KAIROS_TEST_JOB_FILE']) delete env[key];
const child = spawn(process.env.KAIROS_TEST_JOB_FILE, [], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
writeFileSync('helper-pid.txt', String(child.pid));
child.stdout.on('data', data => { if (String(data).includes('child-started')) setTimeout(() => process.exit(0), 25); });
child.on('error', () => process.exit(3)); setTimeout(() => process.exit(2), 15000);`);
  const job = await windowsShellJob({ file: process.execPath, args: ['crash-child.mjs'], cwd: root }, root);
  const host = spawn(process.execPath, ['crash-host.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, KAIROS_TEST_JOB_FILE: job.invocation.file, KAIROS_TEST_JOB_PAYLOAD: job.invocation.env!.KAIROS_OWNED_SHELL_JOB } });
  let hostError = ''; host.stderr.setEncoding('utf8'); host.stderr.on('data', (data: string) => { hostError += data; });
  try {
    const [code] = await once(host, 'close');
    expect(code, hostError).toBe(0);
    expect(await readFile(join(root, 'child-started.txt'), 'utf8')).toBe('started');
    await delay(1200);
    await expect(readFile(join(root, 'after-crash.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    if (host.exitCode === null && host.signalCode === null) { const closed = once(host, 'close'); host.kill('SIGKILL'); await closed; }
    const helperPid = await readFile(join(root, 'helper-pid.txt'), 'utf8').then(Number).catch(() => undefined);
    if (helperPid && Number.isInteger(helperPid)) {
      const alive = () => { try { process.kill(helperPid, 0); return true; } catch { return false; } };
      for (let attempt = 0; attempt < 100 && alive(); attempt++) await delay(20);
      if (alive()) process.kill(helperPid, 'SIGKILL');
      for (let attempt = 0; attempt < 100 && alive(); attempt++) await delay(20);
    }
    await job.release();
  }
}, 25000);

it.runIf(process.platform === 'win32')('preserves timeout classification when the shell cannot finish starting', async () => {
  expect(await tools.run_bash('sleep 10', 1)).toMatchObject({ timedOut: true });
  await expect(tools.background.start('sleep 10', { timeoutMs: 1 })).rejects.toThrow();
  expect(tools.background.list()).toEqual([]);
});

it('rejects invalid commands and timeouts, aborted startup and missing executables without stale tasks', async () => {
  await expect(tools.background.start(' ')).rejects.toThrow(/command/i);
  await expect(tools.background.start('printf no', { timeoutMs: 0 })).rejects.toThrow(/timeout/i);
  await expect(tools.background.start('printf no', { timeoutMs: 300001 })).rejects.toThrow(/timeout/i);
  const controller = new AbortController(); controller.abort();
  await expect(tools.background.start('printf no', { signal: controller.signal })).rejects.toThrow();
  expect(tools.background.list()).toEqual([]);
  const unavailable = new FsTools(root, join(root, 'missing-bash'));
  try {
    await expect(unavailable.background.start('printf no')).rejects.toThrow();
    expect(unavailable.background.running).toBe(false);
    expect(unavailable.background.list()).toEqual([]);
  } finally { await unavailable.close(); }
}, 15000);

it('enforces the live task limit while starts are pending and close awaits and rejects further tasks', async () => {
  const pending = Array.from({ length: 8 }, () => tools.background.start('sleep 20'));
  await expect(tools.background.start('printf overflow')).rejects.toThrow(/limit/i);
  const tasks = await Promise.all(pending);
  expect(tasks).toHaveLength(8);
  await tools.close();
  expect(tools.background.running).toBe(false);
  expect(tools.background.list().every(task => task.status === 'cancelled')).toBe(true);
  await expect(tools.background.start('printf no')).rejects.toThrow(/closed/i);
});

it('close cancels a startup in progress without leaving an owned process', async () => {
  const delayed = new FsTools(root, undefined, { shellInvocation: async ({ shell, command, cwd }) => {
    await delay(50);
    return { file: shell, args: ['--noprofile', '--norc', '-c', command], cwd };
  } });
  const starting = delayed.background.start('printf late > late.txt; sleep 20');
  const rejected = expect(starting).rejects.toThrow(/closed/i);
  await delayed.close();
  await rejected;
  expect(delayed.background.running).toBe(false);
  expect(delayed.background.list()).toEqual([]);
  await expect(readFile(join(root, 'late.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retains only a bounded number of completed logs', async () => {
  const oldestRunning = await tools.background.start('sleep 120', { timeoutMs: 300000 });
  const first = await tools.background.start('printf oldest'); await settled(first.id);
  for (let index = 0; index < 51; index++) {
    const task = await tools.background.start('true'); await settled(task.id);
  }
  expect(tools.background.list()).toHaveLength(51);
  expect(() => tools.background.logs([first.id])).toThrow(/task/i);
  await tools.background.stop([oldestRunning.id]);
  expect(tools.background.list()).toHaveLength(50);
  expect(tools.background.logs([oldestRunning.id])[0]?.status).toBe('cancelled');
}, 30000);

it('uses the same explicit invocation adapter for foreground and background execution', async () => {
  await writeFile(join(root, 'adapter.mjs'), 'process.stdout.write(process.argv[2]);');
  const adapted = new FsTools(root, undefined, { shellInvocation: ({ command, cwd }) => ({ file: process.execPath, args: ['adapter.mjs', command], cwd }) });
  try {
    expect((await adapted.run_bash('foreground')).stdout).toBe('foreground');
    const task = await adapted.background.start('background');
    for (let attempt = 0; attempt < 100 && adapted.background.running; attempt++) await delay(20);
    expect(adapted.background.logs([task.id])[0]).toMatchObject({ status: 'completed', stdout: 'background' });
  } finally { await adapted.close(); }
});

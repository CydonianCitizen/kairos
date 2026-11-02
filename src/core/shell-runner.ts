import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { access, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { diagnoseWindowsShellJob, windowsShellJob } from './windows-shell-job.js';

export interface BashResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean; error?: string; aborted?: boolean }
export class ShellStartupError extends Error {
  constructor(message: string, readonly result: BashResult) { super(message); }
}
export interface ShellInvocation { file: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }
export type ShellInvocationBuilder = (request: { shell: string; command: string; cwd: string; args: string[]; env?: NodeJS.ProcessEnv }) => ShellInvocation | Promise<ShellInvocation>;
export interface ShellProcess {
  pid: number | undefined;
  result: Promise<BashResult>;
  output(): Readonly<BashResult>;
  stop(): Promise<BashResult>;
  releaseSignal(): void;
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function diagnoseStartup(error: unknown, file: string): Promise<void> {
  if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'UNKNOWN' || !(error instanceof Error)) return;
  const details = error as NodeJS.ErrnoException & { path?: string };
  const native = await diagnoseWindowsShellJob(file).catch(reason => errorText(reason));
  error.message += `; ${JSON.stringify({ errno: details.errno, syscall: details.syscall, path: details.path })}; ${native}`;
}

export function validateShell(command: string, timeoutMs: number): void {
  if (typeof command !== 'string' || !command.trim() || command.includes('\0')) throw new Error('command must be non-empty and contain no NUL characters');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('timeoutMs must be between 1 and 300000');
}

let cachedBash: string | undefined;

export function resetBashCache(): void {
  cachedBash = undefined;
}

const envVar = (name: string): string | undefined =>
  process.env[name] ?? process.env[name.toUpperCase()] ?? process.env[name.toLowerCase()];

export async function findBash(bashPath?: string): Promise<string> {
  const envBash = envVar('BASH_PATH');
  if (bashPath || envBash) return bashPath ?? envBash!;
  if (process.platform !== 'win32') return 'bash';

  if (cachedBash) {
    try {
      await access(cachedBash);
      return cachedBash;
    } catch {
      cachedBash = undefined;
    }
  }

  const systemRoot = envVar('SystemRoot') ?? 'C:\\Windows';
  const system32 = join(systemRoot, 'System32').toLowerCase();
  const wslFallbacks: string[] = [];

  // 1. Scan PATH environment variable directories
  const pathEnv = envVar('PATH') ?? '';
  const pathDirs = pathEnv.split(';').map(d => d.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, 'bash.exe');
    try {
      await access(candidate);
      if (candidate.toLowerCase().startsWith(system32)) {
        wslFallbacks.push(candidate);
      } else {
        cachedBash = candidate;
        return candidate;
      }
    } catch {
      // not in this dir
    }
  }

  const programFiles = envVar('ProgramFiles');
  const programFilesX86 = envVar('ProgramFiles(x86)');
  const localAppData = envVar('LOCALAPPDATA');
  const userProfile = envVar('USERPROFILE');
  const chocoInstall = envVar('ChocolateyInstall');
  const programData = envVar('ProgramData');

  // 2. Known standard installation locations on Windows
  const standardLocations: (string | undefined)[] = [
    // Git for Windows (64-bit and 32-bit Program Files)
    programFiles && join(programFiles, 'Git', 'bin', 'bash.exe'),
    programFiles && join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    programFilesX86 && join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    programFilesX86 && join(programFilesX86, 'Git', 'usr', 'bin', 'bash.exe'),
    // Per-user Git for Windows
    localAppData && join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
    localAppData && join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'bash.exe'),
    // Root Git installation
    'C:\\Git\\bin\\bash.exe',
    'C:\\Git\\usr\\bin\\bash.exe',
    // MSYS2 64-bit and 32-bit
    'C:\\msys64\\usr\\bin\\bash.exe',
    'C:\\msys64\\bin\\bash.exe',
    'C:\\msys32\\usr\\bin\\bash.exe',
    'C:\\msys32\\bin\\bash.exe',
    // Scoop
    userProfile && join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
    userProfile && join(userProfile, 'scoop', 'apps', 'git', 'current', 'usr', 'bin', 'bash.exe'),
    userProfile && join(userProfile, 'scoop', 'shims', 'bash.exe'),
    // Chocolatey
    chocoInstall && join(chocoInstall, 'bin', 'bash.exe'),
    join(programData ?? 'C:\\ProgramData', 'chocolatey', 'bin', 'bash.exe'),
    // Cygwin
    'C:\\cygwin64\\bin\\bash.exe',
    'C:\\cygwin\\bin\\bash.exe',
  ];

  for (const loc of standardLocations) {
    if (!loc) continue;
    try {
      await access(loc);
      cachedBash = loc;
      return loc;
    } catch {
      // not in this location
    }
  }

  // 3. Fallback: try where.exe query
  const whereFound = await new Promise<string[]>(resolve => {
    try {
      const cp = spawn('where.exe', ['bash.exe'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let stdout = '';
      cp.stdout?.setEncoding('utf8');
      cp.stdout?.on('data', chunk => { stdout += chunk; });
      cp.once('close', code => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
        } else {
          resolve([]);
        }
      });
      cp.once('error', () => resolve([]));
    } catch {
      resolve([]);
    }
  });

  for (const loc of whereFound) {
    try {
      await access(loc);
      if (loc.toLowerCase().startsWith(system32)) {
        wslFallbacks.push(loc);
      } else {
        cachedBash = loc;
        return loc;
      }
    } catch {}
  }

  // 4. Fallback to WSL launcher if found as last resort
  if (wslFallbacks.length > 0) {
    cachedBash = wslFallbacks[0];
    return wslFallbacks[0]!;
  }

  throw new Error(
    'No compatible Bash executable found on Windows. Please install Git for Windows (https://git-scm.com/download/win), MSYS2 (https://www.msys2.org), or set the BASH_PATH environment variable to bash.exe.'
  );
}

async function terminateTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { child.removeListener('close', complete); resolve(false); }, 2000);
      const complete = () => { clearTimeout(timer); resolve(true); };
      child.once('close', complete);
      child.stdin?.write('stop\n');
    });
    if (exited) return;
    await new Promise<void>(resolve => {
      const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill('SIGKILL'); resolve(); });
      killer.once('close', code => { if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); resolve(); });
    });
    return;
  }
  const kill = (signal: NodeJS.Signals) => {
    try { process.kill(-child.pid!, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal); }
  };
  kill('SIGTERM');
  // A descendant can outlive its shell; escalate for the whole owned group even after shell close.
  await new Promise<void>(resolve => setTimeout(resolve, 100));
  kill('SIGKILL');
}

async function groupAlive(pid: number | undefined): Promise<boolean> {
  if (!pid) return false;
  try { process.kill(-pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  // Zombies cannot run effects and may await reaping by an unrelated init process.
  return new Promise<boolean>(resolve => {
    const ps = spawn('ps', ['-A', '-o', 'pgid=', '-o', 'stat='], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { ps.kill(); resolve(true); }, 1000);
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (data: string) => { output += data.slice(0, Math.max(0, 256000 - output.length)); });
    ps.once('error', () => { clearTimeout(timer); resolve(true); });
    ps.once('close', code => {
      clearTimeout(timer);
      resolve(code !== 0 || output.split('\n').some(line => { const match = /^\s*(\d+)\s+(\S+)/.exec(line); return match && Number(match[1]) === pid && !match[2]!.startsWith('Z'); }));
    });
  });
}

export async function launchShell(workspace: string, bashPath: string | undefined, command: string, options: {
  timeoutMs?: number; signal?: AbortSignal; invocation?: ShellInvocationBuilder; beforeSpawn?: () => void;
} = {}): Promise<ShellProcess> {
  const timeoutMs = options.timeoutMs ?? 30000;
  validateShell(command, timeoutMs);
  options.signal?.throwIfAborted();
  const shell = await findBash(bashPath);
  const cwd = await realpath(workspace);
  const args = ['--noprofile', '--norc', '-c', command];
  let invocation = options.invocation ? await options.invocation({ shell, command, cwd, args }) : { file: shell, args, cwd };
  let ready: string | undefined;
  let releaseJob: (() => Promise<void>) | undefined;
  if (process.platform === 'win32') {
    const job = await windowsShellJob(invocation, cwd);
    invocation = job.invocation; ready = `${job.ready}\n`; releaseJob = job.release;
  }
  if (options.signal?.aborted) { await releaseJob?.(); options.signal.throwIfAborted(); }
  const deadline = Date.now() + timeoutMs;
  let child: ChildProcessByStdio<Writable | null, Readable, Readable>;
  const spawnOptions = { cwd: invocation.cwd ?? cwd, env: invocation.env, windowsHide: true, detached: process.platform !== 'win32' };
  try { options.beforeSpawn?.(); child = process.platform === 'win32' ? spawn(invocation.file, invocation.args, { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] }) : spawn(invocation.file, invocation.args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    await diagnoseStartup(error, invocation.file);
    await releaseJob?.(); throw error;
  }
  child.stdin?.on('error', () => {});
  const result: BashResult = { stdout: '', stderr: '', exitCode: null, timedOut: false, truncated: false };
  let resolveDone!: (result: BashResult) => void;
  const done = new Promise<BashResult>(resolve => { resolveDone = resolve; });
  let closed = false;
  let completion: Promise<void> | undefined;
  let startupDiagnostic: Promise<void> | undefined;
  let termination: Promise<void> | undefined;
  const terminate = () => { termination ??= terminateTree(child); };
  const cancel = () => { if (!closed) { result.aborted = true; terminate(); } };
  const timer = setTimeout(() => { if (!closed) { result.timedOut = true; terminate(); } }, Math.max(0, deadline - Date.now()));
  const releaseSignal = () => options.signal?.removeEventListener('abort', cancel);
  const complete = (): Promise<void> => completion ??= (async () => {
    if (process.platform !== 'win32') {
      while (await groupAlive(child.pid)) await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
    closed = true;
    clearTimeout(timer);
    releaseSignal();
    try { await termination; }
    catch (error) { result.error = errorText(error); }
    await startupDiagnostic;
    await releaseJob?.();
    resolveDone(result);
  })();
  const handle: ShellProcess = {
    pid: child.pid, result: done, output: () => ({ ...result }), releaseSignal,
    stop: () => { cancel(); return done; },
  };
  // Attach both before observing cancellation: spawn failure must always be consumed.
  let started = false;
  let resolveStart!: (process: ShellProcess) => void;
  let rejectStart!: (error: unknown) => void;
  const spawned = new Promise<ShellProcess>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  const start = () => {
    started = true;
    if (Date.now() >= deadline) { result.timedOut = true; terminate(); }
    if (result.aborted || result.timedOut) { void done.then(() => rejectStart(new ShellStartupError(result.timedOut ? 'Shell startup timed out' : 'Shell startup cancelled', result))); }
    else resolveStart(handle);
  };
  const append = (key: 'stdout' | 'stderr', data: string) => {
    const room = 15000 - result[key].length;
    if (data.length > room) result.truncated = true;
    result[key] += data.slice(0, room);
  };
  let handshake = '';
  for (const key of ['stdout', 'stderr'] as const) {
    child[key].setEncoding('utf8');
    child[key].on('data', (data: string) => {
      if (key !== 'stderr' || !ready || started) { append(key, data); return; }
      handshake += data;
      const index = handshake.indexOf(ready);
      if (index >= 0) { append(key, handshake.slice(0, index) + handshake.slice(index + ready.length)); handshake = ''; start(); }
      else if (handshake.length > ready.length * 2) { append(key, handshake.slice(0, -ready.length)); handshake = handshake.slice(-ready.length); }
    });
  }
  child.once('spawn', () => { if (!ready) start(); });
  child.once('error', error => {
    startupDiagnostic = diagnoseStartup(error, invocation.file).then(() => { result.error = errorText(error); });
    void complete().then(() => rejectStart(error));
  });
  child.once('close', code => {
    result.exitCode = code;
    if (handshake) append('stderr', handshake);
    void complete().then(() => {
      if (!started) rejectStart(new ShellStartupError(result.stderr.trim() || (result.aborted ? errorText(options.signal?.reason ?? 'Shell startup cancelled') : `Shell supervisor exited before startup (${code})`), result));
    });
  });
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  return spawned;
}

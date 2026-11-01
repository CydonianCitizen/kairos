import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const intervalMs = 1600;
interface Owner { version: 1; pid: number; id: string }
interface State { version: 1; nextAllowedAt: number }
export interface NimLease {
  beforeDispatch(signal?: AbortSignal, onWait?: (remainingMs: number) => void): Promise<void>;
  deferUntil(timestamp: number): Promise<void>;
  release(): Promise<void>;
}

function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function exists(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'EEXIST'; }
function corrupt(): never { throw new Error('NIM shared rate-limit coordinator is corrupt; inspect its local rate-limit files before retrying.'); }

async function json(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch (error) { if (absent(error)) return undefined; if (error instanceof SyntaxError) corrupt(); throw error; }
}
async function ownerAt(path: string): Promise<Owner | undefined> {
  const value = await json(path);
  if (value === undefined) return undefined;
  const owner = value as Partial<Owner> | null;
  if (!owner || owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid! < 1 ||
      typeof owner.id !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.id)) corrupt();
  return owner as Owner;
}
async function stateAt(path: string): Promise<State> {
  const value = await json(path);
  if (value === undefined) return { version: 1, nextAllowedAt: 0 };
  const state = value as Partial<State> | null;
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.nextAllowedAt) || state.nextAllowedAt! < 0) corrupt();
  return state as State;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function writeComplete(path: string, value: unknown): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
}
async function persist(path: string, state: State): Promise<void> {
  const candidate = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeComplete(candidate, state);
    for(let attempt=0;;attempt++){
      try{await rename(candidate,path);break;}
      catch(error){
        // Windows readers can briefly deny replacement; keep the lease and fail closed if it persists.
        if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??'')||attempt>=19)throw error;
        await pause(25);
      }
    }
  }
  finally { await unlink(candidate).catch(error => { if (!absent(error)) throw error; }); }
}

// A hard link publishes a complete owner record atomically; an empty/partial lock is never visible.
async function claim(path: string, owner: Owner): Promise<boolean> {
  const candidate = `${path}.${owner.id}.tmp`;
  try {
    await writeComplete(candidate, owner);
    try { await link(candidate, path); return true; }
    catch (error) { if (exists(error)) return false; throw error; }
  } finally { await unlink(candidate).catch(error => { if (!absent(error)) throw error; }); }
}

async function recover(lockPath: string, statePath: string, dead: Owner, signal?: AbortSignal): Promise<void> {
  const recovering: Owner = { version: 1, pid: process.pid, id: randomUUID() };
  // Recovery records are immutable and retained. A second reaper must never unlink a new owner's lock.
  // Only crashes add records; a crashed reaper is replaced by the next generation in this small chain.
  for (let generation = 0; ; generation++) {
    signal?.throwIfAborted();
    const election = `${lockPath}.recovery-${dead.id}-${generation}`;
    const elected = await ownerAt(election);
    if (elected) { if (alive(elected.pid)) return; continue; }
    if (!await claim(election, recovering)) { generation--; continue; }
    const current = await ownerAt(lockPath);
    if (!current || current.id !== dead.id || alive(current.pid)) return;
    const state = await stateAt(statePath);
    // The process may have died between dispatch and its final timestamp update.
    await persist(statePath, { version: 1, nextAllowedAt: Math.max(state.nextAllowedAt, Date.now() + intervalMs) });
    await unlink(lockPath);
    return;
  }
}

/** Host-local coordination for clients sharing a credential and rate-limit directory; cross-process order is not FIFO. */
export async function acquireNimLease(apiKey: string, directory = join(homedir(), '.kairos', 'rate-limits'),
  signal?: AbortSignal, onWait?: (remainingMs: number) => void): Promise<NimLease> {
  const hash = createHash('sha256').update(apiKey).digest('hex');
  const lockPath = join(directory, `${hash}.lock`);
  const statePath = join(directory, `${hash}.json`);
  const owner: Owner = { version: 1, pid: process.pid, id: randomUUID() };
  let acquired = false;
  let poisoned = false;
  let state: State;
  try {
    signal?.throwIfAborted();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (;;) {
      signal?.throwIfAborted();
      const current = await ownerAt(lockPath);
      if (!current) {
        if (await claim(lockPath, owner)) { acquired = true; break; }
      }
      else {
        const pending = await stateAt(statePath);
        if (!alive(current.pid)) await recover(lockPath, statePath, current, signal);
        onWait?.(Math.max(100, pending.nextAllowedAt - Date.now()));
        await pause(100, signal);
      }
    }
    state = await stateAt(statePath);
  } catch (error) {
    if (acquired) await unlink(lockPath).catch(() => {});
    if (signal?.aborted) throw error;
    throw new Error(`NIM shared rate-limit coordinator unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const deferUntil = async (timestamp: number): Promise<void> => {
    if (poisoned) throw new Error('NIM shared rate-limit coordinator failed; the lease remains locked until this process exits.');
    if (timestamp <= state.nextAllowedAt) return;
    try {
      const next: State = { version: 1, nextAllowedAt: Math.ceil(timestamp) };
      await persist(statePath, next); state = next;
    } catch (error) {
      poisoned = true;
      throw new Error(`NIM shared rate-limit coordinator could not persist cooldown: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    async beforeDispatch(dispatchSignal, wait) {
      while (Date.now() < state.nextAllowedAt) {
        dispatchSignal?.throwIfAborted();
        const remaining = state.nextAllowedAt - Date.now();
        wait?.(remaining);
        await pause(Math.min(100, remaining), dispatchSignal);
      }
      dispatchSignal?.throwIfAborted();
      // Reserve cooldown durably before sending anything to the provider.
      await deferUntil(Date.now() + intervalMs);
      dispatchSignal?.throwIfAborted();
      wait?.(0);
    },
    deferUntil,
    async release() {
      if (!acquired || poisoned) return;
      const current = await ownerAt(lockPath);
      if (current?.id !== owner.id) throw new Error('NIM shared rate-limit coordinator lost its lease; refusing to remove another owner.');
      await unlink(lockPath); acquired = false;
    },
  };
}

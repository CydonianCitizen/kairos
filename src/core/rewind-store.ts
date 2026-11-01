import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { validateSessionState, type SessionState } from './session-store.js';

export interface RewindSummary { id: string; prompt: string; createdAt: string }
export interface RewindPoint extends RewindSummary { state: SessionState }
interface StoredPoint extends RewindPoint { discardedOwners?: string[] }
interface Checkpoints { version: 1; workspace: string; scope: string; points: StoredPoint[] }
const limit = 32 * 1024 * 1024;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Turn-start snapshots; filesystem changes remain exclusively in the undo journal. */
export class RewindStore {
  private points: StoredPoint[] = [];
  private operations: Promise<unknown> = Promise.resolve();
  constructor(private readonly workspace: string, private readonly scopeId: string, private readonly directory?: string) {
    if (typeof scopeId !== 'string' || !scopeId.trim() || scopeId.length > 256 || /[\u0000-\u001f]/.test(scopeId)) throw new Error('Invalid rewind scope');
  }

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation); this.operations = result.catch(() => undefined); return result;
  }

  private async location(): Promise<{ workspace: string; file: string }> {
    const workspace = await realpath(this.workspace);
    const identity = process.platform === 'win32' ? workspace.toLowerCase() : workspace;
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    return { workspace, file: join(this.directory!, digest(identity), `${digest(this.scopeId)}.rewind.json`) };
  }

  private async load(): Promise<{ points: StoredPoint[]; previous?: string }> {
    if (!this.directory) return { points: structuredClone(this.points) };
    const location = await this.location();
    try {
      if ((await stat(location.file)).size > limit) throw new Error('Checkpoint file exceeds 32 MiB');
      const previous = await readFile(location.file, 'utf8'); const data = JSON.parse(previous) as Checkpoints;
      if (!data || data.version !== 1 || data.workspace !== location.workspace || data.scope !== this.scopeId || !Array.isArray(data.points) || data.points.length > 100) throw new Error('Invalid checkpoint envelope');
      const ids = new Set<string>();
      for (const point of data.points) {
        if (!point || !validId(point.id) || ids.has(point.id) || typeof point.prompt !== 'string' || typeof point.createdAt !== 'string' || !Number.isFinite(Date.parse(point.createdAt))) throw new Error('Invalid checkpoint');
        ids.add(point.id); validateSessionState(point.state);
        if (point.discardedOwners !== undefined && (!Array.isArray(point.discardedOwners) || point.discardedOwners.some(owner => !validId(owner)) || new Set(point.discardedOwners).size !== point.discardedOwners.length)) throw new Error('Invalid discarded checkpoint owners');
      }
      return { points: data.points, previous };
    } catch (error) {
      if (absent(error)) return { points: [] };
      throw new Error(`Rewind checkpoints are corrupt or unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async publish(file: string, data: string): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(data, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(error => { if (!absent(error)) throw error; }); }
  }

  private async save(points: StoredPoint[], previous?: string): Promise<void> {
    if (!this.directory) { this.points = structuredClone(points); return; }
    const location = await this.location();
    const data = JSON.stringify({ version: 1, workspace: location.workspace, scope: this.scopeId, points } satisfies Checkpoints);
    if (Buffer.byteLength(data) > limit) throw new Error('Rewind checkpoints exceed 32 MiB');
    await mkdir(join(location.file, '..'), { recursive: true, mode: 0o700 });
    if (previous !== undefined) await this.publish(`${location.file}.bak`, previous);
    await this.publish(location.file, data);
  }

  capture(prompt: string, state: SessionState): Promise<RewindPoint> {
    return this.queue(async () => {
      if (typeof prompt !== 'string') throw new Error('Invalid rewind prompt'); validateSessionState(state);
      const point: StoredPoint = { id: randomUUID(), prompt, createdAt: new Date().toISOString(), state: structuredClone(state) };
      if (Buffer.byteLength(JSON.stringify(point)) > limit - 1024) throw new Error('Rewind checkpoint exceeds 32 MiB');
      const { points, previous } = await this.load(); points.push(point);
      while (points.length > 100 || Buffer.byteLength(JSON.stringify(points)) > limit - 1024) points.shift();
      await this.save(points, previous); return structuredClone(point);
    });
  }

  list(): Promise<RewindSummary[]> {
    return this.queue(async () => (await this.load()).points.map(({ id, prompt, createdAt }) => ({ id, prompt, createdAt })));
  }

  get(id: string): Promise<RewindPoint> {
    return this.queue(async () => {
      const point = (await this.load()).points.find(point => point.id === id);
      if (!point) throw new Error('Rewind checkpoint not found');
      const { discardedOwners: _owners, ...result } = point; return structuredClone(result);
    });
  }

  ownersFrom(id: string): Promise<string[]> {
    return this.queue(async () => {
      const { points } = await this.load(); const index = points.findIndex(point => point.id === id);
      if (index < 0) throw new Error('Rewind checkpoint not found');
      return [...new Set(points.slice(index).flatMap(point => [point.id, ...point.discardedOwners ?? []]))];
    });
  }

  truncateAfter(id: string): Promise<void> {
    return this.queue(async () => {
      const { points, previous } = await this.load(); const index = points.findIndex(point => point.id === id);
      if (index < 0) throw new Error('Rewind checkpoint not found');
      points[index]!.discardedOwners = [...new Set(points.slice(index).flatMap(point => [point.id, ...point.discardedOwners ?? []]))].filter(owner => owner !== id);
      await this.save(points.slice(0, index + 1), previous);
    });
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface UndoBefore { data: string; mode: number }
// Mode -1 is only valid for newly created files whose platform default is not yet known.
export interface UndoPlanEntry { path: string; before: UndoBefore | null; stages: { hash: string; mode: number }[] }
export interface UndoEntry { path: string; before: UndoBefore | null; afterHash: string; afterMode: number }
export interface UndoMetadata { owner?: string; owners?: string[]; sources?: string[]; sourceOutcomes?: Record<string, UndoEntry[]> }
export interface UndoBatch extends UndoMetadata { id: string; entries: UndoPlanEntry[]; committed?: UndoEntry[]; undoing?: UndoEntry[]; undone?: boolean }
const idPattern = /^\d{16}-[a-f0-9-]{36}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const validMode = (mode: unknown): mode is number => Number.isInteger(mode) && Number(mode) >= 0 && Number(mode) <= 0o7777;
const sameBefore = (a: UndoBefore | null, b: UndoBefore | null): boolean => a === null ? b === null : b !== null && a.data === b.data && a.mode === b.mode;
const sameEntries = (a: UndoEntry[], b: UndoEntry[]): boolean => a.length === b.length && a.every(entry => {
  const other = b.find(candidate => candidate.path === entry.path);
  return !!other && sameBefore(entry.before, other.before) && entry.afterHash === other.afterHash && entry.afterMode === other.afterMode;
});
function validateMetadata(value: UndoMetadata): void {
  if (value.owner !== undefined && (typeof value.owner !== 'string' || !value.owner.trim() || value.owner.length > 256 || /[\u0000-\u001f]/.test(value.owner))) throw new Error('Undo journal contains an invalid owner');
  if (value.sources !== undefined && (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 10000 || value.sources.some(id => typeof id !== 'string' || !idPattern.test(id)) || new Set(value.sources).size !== value.sources.length)) throw new Error('Undo journal contains invalid source batches');
  if (value.owners !== undefined && (!value.sources || !Array.isArray(value.owners) || !value.owners.length || value.owners.length > 10000 || new Set(value.owners).size !== value.owners.length || value.owners.some(owner => typeof owner !== 'string' || !owner.trim() || owner.length > 256 || /[\u0000-\u001f]/.test(owner)) || value.owner === undefined || !value.owners.includes(value.owner))) throw new Error('Undo journal contains invalid aggregate owners');
  if (value.sourceOutcomes !== undefined && (!value.sources || !value.sourceOutcomes || typeof value.sourceOutcomes !== 'object' || Array.isArray(value.sourceOutcomes) || Object.entries(value.sourceOutcomes).some(([id, entries]) => !value.sources!.includes(id) || !Array.isArray(entries) || entries.length > 100))) throw new Error('Undo journal contains invalid source outcomes');
}

/** Immutable write-ahead plans plus immutable outcomes; a crash can never erase the original bytes. */
export class UndoStore {
  constructor(private readonly workspace: string, private readonly directory: string) {}

  private async location(): Promise<{ directory: string; workspace: string }> {
    const workspace = await realpath(this.workspace);
    const identity = process.platform === 'win32' ? workspace.toLowerCase() : workspace;
    return { workspace, directory: join(this.directory, createHash('sha256').update(identity).digest('hex')) };
  }

  private async publish(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let published = false;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
      finally { await file.close(); }
      await link(temporary, path);
      published = true;
    } finally {
      // Cleanup cannot invalidate an already durable outcome or consumed-undo marker.
      await unlink(temporary).catch(error => { if (!missing(error) && !published) throw error; });
    }
  }

  async begin(entries: UndoPlanEntry[], metadata: UndoMetadata = {}): Promise<{ id: string; commit(entries: UndoEntry[]): Promise<void> }> {
    validateMetadata(metadata);
    const location = await this.location();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(location.directory, { recursive: true, mode: 0o700 });
    const names = await readdir(location.directory);
    const latestTime = names.reduce((latest, name) => /^\d{16}-.*\.plan\.json$/.test(name) ? Math.max(latest, Number(name.slice(0, 16))) : latest, 0);
    const id = `${String(Math.max(Date.now(), latestTime + 1)).padStart(16, '0')}-${randomUUID()}`;
    if (metadata.sources?.some(source => !names.includes(`${source}.plan.json`))) throw new Error('Undo source batch is missing');
    await this.publish(join(location.directory, `${id}.plan.json`), { version: 1, workspace: location.workspace, id, entries, ...structuredClone(metadata) });
    return { id, commit: async entries => {
      await this.publish(join(location.directory, `${id}.done.json`), { version: 1, workspace: location.workspace, id, entries });
    } };
  }

  private async read(path: string): Promise<Record<string, unknown> | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid record');
      return value as Record<string, unknown>;
    } catch (error) {
      if (missing(error)) return undefined;
      throw new Error(`Undo journal is corrupt or unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private validBefore(value: unknown): boolean {
    if (value === null) return true;
    if (!value || typeof value !== 'object') return false;
    const before = value as UndoBefore;
    return typeof before.data === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(before.data) &&
      validMode(before.mode);
  }

  private validateUndoing(entries: UndoEntry[], plan: UndoPlanEntry[], committed?: UndoEntry[]): void {
    if (!Array.isArray(entries) || !entries.length || entries.length > 100 || new Set(entries.map(entry => entry?.path)).size !== entries.length)
      throw new Error('Undo journal contains an invalid restore intent');
    for (const entry of entries) {
      if (!entry || typeof entry.path !== 'string' || !this.validBefore(entry.before) || !hashPattern.test(entry.afterHash) || !validMode(entry.afterMode))
        throw new Error('Undo journal contains an invalid restore snapshot');
      const original = plan.find(candidate => candidate.path === entry.path);
      if (!original || !sameBefore(original.before, entry.before) || !original.stages.some(stage => stage.hash === entry.afterHash && (stage.mode === -1 || stage.mode === entry.afterMode)))
        throw new Error('Undo restore intent does not match its write-ahead plan');
      if (committed) {
        const outcome = committed.find(candidate => candidate.path === entry.path);
        if (!outcome || !sameBefore(outcome.before, entry.before) || outcome.afterHash !== entry.afterHash || outcome.afterMode !== -1 && outcome.afterMode !== entry.afterMode)
          throw new Error('Undo restore intent does not match its committed outcome');
      }
    }
    if (committed && entries.length !== committed.length) throw new Error('Undo restore intent is missing committed file snapshots');
  }

  private validateSources(batch: UndoBatch, batches: Map<string, UndoBatch>): void {
    if (!batch.sources) return;
    const timelines = new Map<string, { entry: UndoPlanEntry; pending: boolean }[]>();
    for (const id of [...batch.sources].sort()) {
      const source = batches.get(id); if (!source) throw new Error('Undo source batch is missing');
      if (batch.owners && (source.owner === undefined || !batch.owners.includes(source.owner) || source.owners?.some(owner => !batch.owners!.includes(owner)))) throw new Error('Undo aggregate source owner does not match its approved owners');
      const proven = batch.sourceOutcomes?.[id];
      if (proven !== undefined) {
        if (source.committed !== undefined) throw new Error('Undo aggregate replaces a committed source outcome');
        if (proven.length) this.validateUndoing(proven, source.entries);
      }
      const actual = source.committed ?? proven;
      const entries: UndoPlanEntry[] = actual === undefined ? source.entries : actual.map(entry => ({ path: entry.path, before: entry.before, stages: [{ hash: entry.afterHash, mode: entry.afterMode }] }));
      for (const entry of entries) {
        const timeline = timelines.get(entry.path) ?? []; timeline.push({ entry, pending: actual === undefined }); timelines.set(entry.path, timeline);
      }
    }
    if (timelines.size !== batch.entries.length) throw new Error('Undo aggregate source paths do not match its restore plan');
    const beforeStage = (before: UndoBefore | null) => before === null ? undefined : { hash: createHash('sha256').update(Buffer.from(before.data, 'base64')).digest('hex'), mode: before.mode };
    const matches = (stages: UndoPlanEntry['stages'], target: { hash: string; mode: number } | undefined) => target !== undefined && stages.some(stage => stage.hash === target.hash && (stage.mode === -1 || target.mode === -1 || stage.mode === target.mode));
    for (const entry of batch.entries) {
      const timeline = timelines.get(entry.path);
      if (!timeline?.length || !sameBefore(entry.before, timeline[0]!.entry.before) || entry.stages.length !== 1) throw new Error('Undo aggregate original bytes do not match its source chain');
      for (let index = 0; index < timeline.length; index++) {
        const current = timeline[index]!; const next = timeline[index + 1];
        const target = next ? beforeStage(next.entry.before) : entry.stages[0];
        const unchanged = current.pending ? beforeStage(current.entry.before) : undefined;
        if (!matches(current.entry.stages, target) && !(unchanged && matches([unchanged], target))) throw new Error('Undo aggregate file states do not match its source chain');
      }
    }
  }

  async records(includeUndone = false): Promise<UndoBatch[]> {
    const location = await this.location();
    const names: string[] = await readdir(location.directory).catch(error => { if (missing(error)) return []; throw error; });
    const ids = [...new Set(names.filter(name => /\.(?:plan|undoing)\.json$/.test(name)).map(name => name.replace(/\.(?:plan|undoing)\.json$/, '')))].sort().reverse();
    const records: UndoBatch[] = [];
    for (const id of ids) {
      if (!idPattern.test(id)) throw new Error('Undo journal contains an invalid batch identity');
      const undone = await this.read(join(location.directory, `${id}.undone.json`));
      if (undone) {
        if (undone.version !== 1 || undone.id !== id || undone.workspace !== location.workspace) throw new Error('Undo journal contains an invalid completion marker');
      }
      const plan = await this.read(join(location.directory, `${id}.plan.json`));
      const done = await this.read(join(location.directory, `${id}.done.json`));
      const undoing = await this.read(join(location.directory, `${id}.undoing.json`));
      if (plan) {
        validateMetadata(plan as UndoMetadata);
        if ((plan.sources as string[] | undefined)?.some(source => source >= id || !names.includes(`${source}.plan.json`))) throw new Error('Undo journal contains an invalid source reference');
      }
      for (const record of [plan, ...(done ? [done] : []), ...(undoing ? [undoing] : [])]) {
        if (!record || record.version !== 1 || record.id !== id || record.workspace !== location.workspace || !Array.isArray(record.entries)) throw new Error('Undo journal contains an invalid batch');
        if (record.entries.length > 100) throw new Error('Undo journal batch exceeds its limit');
        for (const entry of record.entries as Record<string, unknown>[]) {
          if (!entry || typeof entry.path !== 'string' || !this.validBefore(entry.before)) throw new Error('Undo journal contains an invalid file snapshot');
          if (record !== plan) {
            if (typeof entry.afterHash !== 'string' || !hashPattern.test(entry.afterHash) || !(validMode(entry.afterMode) || record === done && entry.before === null && entry.afterMode === -1)) throw new Error('Undo journal contains an invalid resulting hash');
          } else if (!Array.isArray(entry.stages) || entry.stages.length > 100 || entry.stages.some(stage => !stage || typeof stage.hash !== 'string' || !hashPattern.test(stage.hash) || !(validMode(stage.mode) || entry.before === null && stage.mode === -1))) throw new Error('Undo journal contains an invalid write-ahead plan');
        }
        if (new Set((record.entries as { path: string }[]).map(entry => entry.path)).size !== record.entries.length) throw new Error('Undo journal contains duplicate file snapshots');
      }
      if (done) {
        for (const entry of done.entries as UndoEntry[]) {
          const original = (plan!.entries as UndoPlanEntry[]).find(candidate => candidate.path === entry.path);
          if (!original || !sameBefore(original.before, entry.before) || !original.stages.some(stage => stage.hash === entry.afterHash && (stage.mode === -1 || stage.mode === entry.afterMode))) throw new Error('Undo journal outcome does not match its write-ahead plan');
        }
      }
      if (undoing) this.validateUndoing(undoing.entries as UndoEntry[], plan!.entries as UndoPlanEntry[], done?.entries as UndoEntry[] | undefined);
      records.push({ id, entries: plan!.entries as UndoPlanEntry[], ...(plan!.owner !== undefined ? { owner: plan!.owner as string } : {}), ...(plan!.owners ? { owners: plan!.owners as string[] } : {}), ...(plan!.sources ? { sources: plan!.sources as string[] } : {}), ...(plan!.sourceOutcomes ? { sourceOutcomes: plan!.sourceOutcomes as Record<string, UndoEntry[]> } : {}), ...(done ? { committed: done.entries as UndoEntry[] } : {}), ...(undoing ? { undoing: undoing.entries as UndoEntry[] } : {}), ...(undone ? { undone: true } : {}) });
    }
    const batches = new Map(records.map(batch => [batch.id, batch]));
    for (const batch of records) this.validateSources(batch, batches);
    return includeUndone ? records : records.filter(batch => !batch.undone);
  }

  async markUndoing(id: string, entries: UndoEntry[]): Promise<void> {
    if (!idPattern.test(id)) throw new Error('Invalid undo batch identity');
    const batch = (await this.records()).find(record => record.id === id);
    if (!batch) throw new Error('Undo batch is no longer available');
    this.validateUndoing(entries, batch.entries, batch.committed);
    if (batch.undoing) {
      if (!sameEntries(entries, batch.undoing)) throw new Error('Undo restore intent changed since its preview');
      return;
    }
    const location = await this.location();
    try { await this.publish(join(location.directory, `${id}.undoing.json`), { version: 1, workspace: location.workspace, id, entries }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = (await this.records()).find(record => record.id === id)?.undoing;
      if (!existing || !sameEntries(entries, existing)) throw new Error('Undo restore intent changed since its preview');
    }
  }

  async markUndone(id: string): Promise<void> {
    if (!idPattern.test(id)) throw new Error('Invalid undo batch identity');
    const location = await this.location();
    const batches = new Map((await this.records(true)).map(batch => [batch.id, batch]));
    const pending: UndoBatch[] = []; const visited = new Set<string>();
    const visit = (identity: string): void => {
      if (visited.has(identity)) return; visited.add(identity);
      const batch = batches.get(identity); if (!batch) throw new Error('Undo source batch is missing');
      for (const source of batch.sources ?? []) visit(source);
      if (!batch.undone) pending.push(batch);
    };
    visit(id);
    // Source markers precede the aggregate marker, so interruption always leaves a resumable intent.
    for (const batch of pending) {
      try { await this.publish(join(location.directory, `${batch.id}.undone.json`), { version: 1, workspace: location.workspace, id: batch.id }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const marker = await this.read(join(location.directory, `${batch.id}.undone.json`));
        if (marker?.version !== 1 || marker.id !== batch.id || marker.workspace !== location.workspace) throw new Error('Undo journal contains an invalid completion marker');
      }
    }
  }
}

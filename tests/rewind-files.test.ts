import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FsTools } from '../src/tools/fs-tools.js';

const faults = vi.hoisted(() => ({ restore: '', marker: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (faults.restore === String(args[1])) { faults.restore = ''; throw new Error('Simulated restore failure'); }
      return fs.rename(...args);
    },
    link: async (...args: Parameters<typeof fs.link>) => {
      if (String(args[1]).endsWith('.undone.json') && faults.marker && --faults.marker === 0) throw new Error('Simulated marker publication failure');
      return fs.link(...args);
    },
  };
});
afterEach(() => { faults.restore = ''; faults.marker = 0; });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kairos-rewind-')); const journal = join(root, 'undo');
  const tools = new FsTools(root, undefined, { undoDirectory: journal });
  await writeFile(join(root, 'a'), 'one'); await writeFile(join(root, 'b'), 'old');
  return { root, journal, tools };
}
async function edit(tools: FsTools, owner: string, path: string, before: string, after: string) {
  tools.setUndoOwner(owner); const result=await tools.apply_edits_batch([{ path, old_text: before, new_text: after }]);expect(result,JSON.stringify(result)).toMatchObject([{ ok: true }]);
}

it('restores a complete multi-turn range across restart, collapsing repeated paths and removing created files', async () => {
  const { root, journal, tools } = await fixture();
  await edit(tools, 'first', 'a', 'one', 'two'); await edit(tools, 'first', 'created', '', 'new');
  await edit(tools, 'second', 'a', 'two', 'three'); await edit(tools, 'second', 'b', 'old', 'new');
  const reopened = new FsTools(root, undefined, { undoDirectory: journal }); const prepared = await reopened.prepare_rewind(['first', 'second']);
  expect(prepared.preview.every(result => result.ok)).toBe(true); expect(prepared.paths?.sort()).toEqual(['a', 'b', 'created']);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('three'); expect((await prepared.apply()).every(result => result.ok)).toBe(true);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('one'); expect(await readFile(join(root, 'b'), 'utf8')).toBe('old');
  await expect(readFile(join(root, 'created'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await reopened.previewUndo()).toEqual([]); expect((await prepared.apply()).every(result => !result.ok)).toBe(true);
});

it('refuses the entire range when human or another session changes any affected file', async () => {
  const { root, tools } = await fixture();
  await edit(tools, 'mine', 'a', 'one', 'two'); await edit(tools, 'mine', 'b', 'old', 'new');
  await writeFile(join(root, 'a'), 'human');
  expect((await tools.prepare_rewind(['mine'])).preview.some(result => !result.ok)).toBe(true);
  expect(await readFile(join(root, 'b'), 'utf8')).toBe('new');
  await writeFile(join(root, 'a'), 'two'); await edit(tools, 'other-session', 'a', 'two', 'other'); await edit(tools, 'mine', 'a', 'other', 'latest');
  expect((await tools.prepare_rewind(['mine'])).preview.some(result => !result.ok)).toBe(true);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('latest'); expect(await readFile(join(root, 'b'), 'utf8')).toBe('new');
});

it('skips explicitly undone batches and refuses a stale preview before touching any target', async () => {
  const { root, tools } = await fixture(); await edit(tools, 'first', 'a', 'one', 'two'); await edit(tools, 'second', 'a', 'two', 'three');
  expect((await tools.undoLast()).every(result => result.ok)).toBe(true);
  const prepared = await tools.prepare_rewind(['first', 'second']); await writeFile(join(root, 'a'), 'human');
  expect((await prepared.apply()).every(result => !result.ok)).toBe(true); expect(await readFile(join(root, 'a'), 'utf8')).toBe('human');
  await writeFile(join(root, 'a'), 'two'); expect((await (await tools.prepare_rewind(['first', 'second'])).apply()).every(result => result.ok)).toBe(true);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('one');
});

it('rolls back a failed restore and resumes its immutable range intent after reopening', async () => {
  const { root, journal, tools } = await fixture(); await edit(tools, 'turn', 'a', 'one', 'two'); await edit(tools, 'turn', 'b', 'old', 'new');
  const prepared = await tools.prepare_rewind(['turn']); faults.restore = join(root, prepared.preview[1]!.path);
  expect((await prepared.apply()).every(result => !result.ok)).toBe(true);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('two'); expect(await readFile(join(root, 'b'), 'utf8')).toBe('new');
  const reopened = new FsTools(root, undefined, { undoDirectory: journal });
  expect((await (await reopened.prepare_rewind(['turn'])).apply()).every(result => result.ok)).toBe(true);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('one'); expect(await reopened.previewUndo()).toEqual([]);
});

it('recovers interrupted source-marker publication without replaying consumed source edits', async () => {
  const { root, journal, tools } = await fixture(); await edit(tools, 'turn', 'a', 'one', 'two'); await edit(tools, 'turn', 'b', 'old', 'new');
  faults.marker = 2; expect((await (await tools.prepare_rewind(['turn'])).apply()).every(result => !result.ok)).toBe(true);
  const reopened = new FsTools(root, undefined, { undoDirectory: journal });
  expect((await (await reopened.prepare_rewind(['turn'])).apply()).every(result => result.ok)).toBe(true);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('one'); expect(await readFile(join(root, 'b'), 'utf8')).toBe('old');
  expect(await reopened.previewUndo()).toEqual([]);
});

it('rejects malformed owner metadata and binds approval paths to canonical targets', async () => {
  const { root, journal, tools } = await fixture(); await mkdir(join(root, 'dir'));
  const prepared = await tools.prepare_edits_batch([{ path: 'dir/../a', old_text: 'one', new_text: 'two' }]); expect(prepared.paths).toEqual(['a']);
  tools.setUndoOwner('turn'); await prepared.apply();
  const directory = join(journal, (await readdir(journal))[0]!); const name = (await readdir(directory)).find(name => name.endsWith('.plan.json'))!;
  const plan = JSON.parse(await readFile(join(directory, name), 'utf8')); plan.owner = { invalid: true }; await writeFile(join(directory, name), JSON.stringify(plan));
  expect((await tools.prepare_rewind(['turn'])).preview.some(result => !result.ok)).toBe(true);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('two');
});

it('refuses a new journaled batch created during approval even if the previewed files are untouched', async () => {
  const { root, journal, tools } = await fixture(); await edit(tools, 'mine', 'a', 'one', 'two');
  const prepared = await tools.prepare_rewind(['mine']); const another = new FsTools(root, undefined, { undoDirectory: journal });
  await edit(another, 'other', 'b', 'old', 'new');
  expect((await prepared.apply()).every(result => !result.ok)).toBe(true);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('two'); expect(await readFile(join(root, 'b'), 'utf8')).toBe('new');
});

it('recovers an uncommitted write-ahead range only when the exact recorded final state is provable', async () => {
  const { root, journal, tools } = await fixture(); await edit(tools, 'mine', 'a', 'one', 'two');
  const directory = join(journal, (await readdir(journal))[0]!); const done = (await readdir(directory)).find(name => name.endsWith('.done.json'))!;
  await unlink(join(directory, done)); const reopened = new FsTools(root, undefined, { undoDirectory: journal });
  expect((await (await reopened.prepare_rewind(['mine'])).apply()).every(result => result.ok)).toBe(true);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('one');
});

it('preserves original mode and refuses changed modes or junction targets before restoring any file', async () => {
  const { root, tools } = await fixture(); await chmod(join(root, 'a'), 0o600); const mode = (await lstat(join(root, 'a'))).mode & 0o7777;
  await edit(tools, 'turn', 'a', 'one', 'two'); await edit(tools, 'turn', 'b', 'old', 'new');
  await chmod(join(root, 'a'), mode ^ 0o200);
  expect((await tools.prepare_rewind(['turn'])).preview.some(result => !result.ok)).toBe(true); expect(await readFile(join(root, 'b'), 'utf8')).toBe('new');
  await chmod(join(root, 'a'), mode); expect((await (await tools.prepare_rewind(['turn'])).apply()).every(result => result.ok)).toBe(true);
  expect((await lstat(join(root, 'a'))).mode & 0o7777).toBe(mode);
  await mkdir(join(root, 'nested')); await edit(tools, 'next', 'nested/file', '', 'agent');
  await mkdir(join(root, 'elsewhere')); await writeFile(join(root, 'elsewhere/file'), 'agent');
  await unlink(join(root, 'nested/file')); const { rmdir } = await import('node:fs/promises'); await rmdir(join(root, 'nested'));
  await symlink(join(root, 'elsewhere'), join(root, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  expect((await tools.prepare_rewind(['next'])).preview.some(result => !result.ok)).toBe(true); expect(await readFile(join(root, 'elsewhere/file'), 'utf8')).toBe('agent');
});

it('keeps unrelated sessions on separate files and refuses a tampered source reference', async () => {
  const { root, journal, tools } = await fixture(); await edit(tools, 'mine', 'a', 'one', 'two'); await edit(tools, 'other', 'b', 'old', 'new');
  expect((await (await tools.prepare_rewind(['mine'])).apply()).every(result => result.ok)).toBe(true);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('one'); expect(await readFile(join(root, 'b'), 'utf8')).toBe('new');
  await edit(tools, 'mine-again', 'a', 'one', 'two');
  const directory = join(journal, (await readdir(journal))[0]!); const name = (await readdir(directory)).filter(name => name.endsWith('.plan.json')).sort().at(-1)!;
  const plan = JSON.parse(await readFile(join(directory, name), 'utf8')); plan.sources = [plan.id]; await writeFile(join(directory, name), JSON.stringify(plan));
  expect((await tools.prepare_rewind(['mine-again'])).preview.some(result => !result.ok)).toBe(true);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('two');
});

it('proves an earlier uncommitted outcome from the next selected before snapshot across restart', async () => {
  const { root, journal, tools } = await fixture(); await edit(tools, 'first', 'a', 'one', 'two');
  const directory = join(journal, (await readdir(journal))[0]!); const firstDone = (await readdir(directory)).find(name => name.endsWith('.done.json'))!;
  await unlink(join(directory, firstDone)); await edit(tools, 'second', 'a', 'two', 'three');
  const reopened = new FsTools(root, undefined, { undoDirectory: journal }); const prepared = await reopened.prepare_rewind(['first', 'second']);
  expect(prepared.preview).toMatchObject([{ path: 'a', ok: true }]);
  expect((await prepared.apply()).every(result => result.ok)).toBe(true); expect(await readFile(join(root, 'a'), 'utf8')).toBe('one');
  expect(await reopened.previewUndo()).toEqual([]);
});

it('refuses an uncommitted source whose next before snapshot does not match a recorded stage', async () => {
  const { root, journal, tools } = await fixture(); await edit(tools, 'first', 'a', 'one', 'two');
  const directory = join(journal, (await readdir(journal))[0]!); const firstDone = (await readdir(directory)).find(name => name.endsWith('.done.json'))!;
  await unlink(join(directory, firstDone)); await writeFile(join(root, 'a'), 'human'); await edit(tools, 'second', 'a', 'human', 'three');
  expect((await tools.prepare_rewind(['first', 'second'])).preview.some(result => !result.ok)).toBe(true);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('three');
});

it.each(['undo', 'rewind'])('detects corrupt consumed history before %s changes file identity', async operation => {
  const { root, journal, tools } = await fixture(); await edit(tools, 'past', 'a', 'one', 'two');
  const directory = join(journal, (await readdir(journal))[0]!); const past = (await readdir(directory)).find(name => name.endsWith('.plan.json'))!;
  expect((await tools.undoLast()).every(result => result.ok)).toBe(true); await writeFile(join(directory, past), '{ broken');
  await edit(tools, 'current', 'b', 'old', 'new'); const before = await lstat(join(root, 'b'));
  const prepared = operation === 'undo' ? await tools.prepare_undo() : await tools.prepare_rewind(['current']);
  const results = await prepared.apply(); expect(results.some(result => !result.ok)).toBe(true);
  expect(results.some(result => !result.ok && result.mutated)).toBe(false);
  const after = await lstat(join(root, 'b')); expect(after.ino).toBe(before.ino); expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(await readFile(join(root, 'b'), 'utf8')).toBe('new');
});

it.each([false, true])('rejects appended unrelated aggregate source before effects (expanded owners=%s)', async expandOwners => {
  const { root, journal, tools } = await fixture(); await edit(tools, 'other', 'b', 'old', 'new'); await edit(tools, 'mine', 'a', 'one', 'two');
  faults.restore = join(root, 'a'); expect((await (await tools.prepare_rewind(['mine'])).apply()).every(result => !result.ok)).toBe(true);
  const directory = join(journal, (await readdir(journal))[0]!);
  const plans = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.plan.json')).map(async name => ({ name, plan: JSON.parse(await readFile(join(directory, name), 'utf8')) })));
  const other = plans.find(({ plan }) => plan.owner === 'other')!; const aggregate = plans.find(({ plan }) => plan.sources)!;
  aggregate.plan.sources.push(other.plan.id); if (expandOwners) aggregate.plan.owners = ['mine', 'other'];
  await writeFile(join(directory, aggregate.name), JSON.stringify(aggregate.plan)); const before = await lstat(join(root, 'a'));
  const reopened = new FsTools(root, undefined, { undoDirectory: journal }); const prepared = await reopened.prepare_rewind(['mine']);
  expect(prepared.preview.some(result => !result.ok)).toBe(true); expect((await prepared.apply()).every(result => !result.ok)).toBe(true);
  expect((await lstat(join(root, 'a'))).ino).toBe(before.ino); expect(await readFile(join(root, 'a'), 'utf8')).toBe('two');
  expect(await readFile(join(root, 'b'), 'utf8')).toBe('new');
  await expect(readFile(join(directory, `${other.plan.id}.undone.json`))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('persists inferred outcomes for multiple pending sources and skips proven unchanged partial-batch files', async () => {
  const { root, journal, tools } = await fixture(); tools.setUndoOwner('first'); faults.restore = join(root, 'b');
  expect((await tools.apply_edits_batch([{ path: 'a', old_text: 'one', new_text: 'two' }, { path: 'b', old_text: 'old', new_text: 'new' }])).map(result => result.ok)).toEqual([true, false]);
  const directory = join(journal, (await readdir(journal))[0]!); const first = (await readdir(directory)).find(name => name.endsWith('.done.json'))!; await unlink(join(directory, first));
  await edit(tools, 'second', 'a', 'two', 'three'); const second = (await readdir(directory)).find(name => name.endsWith('.done.json'))!; await unlink(join(directory, second));
  await edit(tools, 'third', 'a', 'three', 'four');
  const prepared = await tools.prepare_rewind(['first', 'second', 'third']); expect(prepared.preview).toMatchObject([{ path: 'a', ok: true }]);
  faults.restore = join(root, 'a'); expect((await prepared.apply()).every(result => !result.ok)).toBe(true);
  const reopened = new FsTools(root, undefined, { undoDirectory: journal }); const recovered = await reopened.prepare_rewind(['first', 'second', 'third']);
  expect(recovered.preview).toMatchObject([{ path: 'a', ok: true }]); expect((await recovered.apply()).every(result => result.ok)).toBe(true);
  expect(await readFile(join(root, 'a'), 'utf8')).toBe('one'); expect(await readFile(join(root, 'b'), 'utf8')).toBe('old'); expect(await reopened.previewUndo()).toEqual([]);
});

it('detects consumed-history corruption introduced during approval before changing any target', async () => {
  const { root, journal, tools } = await fixture(); await edit(tools, 'past', 'a', 'one', 'two');
  const directory = join(journal, (await readdir(journal))[0]!); const past = (await readdir(directory)).find(name => name.endsWith('.plan.json'))!;
  expect((await tools.undoLast()).every(result => result.ok)).toBe(true); await edit(tools, 'current', 'b', 'old', 'new');
  const prepared = await tools.prepare_rewind(['current']); const before = await lstat(join(root, 'b')); await writeFile(join(directory, past), '{ broken');
  expect((await prepared.apply()).every(result => !result.ok && !result.mutated)).toBe(true);
  const after = await lstat(join(root, 'b')); expect(after.ino).toBe(before.ino); expect(after.mtimeMs).toBe(before.mtimeMs); expect(await readFile(join(root, 'b'), 'utf8')).toBe('new');
});

it('refuses a tampered inferred source outcome before resuming an aggregate restore', async () => {
  const { root, journal, tools } = await fixture(); await edit(tools, 'first', 'a', 'one', 'two');
  const directory = join(journal, (await readdir(journal))[0]!); const first = (await readdir(directory)).find(name => name.endsWith('.done.json'))!; await unlink(join(directory, first));
  await edit(tools, 'second', 'a', 'two', 'three'); faults.restore = join(root, 'a'); expect((await (await tools.prepare_rewind(['first', 'second'])).apply()).every(result => !result.ok)).toBe(true);
  const plans = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.plan.json')).map(async name => ({ name, plan: JSON.parse(await readFile(join(directory, name), 'utf8')) })));
  const aggregate = plans.find(({ plan }) => plan.sourceOutcomes)!; const entries = Object.values(aggregate.plan.sourceOutcomes)[0] as { afterHash: string }[]; entries[0]!.afterHash = '0'.repeat(64);
  await writeFile(join(directory, aggregate.name), JSON.stringify(aggregate.plan)); const before = await lstat(join(root, 'a'));
  expect((await tools.prepare_rewind(['first', 'second'])).preview.some(result => !result.ok)).toBe(true); expect((await lstat(join(root, 'a'))).ino).toBe(before.ino); expect(await readFile(join(root, 'a'), 'utf8')).toBe('three');
});

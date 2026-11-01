import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FsTools } from '../src/tools/fs-tools.js';

const failures = vi.hoisted(() => ({ plan: false, commit: false, undoing: false, undoingSync: false, renameTarget: '', snapshotTarget: '', readTarget: '', undoCleanup: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (failures.undoingSync && String(args[0]).includes('.undoing.json.')) {
        handle.sync = async () => { failures.undoingSync = false; throw new Error('Simulated undo intent sync failure'); };
      }
      return handle;
    },
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (failures.readTarget === String(args[0])) { failures.readTarget = ''; throw new Error('Simulated post-write snapshot failure'); }
      return fs.readFile(...args);
    },
    link: async (...args: Parameters<typeof fs.link>) => {
      if (failures.plan && String(args[1]).endsWith('.plan.json') || failures.commit && String(args[1]).endsWith('.done.json') || failures.undoing && String(args[1]).endsWith('.undoing.json')) {
        failures.plan = false; failures.commit = false; failures.undoing = false; throw new Error('Simulated journal failure');
      }
      await fs.link(...args);
      if (failures.snapshotTarget === String(args[1])) { failures.readTarget = failures.snapshotTarget; failures.snapshotTarget = ''; }
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (failures.renameTarget && String(args[1]) === failures.renameTarget) { failures.renameTarget = ''; throw new Error('Simulated rename failure'); }
      await fs.rename(...args);
      if (failures.snapshotTarget === String(args[1])) { failures.readTarget = failures.snapshotTarget; failures.snapshotTarget = ''; }
    },
    unlink: async (...args: Parameters<typeof fs.unlink>) => {
      if (failures.undoCleanup && String(args[0]).includes('.undone.json.')) { failures.undoCleanup = false; throw new Error('Simulated journal staging cleanup failure'); }
      return fs.unlink(...args);
    },
  };
});
afterEach(() => { failures.plan = false; failures.commit = false; failures.undoing = false; failures.undoingSync = false; failures.renameTarget = ''; failures.snapshotTarget = ''; failures.readTarget = ''; failures.undoCleanup = false; });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kairos-undo-'));
  const journal = await mkdtemp(join(tmpdir(), 'kairos-journal-'));
  return { root, journal, tools: new FsTools(root, undefined, { undoDirectory: journal }) };
}

async function interruptedIntent(journal: string) {
  const directory = join(journal, (await readdir(journal))[0]!);
  const name = (await readdir(directory)).find(name => name.endsWith('.done.json'))!;
  const record = JSON.parse(await readFile(join(directory, name), 'utf8'));
  const path = join(directory, name.replace('.done.json', '.undoing.json'));
  return { directory, record, path, undone: join(directory, name.replace('.done.json', '.undone.json')) };
}
it('durably restores existing bytes/mode and explicitly removes new files, aggregating repeated paths', async () => {
  const { root, journal, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one'); await chmod(join(root, 'a.txt'), 0o600);
  const mode = (await lstat(join(root, 'a.txt'))).mode & 0o777;
  const results = await tools.apply_edits_batch([
    { path: 'a.txt', old_text: 'one', new_text: 'two' },
    { path: 'a.txt', old_text: 'two', new_text: 'three' },
    { path: 'new.txt', old_text: '', new_text: 'new' },
  ]);
  expect(results.every(result => result.ok)).toBe(true);
  const reopened = new FsTools(root, undefined, { undoDirectory: journal });
  const preview = await reopened.previewUndo();
  expect(preview.map(result => result.path).sort()).toEqual(['a.txt', 'new.txt']);
  expect(preview.every(result => result.ok && !!result.diff)).toBe(true);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('three');
  expect((await reopened.undoLast()).every(result => result.ok)).toBe(true);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one');
  expect((await lstat(join(root, 'a.txt'))).mode & 0o777).toBe(mode);
  expect(await readdir(root)).toEqual(['a.txt']);
  expect(await reopened.previewUndo()).toEqual([]);
});

it('preserves file permissions even when the process umask would remove existing bits', async () => {
  const { root, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one'); await chmod(join(root, 'a.txt'), 0o666);
  const original = (await lstat(join(root, 'a.txt'))).mode & 0o777;
  const previous = process.umask(0o077);
  try {
    await tools.apply_edits_batch([{ path: 'a.txt', old_text: 'one', new_text: 'two' }]);
    expect((await lstat(join(root, 'a.txt'))).mode & 0o777).toBe(original);
    expect((await tools.undoLast()).every(result => result.ok)).toBe(true);
    expect((await lstat(join(root, 'a.txt'))).mode & 0o777).toBe(original);
  } finally { process.umask(previous); }
});

it('journals successful paths in a partial batch and isolates other workspaces', async () => {
  const { root, journal, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one');
  expect((await tools.apply_edits_batch([
    { path: 'a.txt', old_text: 'one', new_text: 'two' },
    { path: 'missing.txt', old_text: 'missing', new_text: 'no' },
    { path: 'a.txt', old_text: 'missing', new_text: 'no' },
  ])).map(result => result.ok)).toEqual([true, false, false]);
  const other = await mkdtemp(join(tmpdir(), 'kairos-other-'));
  expect(await new FsTools(other, undefined, { undoDirectory: journal }).previewUndo()).toEqual([]);
  expect((await tools.undoLast()).map(result => result.path)).toEqual(['a.txt']);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one');
});

it('refuses the whole undo if a human changed one of the files', async () => {
  const { root, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one'); await writeFile(join(root, 'b.txt'), 'two');
  await tools.apply_edits_batch([
    { path: 'a.txt', old_text: 'one', new_text: 'three' },
    { path: 'b.txt', old_text: 'two', new_text: 'four' },
  ]);
  await writeFile(join(root, 'b.txt'), 'human');
  const results = await tools.undoLast();
  expect(results.every(result => !result.ok)).toBe(true);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('three');
  expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('human');
});

it('binds undo approval to its batch and refuses a newer batch created during approval', async () => {
  const { root, journal, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one'); await writeFile(join(root, 'b.txt'), 'two');
  await tools.apply_edits_batch([{ path: 'a.txt', old_text: 'one', new_text: 'three' }]);
  const prepared = await tools.prepare_undo();
  const other = new FsTools(root, undefined, { undoDirectory: journal });
  await other.apply_edits_batch([{ path: 'b.txt', old_text: 'two', new_text: 'four' }]);
  expect((await prepared.apply()).every(result => !result.ok)).toBe(true);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('three');
  expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('four');
});

it('makes no edits if the write-ahead journal cannot be saved', async () => {
  const { root, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one'); failures.plan = true;
  expect((await tools.apply_edits_batch([{ path: 'a.txt', old_text: 'one', new_text: 'two' }]))[0]?.ok).toBe(false);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one');
  expect(await tools.previewUndo()).toEqual([]);
});

it('recovers an interrupted outcome from its durable write-ahead plan after reopening', async () => {
  const { root, journal, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one'); failures.commit = true;
  expect((await tools.apply_edits_batch([
    { path: 'a.txt', old_text: 'one', new_text: 'two' },
    { path: 'new.txt', old_text: '', new_text: 'new' },
  ])).every(result => result.ok)).toBe(true);
  const reopened = new FsTools(root, undefined, { undoDirectory: journal });
  expect((await reopened.undoLast()).every(result => result.ok)).toBe(true);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one');
  expect(await readdir(root)).toEqual(['a.txt']);
});

it('retains recovery when the edit succeeds but reading its resulting snapshot fails', async () => {
  const { root, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one'); failures.snapshotTarget = join(root, 'a.txt');
  const results = await tools.apply_edits_batch([{ path: 'a.txt', old_text: 'one', new_text: 'two' }]);
  expect(results[0]).toMatchObject({ ok: false, mutated: true });
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('two');
  expect((await tools.undoLast()).map(result => result.path)).toEqual(['a.txt']);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one');
});

it('retains removal recovery when creating a file succeeds but its resulting snapshot fails', async () => {
  const { root, tools } = await fixture();
  failures.snapshotTarget = join(root, 'new.txt');
  expect((await tools.apply_edits_batch([{ path: 'new.txt', old_text: '', new_text: '' }]))[0]).toMatchObject({ ok: false, mutated: true });
  expect(await readdir(root)).toEqual(['new.txt']);
  expect((await tools.undoLast()).every(result => result.ok)).toBe(true);
  expect(await readdir(root)).toEqual([]);
});

it('journals only effects that succeeded when a later file rename fails', async () => {
  const { root, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one'); await writeFile(join(root, 'b.txt'), 'two');
  failures.renameTarget = join(root, 'b.txt');
  expect((await tools.apply_edits_batch([
    { path: 'a.txt', old_text: 'one', new_text: 'three' },
    { path: 'b.txt', old_text: 'two', new_text: 'four' },
  ])).map(result => result.ok)).toEqual([true, false]);
  expect((await tools.undoLast()).map(result => result.path)).toEqual(['a.txt']);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one');
  expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('two');
});

it('restores original binary bytes rather than a UTF-8 approximation', async () => {
  const { root, tools } = await fixture();
  const original = Buffer.from([0xff, 0x00, 0x6f, 0x6e, 0x65]);
  await writeFile(join(root, 'a.txt'), original);
  await tools.apply_edits_batch([{ path: 'a.txt', old_text: 'one', new_text: 'two' }]);
  expect((await tools.undoLast()).every(result => result.ok)).toBe(true);
  expect(await readFile(join(root, 'a.txt'))).toEqual(original);
});

it('keeps a successfully published undo result when staging cleanup fails', async () => {
  const { root, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one');
  await tools.apply_edits_batch([{ path: 'a.txt', old_text: 'one', new_text: 'two' }]);
  failures.undoCleanup = true;
  expect((await tools.undoLast()).every(result => result.ok)).toBe(true);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one');
  expect(await tools.previewUndo()).toEqual([]);
});

it('rolls back an incomplete restore when a later atomic rename fails', async () => {
  const { root, journal, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one'); await writeFile(join(root, 'b.txt'), 'two');
  await tools.apply_edits_batch([
    { path: 'a.txt', old_text: 'one', new_text: 'three' },
    { path: 'b.txt', old_text: 'two', new_text: 'four' },
  ]);
  failures.renameTarget = join(root, 'b.txt');
  expect((await tools.undoLast()).every(result => !result.ok && result.mutated === true)).toBe(true);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('three');
  expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('four');
  const intent = await interruptedIntent(journal);
  expect(JSON.parse(await readFile(intent.path, 'utf8')).entries).toHaveLength(2);
  const reopened = new FsTools(root, undefined, { undoDirectory: journal });
  expect((await reopened.undoLast()).every(result => result.ok)).toBe(true);
});

it.each(['undoing', 'undoingSync'] as const)('persists undo intent before restoring any file and leaves edited bytes intact if %s fails', async stage => {
  const { root, journal, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one');
  await tools.apply_edits_batch([{ path: 'a.txt', old_text: 'one', new_text: 'two' }]);
  const intent = await interruptedIntent(journal);
  const prepared = await tools.prepare_undo();
  await expect(readFile(intent.path)).rejects.toMatchObject({ code: 'ENOENT' });
  failures[stage] = true;
  expect((await prepared.apply()).every(result => !result.ok && !result.mutated)).toBe(true);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('two');
  await expect(readFile(intent.path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await prepared.apply()).every(result => !result.ok)).toBe(true);
  expect((await new FsTools(root, undefined, { undoDirectory: journal }).undoLast()).every(result => result.ok)).toBe(true);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one');
});

it('recovers interrupted undo from its write-ahead plan even when no committed outcome was published', async () => {
  const { root, journal, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one'); await writeFile(join(root, 'b.txt'), 'two');
  failures.commit = true;
  expect((await tools.apply_edits_batch([
    { path: 'a.txt', old_text: 'one', new_text: 'three' },
    { path: 'b.txt', old_text: 'two', new_text: 'four' },
  ])).every(result => result.ok)).toBe(true);
  const directory = join(journal, (await readdir(journal))[0]!);
  const name = (await readdir(directory)).find(name => name.endsWith('.plan.json'))!;
  const plan = JSON.parse(await readFile(join(directory, name), 'utf8'));
  await writeFile(join(directory, name.replace('.plan.json', '.undoing.json')), JSON.stringify({
    ...plan, entries: plan.entries.map((entry: { path: string; before: { data: string; mode: number }; stages: { hash: string }[] }) => ({
      path: entry.path, before: entry.before, afterHash: entry.stages.at(-1)!.hash, afterMode: entry.before.mode,
    })),
  }));
  await writeFile(join(root, 'a.txt'), 'one');
  const reopened = new FsTools(root, undefined, { undoDirectory: journal });
  expect((await reopened.undoLast()).every(result => result.ok)).toBe(true);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one');
  expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('two');
  expect(await reopened.previewUndo()).toEqual([]);
});

it('resumes a partial undo after reopening while preserving already-restored files', async () => {
  const { root, journal, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one'); await writeFile(join(root, 'b.txt'), 'two');
  await tools.apply_edits_batch([
    { path: 'a.txt', old_text: 'one', new_text: 'three' },
    { path: 'new.txt', old_text: '', new_text: 'created' },
    { path: 'b.txt', old_text: 'two', new_text: 'four' },
  ]);
  const intent = await interruptedIntent(journal);
  await writeFile(intent.path, JSON.stringify(intent.record));
  await writeFile(join(root, 'a.txt'), 'one');
  await chmod(join(root, 'a.txt'), intent.record.entries[0].before.mode);
  await unlink(join(root, 'new.txt'));
  const restored = await lstat(join(root, 'a.txt'));
  const reopened = new FsTools(root, undefined, { undoDirectory: journal });
  const prepared = await reopened.prepare_undo();
  expect(prepared.preview.every(result => result.ok)).toBe(true);
  expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('four');
  await expect(readFile(intent.undone)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await prepared.apply()).every(result => result.ok)).toBe(true);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one');
  expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('two');
  const after = await lstat(join(root, 'a.txt'));
  expect([after.ino, after.mtimeMs, after.mode]).toEqual([restored.ino, restored.mtimeMs, restored.mode]);
  expect(await readdir(root)).toEqual(['a.txt', 'b.txt']);
  expect((await prepared.apply()).every(result => !result.ok)).toBe(true);
  expect(await reopened.previewUndo()).toEqual([]);
});

it('finalizes an already-complete interrupted undo without rewriting files or changing the immutable intent', async () => {
  const { root, journal, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one');
  await tools.apply_edits_batch([
    { path: 'a.txt', old_text: 'one', new_text: 'two' },
    { path: 'new.txt', old_text: '', new_text: 'created' },
  ]);
  const intent = await interruptedIntent(journal);
  const originalIntent = JSON.stringify(intent.record);
  await writeFile(intent.path, originalIntent);
  await writeFile(join(root, 'a.txt'), 'one');
  await chmod(join(root, 'a.txt'), intent.record.entries[0].before.mode);
  await unlink(join(root, 'new.txt'));
  const before = await lstat(join(root, 'a.txt'));
  const reopened = new FsTools(root, undefined, { undoDirectory: journal });
  expect((await reopened.undoLast()).every(result => result.ok)).toBe(true);
  const after = await lstat(join(root, 'a.txt'));
  expect([after.ino, after.mtimeMs, after.mode]).toEqual([before.ino, before.mtimeMs, before.mode]);
  expect(await readFile(intent.path, 'utf8')).toBe(originalIntent);
  expect(JSON.parse(await readFile(intent.undone, 'utf8')).id).toBe(intent.record.id);
  expect(await reopened.previewUndo()).toEqual([]);
});

it.each(['workspace', 'id', 'before', 'after', 'mode', 'missing', 'path'] as const)
('refuses tampered undo intent %s before touching remaining files', async field => {
  const { root, journal, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one'); await writeFile(join(root, 'b.txt'), 'two');
  await tools.apply_edits_batch([
    { path: 'a.txt', old_text: 'one', new_text: 'three' },
    { path: 'b.txt', old_text: 'two', new_text: 'four' },
  ]);
  const intent = await interruptedIntent(journal);
  const record = structuredClone(intent.record);
  if (field === 'workspace') record.workspace += '-other';
  if (field === 'id') record.id = '0000000000000000-00000000-0000-0000-0000-000000000000';
  if (field === 'before') record.entries[0].before.data = Buffer.from('tampered').toString('base64');
  if (field === 'after') record.entries[0].afterHash = '0'.repeat(64);
  if (field === 'mode') record.entries[0].afterMode = -1;
  if (field === 'missing') record.entries.pop();
  if (field === 'path') record.entries[0].path = 'not-in-plan.txt';
  await writeFile(intent.path, JSON.stringify(record));
  const reopened = new FsTools(root, undefined, { undoDirectory: journal });
  expect((await reopened.undoLast()).some(result => !result.ok)).toBe(true);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('three');
  expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('four');
  await expect(readFile(intent.undone)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preflights every interrupted-undo file and refuses any state other than the exact before or after bytes and mode', async () => {
  const { root, journal, tools } = await fixture();
  await writeFile(join(root, 'a.txt'), 'one'); await writeFile(join(root, 'b.txt'), 'two');
  await tools.apply_edits_batch([
    { path: 'a.txt', old_text: 'one', new_text: 'three' },
    { path: 'b.txt', old_text: 'two', new_text: 'four' },
  ]);
  const intent = await interruptedIntent(journal);
  await writeFile(intent.path, JSON.stringify(intent.record));
  await writeFile(join(root, 'b.txt'), 'human');
  expect((await new FsTools(root, undefined, { undoDirectory: journal }).undoLast()).some(result => !result.ok)).toBe(true);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('three');
  expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('human');
  await writeFile(join(root, 'b.txt'), 'two');
  await chmod(join(root, 'b.txt'), 0o444);
  expect((await new FsTools(root, undefined, { undoDirectory: journal }).undoLast()).some(result => !result.ok)).toBe(true);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('three');
});

it('refuses a restore through a replaced symlink directory and leaves outside files untouched', async () => {
  const { root, tools } = await fixture();
  await mkdir(join(root, 'folder')); await writeFile(join(root, 'folder/a.txt'), 'one');
  await tools.apply_edits_batch([{ path: 'folder/a.txt', old_text: 'one', new_text: 'two' }]);
  const outside = await mkdtemp(join(tmpdir(), 'kairos-undo-outside-'));
  await writeFile(join(outside, 'a.txt'), 'two');
  await rename(join(root, 'folder'), join(root, 'moved'));
  await symlink(outside, join(root, 'folder'), process.platform === 'win32' ? 'junction' : 'dir');
  expect((await tools.undoLast()).every(result => !result.ok)).toBe(true);
  expect(await readFile(join(outside, 'a.txt'), 'utf8')).toBe('two');
  expect(await readFile(join(root, 'moved/a.txt'), 'utf8')).toBe('two');
});

it('refuses a restore through a directory symlink even when its target remains inside the workspace', async () => {
  const { root, tools } = await fixture();
  await mkdir(join(root, 'folder')); await writeFile(join(root, 'folder/a.txt'), 'one');
  await tools.apply_edits_batch([{ path: 'folder/a.txt', old_text: 'one', new_text: 'two' }]);
  await rename(join(root, 'folder'), join(root, 'moved'));
  await symlink(join(root, 'moved'), join(root, 'folder'), process.platform === 'win32' ? 'junction' : 'dir');
  expect((await tools.undoLast()).every(result => !result.ok)).toBe(true);
  expect(await readFile(join(root, 'moved/a.txt'), 'utf8')).toBe('two');
});

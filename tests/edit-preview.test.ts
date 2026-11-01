import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FsTools } from '../src/tools/fs-tools.js';
const race = vi.hoisted(() => ({ target: '' }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    await fs.writeFile(...args);
    if (race.target && String(args[0]).startsWith(`${race.target}.`) && String(args[0]).endsWith('.tmp')) {
      const target = race.target; race.target = ''; await fs.writeFile(target, 'human');
    }
  } };
});
afterEach(() => { race.target = ''; });

it('previews ordered dependent replacements without changing files, then applies the exact diff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairos-preview-'));
  await writeFile(join(root, 'a.txt'), 'one two\n');
  const tools = new FsTools(root);
  const prepared = await tools.prepare_edits_batch([
    { path: 'a.txt', old_text: 'one', new_text: 'three' },
    { path: 'a.txt', old_text: 'three', new_text: 'four' },
  ]);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one two\n');
  expect(prepared.preview[0]).toMatchObject({ ok: true, diff: expect.stringContaining('+three two') });
  expect(prepared.preview[1]).toMatchObject({ ok: true, diff: expect.stringContaining('+four two') });
  expect(await prepared.apply()).toEqual(prepared.preview);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('four two\n');
});

it('rejects the whole prepared batch before writing when a human changes any target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairos-preview-'));
  await writeFile(join(root, 'a.txt'), 'one'); await writeFile(join(root, 'b.txt'), 'two');
  const tools = new FsTools(root);
  const prepared = await tools.prepare_edits_batch([
    { path: 'a.txt', old_text: 'one', new_text: 'three' },
    { path: 'b.txt', old_text: 'two', new_text: 'four' },
  ]);
  await writeFile(join(root, 'b.txt'), 'human');
  const results = await prepared.apply();
  expect(results.every(result => !result.ok)).toBe(true);
  expect(results.every(result => !result.ok && result.mutated !== true)).toBe(true);
  expect(results[0]).toMatchObject({ error: expect.stringMatching(/stale|changed/i) });
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one');
  expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('human');
});

it('binds new-file previews to absence and refuses replay of an approved plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairos-preview-'));
  const tools = new FsTools(root);
  const first = await tools.prepare_edits_batch([{ path: 'new.txt', old_text: '', new_text: 'agent' }]);
  await writeFile(join(root, 'new.txt'), 'human');
  expect((await first.apply())[0]?.ok).toBe(false);
  expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('human');
  const second = await tools.prepare_edits_batch([{ path: 'new.txt', old_text: 'human', new_text: 'approved' }]);
  expect((await second.apply())[0]?.ok).toBe(true);
  expect((await second.apply())[0]?.ok).toBe(false);
});

it('preserves a human edit that arrives while the approved replacement is being staged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairos-preview-'));
  await writeFile(join(root, 'a.txt'), 'one');
  const prepared = await new FsTools(root).prepare_edits_batch([{ path: 'a.txt', old_text: 'one', new_text: 'two' }]);
  race.target = join(root, 'a.txt');
  const result = (await prepared.apply())[0];
  expect(result?.ok).toBe(false);
  expect(result && !result.ok && result.mutated === true).toBe(false);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('human');
});

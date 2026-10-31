import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { FsTools } from '../src/tools/fs-tools.js';
let root: string;
let tools: FsTools;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'nim-test-')); tools = new FsTools(root); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('reads batches with independent errors and rejects traversal', async () => {
  await writeFile(join(root, 'a.txt'), 'hello');
  const result = await tools.read_files_batch(['a.txt', 'missing.txt', '../outside']);
  expect(result[0]).toEqual({ path: 'a.txt', ok: true, content: 'hello' });
  expect(result.slice(1).every(r => !r.ok)).toBe(true);
});
it('applies ordered edits and refuses ambiguous replacements without modifying the file', async () => {
  await writeFile(join(root, 'a.txt'), 'one two');
  const result = await tools.apply_edits_batch([
    { path: 'a.txt', old_text: 'one', new_text: 'two' },
    { path: 'a.txt', old_text: 'two', new_text: 'three' },
  ]);
  expect(result.map(r => r.ok)).toEqual([true, false]);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('two two');
});
it('creates files explicitly and never overwrites existing files with empty old_text', async () => {
  const edit = { path: 'new.txt', old_text: '', new_text: 'hello' };
  expect((await tools.apply_edits_batch([edit]))[0]?.ok).toBe(true);
  expect((await tools.apply_edits_batch([edit]))[0]?.ok).toBe(false);
});
it('executes bash, bounds output and enforces timeout', async () => {
  expect((await tools.run_bash('printf hello')).stdout).toBe('hello');
  const long = await tools.run_bash("printf '%20000s' x");
  expect(long.stdout.length).toBeLessThanOrEqual(15000);
  expect(long.truncated).toBe(true);
  expect((await tools.run_bash('sleep 10', 100)).timedOut).toBe(true);
}, 10000);
it('rejects symlinks escaping the workspace and preserves outside content', async () => {
  const { symlink } = await import('node:fs/promises');
  const outside = await mkdtemp(join(tmpdir(), 'nim-outside-'));
  try {
    await writeFile(join(outside, 'secret.txt'), 'original');
    await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await tools.read_files_batch(['link/secret.txt']))[0]?.ok).toBe(false);
    expect((await tools.apply_edits_batch([{ path: 'link/secret.txt', old_text: 'original', new_text: 'changed' }]))[0]?.ok).toBe(false);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('original');
  } finally { await rm(outside, { recursive: true, force: true }); }
});
it('cancels queued edits and a running shell command', async () => {
  const controller = new AbortController(); controller.abort();
  const edits = await tools.apply_edits_batch([{ path: 'never.txt', old_text: '', new_text: 'no' }], controller.signal);
  expect(edits[0]?.ok).toBe(false);
  const running = new AbortController();
  const pending = tools.run_bash('sleep 10', 10000, running.signal);
  setTimeout(() => running.abort(), 100);
  expect((await pending).aborted).toBe(true);
}, 5000);
it('returns a unified diff only for edits actually applied', async () => {
  await writeFile(join(root, 'a.ts'), 'const value = 1;\n');
  const results = await tools.apply_edits_batch([
    { path: 'a.ts', old_text: '1', new_text: '2' },
    { path: 'a.ts', old_text: 'missing', new_text: '3' },
  ]);
  expect(results[0]).toMatchObject({ ok: true, diff: expect.stringContaining('-const value = 1;') });
  expect(results[0]).toMatchObject({ diff: expect.stringContaining('+const value = 2;') });
  expect(results[1]).not.toHaveProperty('diff');
});

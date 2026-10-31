import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsTools } from '../src/tools/fs-tools.js';
const failure = vi.hoisted(() => ({ write: false, rename: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (failure.write) {
        failure.write = false;
        await fs.writeFile(args[0], 'partial', args[2]);
        throw Object.assign(new Error('Simulated disk full'), { code: 'ENOSPC' });
      }
      return fs.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (failure.rename) { failure.rename = false; throw Object.assign(new Error('Simulated rename failure'), { code: 'EACCES' }); }
      return fs.rename(...args);
    },
  };
});
let root: string;
afterEach(async () => { failure.write = false; failure.rename = false; if (root) await rm(root, { force: true, recursive: true }); });
it.each(['write', 'rename'] as const)('preserves the original file on %s failure and cleans staging files', async stage => {
  root = await mkdtemp(join(tmpdir(), 'nim-atomic-'));
  await writeFile(join(root, 'a.ts'), 'original content');
  failure[stage] = true;
  const result = await new FsTools(root).apply_edits_batch([{ path: 'a.ts', old_text: 'original', new_text: 'changed' }]);
  expect(result[0]?.ok).toBe(false);
  expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('original content');
  expect(await readdir(root)).toEqual(['a.ts']);
});
it('does not leave a partially created file when writing fails', async () => {
  root = await mkdtemp(join(tmpdir(), 'nim-atomic-'));
  failure.write = true;
  expect((await new FsTools(root).apply_edits_batch([{ path: 'new.ts', old_text: '', new_text: 'complete' }]))[0]?.ok).toBe(false);
  expect(await readdir(root)).toEqual([]);
});

import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { indexWorkspace } from '../src/graph/indexer.js';
import { resolveReferences } from '../src/core/references.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'kairos-refs-')); });
afterEach(async () => {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'kairos-refs-')) throw new Error('Unexpected test directory');
  await rm(root, { recursive: true, force: true });
});
async function file(path: string, source: string) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), source);
}

it('resolves autocomplete forms and explicit quoted paths to untrusted source with locations', async () => {
  await file('src/a.ts', '// Header\nexport function greet() { return "hello"; }\n');
  await file('docs/my notes.md', 'Useful project notes.');
  const graph = await indexWorkspace(root);
  const result = await resolveReferences(root, graph, 'Read @src/a.ts, @symbol:greet and @file:"docs/my notes.md".');
  expect(result.context).toMatch(/untrusted/i);
  expect(result.context).toContain('src/a.ts:2');
  expect(result.context).toContain('function greet() { return "hello"; }');
  expect(result.context).toContain('Useful project notes.');
  expect(result.references).toEqual([
    expect.objectContaining({ kind: 'file', path: 'src/a.ts', startLine: 1, endLine: 3, truncated: false }),
    expect.objectContaining({ kind: 'symbol', path: 'src/a.ts', name: 'greet', startLine: 2, endLine: 2, truncated: false }),
    expect.objectContaining({ kind: 'file', path: 'docs/my notes.md', startLine: 1, endLine: 1, truncated: false }),
  ]);
  expect(result.chars).toBe(result.context.length);
  expect(result.maxChars).toBe(12000);
});

it('does not treat email addresses, embedded at signs or a bare at sign as references', async () => {
  const graph = await indexWorkspace(root);
  expect(await resolveReferences(root, graph, 'Contact person@example.com or foo@Bar; use @ in prose.'))
    .toMatchObject({ context: '', references: [], chars: 0 });
});

it('rejects unknown and ambiguous symbols and resolves qualified candidates without neighboring source', async () => {
  await file('a.ts', '// irrelevant content\nfunction same() { return 1; }');
  await file('b.ts', 'function same() { return 2; }');
  const graph = await indexWorkspace(root);
  await expect(resolveReferences(root, graph, '@missing')).rejects.toThrow(/Unknown.*missing/);
  await expect(resolveReferences(root, graph, '@file:missing.txt')).rejects.toThrow(/missing/);
  await expect(resolveReferences(root, graph, '@same')).rejects.toThrow(/ambiguous.*a.ts:same.*b.ts:same/is);
  const result = await resolveReferences(root, graph, '@symbol:a.ts:same');
  expect(result.context).toContain('return 1');
  expect(result.context).not.toContain('irrelevant content');
  expect(result.references).toHaveLength(1);
});

it('deduplicates references and never retains content from previous prompts', async () => {
  await file('a.ts', 'function one() { return 1; }');
  const graph = await indexWorkspace(root);
  expect((await resolveReferences(root, graph, '@one @symbol:one')).references).toHaveLength(1);
  expect(await resolveReferences(root, graph, 'A separate request')).toMatchObject({ context: '', references: [], chars: 0 });
});

it('caps the whole context and explicitly reports truncated or omitted content', async () => {
  await file('large.txt', 'x'.repeat(3000));
  await file('second.txt', 'Second file content');
  const graph = await indexWorkspace(root);
  const result = await resolveReferences(root, graph, '@file:large.txt @file:second.txt', { maxChars: 512 });
  expect(result.context.length).toBeLessThanOrEqual(512);
  expect(result.context).toMatch(/truncated/i);
  expect(result.references[0]?.truncated).toBe(true);
  expect(result.references[1]?.truncated).toBe(true);
  expect(result.chars).toBe(result.context.length);
  expect(result.maxChars).toBe(512);
  await expect(resolveReferences(root, graph, '@file:large.txt @missing', { maxChars: 512 })).rejects.toThrow(/missing/);
});

it('requires an explicit file prefix to override ignored code and refuses missing sources', async () => {
  await file('.gitignore', 'ignored.ts');
  await file('ignored.ts', 'function hidden() {}');
  const graph = await indexWorkspace(root);
  await expect(resolveReferences(root, graph, '@ignored.ts')).rejects.toThrow(/indexed|ignored/i);
  expect((await resolveReferences(root, graph, '@file:ignored.ts')).context).toContain('function hidden');
  await expect(resolveReferences(root, graph, '@hidden')).rejects.toThrow(/Unknown/);
});

it.each(['../outside.txt', '/outside.txt', 'C:\\outside.txt', '.env', '.env.local', 'private.pem', 'secret.key', '.ssh/id_ed25519'])
('rejects traversal and secret file reference %s', async path => {
  const graph = await indexWorkspace(root);
  await expect(resolveReferences(root, graph, `@file:"${path}"`)).rejects.toThrow(/workspace|secret|key/i);
});

it('refuses oversized files and private keys stored under ordinary filenames', async () => {
  await file('large.txt', 'x'.repeat(1024 * 1024 + 1));
  await file('notes.txt', '-----BEGIN PRIVATE KEY-----\nprivate test material');
  const graph = await indexWorkspace(root);
  await expect(resolveReferences(root, graph, '@file:large.txt')).rejects.toThrow(/1 MiB/);
  await expect(resolveReferences(root, graph, '@file:notes.txt')).rejects.toThrow(/private key/i);
});

it('refuses external symlink targets for files and stale graph symbols', async context => {
  const outside = await mkdtemp(join(tmpdir(), 'kairos-refs-outside-'));
  try {
    await writeFile(join(outside, 'external.ts'), 'function secret() {}');
    try { await symlink(outside, join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    await file('swapped/external.ts', 'function onlyHere() {}');
    const graph = await indexWorkspace(root);
    await expect(resolveReferences(root, graph, '@file:external/external.ts')).rejects.toThrow(/outside|workspace/i);
    await rename(join(root, 'swapped'), join(root, 'original'));
    await symlink(outside, join(root, 'swapped'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(resolveReferences(root, graph, '@onlyHere')).rejects.toThrow(/outside|workspace/i);
  } finally { await rm(outside, { recursive: true, force: true }); }
});

it('rejects cancellation and a graph from another workspace before resolving content', async () => {
  const graph = await indexWorkspace(root);
  const abort = new AbortController(); abort.abort();
  await expect(resolveReferences(root, graph, '@missing', { signal: abort.signal })).rejects.toThrow();
  await expect(resolveReferences(join(root, '..'), graph, '@missing')).rejects.toThrow(/workspace/i);
});

it('refuses unindexed C and Java files unless explicitly selected with @file:', async () => {
  await file('.gitignore', 'ignored.c\n');
  await file('ignored.c', 'int main() { return 0; }');
  const graph = await indexWorkspace(root);
  await expect(resolveReferences(root, graph, '@ignored.c')).rejects.toThrow(/not indexed or is ignored/i);
  const explicit = await resolveReferences(root, graph, '@file:ignored.c');
  expect(explicit.context).toContain('int main()');
});

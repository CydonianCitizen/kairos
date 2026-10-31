import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { ToolRegistry, serializeToolResult } from '../src/tools/registry.js';
import { FsTools } from '../src/tools/fs-tools.js';
import { RepoGraph } from '../src/graph/repo-graph.js';
it('rejects bad JSON, wrong argument types and invalid whole batches before writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nim-registry-'));
  try {
    const registry = new ToolRegistry(new FsTools(root), () => new RepoGraph(root));
    for (const [name, json] of [
      ['read_files_batch', '{'], ['read_files_batch', 'null'], ['read_files_batch', '{"paths":"a.ts"}'],
      ['get_repo_map', '{"extra":true}'], ['run_bash', '{"command":"echo no","timeoutMs":"100"}'],
      ['apply_edits_batch', JSON.stringify({ edits: [{ path: 'a.ts', old_text: '', new_text: 'created' }, { path: 'b.ts' }] })],
    ]) expect((await registry.execute(name!, json!)).ok).toBe(false);
    await expect(readFile(join(root, 'a.ts'))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('serializes oversized Unicode and escaped tool output as bounded valid JSON', () => {
  const serialized = serializeToolResult({ ok: true, result: '\n"😀'.repeat(10000), mutated: false }, 512);
  expect(serialized.length).toBeLessThanOrEqual(512);
  expect(JSON.parse(serialized)).toMatchObject({ ok: true, truncated: true });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsTools } from '../src/tools/fs-tools.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { RepoGraph } from '../src/graph/repo-graph.js';

describe('WorkspaceScope 4-level permissions', () => {
  let workspace: string;
  let outsideDir: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'scope-ws-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'scope-outside-'));
    await writeFile(join(workspace, 'local.txt'), 'local content');
    await writeFile(join(outsideDir, 'outside.txt'), 'outside content');
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('scope: none disables reading, writing and shell', async () => {
    const fs = new FsTools(workspace, undefined, { scope: 'none' });
    const graph = new RepoGraph(workspace);
    const registry = new ToolRegistry(fs, () => graph);

    expect(registry.schemas('build')).toEqual([]);
    const res1 = await registry.execute('read_files_batch', JSON.stringify({ paths: ['local.txt'] }));
    expect(res1.ok).toBe(false);
    expect(res1.error).toContain('disabled');

    const res2 = await registry.execute('apply_edits_batch', JSON.stringify({ edits: [{ path: 'local.txt', old_text: 'local', new_text: 'new' }] }));
    expect(res2.ok).toBe(false);
    expect(res2.error).toContain('disabled');

    const bash = await fs.run_bash('echo hi');
    expect(bash.error).toContain('disabled');
  });

  it('scope: read-only allows reading workspace files but blocks edits and shell', async () => {
    const fs = new FsTools(workspace, undefined, { scope: 'read-only' });
    const graph = new RepoGraph(workspace);
    const registry = new ToolRegistry(fs, () => graph);

    const schemas = registry.schemas('build');
    const names = schemas.map(s => s.type === 'function' ? s.function.name : '');
    expect(names).toContain('read_files_batch');
    expect(names).not.toContain('apply_edits_batch');
    expect(names).not.toContain('run_bash');

    // Read succeeds
    const read = await fs.read_files_batch(['local.txt']);
    expect(read[0]?.ok).toBe(true);
    expect(read[0]?.content).toBe('local content');

    // Edit fails
    await expect(fs.apply_edits_batch([{ path: 'local.txt', old_text: 'local', new_text: 'new' }])).rejects.toThrow(/disabled/i);

    // Bash returns disabled error
    const bash = await fs.run_bash('echo test');
    expect(bash.error).toContain('disabled');
  });

  it('scope: workspace allows reading and writing inside workspace, blocks outside', async () => {
    const fs = new FsTools(workspace, undefined, { scope: 'workspace' });

    // Read inside OK
    const read = await fs.read_files_batch(['local.txt']);
    expect(read[0]?.ok).toBe(true);

    // Read outside blocked
    const outsidePath = join(outsideDir, 'outside.txt');
    const readOutside = await fs.read_files_batch([outsidePath]);
    expect(readOutside[0]?.ok).toBe(false);
    expect(readOutside[0]?.error).toContain('Expected a non-empty relative workspace path');

    // Edit inside OK
    const edit = await fs.apply_edits_batch([{ path: 'local.txt', old_text: 'local', new_text: 'edited' }]);
    expect(edit[0]?.ok).toBe(true);
    expect(await readFile(join(workspace, 'local.txt'), 'utf8')).toBe('edited content');
  });

  it('scope: full allows reading and writing outside workspace', async () => {
    const fs = new FsTools(workspace, undefined, { scope: 'full' });

    const outsidePath = join(outsideDir, 'outside.txt');
    const read = await fs.read_files_batch([outsidePath]);
    expect(read[0]?.ok).toBe(true);
    expect(read[0]?.content).toBe('outside content');

    const edit = await fs.apply_edits_batch([{ path: outsidePath, old_text: 'outside', new_text: 'full-edited' }]);
    expect(edit[0]?.ok).toBe(true);
    expect(await readFile(outsidePath, 'utf8')).toBe('full-edited content');
  });

  it('allows dynamic scope switching', async () => {
    const fs = new FsTools(workspace, undefined, { scope: 'read-only' });
    expect(fs.getScope()).toBe('read-only');

    await expect(fs.apply_edits_batch([{ path: 'local.txt', old_text: 'local', new_text: 'new' }])).rejects.toThrow(/disabled/i);

    fs.setScope('workspace');
    expect(fs.getScope()).toBe('workspace');
    const edit = await fs.apply_edits_batch([{ path: 'local.txt', old_text: 'local', new_text: 'switched' }]);
    expect(edit[0]?.ok).toBe(true);
  });
});

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resolveWorkspaceInstructions } from '../src/core/workspace-instructions.js';

let root: string;
let workspace: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kairos-nested-instructions-'));
  workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'src', 'feature'), { recursive: true });
  await writeFile(join(workspace, 'AGENTS.md'), 'Root convention.');
  await writeFile(join(workspace, 'src', 'AGENTS.md'), 'Source convention.');
  await writeFile(join(workspace, 'src', 'feature', 'AGENTS.md'), 'Feature convention.');
  await writeFile(join(workspace, 'src', 'feature', 'a.ts'), 'export const a = 1;');
});
afterEach(async () => {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'kairos-nested-instructions-')) throw new Error('Unexpected test directory');
  await rm(root, { recursive: true, force: true });
});

it('does not access even a missing workspace unless trusted', async () => {
  expect(await resolveWorkspaceInstructions(join(root, 'absent'), ['src/a.ts'], { trusted: false })).toEqual({ context: '', files: [] });
});

it('loads only relevant ancestors once in root-to-leaf order', async () => {
  await mkdir(join(workspace, 'unrelated'));
  await writeFile(join(workspace, 'unrelated', 'AGENTS.md'), 'Never load me.');
  const result = await resolveWorkspaceInstructions(workspace, ['src/feature/a.ts', 'src/feature', 'src/feature/a.ts'], { trusted: true });
  expect(result.files).toEqual(['AGENTS.md', 'src/AGENTS.md', 'src/feature/AGENTS.md']);
  expect(result.context.indexOf('Root convention.')).toBeLessThan(result.context.indexOf('Source convention.'));
  expect(result.context.indexOf('Source convention.')).toBeLessThan(result.context.indexOf('Feature convention.'));
  expect(result.context).not.toContain('Never load me.');
  expect(result.context).toContain('subordinate');
});

it('can omit root instructions already loaded by the extension host', async () => {
  const result = await resolveWorkspaceInstructions(workspace, ['src/feature/a.ts'], { trusted: true, includeRoot: false });
  expect(result.files).toEqual(['src/AGENTS.md', 'src/feature/AGENTS.md']);
  expect(result.context).not.toContain('Root convention.');
});

it('retains applicable ancestor instructions when a requested file was deleted', async () => {
  await rm(join(workspace, 'src', 'feature', 'a.ts'));
  const result = await resolveWorkspaceInstructions(workspace, ['src/feature/a.ts', 'src/feature/new/sub/file.ts'], { trusted: true });
  expect(result.files).toEqual(['AGENTS.md', 'src/AGENTS.md', 'src/feature/AGENTS.md']);
});

it('ignores traversal and absolute paths outside the workspace', async () => {
  const outside = join(root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'AGENTS.md'), 'Outside secret instruction.');
  const result = await resolveWorkspaceInstructions(workspace, ['../outside', outside, '../../AGENTS.md'], { trusted: true });
  expect(result.files).toEqual(['AGENTS.md']);
  expect(result.context).not.toContain('Outside secret instruction.');
});

it('does not follow an external directory junction or redirected AGENTS.md', async () => {
  const outside = join(root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'AGENTS.md'), 'Outside secret instruction.');
  await symlink(await realpath(outside), join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await resolveWorkspaceInstructions(workspace, ['linked', 'linked/new.ts'], { trusted: true });
  expect(linked.files).toEqual(['AGENTS.md']);
  await rm(join(workspace, 'src', 'AGENTS.md'));
  await symlink(process.platform === 'win32' ? outside : join(outside, 'AGENTS.md'), join(workspace, 'src', 'AGENTS.md'), process.platform === 'win32' ? 'junction' : 'file');
  const redirected = await resolveWorkspaceInstructions(workspace, ['src/feature/a.ts'], { trusted: true });
  expect(redirected.files).toEqual(['AGENTS.md', 'src/feature/AGENTS.md']);
  expect(redirected.context).not.toContain('Outside secret instruction.');
});

it('supports a symlinked workspace root without importing parent instructions', async () => {
  await writeFile(join(root, 'AGENTS.md'), 'Outside parent.');
  const alias = join(root, 'alias');
  await symlink(await realpath(workspace), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await resolveWorkspaceInstructions(alias, ['src/feature/a.ts'], { trusted: true });
  expect(result.files).toEqual(['AGENTS.md', 'src/AGENTS.md', 'src/feature/AGENTS.md']);
  expect(result.context).not.toContain('Outside parent.');
});

it('honors cancellation and document/context bounds', async () => {
  const cancelled = new AbortController(); cancelled.abort();
  await expect(resolveWorkspaceInstructions(workspace, ['src'], { trusted: true, signal: cancelled.signal })).rejects.toThrow();
  const bounded = await resolveWorkspaceInstructions(workspace, ['src/feature'], { trusted: true, maxChars: 90 });
  expect(bounded.context.length).toBeLessThanOrEqual(90);
  await writeFile(join(workspace, 'AGENTS.md'), 'x'.repeat(9000));
  expect((await resolveWorkspaceInstructions(workspace, [], { trusted: true, maxChars: 100000 })).context.length).toBeLessThanOrEqual(8000);
  await writeFile(join(workspace, 'AGENTS.md'), 'x'.repeat(32769));
  await expect(resolveWorkspaceInstructions(workspace, [], { trusted: true })).rejects.toThrow(/32 KiB/);
});

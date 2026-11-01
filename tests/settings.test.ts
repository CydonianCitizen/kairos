import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadSettings } from '../src/config/settings.js';
import { PermissionGate } from '../src/core/permissions.js';

let root: string;
let home: string;
let workspace: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kairos-settings-'));
  home = join(root, 'home'); workspace = join(root, 'workspace');
  await mkdir(join(home, '.kairos'), { recursive: true });
  await mkdir(join(workspace, '.kairos'), { recursive: true });
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  expect(homedir()).toBe(home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'kairos-settings-')) throw new Error('Unexpected test directory');
  await rm(root, { recursive: true, force: true });
});
const personal = (settings: unknown) => writeFile(join(home, '.kairos', 'config.json'), JSON.stringify(settings));
const project = (settings: unknown) => writeFile(join(workspace, '.kairos', 'config.json'), JSON.stringify(settings));
const remembered = (model: string) => writeFile(join(home, '.kairos', 'last-model.json'), JSON.stringify({ version: 1, model, updatedAt: '2026-11-01T00:00:00.000Z' }));

it('accepts absent settings without manufacturing model or effort overrides', async () => {
  expect(await loadSettings(workspace)).toEqual({});
});

it('uses personal settings across workspaces and ignores untrusted project settings', async () => {
  await personal({ model: 'minimaxai/minimax-m3.1-flash', effort: 'max', timeoutMs: 9000 });
  await writeFile(join(workspace, '.kairos', 'config.json'), 'untrusted invalid JSON');
  const expected = { model: 'minimaxai/minimax-m3.1-flash', effort: 'max', timeoutMs: 9000 };
  expect(await loadSettings(workspace)).toEqual(expected);
  expect(await loadSettings(root)).toEqual(expected);
});

it('merges explicit CLI choices over trusted project choices over personal defaults', async () => {
  await personal({ model: 'minimaxai/minimax-m3.1-flash', effort: 'max', timeoutMs: 9000 });
  await project({ effort: 'medium', timeoutMs: 5000 });
  expect(await loadSettings(workspace, { trustWorkspace: true, overrides: { effort: 'high', model: undefined } }))
    .toEqual({ model: 'minimaxai/minimax-m3.1-flash', effort: 'high', timeoutMs: 5000 });
});

it('validates effort against the merged model and accepts custom model IDs with auto effort', async () => {
  await personal({ model: 'custom/model', effort: 'high' });
  await expect(loadSettings(workspace)).rejects.toThrow(/Effort/);
  expect(await loadSettings(workspace, { overrides: { effort: 'auto' } })).toEqual({ model: 'custom/model', effort: 'auto' });
  await personal({ effort: 'max' });
  expect(await loadSettings(workspace, { overrides: { model: 'minimaxai/minimax-m3.1-flash' } }))
    .toEqual({ model: 'minimaxai/minimax-m3.1-flash', effort: 'max' });
});

it('prefers a remembered model to personal defaults across workspaces, below project and CLI choices', async () => {
  await personal({ model: 'personal/model' });
  await remembered('remembered/model');
  await project({ model: 'project/model' });
  expect(await loadSettings(workspace)).toEqual({ model: 'remembered/model' });
  expect(await loadSettings(root)).toEqual({ model: 'remembered/model' });
  expect(await loadSettings(workspace, { trustWorkspace: true })).toEqual({ model: 'project/model' });
  expect(await loadSettings(workspace, { trustWorkspace: true, overrides: { model: 'cli/model' } })).toEqual({ model: 'cli/model' });
});

it('falls back from corrupt remembered data without changing personal settings', async () => {
  await personal({ model: 'personal/model', effort: 'auto' });
  await writeFile(join(home, '.kairos', 'last-model.json'), '{"secret":"not-a-model"');
  expect(await loadSettings(workspace)).toEqual({ model: 'personal/model', effort: 'auto' });
});

it('resets inherited personal effort when a different selected model cannot support it', async () => {
  await personal({ model: 'minimaxai/minimax-m3.1-flash', effort: 'max' });
  await remembered('custom/model');
  expect(await loadSettings(workspace)).toEqual({ model: 'custom/model', effort: 'auto' });
  await expect(loadSettings(workspace, { overrides: { effort: 'max' } })).rejects.toThrow(/Effort/);
  await project({ effort: 'max' });
  await expect(loadSettings(workspace, { trustWorkspace: true })).rejects.toThrow(/Effort/);
  await project({ model: 'another/model' });
  expect(await loadSettings(workspace, { trustWorkspace: true })).toEqual({ model: 'another/model', effort: 'auto' });
});

it('allows CLI and trusted project model switches while keeping their explicit effort choices strict', async () => {
  await personal({ model: 'minimaxai/minimax-m3.1-flash', effort: 'max' });
  expect(await loadSettings(workspace, { overrides: { model: 'cli/model' } })).toEqual({ model: 'cli/model', effort: 'auto' });
  await expect(loadSettings(workspace, { overrides: { model: 'cli/model', effort: 'max' } })).rejects.toThrow(/Effort/);
  await project({ model: 'project/model' });
  expect(await loadSettings(workspace, { trustWorkspace: true })).toEqual({ model: 'project/model', effort: 'auto' });
  await project({ model: 'project/model', effort: 'max' });
  await expect(loadSettings(workspace, { trustWorkspace: true })).rejects.toThrow(/Effort/);
  await expect(loadSettings(workspace, { trustWorkspace: true, overrides: { model: 'cli/model' } })).rejects.toThrow(/Effort/);
});

it('does not hide an invalid personal effort when the selected model has not changed', async () => {
  await personal({ model: 'custom/model', effort: 'high' });
  await remembered('custom/model');
  await expect(loadSettings(workspace)).rejects.toThrow(/Effort/);
  await expect(loadSettings(workspace, { overrides: { model: 'custom/model' } })).rejects.toThrow(/Effort/);
  await project({ model: 'custom/model' });
  await expect(loadSettings(workspace, { trustWorkspace: true })).rejects.toThrow(/Effort/);
});

it('retains supported inherited effort through explicit CLI and project model switches', async () => {
  await personal({ effort: 'high' });
  expect(await loadSettings(workspace, { overrides: { model: 'minimaxai/minimax-m3.1-flash' } }))
    .toEqual({ model: 'minimaxai/minimax-m3.1-flash', effort: 'high' });
  await project({ model: 'minimaxai/minimax-m3.1-flash' });
  expect(await loadSettings(workspace, { trustWorkspace: true })).toEqual({ model: 'minimaxai/minimax-m3.1-flash', effort: 'high' });
});

it('keeps supported personal effort when the remembered model supports the same level', async () => {
  await personal({ effort: 'high' });
  await remembered('minimaxai/minimax-m3.1-flash');
  expect(await loadSettings(workspace)).toEqual({ model: 'minimaxai/minimax-m3.1-flash', effort: 'high' });
});

it('merges each permission category separately through personal, trusted project and CLI settings', async () => {
  await personal({ permissions: { edits: 'allow', shell: 'deny', external: 'ask' } });
  await project({ permissions: { edits: 'ask', external: 'deny' } });
  expect(await loadSettings(workspace, { overrides: { permissions: { shell: 'allow' } } }))
    .toEqual({ permissions: { edits: 'allow', shell: 'allow', external: 'ask' } });
  expect(await loadSettings(workspace, { trustWorkspace: true, overrides: { permissions: { shell: 'allow', edits: 'deny' } } }))
    .toEqual({ permissions: { edits: 'deny', shell: 'allow', external: 'deny' } });
});

it('appends granular policies across settings layers and preserves personal denies', async () => {
  await personal({ permissions: { edits: 'ask', rules: [{ kind: 'edits', mode: 'deny', pattern: 'private/**' }] } });
  await project({ permissions: { rules: [{ kind: 'edits', mode: 'allow', pattern: '**' }] } });
  const settings = await loadSettings(workspace, { trustWorkspace: true, overrides: { permissions: {
    rules: [{ kind: 'shell', mode: 'ask', pattern: 'npm *' }],
  } } });
  expect(settings.permissions?.rules).toHaveLength(3);
  expect(new PermissionGate(settings.permissions).mode('edits', { paths: ['private/secret.txt'] })).toBe('deny');
  expect(new PermissionGate(settings.permissions).mode('edits', { paths: ['src/main.ts'] })).toBe('allow');
  await project({ permissions: { rules: [] } });
  expect(new PermissionGate((await loadSettings(workspace, { trustWorkspace: true })).permissions)
    .mode('edits', { paths: ['private/secret.txt'] })).toBe('deny');
});

it('merges memory and sandbox preferences with CLI over trusted project over personal settings', async () => {
  await personal({ memory: true, sandbox: 'required' });
  await project({ memory: false, sandbox: 'off' });
  expect(await loadSettings(workspace)).toEqual({ memory: true, sandbox: 'required' });
  expect(await loadSettings(workspace, { trustWorkspace: true })).toEqual({ memory: false, sandbox: 'off' });
  expect(await loadSettings(workspace, { trustWorkspace: true, overrides: { memory: true, sandbox: 'required' } }))
    .toEqual({ memory: true, sandbox: 'required' });
});

it.each([
  { memory: 'true' }, { memory: null }, { sandbox: true }, { sandbox: 'native' },
  { permissions: { rules: [{ kind: 'shell', mode: 'allow', pattern: '*', credential: 'private-test-credential' }] } },
  { permissions: { rules: [{ kind: 'shell', mode: 'allow', pattern: 'x'.repeat(513) }] } },
])('rejects invalid granular and runtime settings without echoing contents (%j)', async value => {
  await personal(value);
  const error = await loadSettings(workspace).catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain('private-test-credential');
});

it.each([null, [], 'allow', { edits: true }, { shell: 'private-test-credential' }, { unknown: 'allow' }])
('rejects malformed permission rules without echoing their contents (%j)', async permissions => {
  await personal({ permissions });
  const error = await loadSettings(workspace).catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain('private-test-credential');
});

it.each([
  null, [], { apiKey: 'private-test-credential' }, { model: 'private-test-credential' },
  { effort: 'private-test-credential' }, { timeoutMs: 'private-test-credential' },
  { timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: 2147483648 }, { timeoutMs: Number.MAX_SAFE_INTEGER + 1 },
  { systemPromptFile: '' }, { systemPromptFile: 7 },
])('rejects malformed settings without disclosing their values (%j)', async value => {
  await personal(value);
  const error = await loadSettings(workspace).catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain('private-test-credential');
});

it('reports invalid JSON without copying its potentially secret contents', async () => {
  await writeFile(join(home, '.kairos', 'config.json'), '{"secret":"private-test-credential",');
  await expect(loadSettings(workspace)).rejects.toThrow(/JSON/);
  await expect(loadSettings(workspace)).rejects.not.toThrow(/private-test-credential/);
});

it('validates project settings only when the workspace is trusted', async () => {
  await project({ apiKey: 'private-test-credential' });
  expect(await loadSettings(workspace)).toEqual({});
  await expect(loadSettings(workspace, { trustWorkspace: true })).rejects.toThrow(/unsupported setting/);
  await writeFile(join(workspace, '.kairos', 'config.json'), '{"invalid"');
  await expect(loadSettings(workspace, { trustWorkspace: true })).rejects.toThrow(/JSON/);
});

it('limits both configuration and instruction files to 32 KiB', async () => {
  await writeFile(join(home, '.kairos', 'config.json'), ' '.repeat(32769));
  await expect(loadSettings(workspace)).rejects.toThrow(/32 KiB/);
  await personal({});
  await writeFile(join(home, '.kairos', 'system-prompt.md'), 'é'.repeat(16385));
  await expect(loadSettings(workspace)).rejects.toThrow(/32 KiB/);
});

it('loads optional personal instructions even without a personal config file', async () => {
  await writeFile(join(home, '.kairos', 'system-prompt.md'), 'Answer in Italian.');
  expect(await loadSettings(workspace)).toEqual({ systemPrompt: 'Answer in Italian.' });
});

it('resolves prompt paths relative to their defining config and chooses the winning prompt', async () => {
  await personal({ systemPromptFile: 'personal.md' });
  await project({ systemPromptFile: 'project.md' });
  await writeFile(join(home, '.kairos', 'personal.md'), 'Personal instructions');
  await writeFile(join(workspace, '.kairos', 'project.md'), 'Trusted project instructions');
  await writeFile(join(workspace, 'cli.md'), 'Explicit CLI instructions');
  expect(await loadSettings(workspace)).toEqual({ systemPrompt: 'Personal instructions' });
  expect(await loadSettings(workspace, { trustWorkspace: true })).toEqual({ systemPrompt: 'Trusted project instructions' });
  expect(await loadSettings(workspace, { trustWorkspace: true, overrides: { systemPromptFile: 'cli.md' } }))
    .toEqual({ systemPrompt: 'Explicit CLI instructions' });
});

it('fails for explicitly configured missing instructions while allowing a selected external file', async () => {
  await personal({ systemPromptFile: 'missing.md' });
  await expect(loadSettings(workspace)).rejects.toThrow(/prompt/i);
  await writeFile(join(root, 'external.md'), 'Selected outside the project');
  expect(await loadSettings(workspace, { overrides: { systemPromptFile: join(root, 'external.md') } }))
    .toEqual({ systemPrompt: 'Selected outside the project' });
});

it('allows personal instructions outside the workspace and fails for missing trusted project instructions', async () => {
  await writeFile(join(root, 'external.md'), 'Personal external instructions');
  await personal({ systemPromptFile: join(root, 'external.md') });
  expect(await loadSettings(workspace)).toEqual({ systemPrompt: 'Personal external instructions' });
  await project({ systemPromptFile: 'missing.md' });
  await expect(loadSettings(workspace, { trustWorkspace: true })).rejects.toThrow(/prompt/i);
});

it('rejects trusted project prompt paths outside the workspace', async () => {
  await writeFile(join(root, 'external.md'), 'Outside instructions');
  await project({ systemPromptFile: '../../external.md' });
  await expect(loadSettings(workspace, { trustWorkspace: true })).rejects.toThrow(/workspace/);
  await project({ systemPromptFile: join(root, 'external.md') });
  await expect(loadSettings(workspace, { trustWorkspace: true })).rejects.toThrow(/workspace/);
});

it('rejects project prompt symlinks that resolve outside the workspace', async context => {
  await writeFile(join(root, 'external.md'), 'Outside instructions');
  try { await symlink(join(root, 'external.md'), join(workspace, '.kairos', 'linked.md')); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
    throw error;
  }
  await project({ systemPromptFile: 'linked.md' });
  await expect(loadSettings(workspace, { trustWorkspace: true })).rejects.toThrow(/workspace/);
});

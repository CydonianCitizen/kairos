import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const loading = vi.hoisted(() => ({ dotenv: 0 }));
vi.mock('dotenv/config', () => { loading.dotenv++; return {}; });
import { NimClient } from '../src/core/nim-client.js';
import { loadEnvironment } from '../src/config/env.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'kairos-env-')) throw new Error('Unexpected temporary directory');
    await rm(root, { recursive: true, force: true });
  }
});

async function environment() {
  const root = await mkdtemp(join(tmpdir(), 'kairos-env-'));
  roots.push(root);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  const otherWorkspace = join(root, 'other-project');
  await mkdir(join(home, '.kairos'), { recursive: true });
  await mkdir(workspace);
  await mkdir(otherWorkspace);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('NVIDIA_API_KEY', undefined);
  expect(homedir()).toBe(home);
  return { home, workspace, otherWorkspace };
}

it('does not implicitly load a different workspace dotenv file when importing the client', () => {
  expect(NimClient).toBeDefined();
  expect(loading.dotenv).toBe(0);
});

it('uses the personal API key in multiple workspaces without local dotenv files', async () => {
  const { home, workspace, otherWorkspace } = await environment();
  await writeFile(join(home, '.kairos', '.env'), 'NVIDIA_API_KEY=personal-test-key\n');
  for (const directory of [workspace, otherWorkspace]) {
    delete process.env.NVIDIA_API_KEY;
    loadEnvironment(directory);
    expect(process.env.NVIDIA_API_KEY).toBe('personal-test-key');
  }
});

it('keeps workspace credentials ahead of personal credentials', async () => {
  const { home, workspace } = await environment();
  await writeFile(join(home, '.kairos', '.env'), 'NVIDIA_API_KEY=personal-test-key\n');
  await writeFile(join(workspace, '.env'), 'NVIDIA_API_KEY=workspace-test-key\n');
  loadEnvironment(workspace);
  expect(process.env.NVIDIA_API_KEY).toBe('workspace-test-key');
});

it('keeps environment credentials ahead of both dotenv files even with dotenv override enabled', async () => {
  const { home, workspace } = await environment();
  await writeFile(join(home, '.kairos', '.env'), 'NVIDIA_API_KEY=personal-test-key\n');
  await writeFile(join(workspace, '.env'), 'NVIDIA_API_KEY=workspace-test-key\n');
  vi.stubEnv('DOTENV_OVERRIDE', 'true');
  vi.stubEnv('NVIDIA_API_KEY', 'environment-test-key');
  loadEnvironment(workspace);
  expect(process.env.NVIDIA_API_KEY).toBe('environment-test-key');
});

it('works without a personal dotenv file and does not load the launch directory dotenv', async () => {
  const { workspace } = await environment();
  loadEnvironment(workspace);
  expect(process.env.NVIDIA_API_KEY).toBeUndefined();
  await writeFile(join(workspace, '.env'), 'NVIDIA_API_KEY=workspace-test-key\n');
  loadEnvironment(workspace);
  expect(process.env.NVIDIA_API_KEY).toBe('workspace-test-key');
});

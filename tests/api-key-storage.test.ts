import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as environment from '../src/config/env.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'kairos-key-storage-')); });
afterEach(async () => {
  vi.unstubAllEnvs();
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'kairos-key-storage-')) throw new Error('Unexpected temporary directory');
  await rm(root, { recursive: true, force: true });
});

it('saves a trimmed personal key that loads in two workspaces without writing either workspace', async () => {
  vi.stubEnv('HOME', root); vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('NVIDIA_API_KEY', undefined);
  expect(homedir()).toBe(root);
  const first = join(root, 'first'); const second = join(root, 'second');
  await mkdir(first); await mkdir(second);
  await environment.savePersonalApiKey('  nvapi-fixture-key  ');
  expect(environment.personalEnvPath()).toBe(join(root, '.kairos', '.env'));
  for (const workspace of [first, second]) {
    delete process.env.NVIDIA_API_KEY;
    environment.loadEnvironment(workspace);
    expect(process.env.NVIDIA_API_KEY).toBe('nvapi-fixture-key');
    expect(await readdir(workspace)).toEqual([]);
  }
  expect(await readFile(environment.personalEnvPath(), 'utf8')).toBe('NVIDIA_API_KEY=nvapi-fixture-key\n');
  if (process.platform !== 'win32') {
    expect((await stat(environment.personalEnvPath())).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, '.kairos'))).mode & 0o777).toBe(0o700);
  }
});

it('backs up exact bytes and preserves comments, CRLF, unrelated values, export prefixes and duplicate assignments', async () => {
  const previous = '# personal preferences\r\nOTHER="keep # this"\r\nexport NVIDIA_API_KEY = "old\r\nmultiline" # first\r\nNVIDIA_API_KEY=\'old-key\'\r\nNVIDIA_API_KEY=`older-key`\r\n# final comment';
  await writeFile(join(root, '.env'), previous);
  await writeFile(join(root, '.env.bak'), 'previous backup');
  await environment.savePersonalApiKey('nvapi-replacement', { directory: root });
  expect(await readFile(join(root, '.env.bak'))).toEqual(Buffer.from(previous));
  expect(await readFile(join(root, '.env'), 'utf8')).toBe('# personal preferences\r\nOTHER="keep # this"\r\nexport NVIDIA_API_KEY = nvapi-replacement # first\r\nNVIDIA_API_KEY=nvapi-replacement\r\nNVIDIA_API_KEY=nvapi-replacement\r\n# final comment');
  expect((await readdir(root)).sort()).toEqual(['.env', '.env.bak']);
  if (process.platform !== 'win32') expect((await stat(join(root, '.env.bak'))).mode & 0o777).toBe(0o600);
});

it('appends a missing assignment without changing existing text or its newline style', async () => {
  await writeFile(join(root, '.env'), '# settings\r\nOTHER=untouched');
  await environment.savePersonalApiKey('nvapi-new', { directory: root });
  expect(await readFile(join(root, '.env'), 'utf8')).toBe('# settings\r\nOTHER=untouched\r\nNVIDIA_API_KEY=nvapi-new\r\n');
});

it('does not rewrite key-like text inside another multiline variable', async () => {
  const previous = 'OTHER="first\nNVIDIA_API_KEY=literal\nlast"\nNVIDIA_API_KEY=old   # keep comment\n';
  await writeFile(join(root, '.env'), previous);
  await environment.savePersonalApiKey('nvapi-new', { directory: root });
  expect(await readFile(join(root, '.env'), 'utf8')).toBe('OTHER="first\nNVIDIA_API_KEY=literal\nlast"\nNVIDIA_API_KEY=nvapi-new   # keep comment\n');
});

it.each(['', '   ', 'key with spaces', 'key\nOTHER=bad', 'key\0bad', 'key#comment', 'key"quote', "key'quote", 'key`quote', 'key=assignment', 'key\\escape', 'x'.repeat(4097)])
('rejects unsafe key input without changing files or exposing its value (%#)', async value => {
  await writeFile(join(root, '.env'), 'OTHER=preserved\n');
  const error = await environment.savePersonalApiKey(value, { directory: root }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/invalid.*key/i);
  if (value.length > 3) expect((error as Error).message).not.toContain(value);
  expect(await readFile(join(root, '.env'), 'utf8')).toBe('OTHER=preserved\n');
  expect(await readdir(root)).toEqual(['.env']);
});

it.each(['.env', '.env.bak'])('rejects a nonregular %s without modifying existing files', async name => {
  if (name === '.env.bak') await writeFile(join(root, '.env'), 'NVIDIA_API_KEY=original\n');
  await mkdir(join(root, name));
  await expect(environment.savePersonalApiKey('nvapi-new', { directory: root })).rejects.toThrow(/save/i);
  if (name === '.env.bak') expect(await readFile(join(root, '.env'), 'utf8')).toBe('NVIDIA_API_KEY=original\n');
  expect((await readdir(root)).sort()).toEqual(name === '.env' ? ['.env'] : ['.env', '.env.bak']);
});

it.each(['.env', '.env.bak'])('rejects oversized %s without modifying existing files', async name => {
  const original = 'NVIDIA_API_KEY=original\n';
  if (name === '.env.bak') await writeFile(join(root, '.env'), original);
  const oversized = Buffer.alloc(1024 * 1024 + 1, 32);
  await writeFile(join(root, name), oversized);
  await expect(environment.savePersonalApiKey('nvapi-new', { directory: root })).rejects.toThrow(/save/i);
  expect((await readFile(join(root, name))).equals(oversized)).toBe(true);
  if (name === '.env.bak') expect(await readFile(join(root, '.env'), 'utf8')).toBe(original);
});

it.each(['.env', '.env.bak'])('rejects a symbolic link at %s without writing through it', async (name, context) => {
  const target = join(root, 'target'); await mkdir(target);
  await writeFile(join(target, 'keep'), 'unchanged');
  if (name === '.env.bak') await writeFile(join(root, '.env'), 'NVIDIA_API_KEY=original\n');
  try { await symlink(target, join(root, name), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; }
    throw error;
  }
  await expect(environment.savePersonalApiKey('nvapi-new', { directory: root })).rejects.toThrow(/save/i);
  expect(await readFile(join(target, 'keep'), 'utf8')).toBe('unchanged');
  if (name === '.env.bak') expect(await readFile(join(root, '.env'), 'utf8')).toBe('NVIDIA_API_KEY=original\n');
});

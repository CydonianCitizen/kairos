import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readLastModel, rememberModel } from '../src/config/model-preferences.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'kairos-preferences-')); });
afterEach(async () => {
  vi.unstubAllEnvs();
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'kairos-preferences-')) throw new Error('Unexpected test directory');
  await rm(root, { recursive: true, force: true });
});

it('remembers a valid selected model durably without creating a personal config file', async () => {
  const directory = join(root, 'preferences');
  await rememberModel('custom/model', { directory });
  expect(await readLastModel({ directory })).toBe('custom/model');
  const state = JSON.parse(await readFile(join(directory, 'last-model.json'), 'utf8'));
  expect(state).toMatchObject({ version: 1, model: 'custom/model' });
  expect(Number.isFinite(Date.parse(state.updatedAt))).toBe(true);
  expect(Object.keys(state).sort()).toEqual(['model', 'updatedAt', 'version']);
  expect(await readdir(directory)).toEqual(['last-model.json']);
});

it('uses the personal directory by default and supports an explicit fixture file', async () => {
  vi.stubEnv('HOME', root); vi.stubEnv('USERPROFILE', root);
  expect(homedir()).toBe(root);
  await rememberModel('default/location');
  expect(await readLastModel()).toBe('default/location');
  expect(JSON.parse(await readFile(join(root, '.kairos', 'last-model.json'), 'utf8')).model).toBe('default/location');
  const path = join(root, 'custom', 'selected.json');
  await rememberModel('fixture/location', { path });
  expect(await readLastModel({ path })).toBe('fixture/location');
});

it('backs up the raw previous state and preserves unrelated existing fields', async () => {
  const path = join(root, 'last-model.json');
  const previous = '{ "version": 1, "model": "old/model", "updatedAt": "2026-11-01T00:00:00.000Z", "theme": "dark" }\n';
  await writeFile(path, previous);
  await writeFile(join(root, 'config.json'), '{"model":"configured/model"}\n');
  await rememberModel('new/model', { path });
  expect(await readFile(path + '.bak', 'utf8')).toBe(previous);
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1, model: 'new/model', theme: 'dark' });
  expect(await readFile(join(root, 'config.json'), 'utf8')).toBe('{"model":"configured/model"}\n');
  expect((await readdir(root)).sort()).toEqual(['config.json', 'last-model.json', 'last-model.json.bak']);
});

it('serializes overlapping saves so the final call wins and its backup is the previous selection', async () => {
  const path = join(root, 'last-model.json');
  await Promise.all(['first/model', 'second/model', 'last/model'].map(model => rememberModel(model, { path })));
  expect(await readLastModel({ path })).toBe('last/model');
  expect(JSON.parse(await readFile(path + '.bak', 'utf8')).model).toBe('second/model');
  expect((await readdir(root)).sort()).toEqual(['last-model.json', 'last-model.json.bak']);
});

it.skipIf(Number(process.versions.node.split('.')[0]) < 22)('reads a saved selection in a fresh process', async () => {
  const path = join(root, 'last-model.json');
  await rememberModel('fresh/process', { path });
  const moduleUrl = new URL('../src/config/model-preferences.ts', import.meta.url).href;
  const script = `import { readLastModel } from ${JSON.stringify(moduleUrl)}; process.stdout.write(await readLastModel({ path: process.argv[1] }) ?? '');`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, path]);
  expect(stdout).toBe('fresh/process');
});

it.each(['invalid', '', 'private-test-credential\n/model', 'https://example.com/model'])
('rejects invalid selections before changing an existing preference (%j)', async model => {
  const path = join(root, 'last-model.json');
  await rememberModel('original/model', { path });
  const original = await readFile(path, 'utf8');
  await expect(rememberModel(model, { path })).rejects.toThrow(/provider\/model/);
  expect(await readFile(path, 'utf8')).toBe(original);
});

it.each([
  'not JSON', '[]', 'null', '{"version":2,"model":"custom/model"}',
  '{"version":1,"model":"invalid"}', '{"version":1,"model":"custom/model","updatedAt":"invalid"}',
  ' '.repeat(32769),
])('ignores corrupt, unsupported or oversized remembered state (%#)', async text => {
  const path = join(root, 'last-model.json');
  await writeFile(path, text);
  expect(await readLastModel({ path })).toBeUndefined();
});

it('falls back on missing or unavailable state but surfaces save errors', async () => {
  const missing = join(root, 'missing.json');
  expect(await readLastModel({ path: missing })).toBeUndefined();
  const directory = join(root, 'directory.json'); await mkdir(directory);
  expect(await readLastModel({ path: directory })).toBeUndefined();
  await expect(rememberModel('custom/model', { path: directory })).rejects.toThrow(/save/i);
  expect(await readdir(root)).toEqual(['directory.json']);
});

it('backs up a corrupt state before replacing it with a valid selection', async () => {
  const path = join(root, 'last-model.json');
  await writeFile(path, '{"broken":');
  await rememberModel('custom/model', { path });
  expect(await readFile(path + '.bak', 'utf8')).toBe('{"broken":');
  expect(await readLastModel({ path })).toBe('custom/model');
});

it('preserves the original selection if its backup cannot be replaced and allows a later retry', async () => {
  const path = join(root, 'last-model.json');
  await rememberModel('original/model', { path });
  const original = await readFile(path, 'utf8');
  await mkdir(path + '.bak');
  await expect(rememberModel('failed/model', { path })).rejects.toThrow(/save/i);
  expect(await readFile(path, 'utf8')).toBe(original);
  expect((await readdir(root)).sort()).toEqual(['last-model.json', 'last-model.json.bak']);
  await rm(path + '.bak', { recursive: true });
  await rememberModel('retry/model', { path });
  expect(await readLastModel({ path })).toBe('retry/model');
});

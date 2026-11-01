import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RewindStore } from '../src/core/rewind-store.js';
import type { SessionState } from '../src/core/session-store.js';

const state: SessionState = { messages: [{ role: 'user', content: 'Earlier' }], memory: 'summary', model: 'test/model', mode: 'build' };
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'kairos-checkpoints-')); return { root, directory: join(root, 'rewinds') }; }

it('reopens workspace/session scoped turn-start snapshots without sharing mutable state', async () => {
  const { root, directory } = await fixture(); const store = new RewindStore(root, 'one', directory);
  const original = structuredClone(state); const point = await store.capture('First', original);
  original.messages.push({ role: 'user', content: 'Later mutation' }); point.state.memory = 'changed';
  const reopened = new RewindStore(root, 'one', directory);
  expect((await reopened.get(point.id)).state).toEqual(state);
  expect(await reopened.list()).toEqual([{ id: point.id, prompt: 'First', createdAt: point.createdAt }]);
  expect(await new RewindStore(root, 'two', directory).list()).toEqual([]);
});

it('retains discarded edit owners across conversation rewind, restart and a new branch of turns', async () => {
  const { root, directory } = await fixture(); const store = new RewindStore(root, 'scope', directory);
  const first = await store.capture('First', state); const second = await store.capture('Second', state);
  const third = await store.capture('Third', state); await store.truncateAfter(first.id);
  const reopened = new RewindStore(root, 'scope', directory); const fourth = await reopened.capture('Fourth', state);
  expect(await reopened.ownersFrom(first.id)).toEqual(expect.arrayContaining([first.id, second.id, third.id, fourth.id]));
  expect((await reopened.list()).map(point => point.prompt)).toEqual(['First', 'Fourth']);
  await expect(reopened.get(second.id)).rejects.toThrow(/not found/i);
});

it('keeps the latest hundred checkpoints and rejects oversized or invalid snapshots before replacement', async () => {
  const { root } = await fixture(); const store = new RewindStore(root, 'memory');
  for (let index = 0; index < 102; index++) await store.capture(String(index), state);
  expect((await store.list()).map(point => point.prompt)).toEqual(Array.from({ length: 100 }, (_, index) => String(index + 2)));
  await expect(store.capture('bad', { ...state, mode: 'invalid' as never })).rejects.toThrow(/session/i);
  await expect(store.capture('large', { ...state, memory: 'x'.repeat(33 * 1024 * 1024) })).rejects.toThrow(/32 MiB/);
  expect((await store.list()).at(-1)?.prompt).toBe('101');
});

it('preserves a prior backup and refuses to overwrite a corrupt checkpoint file', async () => {
  const { root, directory } = await fixture(); const store = new RewindStore(root, 'scope', directory);
  const first = await store.capture('First', state); await store.capture('Second', state);
  const subdir = join(directory, (await readdir(directory))[0]!);
  const file = join(subdir, (await readdir(subdir)).find(name => name.endsWith('.json'))!);
  const backup = await readFile(`${file}.bak`, 'utf8'); expect(backup).toContain(first.id);
  await writeFile(file, '{ broken');
  await expect(new RewindStore(root, 'scope', directory).capture('Third', state)).rejects.toThrow(/corrupt|unreadable/);
  expect(await readFile(file, 'utf8')).toBe('{ broken'); expect(await readFile(`${file}.bak`, 'utf8')).toBe(backup);
});

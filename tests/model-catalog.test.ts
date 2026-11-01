import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { loadModelCatalog } from '../src/core/model-catalog.js';
import { MODELS } from '../src/config/models.js';

let root: string;
let cachePath: string;
const now = Date.UTC(2026, 9, 31);
const day = 24 * 60 * 60 * 1000;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'kairos-models-')); cachePath = join(root, 'models.json'); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const remote = (...value: string[]) => ({ listModels: vi.fn(async () => ({ ok: true as const, value })) });

it('downloads and caches chat candidates, keeping verified presets first without guessing new capabilities', async () => {
  const client = remote('future/new-coder', 'nvidia/embed-new', MODELS[0].id, 'future/new-coder', 'nvidia/reranker-v2', 'nvidia/content-safety', 'bad\x1b[2J/id');
  const result = await loadModelCatalog(client, { cachePath, now });
  expect(result).toMatchObject({ source: 'remote', updatedAt: now, models: [MODELS[0].id, 'future/new-coder'] });
  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  expect(cache).toMatchObject({ version: 1, checkedAt: now, updatedAt: now, models: result.models });
  expect(MODELS.some(model => String(model.id) === 'future/new-coder')).toBe(false);
});
it('does not fetch again within 24 hours, then replaces the catalog with a fresh response', async () => {
  const first = remote('future/old-model'); await loadModelCatalog(first, { cachePath, now });
  const second = remote('future/new-model');
  expect(await loadModelCatalog(second, { cachePath, now: now + day - 1 })).toMatchObject({ source: 'cache', models: ['future/old-model'] });
  expect(second.listModels).not.toHaveBeenCalled();
  expect(await loadModelCatalog(second, { cachePath, now: now + day })).toMatchObject({ source: 'remote', models: ['future/new-model'] });
  expect(second.listModels).toHaveBeenCalledTimes(1);
});
it('keeps stale models after a failed refresh and records the attempt to avoid repeated startup calls', async () => {
  await loadModelCatalog(remote('future/working-model'), { cachePath, now });
  const client = { listModels: vi.fn(async () => ({ ok: false as const, error: 'Offline', status: 503 })) };
  expect(await loadModelCatalog(client, { cachePath, now: now + day })).toMatchObject({ source: 'cache', updatedAt: now, models: ['future/working-model'] });
  expect(await loadModelCatalog(client, { cachePath, now: now + day + 1 })).toMatchObject({ source: 'cache' });
  expect(client.listModels).toHaveBeenCalledTimes(1);
});
it('falls back to bundled models on first failure, corrupt cache or empty/unusable responses', async () => {
  await writeFile(cachePath, '{broken json');
  const result = await loadModelCatalog(remote('nvidia/embed-1b', 'not-a-model'), { cachePath, now });
  expect(result).toMatchObject({ source: 'bundled', updatedAt: null, models: MODELS.map(model => model.id) });
  const client = remote('future/fresh');
  expect(await loadModelCatalog(client, { cachePath, now: now + 1 })).toMatchObject({ source: 'bundled' });
  expect(client.listModels).not.toHaveBeenCalled();
});
it('ignores future timestamps and still returns live models when cache writes fail', async () => {
  await writeFile(cachePath, JSON.stringify({ version: 1, checkedAt: now + day, updatedAt: now + day, models: ['future/stale'] }));
  expect(await loadModelCatalog(remote('future/current'), { cachePath, now })).toMatchObject({ source: 'remote', models: ['future/current'] });
  const blocker = join(root, 'file'); await writeFile(blocker, 'not a directory');
  expect(await loadModelCatalog(remote('future/usable'), { cachePath: join(blocker, 'models.json'), now })).toMatchObject({ source: 'remote', models: ['future/usable'] });
});

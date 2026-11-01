import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { MODELS } from '../config/models.js';
import type { NimClient } from './nim-client.js';

const DAY = 24 * 60 * 60 * 1000;
export const defaultModelCachePath = () => join(homedir(), '.nim-codex', 'models.json');
export interface ModelCatalog {
  models: string[];
  checkedAt: number;
  updatedAt: number | null;
  source: 'remote' | 'cache' | 'bundled';
}
interface Cache { version: 1; checkedAt: number; updatedAt: number | null; models: string[] }

function candidates(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 5000) throw new Error('Invalid model list');
  // The endpoint has no capability metadata: exclude obvious non-chat families only.
  const ids = new Set(raw.filter((id): id is string => typeof id === 'string' && id.length <= 200 && /^[\w.-]+\/[\w.-]+$/.test(id)
    && !/embed|rerank|reward|guard|safety|parse|clip|detector|deplot|riva-|ising-|diffusion/i.test(id.split('/')[1]!)));
  if (!ids.size) throw new Error('No chat candidates in catalog');
  const preferred = MODELS.map(model => model.id).filter(id => ids.delete(id));
  return [...preferred, ...[...ids].sort()];
}

async function readCache(path: string, now: number): Promise<Cache | undefined> {
  try {
    if ((await stat(path)).size > 1024 * 1024) return;
    const value = JSON.parse(await readFile(path, 'utf8')) as Cache;
    if (value.version !== 1 || !Number.isSafeInteger(value.checkedAt) || value.checkedAt < 0 || value.checkedAt > now
      || (value.updatedAt !== null && (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 || value.updatedAt > value.checkedAt))) return;
    return { version: 1, checkedAt: value.checkedAt, updatedAt: value.updatedAt, models: candidates(value.models) };
  } catch { return; }
}

async function saveCache(path: string, value: Cache): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** One metadata check per 24 hours on TUI startup; failures preserve the last useful list. */
export async function loadModelCatalog(client: Pick<NimClient, 'listModels'>,
  { cachePath = defaultModelCachePath(), now = Date.now(), signal }: { cachePath?: string; now?: number; signal?: AbortSignal } = {}): Promise<ModelCatalog> {
  const cached = await readCache(cachePath, now);
  const fallback: ModelCatalog = {
    models: cached?.models ?? MODELS.map(model => model.id), checkedAt: cached?.checkedAt ?? now,
    updatedAt: cached?.updatedAt ?? null, source: cached?.updatedAt !== undefined && cached.updatedAt !== null ? 'cache' : 'bundled',
  };
  if (cached && now - cached.checkedAt < DAY) return fallback;
  let catalog = { ...fallback, checkedAt: now };
  try {
    const result = await client.listModels(signal);
    if (result.ok) catalog = { models: candidates(result.value), checkedAt: now, updatedAt: now, source: 'remote' };
  } catch { /* Keep startup usable when discovery fails or returns malformed data. */ }
  await saveCache(cachePath, { version: 1, checkedAt: catalog.checkedAt, updatedAt: catalog.updatedAt, models: catalog.models }).catch(() => {});
  return catalog;
}

import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EFFORTS, effortLevels, validateEffort, type Effort } from './effort.js';
import { DEFAULT_MODEL } from './models.js';
import { readLastModel } from './model-preferences.js';
import { validatePermissionRules, type PermissionRules } from '../core/permissions.js';
import type { WorkspaceScope } from '../tools/fs-tools.js';

export interface Settings {
  model?: string;
  effort?: Effort;
  timeoutMs?: number;
  systemPrompt?: string;
  permissions?: PermissionRules;
  memory?: boolean;
  sandbox?: 'off' | 'required';
  scope?: WorkspaceScope;
}
export interface SettingsOverrides {
  model?: string;
  effort?: Effort;
  timeoutMs?: number;
  systemPromptFile?: string;
  permissions?: PermissionRules;
  memory?: boolean;
  sandbox?: 'off' | 'required';
  scope?: WorkspaceScope;
}
export interface SettingsOptions { trustWorkspace?: boolean; overrides?: SettingsOverrides }
const MAX_BYTES = 32 * 1024;
const KEYS = ['model', 'effort', 'timeoutMs', 'systemPromptFile', 'permissions', 'memory', 'sandbox', 'scope'] as const;
export const EXTENSION_CONFIG_KEYS = ['plugins', 'mcpServers'] as const;

async function readText(file: string, label: string, optional = false): Promise<string | undefined> {
  const handle = await open(file, 'r').catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === 'ENOENT') return undefined;
    throw new Error(`Cannot read ${label}`);
  });
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${label} must be a regular file`);
    if (info.size > MAX_BYTES) throw new Error(`${label} exceeds 32 KiB`);
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new Error(`${label} exceeds 32 KiB`);
    return buffer.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}

function validateSettings(value: unknown, label: string, allowUndefined = false, personal = false): SettingsOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !KEYS.some(allowed => allowed === key) && !(personal && EXTENSION_CONFIG_KEYS.some(allowed => allowed === key)))) throw new Error(`${label} contains an unsupported setting; allowed: ${[...KEYS, ...(personal ? EXTENSION_CONFIG_KEYS : [])].join(', ')}`);
  const result: SettingsOverrides = {};
  for (const key of KEYS) {
    if (!Object.hasOwn(data, key) || (allowUndefined && data[key] === undefined)) continue;
    const item = data[key];
    if (key === 'model') {
      if (typeof item !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(item)) throw new Error(`${label}: model must be provider/model`);
      result.model = item;
    } else if (key === 'effort') {
      if (!EFFORTS.some(effort => effort === item)) throw new Error(`${label}: effort must be ${EFFORTS.join(', ')}`);
      result.effort = item as Effort;
    } else if (key === 'timeoutMs') {
      if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1 || item > 2147483647) throw new Error(`${label}: timeoutMs must be an integer from 1 to 2147483647`);
      result.timeoutMs = item;
    } else if (key === 'systemPromptFile') {
      if (typeof item !== 'string' || !item.trim() || item.includes('\0')) throw new Error(`${label}: systemPromptFile must be a nonempty file path`);
      result.systemPromptFile = item;
    } else if (key === 'memory') {
      if (typeof item !== 'boolean') throw new Error(`${label}: memory must be a boolean`);
      result.memory = item;
    } else if (key === 'sandbox') {
      if (item !== 'off' && item !== 'required') throw new Error(`${label}: sandbox must be off or required`);
      result.sandbox = item;
    } else if (key === 'scope') {
      if (!['none', 'read-only', 'workspace', 'full'].includes(item as string)) throw new Error(`${label}: scope must be none, read-only, workspace or full`);
      result.scope = item as WorkspaceScope;
    } else {
      try { result.permissions = validatePermissionRules(item, allowUndefined); }
      catch { throw new Error(`${label}: invalid permission rules`); }
    }
  }
  return result;
}

async function readSettings(file: string, label: string, personal = false): Promise<SettingsOverrides> {
  const text = await readText(file, label, true);
  if (text === undefined) return {};
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error(`${label} contains invalid JSON`); }
  return validateSettings(data, label, false, personal);
}

function isWithin(root: string, file: string): boolean {
  const path = relative(root, file);
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep);
}

async function workspaceFile(file: string, workspace: string): Promise<string | undefined> {
  if (!isWithin(resolve(workspace), resolve(file))) throw new Error('Workspace settings and prompt files must remain inside the workspace');
  const canonical = await realpath(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new Error('Cannot resolve workspace settings or prompt file');
  });
  if (canonical === undefined) return undefined;
  if (!isWithin(await realpath(workspace), canonical)) throw new Error('Workspace settings and prompt files must remain inside the workspace');
  return canonical;
}

export async function loadSettings(workspace: string, options: SettingsOptions = {}): Promise<Settings> {
  const personalDirectory = join(homedir(), '.kairos');
  const personal = await readSettings(join(personalDirectory, 'config.json'), 'Personal settings (~/.kairos/config.json)', true);
  const projectDirectory = join(resolve(workspace), '.kairos');
  let project: SettingsOverrides = {};
  if (options.trustWorkspace) {
    const file = await workspaceFile(join(projectDirectory, 'config.json'), workspace);
    if (file) project = await readSettings(file, 'Workspace settings (.kairos/config.json)');
  }
  const overrides = validateSettings(options.overrides ?? {}, 'CLI settings', true);
  const rememberedModel = await readLastModel();
  const model = overrides.model ?? project.model ?? rememberedModel ?? personal.model;
  const { timeoutMs, memory, sandbox, scope } = { ...personal, ...project, ...overrides };
  let effort = overrides.effort ?? project.effort ?? personal.effort;
  if ((model ?? DEFAULT_MODEL) !== (personal.model ?? DEFAULT_MODEL) && overrides.effort === undefined && project.effort === undefined
    && effort !== undefined && !effortLevels(model ?? DEFAULT_MODEL).includes(effort)) effort = 'auto';
  if (effort !== undefined) validateEffort(model ?? DEFAULT_MODEL, effort);
  const result: Settings = { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(memory !== undefined ? { memory } : {}), ...(sandbox !== undefined ? { sandbox } : {}), ...(scope !== undefined ? { scope } : {}) };
  if (personal.permissions !== undefined || project.permissions !== undefined || overrides.permissions !== undefined) {
    const layers = [personal.permissions, project.permissions, overrides.permissions];
    const permissions = { ...personal.permissions, ...project.permissions, ...overrides.permissions };
    // Appending preserves personal deny patterns even when a trusted project supplies an empty array.
    if (layers.some(layer => layer?.rules !== undefined)) permissions.rules = layers.flatMap(layer => layer?.rules ?? []);
    result.permissions = validatePermissionRules(permissions);
  }
  let promptFile = join(personalDirectory, 'system-prompt.md');
  let explicit = false;
  if (overrides.systemPromptFile !== undefined) { promptFile = resolve(workspace, overrides.systemPromptFile); explicit = true; }
  else if (project.systemPromptFile !== undefined) {
    const file = await workspaceFile(resolve(projectDirectory, project.systemPromptFile), workspace);
    if (!file) throw new Error('Cannot read workspace system prompt');
    promptFile = file; explicit = true;
  } else if (personal.systemPromptFile !== undefined) { promptFile = resolve(personalDirectory, personal.systemPromptFile); explicit = true; }
  const systemPrompt = await readText(promptFile, 'System prompt', !explicit);
  if (systemPrompt !== undefined) result.systemPrompt = systemPrompt;
  return result;
}

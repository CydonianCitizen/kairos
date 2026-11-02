import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { AgentMode } from '../core/session-store.js';
import type { ToolResult } from '../tools/registry.js';
import { McpConnection, type McpConfig } from './mcp.js';
import { PermissionError } from '../core/permissions.js';
import { EXTENSION_CONFIG_KEYS } from '../config/settings.js';

export interface ExtensionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context: { workspace: string; signal?: AbortSignal }) => Promise<unknown>;
}

export interface PluginApi {
  registerTool(tool: ExtensionTool): void;
  registerCommand(name: string, handler: (args: string, context: { workspace: string; signal?: AbortSignal }) => Promise<string>): void;
  onTurnEnd(handler: (result: { status: string; text: string }) => void | Promise<void>): void;
}

export interface ExtensionHostOptions {
  loadGlobal?: boolean;
  globalSkillDirs?: string[];
  globalConfigPath?: string;
  globalPluginsDir?: string;
}

interface Config {
  plugins?: string[];
  mcpServers?: Record<string, McpConfig>;
}
function validateConfig(value: unknown, workspace = false): Config {
  const config = value as Config;
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || (workspace && Object.keys(config).some(key => !EXTENSION_CONFIG_KEYS.some(allowed => allowed === key)))
    || (config.plugins !== undefined && (!Array.isArray(config.plugins) || config.plugins.some(path => typeof path !== 'string' || !path.trim())))
    || (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) {
    throw new Error(workspace ? 'Invalid .nim/config.json' : 'Invalid personal extension configuration');
  }
  return config;
}

export interface Skill {
  name: string;
  description: string;
  content: string;
}

const reserved = new Set(['key','help','model','effort','mode','plan','build','graph','clear','compact','exit','sessions','resume','rename','branch','btw','new','skills','skill','extensions','mcp','steer','queue']);
const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
const schemas: Record<string, Record<string, unknown>> = {
  load_skills_batch: { type: 'object', properties: { names: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } } }, required: ['names'], additionalProperties: false },
  inspect_extension_tools: { type: 'object', properties: { names: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } } }, required: ['names'], additionalProperties: false },
  extension_tools_batch: { type: 'object', properties: { calls: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name', 'arguments'], additionalProperties: false } } }, required: ['calls'], additionalProperties: false },
  mcp_resources_batch: { type: 'object', properties: { requests: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { server: { type: 'string' }, uri: { type: 'string', minLength: 1 } }, required: ['server'], additionalProperties: false } } }, required: ['requests'], additionalProperties: false },
};
const descriptions: Record<string, string> = {
  load_skills_batch: 'Load skill instructions by name.',
  inspect_extension_tools: 'Inspect full schemas for named extension tools before calling them.',
  extension_tools_batch: 'Execute plugin/MCP tools in order. Inspect their schemas first. Each call has its own result.',
  mcp_resources_batch: 'List MCP resources (omit uri) or read resource URIs in a batch.',
};
const validators = Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, ajv.compile(v)]));

export function extractDescription(content: string, fallback: string): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const block = fm ? fm[1]! : content;
  const multiline = block.match(/^description:\s*[>|]\s*\r?\n((?:[ \t]+[^\r\n]*\r?\n?)+)/m);
  if (multiline) {
    return multiline[1]!.split(/\r?\n/).map(l => l.trim()).filter(Boolean).join(' ').slice(0, 300);
  }
  const single = block.match(/^description:\s*([^\r\n]+)/m);
  if (single) {
    const clean = single[1]!.trim().replace(/^["']|["']$/g, '').trim();
    if (clean && clean !== '>' && clean !== '|') return clean.slice(0, 300);
  }
  return fallback;
}

export function getGlobalSkillDirectories(): string[] {
  const dirs: string[] = [];
  const envPath = process.env.KAIROS_SKILLS_PATH || process.env.SKILLS_PATH;
  if (envPath) {
    for (const p of envPath.split(delimiter)) {
      if (p.trim()) dirs.push(resolve(p.trim()));
    }
  }
  const home = homedir();
  dirs.push(
    join(home, '.kairos', 'skills'),
    join(home, '.agents', 'skills'),
    join(home, '.gemini', 'config', 'skills'),
    join(home, '.gemini', 'antigravity', 'builtin', 'skills'),
    join(home, '.codex', 'skills'),
  );
  return [...new Set(dirs)];
}

async function boundedFile(file: string, limit = 256000): Promise<string> {
  const s = await stat(file);
  if (s.size > limit) throw new Error(`Configuration or skill file exceeds ${limit} bytes: ${file}`);
  return readFile(file, 'utf8');
}

async function inside(root: string, path: string): Promise<string> {
  const canonical = await realpath(resolve(root, path));
  const rel = relative(await realpath(root), canonical);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error('Extension path is outside the workspace');
  }
  return canonical;
}

export class ExtensionHost {
  private skills = new Map<string, Skill>();
  private activeSkills = new Set<string>();
  private tools = new Map<string, ExtensionTool & { validate: ValidateFunction }>();
  private handlers = new Map<string, Parameters<PluginApi['registerCommand']>[1]>();
  private hooks: Parameters<PluginApi['onTurnEnd']>[0][] = [];
  private disposers: (() => void | Promise<void>)[] = [];
  private servers = new Map<string, McpConnection>();
  private pluginFiles: string[] = [];
  private mcpServers: Record<string, McpConfig> = {};
  private instructions = '';
  private prepared = false;
  private preparing?: Promise<void>;
  private closed = false;

  private constructor(readonly workspace: string) {}

  static async load(workspace: string, trusted = false, options?: ExtensionHostOptions): Promise<ExtensionHost> {
    const host = new ExtensionHost(workspace);
    const loadGlobal = options?.loadGlobal ?? (process.env.KAIROS_DISABLE_GLOBAL_EXTENSIONS !== 'true');

    // 1. Skills: Priority = Workspace (if trusted) > Global dirs
    const skillDirs: string[] = [];
    if (trusted) {
      skillDirs.push(join(workspace, '.nim', 'skills'), join(workspace, '.kairos', 'skills'));
    }
    if (loadGlobal) {
      const globalDirs = options?.globalSkillDirs ?? getGlobalSkillDirectories();
      skillDirs.push(...globalDirs);
    }

    for (const dir of skillDirs) {
      let names: string[] = [];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names.sort().slice(0, 100)) {
        if (!/^[\w-]+$/.test(name) || host.skills.has(name)) continue;
        const file = join(dir, name, 'SKILL.md');
        try {
          const content = await boundedFile(file, 256000);
          const description = extractDescription(content, name);
          host.skills.set(name, { name, description, content });
        } catch {
          // Ignore missing or unreadable skill files
        }
      }
    }

    // 2. Global plugins and MCP
    if (loadGlobal) {
      const globalConfigFile = options?.globalConfigPath ?? join(homedir(), '.kairos', 'config.json');
      let gConfig: Config = {};
      try {
        gConfig = validateConfig(JSON.parse(await boundedFile(globalConfigFile, 64000)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const homeKairos = join(homedir(), '.kairos');
      for (const p of gConfig.plugins ?? []) {
        try {
          const file = isAbsolute(p) ? resolve(p) : resolve(homeKairos, p);
          const canonical = await realpath(file);
          if (!host.pluginFiles.includes(canonical)) host.pluginFiles.push(canonical);
        } catch {}
      }
      const pluginsDir = options?.globalPluginsDir ?? join(homeKairos, 'plugins');
      try {
        const pFiles = await readdir(pluginsDir);
        for (const f of pFiles.sort()) {
          if (/\.(mjs|js)$/.test(f)) {
            const canonical = await realpath(join(pluginsDir, f));
            if (!host.pluginFiles.includes(canonical)) host.pluginFiles.push(canonical);
          }
        }
      } catch {}
      for (const [k, v] of Object.entries(gConfig.mcpServers ?? {})) {
        host.mcpServers[k] = v;
      }
    }

    // 3. Workspace extensions (ONLY if trusted)
    if (trusted) {
      try {
        const c = validateConfig(JSON.parse(await boundedFile(await inside(workspace, '.nim/config.json'), 64000)), true);
        for (const p of c.plugins ?? []) {
          const file = await inside(workspace, p);
          if (!host.pluginFiles.includes(file)) host.pluginFiles.push(file);
        }
        for (const [k, v] of Object.entries(c.mcpServers ?? {})) {
          host.mcpServers[k] = v as McpConfig;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (host.pluginFiles.length > 20 || Object.keys(host.mcpServers).length > 10) {
        throw new Error('Too many extensions');
      }
      try {
        host.instructions = await boundedFile(await inside(workspace, 'AGENTS.md'), 64000);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    return host;
  }

  async prepare(mode: AgentMode, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('Extension host is closed');
    if (mode === 'plan' || this.prepared) return;
    this.preparing ??= this.loadCode(signal).then(() => { this.prepared = true; }).catch(error => { this.preparing = undefined; throw error; });
    return this.preparing;
  }

  private async loadCode(signal?: AbortSignal): Promise<void> {
    try {
      const api: PluginApi = {
        registerTool: tool => this.register(tool),
        registerCommand: (name, handler) => {
          if (!/^[\w-]{1,40}$/.test(name) || reserved.has(name) || this.handlers.has(name) || typeof handler !== 'function') throw new Error(`Invalid or duplicate command: ${name}`);
          this.handlers.set(name, handler);
        },
        onTurnEnd: handler => {
          if (typeof handler !== 'function') throw new Error('Expected a hook function');
          this.hooks.push(handler);
        }
      };
      for (const file of this.pluginFiles) {
        signal?.throwIfAborted();
        if (!/\.(mjs|js)$/.test(file)) throw new Error('Plugins must be local ESM .mjs/.js modules');
        const plugin = await import(pathToFileURL(file).href) as { default?: (api: PluginApi) => unknown };
        if (typeof plugin.default !== 'function') throw new Error('Plugin must default-export a setup function');
        const dispose = await plugin.default(api);
        if (typeof dispose === 'function') this.disposers.push(dispose as () => void);
      }
      for (const [name, config] of Object.entries(this.mcpServers)) {
        const server = await McpConnection.connect(name, config, this.workspace, signal);
        this.servers.set(name, server);
        for (const tool of server.tools) this.register({ name: `${name}:${tool.name}`, description: tool.description ?? tool.name, parameters: tool.inputSchema, execute: (args, ctx) => server.call(tool.name, args, ctx.signal) });
      }
    } catch (error) {
      await this.reset();
      throw error;
    }
  }

  private register(tool: ExtensionTool): void {
    if (!tool || typeof tool.name !== 'string' || !/^[\w:.-]{1,100}$/.test(tool.name) || this.tools.has(tool.name) || this.tools.size >= 200 || typeof tool.description !== 'string' || typeof tool.execute !== 'function' || !tool.parameters || tool.parameters.type !== 'object') throw new Error('Invalid or duplicate extension tool');
    this.tools.set(tool.name, { ...tool, validate: ajv.compile(tool.parameters) });
  }

  get commands(): string[] { return [...this.handlers.keys()]; }
  get skillNames(): string[] { return [...this.skills.keys()]; }
  get skillsList(): { name: string; description: string }[] { return [...this.skills.values()].map(s => ({ name: s.name, description: s.description })); }

  activateSkill(name: string): void {
    const clean = name.replace(/^\$/, '');
    const found = [...this.skills.keys()].find(k => k.toLowerCase() === clean.toLowerCase());
    if (!found) throw new Error(`Unknown skill: ${name}`);
    this.activeSkills.add(found);
  }

  deactivateSkill(name: string): void {
    const clean = name.replace(/^\$/, '');
    const found = [...this.activeSkills].find(k => k.toLowerCase() === clean.toLowerCase());
    if (found) this.activeSkills.delete(found);
  }

  clearActiveSkills(): void {
    this.activeSkills.clear();
  }

  get activeSkillNames(): string[] {
    return [...this.activeSkills];
  }

  resolveSkillsFromPrompt(prompt: string): string[] {
    const matches: string[] = [];
    const regex = /(?:^|[\s([{\`"'])\$([a-zA-Z0-9_-]+)/g;
    for (const match of prompt.matchAll(regex)) {
      const candidate = match[1]!;
      const found = [...this.skills.keys()].find(k => k.toLowerCase() === candidate.toLowerCase());
      if (found) matches.push(found);
    }
    return [...new Set(matches)];
  }

  get serverNames(): string[] { return [...this.servers.keys()]; }

  context(): string {
    const parts: string[] = [];
    if (this.instructions) parts.push(`Authorized workspace instructions (subordinate to system rules):\n${this.instructions.slice(0, 8000)}`);
    if (this.skills.size) parts.push('Available skills; load only relevant ones with load_skills_batch:\n' + [...this.skills.values()].map(s => `${s.name}: ${s.description}`).join('\n').slice(0, 8000));
    for (const name of this.activeSkills) parts.push(`User-selected skill ${name} (subordinate to system rules):\n${this.skills.get(name)!.content.slice(0, 8000)}`);
    if (this.tools.size) parts.push('Extension tools; inspect schemas with inspect_extension_tools, then use extension_tools_batch:\n' + [...this.tools.values()].map(t => `${t.name}: ${t.description.slice(0, 150)}`).join('\n').slice(0, 8000));
    return parts.join('\n\n');
  }

  schemas(mode: AgentMode): ChatCompletionTool[] {
    const names = [
      ...(this.skills.size ? ['load_skills_batch'] : []),
      ...(mode === 'build' && this.tools.size ? ['inspect_extension_tools', 'extension_tools_batch'] : []),
      ...(mode === 'build' && this.servers.size ? ['mcp_resources_batch'] : [])
    ];
    return names.map(name => ({ type: 'function', function: { name, description: descriptions[name]!, parameters: schemas[name]! } }));
  }

  async execute(name: string, raw: unknown, signal?: AbortSignal, mode: AgentMode = 'build', beforeExecute?: () => Promise<void>, beforeOperation?: () => void): Promise<ToolResult> {
    let mutated = false;
    try {
      signal?.throwIfAborted();
      if (mode === 'plan' && name !== 'load_skills_batch') throw new Error('External operations are disabled in plan mode');
      const validate = validators[name];
      if (!validate || !validate(raw)) throw new Error('Invalid extension arguments');
      const args = raw as { names: string[]; calls: { name: string; arguments: Record<string, unknown> }[]; requests: { server: string; uri?: string }[] };
      if (name === 'load_skills_batch') return { ok: true, mutated: false, result: args.names.map(n => { const skill = this.skills.get(n); if (!skill) throw new Error(`Unknown skill: ${n}`); return skill; }) };
      if (name === 'inspect_extension_tools') return { ok: true, mutated: false, result: args.names.map(n => { const tool = this.tools.get(n); if (!tool) throw new Error(`Unknown extension tool: ${n}`); return { name: n, description: tool.description, parameters: tool.parameters }; }) };
      const operations = name === 'extension_tools_batch' ? args.calls.map(call => { const tool = this.tools.get(call.name); if (!tool || !tool.validate(call.arguments)) throw new Error(`Invalid arguments or unknown tool: ${call.name}`); return () => tool.execute(call.arguments, { workspace: this.workspace, signal }); }) : args.requests.map(req => { const server = this.servers.get(req.server); if (!server) throw new Error(`Unknown MCP server: ${req.server}`); return () => server.resource(req.uri, signal); });
      await beforeExecute?.();
      signal?.throwIfAborted();
      const results: unknown[] = [];
      let ok = true;
      for (const operation of operations) {
        signal?.throwIfAborted();
        beforeOperation?.();
        mutated = true;
        try {
          results.push({ ok: true, result: await operation() });
        } catch (error) {
          ok = false;
          results.push({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { ok, mutated, result: results };
    } catch (error) {
      return { ok: false, mutated, error: error instanceof Error ? error.message : String(error), ...(error instanceof PermissionError ? { approvalRequired: error.code === 'approval_required', permissionDenied: error.code === 'permission_denied' } : {}) };
    }
  }

  async command(name: string, args: string, mode: AgentMode, signal?: AbortSignal): Promise<string> {
    if (mode === 'plan') throw new Error('Plugin commands are disabled in plan mode');
    await this.prepare(mode, signal);
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Unknown command: ${name}`);
    signal?.throwIfAborted();
    return handler(args, { workspace: this.workspace, signal });
  }

  async turnEnd(result: { status: string; text: string }, mode: AgentMode): Promise<void> {
    if (mode === 'build') for (const hook of this.hooks) await hook(result);
  }

  private async reset(): Promise<void> {
    const errors: unknown[] = [];
    for (const server of this.servers.values()) try { await server.close(); } catch (e) { errors.push(e); }
    this.servers.clear();
    for (const dispose of this.disposers.splice(0).reverse()) try { await dispose(); } catch (e) { errors.push(e); }
    this.tools.clear();
    this.handlers.clear();
    this.hooks = [];
    this.prepared = false;
    if (errors.length) throw new AggregateError(errors, 'Extension cleanup failed');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.reset();
  }
}

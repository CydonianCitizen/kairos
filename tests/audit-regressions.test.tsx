import React from 'react';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { CompletionInput, NimResult } from '../src/core/nim-client.js';
import { AgentLoop } from '../src/core/agent-loop.js';
import { FsTools } from '../src/tools/fs-tools.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { RepoGraph } from '../src/graph/repo-graph.js';
import { PermissionGate } from '../src/core/permissions.js';
import { ExtensionHost } from '../src/extensions/host.js';
import { loadSettings } from '../src/config/settings.js';
import { UiController } from '../src/ui/controller.js';
import { ToolCallBadge, parseToolInfo } from '../src/ui/ToolCallBadge.js';
import { App } from '../src/ui/App.js';

let root: string;
let workspace: string;
const close: (() => Promise<void>)[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kairos-audit-fixes-'));
  workspace = join(root, 'workspace'); await mkdir(workspace);
});
afterEach(async () => {
  cleanup();
  try { for (const dispose of close.splice(0).reverse()) await dispose(); }
  finally {
    vi.unstubAllEnvs();
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('kairos-audit-fixes-')) throw new Error('Unexpected cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});
function chunk(delta: ChatCompletionChunk['choices'][number]['delta'], finish: 'stop' | 'tool_calls'): ChatCompletionChunk {
  return { id: 'audit', object: 'chat.completion.chunk', created: 0, model: 'test/model', choices: [{ index: 0, delta, finish_reason: finish }] };
}
class Client extends EventEmitter {
  requests: CompletionInput[] = [];
  async stream(input: CompletionInput): Promise<NimResult<ChatCompletionChunk[]>> {
    this.requests.push(structuredClone(input));
    return { ok: true, value: [chunk({ content: 'Done.' }, 'stop')] };
  }
}
function agent(options: Partial<ConstructorParameters<typeof AgentLoop>[0]> = {}) {
  const result = new AgentLoop({ workspace, client: new Client(), session: false, ...options });
  close.push(() => result.close()); return result;
}
function tools(scope: 'none' | 'read-only' | 'workspace' | 'full' = 'workspace') {
  const result = new FsTools(workspace, undefined, { scope, undoDirectory: join(root, 'undo') });
  close.push(() => result.close()); return result;
}

it('omits new repository context and references after switching to scope none', async () => {
  await writeFile(join(workspace, 'private.ts'), 'export function privateSymbol() { return "PRIVATE_BODY"; }');
  await writeFile(join(workspace, 'note.txt'), 'PRIVATE_REFERENCE');
  const client = new Client(); const instance = agent({ client });
  await instance.initialize(); instance.setScope('none');
  expect((await instance.run('Explain @file:note.txt')).status).toBe('completed');
  const sent = JSON.stringify(client.requests[0]);
  expect(sent).not.toContain('privateSymbol');
  expect(sent).not.toContain('PRIVATE_REFERENCE');
  expect(client.requests[0]?.tools).toEqual([]);
  expect(instance.graphSnapshot).toBeUndefined();
});

it.each(['none', 'read-only'] as const)('blocks background startup in scope %s before invocation', async scope => {
  const marker = join(workspace, 'invoked');
  const instance = agent({ scope, bashPath: process.execPath, shellInvocation: async () => {
    await writeFile(marker, 'called'); return { file: process.execPath, args: ['-e', ''], cwd: workspace };
  } });
  await expect(instance.startBackground('probe')).rejects.toThrow(/scope|disabled/i);
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects scope changes during an active agent turn', async () => {
  let started!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = new class extends Client {
    override async stream(input: CompletionInput) { started(); await gate; return super.stream(input); }
  }();
  const instance = agent({ client }); const work = instance.run('Inspect'); await ready;
  try { expect(() => instance.setScope('none')).toThrow(/busy/i); }
  finally { release(); await work; }
  instance.setScope('none'); expect(instance.graphSnapshot).toBeUndefined();
});

it('blocks background execution when scope changes during shell preparation', async () => {
  let started!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fs = new FsTools(workspace, process.execPath, { shellInvocation: async () => {
    started(); await gate;
    return { file: process.execPath, args: ['-e', "require('node:fs').writeFileSync('spawned.txt','bad')"], cwd: workspace };
  } });
  close.push(() => fs.close());
  const start = fs.background.start('probe'); await ready;
  fs.setScope('read-only'); release();
  await expect(start).rejects.toThrow(/disabled|scope/i);
  await expect(readFile(join(workspace, 'spawned.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['none', 'read-only'] as const)('invalidates prepared edits and undo when scope becomes %s', async scope => {
  await writeFile(join(workspace, 'a.txt'), 'before');
  const fs = tools();
  await fs.apply_edits_batch([{ path: 'a.txt', old_text: 'before', new_text: 'after' }]);
  const edit = await fs.prepare_edits_batch([{ path: 'a.txt', old_text: 'after', new_text: 'bad' }]);
  const undo = await fs.prepare_undo();
  fs.setScope(scope);
  expect((await edit.apply()).every(item => !item.ok)).toBe(true);
  expect((await undo.apply()).every(item => !item.ok)).toBe(true);
  expect((await fs.undoLast()).every(item => !item.ok)).toBe(true);
  expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('after');
});

it('invalidates prepared file rewind after scope becomes read-only', async () => {
  await writeFile(join(workspace, 'a.txt'), 'before');
  const fs = tools(); fs.setUndoOwner('turn');
  await fs.apply_edits_batch([{ path: 'a.txt', old_text: 'before', new_text: 'after' }]);
  const rewind = await fs.prepare_rewind(['turn']); fs.setScope('read-only');
  expect((await rewind.apply()).every(item => !item.ok)).toBe(true);
  expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('after');
});

async function extensionFixture() {
  await mkdir(join(workspace, '.nim'), { recursive: true });
  await writeFile(join(workspace, '.nim', 'plugin.mjs'), `import {writeFile} from 'node:fs/promises';import {join} from 'node:path';
export default api => api.registerTool({name:'write_marker',description:'Write a marker',parameters:{type:'object'},execute:async (_args,ctx)=>{await writeFile(join(ctx.workspace,'external.txt'),'changed');return 'done';}});`);
  await writeFile(join(workspace, '.nim', 'config.json'), JSON.stringify({ plugins: ['.nim/plugin.mjs'] }));
  const host = await ExtensionHost.load(workspace, true, { loadGlobal: false });
  close.push(() => host.close()); await host.prepare('build'); return host;
}

it('does not advertise or dispatch external effects in read-only scope', async () => {
  const host = await extensionFixture();
  const fs = tools(); const registry = new ToolRegistry(fs, () => new RepoGraph(workspace), host);
  const input = JSON.stringify({ calls: [{ name: 'write_marker', arguments: {} }] });
  expect((await registry.execute('extension_tools_batch', input)).ok).toBe(true);
  expect(await readFile(join(workspace, 'external.txt'), 'utf8')).toBe('changed');
  await unlink(join(workspace, 'external.txt')); fs.setScope('read-only');
  expect(registry.schemas('build').some(tool => tool.type === 'function' && tool.function.name === 'extension_tools_batch')).toBe(false);
  const result = await registry.execute('extension_tools_batch', input);
  expect(result.ok).toBe(false);
  await expect(readFile(join(workspace, 'external.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rechecks scope after an external batch approval completes', async () => {
  const host = await extensionFixture(); const fs = tools();
  const registry = new ToolRegistry(fs, () => new RepoGraph(workspace), host,
    new PermissionGate({ external: 'ask' }, async () => { fs.setScope('read-only'); return true; }));
  const result = await registry.execute('extension_tools_batch', JSON.stringify({ calls: [{ name: 'write_marker', arguments: {} }] }));
  expect(result.ok).toBe(false);
  await expect(readFile(join(workspace, 'external.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('loads settings and extensions from the same personal configuration', async () => {
  const home = join(root, 'home'); await mkdir(join(home, '.kairos'), { recursive: true });
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  await writeFile(join(home, '.kairos', 'plugin.mjs'), "export default api => api.registerCommand('hello',async()=> 'personal plugin');");
  await writeFile(join(home, '.kairos', 'config.json'), JSON.stringify({ model: 'custom/model', plugins: ['plugin.mjs'], mcpServers: {} }));
  expect(await loadSettings(workspace)).toEqual({ model: 'custom/model' });
  const host = await ExtensionHost.load(workspace, false, { loadGlobal: true, globalSkillDirs: [], globalPluginsDir: join(home, 'missing') });
  close.push(() => host.close());
  expect(await host.command('hello', '', 'build')).toBe('personal plugin');
});

it('allows approved external edits in full scope and journals their undo', async () => {
  const path = join(root, 'outside.txt'); await writeFile(path, 'before');
  const fs = tools('full'); const approvals: string[] = [];
  const gate = new PermissionGate({ edits: 'ask' }, async request => { approvals.push(request.preview); return true; });
  const registry = new ToolRegistry(fs, () => new RepoGraph(workspace), undefined, gate);
  const result = await registry.execute('apply_edits_batch', JSON.stringify({ edits: [{ path, old_text: 'before', new_text: 'after' }] }));
  expect(result.ok).toBe(true); expect(approvals.join('')).toContain('-before');
  expect(await readFile(path, 'utf8')).toBe('after');
  expect((await fs.undoLast()).every(item => item.ok)).toBe(true);
  expect(await readFile(path, 'utf8')).toBe('before');
});

it('keeps deny policies and workspace containment effective for external edits', async () => {
  const path = join(root, 'outside.txt'); await writeFile(path, 'before');
  for (const [scope, policy] of [
    ['workspace', { edits: 'allow' }],
    ['full', { edits: 'deny' }],
    ['full', { edits: 'allow', rules: [{ kind: 'edits', mode: 'deny', pattern: '**/outside.txt' }] }],
  ] as const) {
    const gate = new PermissionGate(policy);
    const registry = new ToolRegistry(tools(scope), () => new RepoGraph(workspace), undefined, gate);
    expect((await registry.execute('apply_edits_batch', JSON.stringify({ edits: [{ path, old_text: 'before', new_text: 'bad' }] }))).ok).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('before');
  }
});

it('keeps unknown personal keys and malformed extension sections invalid', async () => {
  const home = join(root, 'home'); await mkdir(join(home, '.kairos'), { recursive: true });
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  const path = join(home, '.kairos', 'config.json');
  await writeFile(path, '{"unknown":true}');
  await expect(loadSettings(workspace)).rejects.toThrow(/unsupported setting/);
  for (const config of [{ plugins: 'plugin.mjs' }, { mcpServers: [] }, { mcpServers: null }]) {
    await writeFile(path, JSON.stringify(config));
    await expect(ExtensionHost.load(workspace, false, { loadGlobal: true, globalSkillDirs: [] })).rejects.toThrow(/Invalid personal extension configuration/);
  }
});

it.each([
  ['read_files_batch', { paths: 'abc' }],
  ['apply_edits_batch', { edits: [null] }],
  ['load_skills_batch', { names: 1 }],
  ['inspect_symbol_graph', { symbol_names: {} }],
  ['run_bash', { command: {} }],
  ['get_repo_map', { directory: {} }],
] as const)('renders a safe badge for malformed %s arguments', (name, args) => {
  const view = render(<ToolCallBadge tool={{ id: 'bad', name, arguments: JSON.stringify(args) }} />);
  expect(view.lastFrame()).toContain('running');
});

it('uses retained diffstats for both the latest tool and completed history', () => {
  const instance = agent(); const controller = new UiController(instance);
  close.push(() => controller.close());
  instance.emit('onToolStart', { id: 'edit', name: 'apply_edits_batch', arguments: '{"edits":[{"path":"a.txt"}]}' });
  instance.emit('onToolEnd', { id: 'edit', name: 'apply_edits_batch', result: { ok: true, mutated: true, result: [{ path: 'a.txt', ok: true, diff: '--- a/a.txt\n+++ b/a.txt\n-old\n+new\n' }] } });
  expect(parseToolInfo(controller.getSnapshot().lastTool!).detail).toBe('(+1 -1)');
  expect(parseToolInfo(controller.getSnapshot().history.at(-1)!.tool!).detail).toBe('(+1 -1)');
});

it('activates a queued skill only when its prompt starts, even if the queue is edited or cleared', async () => {
  await mkdir(join(workspace, '.nim', 'skills', 'beta'), { recursive: true });
  await writeFile(join(workspace, '.nim', 'skills', 'beta', 'SKILL.md'), '---\ndescription: Beta\n---\nBETA_BODY');
  const host = await ExtensionHost.load(workspace, true, { loadGlobal: false });
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const client = new class extends Client {
    override async stream(input: CompletionInput): Promise<NimResult<ChatCompletionChunk[]>> {
      if (!this.requests.length) {
        this.requests.push(structuredClone(input)); started(); await gate;
        return { ok: true, value: [chunk({ tool_calls: [{ index: 0, id: 'map', type: 'function', function: { name: 'get_repo_map', arguments: '{}' } }] }, 'tool_calls')] };
      }
      return super.stream(input);
    }
  }();
  const instance = agent({ client, extensions: host }); const controller = new UiController(instance);
  close.push(() => controller.close());
  const main = controller.submit('Main task'); await ready;
  try {
    const queued = controller.submit('$beta Future task');
    controller.interaction.clearQueue(); await queued;
  } finally { release(); await main; }
  expect(JSON.stringify(client.requests[1])).not.toContain('BETA_BODY');
  await controller.submit('$beta Current task');
  expect(JSON.stringify(client.requests.at(-1))).toContain('BETA_BODY');
});

it('shows the entire diff when /diff is explicitly requested', async () => {
  const instance = agent(); const controller = new UiController(instance);
  close.push(() => controller.close());
  await controller.start();
  const view = render(<App controller={controller} version="test" />);
  await new Promise(resolve => setTimeout(resolve, 80));
  instance.emit('onToolEnd', { id: 'edit', name: 'apply_edits_batch', result: { ok: true, mutated: true, result: [{ path: 'a.txt', ok: true, diff: Array.from({ length: 40 }, (_, i) => `+line ${i}${i === 39 ? ' DIFF_TAIL' : ''}`).join('\n') }] } });
  await controller.submit('/diff');
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(view.frames.join('\n')).toContain('DIFF_TAIL');
  view.unmount();
});

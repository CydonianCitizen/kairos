import { EventEmitter } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../src/core/agent-loop.js';
import { UiController } from '../src/ui/controller.js';
import { parseCliArgs } from '../src/cli-options.js';
import { ExtensionHost } from '../src/extensions/host.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'nim-ui-')); roots.push(root);
  await writeFile(join(root, 'math.ts'), 'export function sum() { return 1; }');
  const client = new class extends EventEmitter {
    count = 0;
    async stream() { this.count++; this.emit('onTokenStream', 'Hello'); return { ok: true as const, value: [{ id: 'x', object: 'chat.completion.chunk' as const, model: 'test', created: 0, choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' as const }] }] }; }
  }();
  const agent = new AgentLoop({ workspace: root, client });
  const controller = new UiController(agent);
  await controller.start();
  return { controller, agent, client };
}
it('executes slash commands locally, preserves scrollback and completes file/symbol mentions', async () => {
  const { controller, agent, client } = await setup();
  expect(controller.suggestions('Explain @su')).toContain('sum');
  expect(controller.suggestions('Read @ma')).toContain('math.ts');
  expect(controller.suggestions('Read @file:ma')).toContain('file:math.ts');
  expect(controller.suggestions('Read @symbol:su')).toContain('symbol:sum');
  expect(controller.commandSuggestions('/')).toHaveLength(31);
  expect(controller.commandSuggestions('/dif').map(item => item.name)).toEqual(['/diff']);
  expect(controller.commandSuggestions('/mod').map(item => item.name)).toEqual(['/model', '/mode']);
  expect(controller.commandSuggestions('/think').map(item => item.name)).toEqual(['/thinking']);
  expect(controller.commandSuggestions('/scop').map(item => item.name)).toEqual(['/scope']);
  expect(controller.commandSuggestions('/mode plan')).toEqual([]);
  await controller.submit('/thinking on');
  expect(controller.getSnapshot().showThinking).toBe(true);
  await controller.submit('/thinking off');
  expect(controller.getSnapshot().showThinking).toBe(false);
  await controller.submit('/thinking');
  expect(controller.getSnapshot().showThinking).toBe(true);
  await controller.submit('/scope read-only');
  expect(controller.getSnapshot().scope).toBe('read-only');
  expect(agent.scope).toBe('read-only');
  await controller.submit('/scope full');
  expect(controller.getSnapshot().scope).toBe('full');
  expect(agent.scope).toBe('full');
  await controller.submit('/help');
  const historyLength = controller.getSnapshot().history.length;
  await controller.submit('/model');
  expect(controller.getSnapshot().modelPickerOpen).toBe(true);
  expect(controller.getSnapshot().history).toHaveLength(historyLength);
  await controller.submit('/model meta/llama-3.3-70b-instruct');
  expect(agent.model).toBe('meta/llama-3.3-70b-instruct');
  expect(controller.getSnapshot().modelPickerOpen).toBe(false);
  await controller.submit('/graph');
  await controller.submit('/compact');
  expect(client.count).toBe(0);
  await controller.submit('Hello');
  const length = controller.getSnapshot().history.length;
  expect(controller.getSnapshot().history.some(e => e.kind === 'assistant' && e.text === 'Hello')).toBe(true);
  await controller.submit('/clear');
  expect(agent.messages).toEqual([]);
  expect(controller.getSnapshot().history.length).toBeGreaterThan(length);
  controller.dispose();
  expect(agent.listenerCount('onTokenStream')).toBe(0);
});
it('treats multiline slash-prefixed text as a prompt and retains search history after clear', async () => {
 const { controller, client } = await setup(); let exited = false;
 controller.on('exit', () => { exited = true; });
 try {
  await controller.submit('/exit\nExplain this command');
  expect(exited).toBe(false); expect(client.count).toBe(1);
  await controller.submit('/clear');
  expect(await controller.promptHistory()).toContain('/exit\nExplain this command');
 } finally { await controller.close(); }
});
it('opens effort selection, validates levels and resets unsupported choices on model changes', async () => {
  const { controller, agent, client } = await setup();
  await controller.submit('/effort');
  expect(controller.getSnapshot().effortPickerOpen).toBe(true);
  controller.cancel(); expect(controller.getSnapshot().effortPickerOpen).toBe(false);
  await controller.submit('/effort high'); expect(agent.effort).toBe('high');
  expect(controller.getSnapshot().effort).toBe('high');
  await controller.submit('/effort low');
  expect(agent.effort).toBe('high');
  expect(controller.getSnapshot().history.at(-1)?.kind).toBe('error');
  await controller.submit('/model minimaxai/minimax-m3.1-flash');
  expect(agent.effort).toBe('high');
  await controller.submit('/effort max'); expect(agent.effort).toBe('max');
  await controller.submit('/model custom/new-model'); expect(agent.effort).toBe('auto');
  expect(client.count).toBe(0); await controller.close();
});
it('dismisses the model picker with cancel or Ctrl+C without changing the model or exiting', async () => {
  const { controller, agent, client } = await setup();
  let exits = 0; controller.on('exit', () => exits++);
  const original = agent.model;
  await controller.submit('/model'); controller.cancel();
  expect(controller.getSnapshot().modelPickerOpen).toBe(false);
  await controller.submit('/model'); controller.cancelOrExit();
  expect(controller.getSnapshot().modelPickerOpen).toBe(false);
  expect(agent.model).toBe(original); expect(exits).toBe(0); expect(client.count).toBe(0);
  await controller.close();
});
it('refuses to open the model picker while work is active', async () => {
  const { controller, agent } = await setup();
  const original = agent.model;
  let release = () => {};
  const active = controller.interaction.action(() => new Promise<void>(resolve => { release = resolve; }));
  try {
    await controller.submit('/model');
    expect(controller.getSnapshot().modelPickerOpen).not.toBe(true);
    expect(controller.getSnapshot().history.at(-1)?.text).toContain('Command requires an idle agent');
    expect(agent.model).toBe(original);
    await controller.submit('/effort');
    expect(controller.getSnapshot().effortPickerOpen).not.toBe(true);
    await controller.submit('/effort high'); expect(agent.effort).toBe('auto');
  } finally { release(); await active; await controller.close(); }
});
it('rejects unknown slash commands without sending them to NIM', async () => {
  const { controller, client } = await setup();
  await controller.submit('/missing');
  expect(client.count).toBe(0);
  expect(controller.getSnapshot().history.at(-1)?.text).toContain('Unknown command');
  controller.dispose();
});
it('includes loaded plugin commands in the slash menu', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairos-plugin-menu-')); roots.push(root);
  await mkdir(join(root, '.nim'));
  await writeFile(join(root, '.nim', 'command.mjs'), "export default api => api.registerCommand('hello', async () => 'Hello from plugin');");
  await writeFile(join(root, '.nim', 'config.json'), JSON.stringify({ plugins: ['.nim/command.mjs'] }));
  const extensions = await ExtensionHost.load(root, true);
  const client = new class extends EventEmitter { async stream() { throw new Error('No NIM calls expected'); } }();
  const controller = new UiController(new AgentLoop({ workspace: root, extensions, client, session: false }));
  try {
    await controller.start();
    expect(controller.commandSuggestions('/hell')).toEqual([{ name: '/hello', description: 'Workspace plugin command' }]);
    await controller.submit('/hello');
    expect(controller.getSnapshot().history.at(-1)?.text).toBe('Hello from plugin');
  } finally { await controller.close(); }
});
it('lists skills and autocompletes /skill commands and $skill syntax', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairos-skills-menu-')); roots.push(root);
  await mkdir(join(root, '.nim', 'skills', 'caveman'), { recursive: true });
  await writeFile(join(root, '.nim', 'skills', 'caveman', 'SKILL.md'), '---\nname: caveman\ndescription: Terse voice\n---\nSpeak briefly.');
  const extensions = await ExtensionHost.load(root, true, { loadGlobal: false });
  const client = new class extends EventEmitter { async stream() { throw new Error('No NIM calls expected'); } }();
  const controller = new UiController(new AgentLoop({ workspace: root, extensions, client, session: false }));
  try {
    await controller.start();
    expect(controller.suggestions('/skill ')).toEqual(['/skill caveman']);
    expect(controller.suggestions('$ca')).toEqual(['$caveman']);
    expect(controller.suggestions('prompt $ca')).toEqual(['$caveman']);
    await controller.submit('/skills');
    expect(controller.getSnapshot().history.at(-1)?.text).toContain('caveman');
    expect(controller.getSnapshot().history.at(-1)?.text).toContain('Terse voice');
    await controller.submit('$caveman');
    expect(controller.getSnapshot().history.at(-1)?.text).toBe('Skill $caveman activated for the next turn.');
    expect(extensions.activeSkillNames).toContain('caveman');
    await controller.submit('/skill caveman');
    expect(controller.getSnapshot().history.at(-1)?.text).toBe('Skill $caveman added to the next turn context.');
  } finally { await controller.close(); }
});
it('parses CLI flags strictly and supports help without credentials', () => {
  expect(parseCliArgs(['--help']).help).toBe(true);
  expect(parseCliArgs(['--cwd', '.', '--model', 'meta/llama-3.3-70b-instruct', '--prompt', 'hello']).prompt).toBe('hello');
  expect(() => parseCliArgs(['--max-iterations', '0'])).toThrow();
  expect(() => parseCliArgs(['--unknown'])).toThrow();
});
it('does not retain complete file results in Static history and bounds the details preview', async () => {
  const { controller, agent } = await setup();
  agent.emit('onToolEnd', { id: 'read', name: 'read_files_batch', result: { ok: true, mutated: false, result: [{ path: 'large.ts', ok: true, content: 'x'.repeat(1000000) }] } });
  const state = controller.getSnapshot();
  expect(JSON.stringify(state.history.at(-1)).length).toBeLessThan(500);
  expect(JSON.stringify(state.lastTool).length).toBeLessThan(3000);
  controller.dispose();
});
it('accepts plan/session/RPC options and rejects incompatible output modes',()=>{
 expect(parseCliArgs(['--mode','plan','--rpc','--session-dir','./sessions','--trust-workspace'])).toMatchObject({mode:'plan',rpc:true,trustWorkspace:true});
 expect(()=>parseCliArgs(['--json','--rpc'])).toThrow();expect(()=>parseCliArgs(['--session','id','--no-session'])).toThrow();expect(()=>parseCliArgs(['--mode','unsafe'])).toThrow();
});
it('switches modes locally and queues an input while a turn is active',async()=>{
 const {controller,agent}=await setup();await controller.submit('/plan');expect(agent.mode).toBe('plan');await controller.submit('/build');expect(agent.mode).toBe('build');
 const a=controller.submit('one');const b=controller.submit('two');await Promise.all([a,b]);
 expect(controller.getSnapshot().history.filter(e=>e.kind==='user').map(e=>e.text)).toEqual(['one','two']);await controller.close();
});
it('preserves CoT reasoning in history when showThinking is enabled and streams to assistant text', async () => {
 const { controller, agent } = await setup();
 await controller.submit('/thinking on');
 expect(controller.getSnapshot().showThinking).toBe(true);
 agent.emit('onReasoningStream', 'Step 1: analyze.');
 agent.emit('onReasoningStream', '\nStep 2: implement.');
 expect(controller.getSnapshot().thinkingStream).toBe('Step 1: analyze.\nStep 2: implement.');
 agent.emit('onTokenStream', 'Here is the answer.');
 expect(controller.getSnapshot().thinkingStream).toBe('');
 expect(controller.getSnapshot().streaming).toBe('Here is the answer.');
 expect(controller.getSnapshot().history.some(e => e.kind === 'thinking' && e.text.includes('Step 1: analyze.'))).toBe(true);
 await controller.close();
});

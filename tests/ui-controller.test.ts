import { EventEmitter } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../src/core/agent-loop.js';
import { UiController } from '../src/ui/controller.js';
import { parseCliArgs } from '../src/cli-options.js';
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
  await controller.submit('/help');
  await controller.submit('/model');
  const catalog = controller.getSnapshot().history.at(-1)?.text;
  expect(catalog).toContain('Active: mistralai/mistral-large-4-1t-a52b');
  expect(catalog).toContain('z-ai/glm-5.3-flash');
  expect(catalog).toContain('minimaxai/minimax-m3.1-flash');
  expect(catalog).toContain('deepseek-ai/deepseek-v4.1-flash');
  expect(catalog).toContain('nvidia/nemotron-3.5-bolt-e4b');
  expect(catalog).not.toContain('deepseek-r1');
  await controller.submit('/model meta/llama-3.3-70b-instruct');
  expect(agent.model).toBe('meta/llama-3.3-70b-instruct');
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
it('rejects unknown slash commands without sending them to NIM', async () => {
  const { controller, client } = await setup();
  await controller.submit('/missing');
  expect(client.count).toBe(0);
  expect(controller.getSnapshot().history.at(-1)?.text).toContain('Unknown command');
  controller.dispose();
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

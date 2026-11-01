import React from 'react';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it } from 'vitest';
import { AgentLoop } from '../src/core/agent-loop.js';
import { UiController } from '../src/ui/controller.js';
import { App } from '../src/ui/App.js';
import type { CompletionInput } from '../src/core/nim-client.js';

const roots: string[] = [], controllers: UiController[] = [];
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
afterEach(async () => {
  cleanup(); for (const controller of controllers.splice(0)) await controller.close();
  for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'kairos-approval-ui-')) throw new Error('Unexpected fixture'); await rm(root, { recursive: true, force: true }); }
});
async function ready(predicate: () => boolean) {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await tick(); }
  throw new Error('Approval state did not arrive');
}
async function setup(deferFirst=false) {
  const root = await mkdtemp(join(tmpdir(), 'kairos-approval-ui-')); roots.push(root);
  await writeFile(join(root, 'a.txt'), 'before');
  let release=()=>{};let began=()=>{};const firstStarted=new Promise<void>(resolve=>{began=resolve;});
  const client = new class extends EventEmitter {
    requests = 0;
    async stream(_input: CompletionInput,signal?:AbortSignal) {
      this.requests++;
      const edit = this.requests === 1;
      if(edit&&deferFirst){await new Promise<void>(resolve=>{release=resolve;signal?.addEventListener('abort',()=>resolve(),{once:true});began();});signal?.throwIfAborted();}
      return { ok: true as const, value: [{ id: 'x', object: 'chat.completion.chunk' as const, created: 0, model: 'test', choices: [{ index: 0,
        delta: edit ? { tool_calls: [{ index: 0, id: 'edit', type: 'function' as const, function: { name: 'apply_edits_batch', arguments: JSON.stringify({ edits: [{ path: 'a.txt', old_text: 'before', new_text: 'after' }] }) } }] } : { content: 'Done' }, finish_reason: edit ? 'tool_calls' as const : 'stop' as const }] }] };
    }
  }();
  const agent = new AgentLoop({ workspace: root, client, session: false, permissions: { edits: 'ask' }, undoDirectory: join(root, 'undo') });
  const controller = new UiController(agent); controllers.push(controller);
  const app = render(<App controller={controller} version="test" />);
  await controller.start(); await tick();
  return { root, client, controller, app, firstStarted, release:()=>release() };
}

it('approves the visible edit, then previews and approves undo without an inference request', async () => {
  const { root, client, controller, app } = await setup();
  const turn = controller.submit('Change the file');
  await ready(() => !!controller.getSnapshot().approval); await tick();
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('before');
  expect(app.lastFrame()).toContain('Approval required'); expect(app.lastFrame()).toContain('+after');
  app.stdin.write('y'); await turn; await tick();
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('after');
  const undo = controller.submit('/undo'); await ready(() => !!controller.getSnapshot().approval); await tick();
  expect(app.lastFrame()).toContain('+before');
  app.stdin.write('y'); await undo;
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('before');
  expect(client.requests).toBe(2);
});

it('cancels a pending approval and restores input without modifying the file', async () => {
  const { root, controller, app } = await setup();
  const turn = controller.submit('Change the file'); await ready(() => !!controller.getSnapshot().approval);
  await tick(); app.stdin.write('\x1b'); await turn; await tick();
  expect(controller.getSnapshot().approval).toBeUndefined();
  expect(controller.interaction.busy).toBe(false);
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('before');
  expect(app.lastFrame()).toContain('Ask a question');
});
it('preserves a queue edit and the previous draft while approval replaces the input',async()=>{
 const {controller,app,client,firstStarted,release}=await setup(true);
 const turn=controller.submit('Change the file');await firstStarted;const queued=controller.submit('follow-up');
 for(const key of ['my unsent draft','\x1b[A','\r',' changed']){app.stdin.write(key);await tick();}
 expect(controller.getSnapshot().queueEdit?.draft.text).toBe('follow-up changed');
 release();await ready(()=>!!controller.getSnapshot().approval);await tick();expect(app.lastFrame()).toContain('Approval required');
 app.stdin.write('y');await turn;await tick();
 expect(client.requests).toBe(2);expect(controller.interaction.queuePaused).toBe(true);
 expect(app.lastFrame()).toContain('follow-up changed');
 app.stdin.write('\x1b');await queued;await tick();
 expect(app.lastFrame()).toContain('my unsent draft');expect(controller.getSnapshot().queueEdit).toBeUndefined();
 expect(client.requests).toBe(3);
});
it('cancels a rewind approval with one Esc without restoring files or leaving work active',async()=>{
 const {controller,app,root}=await setup();const turn=controller.submit('Change the file');await ready(()=>!!controller.getSnapshot().approval);await tick();app.stdin.write('y');await turn;
 await controller.submit('/rewind');await tick();app.stdin.write('\r');await ready(()=>controller.getSnapshot().approval?.tool==='rewind');await tick();
 expect(await readFile(join(root,'a.txt'),'utf8')).toBe('after');app.stdin.write('\x1b');await tick();
 expect(controller.getSnapshot().approval).toBeUndefined();expect(controller.getSnapshot().rewindPoints).toBeUndefined();
 await controller.interaction.drain();expect(controller.interaction.busy).toBe(false);expect(await readFile(join(root,'a.txt'),'utf8')).toBe('after');
});

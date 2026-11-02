import React from 'react';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { AgentLoop } from '../src/core/agent-loop.js';
import { UiController } from '../src/ui/controller.js';
import { App } from '../src/ui/App.js';

const roots: string[] = [], controllers: UiController[] = [];
afterEach(async () => {
  cleanup(); for (const controller of controllers.splice(0)) await controller.close();
  for (const root of roots.splice(0)) { if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('kairos-key-ui-')) throw new Error('Unexpected fixture'); await rm(root, { recursive: true, force: true }); }
});
async function setup(save: (key: string) => Promise<void>, required = false) {
  const root = await mkdtemp(join(tmpdir(), 'kairos-key-ui-')); roots.push(root);
  const client = new class extends EventEmitter { async stream() { throw new Error('No model calls expected'); } }();
  const agent = new AgentLoop({ workspace: root, client, session: false });
  const controller = new UiController(agent, undefined, { keySettings: { save, path: join(root, 'global', '.env'), required } });
  controllers.push(controller); await controller.start(); return { controller, agent };
}

it('opens /key locally and never places a saved secret in state, history or model messages', async () => {
  let stored = '';
  const { controller, agent } = await setup(async key => { stored = key; });
  await controller.submit('/key'); expect(controller.getSnapshot().keyPanelOpen).toBe(true);
  await controller.saveApiKey('private-test-key');
  expect(stored).toBe('private-test-key'); expect(controller.getSnapshot().keyPanelOpen).toBe(false);
  expect(JSON.stringify(controller.getSnapshot())).not.toContain('private-test-key');
  expect(await controller.promptHistory()).not.toContain('private-test-key');
  expect(agent.messages).toEqual([]);
});

it('rejects inline key arguments without saving or journaling them', async () => {
  let writes = 0; const { controller, agent } = await setup(async () => { writes++; });
  await controller.submit('/key private-test-key');
  expect(writes).toBe(0); expect(agent.messages).toEqual([]);
  expect(JSON.stringify(controller.getSnapshot())).not.toContain('private-test-key');
  expect(await controller.promptHistory()).not.toContain('/key private-test-key');
  await controller.submit('/key\nprivate-test-key');
  expect(writes).toBe(0); expect(agent.messages).toEqual([]);
  expect(JSON.stringify(controller.getSnapshot())).not.toContain('private-test-key');
});

it('reserves the interaction during save and ignores duplicate saves, cancellation and prompts', async () => {
  let finish!: () => void, writes = 0;
  const { controller, agent } = await setup(async () => { writes++; await new Promise<void>(resolve => { finish = resolve; }); });
  await controller.submit('/key');
  const pending = controller.saveApiKey('private-test-key'); await Promise.resolve();
  await controller.saveApiKey('other-test-key'); controller.cancel();
  await controller.submit('a prompt during save');
  expect(controller.getSnapshot()).toMatchObject({ keyPanelOpen: true, keySaving: true });
  expect(agent.messages).toEqual([]); expect(writes).toBe(1);
  finish(); await pending; expect(controller.getSnapshot().keyPanelOpen).toBe(false);
});

it('requires an idle interaction before opening key settings', async () => {
  const { controller } = await setup(async () => {});
  let finish!: () => void;
  const pending = controller.interaction.action(() => new Promise<void>(resolve => { finish = resolve; }));
  await Promise.resolve(); await controller.submit('/key');
  expect(controller.getSnapshot().keyPanelOpen).toBe(false);
  finish(); await pending; await controller.submit('/key');
  expect(controller.getSnapshot().keyPanelOpen).toBe(true);
});

it('keeps the form open on failed save without exposing exception details', async () => {
  const { controller } = await setup(async key => { throw new Error('Sensitive failure: ' + key); });
  await controller.submit('/key'); await controller.saveApiKey('private-test-key');
  expect(controller.getSnapshot()).toMatchObject({ keyPanelOpen: true, keySaving: false, keyError: expect.any(String) });
  expect(JSON.stringify(controller.getSnapshot())).not.toContain('private-test-key');
  controller.cancel(); expect(controller.getSnapshot().keyPanelOpen).toBe(false);
});

it('opens setup on first use and exits cleanly when cancelled without a key', async () => {
  const { controller } = await setup(async () => {}, true);
  let exits = 0; controller.on('exit', () => { exits++; });
  expect(controller.getSnapshot().keyPanelOpen).toBe(true);
  controller.cancel(); expect(exits).toBe(1);
});

it('renders the masked key panel inside the app instead of the ordinary prompt', async () => {
  let stored = '';
  const { controller } = await setup(async key => { stored = key; });
  const view = render(<App controller={controller} version="test" />);
  await new Promise(resolve => setTimeout(resolve, 80));
  await controller.submit('/key'); await new Promise(resolve => setTimeout(resolve, 80));
  view.stdin.write('private-test-key'); await new Promise(resolve => setTimeout(resolve, 80));
  expect(view.frames.join('\n')).not.toContain('private-test-key');
  view.stdin.write('\r'); await new Promise(resolve => setTimeout(resolve, 100));
  expect(stored).toBe('private-test-key');
});

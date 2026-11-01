import React from 'react';
import { EventEmitter,once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, cleanup } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/ui/App.js';
import { SessionPicker } from '../src/ui/SessionPicker.js';
import { UiController } from '../src/ui/controller.js';
import { AgentLoop } from '../src/core/agent-loop.js';
import { SessionStore, type SessionState } from '../src/core/session-store.js';

const roots: string[] = [];
const controllers: UiController[] = [];
const stores: SessionStore[] = [];
const tick = () => new Promise(resolve => setTimeout(resolve, 80));
const state = (prompt: string): SessionState => ({ model: 'test/graph-model', mode: 'plan', memory: '', messages: [{ role: 'user', content: prompt }] });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'kairos-resume-')); roots.push(root);
  const directory = join(root, 'sessions');
  const saved = await SessionStore.create(directory, root, state('Fix graph traversal')); await saved.close();
  const another = await SessionStore.create(directory, root, state('Document the parser')); await another.close();
  const other = join(root, 'other'); await mkdir(other);
  const foreign = await SessionStore.create(directory, other, state('Private other project')); await foreign.close();
  const client = new class extends EventEmitter { calls = 0; async stream() { this.calls++; throw new Error('Resume must not call NIM'); } }();
  const agent = new AgentLoop({ workspace: root, session: { directory }, client });
  const controller = new UiController(agent); controllers.push(controller);
  await controller.start();
  const app = render(<App controller={controller} version="0.0.1-alpha" />); await tick();
  return { root, directory, saved, another, client, agent, controller, app };
}
afterEach(async () => {
  cleanup();
  for (const controller of controllers.splice(0)) await controller.close();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('opens from slash completion, filters project sessions by prompt and resumes with Enter', async () => {
  const { app, agent, saved, client,controller } = await setup();
  app.stdin.write('/res'); await tick(); app.stdin.write('\r');await vi.waitFor(()=>expect(controller.getSnapshot().resumeSessions).toBeDefined(),{timeout:3000});await tick();
  expect(app.lastFrame()).toContain('Resume session');
  expect(app.lastFrame()).toContain('Fix graph traversal');
  expect(app.lastFrame()).not.toContain('Private other project');
  expect(app.lastFrame()).toContain('(current)');
  app.stdin.write('FIX GRAPH'); await tick();
  expect(app.lastFrame()).not.toContain('Document the parser');
  const resumed=once(agent,'onSession');app.stdin.write('\r');await resumed;await tick();
  expect(agent.sessionId).toBe(saved.id); expect(agent.model).toBe('test/graph-model'); expect(agent.mode).toBe('plan');
  expect(app.lastFrame()).toContain('Ask a question');
  expect(app.lastFrame()).not.toContain('Resume session');
  expect(client.calls).toBe(0);
});

it('handles no matches and cancels with Esc or Ctrl+C without changing the session', async () => {
  const { app, agent, controller } = await setup(); const id = agent.sessionId;
  let exits = 0; controller.on('exit', () => { exits++; });
  await controller.submit('/resume'); await tick();
  app.stdin.write('does-not-exist'); await tick();
  expect(app.lastFrame()).toContain('No sessions found');
  app.stdin.write('\r'); await tick(); expect(agent.sessionId).toBe(id);
  app.stdin.write('\x1b'); await tick(); expect(app.lastFrame()).toContain('Ask a question');
  await controller.submit('/resume'); await tick(); app.stdin.write('\x03'); await tick();
  expect(app.lastFrame()).toContain('Ask a question'); expect(agent.sessionId).toBe(id); expect(exits).toBe(0);
});

it('keeps the current session and picker available when the selected journal is locked', async () => {
  const { app, agent, controller, saved, root, directory } = await setup(); const id = agent.sessionId;
  const locked = await SessionStore.open(directory, saved.id, root); stores.push(locked);
  await controller.submit('/resume'); await tick();
  app.stdin.write('traversal'); await tick(); app.stdin.write('\r'); await tick();
  expect(agent.sessionId).toBe(id); expect(app.lastFrame()).toContain('in use');
  expect(app.lastFrame()).toContain('Resume session');
  await locked.close();const resumed=once(agent,'onSession');app.stdin.write('\r');await resumed;await tick();
  expect(agent.sessionId).toBe(saved.id); expect(app.lastFrame()).toContain('Ask a question');
});
it('keeps direct ID resume working and selecting the current session does not duplicate its history', async () => {
  const { app, agent, controller, another } = await setup(); const current = agent.sessionId!;
  await controller.submit('/resume'); await tick();
  app.stdin.write(current); await tick(); app.stdin.write('\x1b[B'); await tick(); app.stdin.write('\r'); await tick();
  expect(agent.sessionId).toBe(current);
  expect(app.lastFrame()).toContain('Ask a question');
  await controller.submit(`/resume ${another.id}`);
  expect(agent.sessionId).toBe(another.id);
  await controller.submit('/resume'); await tick();
  app.stdin.write('Document the parser'); await tick();
  app.stdin.write('\x1b[A'); await tick();
  expect(app.lastFrame()).toContain('› (current) Document the parser');
  const length = controller.getSnapshot().history.length;
  app.stdin.write('\x1b[B'); await tick(); app.stdin.write('\r'); await tick();
  expect(agent.sessionId).toBe(another.id); expect(controller.getSnapshot().history).toHaveLength(length);
});
it('does not open the picker after its disk scan was cancelled or while work is active', async () => {
  const { agent, controller } = await setup(); const id = agent.sessionId;
  let finish = () => {};
  const list = vi.spyOn(agent, 'listSessions').mockImplementation(() => new Promise(resolve => { finish = () => resolve([]); }));
  const opening = controller.submit('/resume'); await tick(); controller.cancel(); finish(); await opening;
  expect(controller.getSnapshot().resumeSessions).toBeUndefined(); expect(agent.sessionId).toBe(id);
  list.mockRestore();
  let release = () => {};
  const work = controller.interaction.action(() => new Promise<void>(resolve => { release = resolve; }));
  await tick(); await controller.submit('/resume');
  expect(controller.getSnapshot().resumeSessions).toBeUndefined();
  expect(controller.getSnapshot().history.at(-1)?.text).toContain('idle agent');
  release(); await work;
});
it('rejects resume with persistence disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairos-no-resume-')); roots.push(root);
  const client = new class extends EventEmitter { async stream() { throw new Error('No NIM'); } }();
  const controller = new UiController(new AgentLoop({ workspace: root, client, session: false })); controllers.push(controller);
  await controller.start(); await controller.submit('/resume');
  expect(controller.getSnapshot().resumeSessions).toBeUndefined();
  expect(controller.getSnapshot().history.at(-1)?.text).toContain('Persistence is disabled');
  await controller.submit('/rename Cannot persist');
  expect(controller.getSnapshot().history.at(-1)?.text).toContain('Persistence is disabled');
});
it('renames the current session and searches its chosen name in the resume menu', async () => {
  const { app, agent, controller, client, directory, root } = await setup(); const id = agent.sessionId!;
  app.stdin.write('/ren'); await tick(); app.stdin.write('\r'); await tick();
  expect(app.lastFrame()).toContain('❯ /rename');
  app.stdin.write('Piano del grafo'); await tick(); app.stdin.write('\r'); await tick();
  expect(controller.getSnapshot().history.at(-1)?.text).toContain('Session renamed: Piano del grafo');
  expect(agent.sessionId).toBe(id); expect(client.calls).toBe(0);
  await controller.submit('/resume'); await tick();
  expect(app.lastFrame()).toContain('(current) Piano del grafo');
  app.stdin.write('PIANO DEL GRAFO'); await tick();
  expect(app.lastFrame()).toContain('1/1');
  expect(app.lastFrame()).not.toContain('Document the parser');
  controller.cancel();
  const sessions = await SessionStore.list(directory, root);
  expect(sessions.find(session => session.id === id)?.name).toBe('Piano del grafo');
  let release = () => {};
  const busy = controller.interaction.action(() => new Promise<void>(resolve => { release = resolve; }));
  await tick(); await controller.submit('/rename Do not apply');
  expect(agent.sessionName).toBe('Piano del grafo');
  expect(controller.getSnapshot().history.at(-1)?.text).toContain('idle agent');
  release(); await busy;
});
it('scrolls a short picker with arrows, filters by ID and ignores empty-result submissions', async () => {
  const sessions = Array.from({length:10}, (_, i) => ({id:`session-${i}`,updatedAt:'2026-10-31T12:00:00Z',model:'test/model',mode:'plan' as const,title:`Topic ${i}`}));
  const selected: string[] = []; const cancel = vi.fn();
  const app = render(<SessionPicker sessions={sessions} currentId="session-0" maxRows={9} onSelect={id => selected.push(id)} onCancel={cancel} />);
  expect(app.lastFrame()).toContain('› Topic 1');
  await tick(); app.stdin.write('\x1b[A'); await tick(); app.stdin.write('\x1b[A'); await tick();
  expect(app.lastFrame()).toContain('› Topic 9'); expect(app.lastFrame()!.split('\n').length).toBeLessThanOrEqual(9);
  app.stdin.write('\r'); await tick(); expect(selected).toEqual(['session-9']);
  app.stdin.write('SESSION-3'); await tick(); expect(app.lastFrame()).toContain('› Topic 3');
  app.stdin.write('\r'); await tick(); expect(selected).toEqual(['session-9','session-3']);
  app.stdin.write('missing'); await tick(); app.stdin.write('\r'); await tick(); expect(selected).toHaveLength(2);
  app.stdin.write('\x1b'); await tick(); expect(cancel).toHaveBeenCalledOnce();
});
it('shows an empty list and prevents keyboard actions during an atomic resume', async () => {
  const selected = vi.fn(); const cancel = vi.fn();
  const app = render(<SessionPicker sessions={[]} maxRows={6} onSelect={selected} onCancel={cancel} />);
  expect(app.lastFrame()).toContain('No saved sessions for this project');
  expect(app.lastFrame()!.split('\n').length).toBeLessThanOrEqual(6);
  await tick(); app.stdin.write('\r'); await tick(); expect(selected).not.toHaveBeenCalled();
  app.rerender(<SessionPicker sessions={[{id:'one',updatedAt:'now',model:'test/model',mode:'plan',title:'One'}]} pending maxRows={8} onSelect={selected} onCancel={cancel} />);
  await tick(); app.stdin.write('\r'); app.stdin.write('\x1b'); await tick();
  expect(selected).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
  expect(app.lastFrame()).toContain('Opening session');
});

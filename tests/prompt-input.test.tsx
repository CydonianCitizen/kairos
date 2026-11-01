import React from 'react';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, cleanup } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { InputBox } from '../src/ui/InputBox.js';
import { UiController } from '../src/ui/controller.js';
import { AgentLoop } from '../src/core/agent-loop.js';

const roots: string[] = [];
const controllers: UiController[] = [];
const tick = () => new Promise(resolve => setTimeout(resolve, 50));
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'kairos-input-')); roots.push(root);
  const client = new class extends EventEmitter { async stream() { throw new Error('Editor must not call NIM'); } }();
  const controller = new UiController(new AgentLoop({ workspace: root, client, session: false }));
  controllers.push(controller);
  const submit = vi.spyOn(controller, 'submit').mockResolvedValue();
  const toggle = vi.fn();
  const app = render(<InputBox controller={controller} busy={false} onToggleDetails={toggle} columns={40} maxInputRows={3} />);
  await tick();
  return { app, controller, submit, toggle };
}
afterEach(async () => {
  cleanup();
  for (const controller of controllers.splice(0)) await controller.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('inserts newlines with Ctrl+J, backslash Enter and Shift+Enter and submits the complete prompt once', async () => {
  const { app, submit } = await setup();
  for (const key of ['first', '\n', 'second', '\\', '\r', 'third', '\x1b[13;2u', 'fourth']) {
    app.stdin.write(key); await tick();
  }
  expect(submit).not.toHaveBeenCalled();
  expect(app.lastFrame()).toContain('fourth');
  app.stdin.write('\r'); await tick();
  expect(submit).toHaveBeenCalledExactlyOnceWith('first\nsecond\nthird\nfourth');
});

it('pastes multiline text with CRLF and split bracketed paste without sending commands', async () => {
  const { app, submit } = await setup();
  for (const chunk of ['\x1b[200~', '/exit\r\nsecond', '\r', 'third\tindented', '\x1b[201~']) {
    app.stdin.write(chunk); await tick();
  }
  expect(submit).not.toHaveBeenCalled();
  app.stdin.write('\r'); await tick();
  expect(submit).toHaveBeenCalledExactlyOnceWith('/exit\nsecond\nthird\tindented');
});

it('edits between lines and deletes complete Unicode graphemes', async () => {
  const { app, submit } = await setup();
  app.stdin.write('one\ntwo'); await tick();
  for (const key of ['\x1b[A', '\x1b[H', 'X', '\x1b[F', '\x1b[3~', '\x05', '👩‍💻', '\x7f', '\r']) {
    app.stdin.write(key); await tick();
  }
  expect(submit).toHaveBeenCalledExactlyOnceWith('Xonetwo');
});

it('loads a matching history prompt without submitting and restores the original draft on Esc', async () => {
  const { app, controller, submit } = await setup();
  vi.spyOn(controller, 'promptHistory').mockResolvedValue(['older graph question', 'newer graph\nquestion', 'other prompt']);
  app.stdin.write('my draft'); await tick();
  app.stdin.write('\x12'); await tick();
  app.stdin.write('GRAPH'); await tick();
  expect(app.lastFrame()).toContain('History');
  expect(app.lastFrame()).toContain('newer graph');
  app.stdin.write('\x12'); await tick();
  app.stdin.write('\r'); await tick();
  expect(app.lastFrame()).toContain('older graph question');
  expect(submit).not.toHaveBeenCalled();
  app.stdin.write('\x12'); await tick(); app.stdin.write('missing'); await tick();
  expect(app.lastFrame()).toContain('No matching prompts');
  app.stdin.write('\x1b'); await tick();
  expect(app.lastFrame()).toContain('older graph question');
  app.stdin.write('\r'); await tick();
  expect(submit).toHaveBeenCalledExactlyOnceWith('older graph question');
});

it('cancels history search without interrupting active work or discarding the draft', async () => {
  const { app, controller } = await setup();
  vi.spyOn(controller, 'promptHistory').mockResolvedValue(['previous']);
  const cancel = vi.spyOn(controller, 'cancel');
  app.stdin.write('keep\nthis draft'); await tick();
  app.stdin.write('\x12'); await tick(); app.stdin.write('previous'); await tick();
  app.stdin.write('\x03'); await tick();
  expect(app.lastFrame()).toContain('keep'); expect(app.lastFrame()).toContain('this draft');
  expect(cancel).not.toHaveBeenCalled();
});
it('preserves a long multiline draft in a bounded viewport and refuses oversized inserts without losing text', async () => {
 const { app, submit } = await setup();
 const text = Array.from({length:20}, (_, i) => `line ${i}`).join('\n');
 app.stdin.write(text); await tick();
 expect(app.lastFrame()).toContain('line 19'); expect(app.lastFrame()).not.toContain('line 0');
 expect(app.lastFrame()!.split('\n')).toHaveLength(6);
 app.stdin.write('x'.repeat(64001)); await tick();
 expect(app.lastFrame()).toContain('Prompt limit: 64,000');
 app.stdin.write('\r'); await tick();
 expect(submit).toHaveBeenCalledExactlyOnceWith(text);
});
it('keeps wide Unicode characters and mentions intact when editing inside a multiline prompt', async () => {
 const { app, controller, submit } = await setup();
 vi.spyOn(controller, 'suggestions').mockImplementation(prefix => prefix.endsWith('@sa') ? ['sample.ts'] : []);
 app.stdin.write('漢字 👩‍💻\nRead @sa tail'); await tick();
 for (let i=0;i<5;i++) { app.stdin.write('\x1b[D'); await tick(); }
 app.stdin.write('\t'); await tick(); app.stdin.write('\r'); await tick();
 expect(submit).toHaveBeenCalledExactlyOnceWith('漢字 👩‍💻\nRead @sample.ts  tail');
});
it('sanitizes history text before loading it into the editable draft', async () => {
 const { app, controller, submit } = await setup();
 vi.spyOn(controller, 'promptHistory').mockResolvedValue(['previous\x1b[2J\r\nprompt']);
 app.stdin.write('\x12'); await tick(); app.stdin.write('\r'); await tick(); app.stdin.write('\r'); await tick();
 expect(submit).toHaveBeenCalledExactlyOnceWith('previous\nprompt');
});
it('completes $skill suggestions with Tab', async () => {
 const { app, controller, submit } = await setup();
 vi.spyOn(controller, 'suggestions').mockImplementation(prefix => prefix.endsWith('$ca') ? ['$caveman'] : []);
 app.stdin.write('use $ca'); await tick();
 app.stdin.write('\t'); await tick();
 app.stdin.write('\r'); await tick();
 expect(submit).toHaveBeenCalledExactlyOnceWith('use $caveman ');
});

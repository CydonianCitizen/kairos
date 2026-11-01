import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { afterEach, expect, it } from 'vitest';
import { EventEmitter,once } from 'node:events';
import { PassThrough } from 'node:stream';
import { Box, render as renderInk } from 'ink';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/ui/App.js';
import { DiffBlock } from '../src/ui/DiffBlock.js';
import { StatusBar } from '../src/ui/StatusBar.js';
import { Banner } from '../src/ui/Banner.js';
import { ModelPicker } from '../src/ui/ModelPicker.js';
import { UiController } from '../src/ui/controller.js';
import { AgentLoop } from '../src/core/agent-loop.js';
import { safeText } from '../src/ui/text.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 70));
afterEach(cleanup);
it('summarizes model, effort, NIM, graph, queue and session in one footer line',()=>{
 const state={history:[],model:'deepseek-ai/deepseek-v4.1-flash',effort:'auto' as const,busy:false,activity:'Ready',streaming:'',graph:{files:60,symbols:414,diagnostics:1},mode:'build' as const,queued:0,sessionId:'ff52f3ec-1234',cooldownUntil:0,cooldownReason:''};
 const app=render(<Box width={120}><StatusBar state={state} columns={120}/></Box>);const frame=app.lastFrame()!;
 expect(frame.split('\n')).toHaveLength(1);expect(frame).toContain('deepseek-v4.1-flash · Effort: auto');expect(frame).toContain('Ready · build · AST 60/414 !1 · Q0 · #ff52f3ec');
 expect(frame.trimEnd().endsWith('/help for commands')).toBe(true);
 expect(frame.indexOf('/help for commands')).toBeGreaterThanOrEqual(100);
});
it('keeps the input and footer reachable and avoids roaming mascot above the input when the terminal shrinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairos-mascot-'));
  const client = new class extends EventEmitter { async stream() { throw new Error('Mascot must stay local'); } }();
  const controller = new UiController(new AgentLoop({ workspace: root, client, session: false }));
  const stdout = Object.assign(new PassThrough(), { columns: 60, rows: 24, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const writes: string[] = [];
  stdout.on('data', data => writes.push(data.toString()));
  let app: ReturnType<typeof renderInk> | undefined;
  try {
    app = renderInk(<App controller={controller} version="0.0.1-alpha" />, {
      stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false,
    });
    await controller.start(); await tick();
    const output = safeText(writes.join(''));
    expect(output).not.toContain('▀█████▀');
    expect(output).toContain('Ask a question');
    writes.length = 0;
    stdout.rows = 10; stdout.emit('resize'); await tick();
    const resizedOutput = safeText(writes.join(''));
    const compact = resizedOutput.slice(resizedOutput.lastIndexOf('K A I R O S'));
    expect(compact).not.toContain('▀█████▀');
    expect(compact).toContain('Ask a question');
    expect(compact).toContain('· Effort: auto');
    expect(writes.join('')).not.toContain('\x1b[?1049h');
  } finally {
    app?.unmount(); app?.cleanup(); await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('keeps model and effort on a left-aligned footer even in narrow terminals', () => {
  const state = { history: [], model: 'provider/a-very-long-model-name-for-the-terminal', effort: 'high' as const, busy: false, activity: 'Ready', streaming: '', cooldownUntil: 0, cooldownReason: '' };
  const app = render(<Box width={40}><StatusBar state={state} columns={40} /></Box>);
  const line = app.lastFrame()!;
  expect(line).toMatch(/^ a-very-long/);
  expect(line).toContain('· Effort: high');
  expect(line).not.toContain('provider/');
  expect(line).not.toContain('/ commands');
  expect(line.length).toBeLessThanOrEqual(40);
});
it('opens, filters and scrolls slash commands, confirms with Enter and prepares required arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairos-commands-'));
  const client = new class extends EventEmitter { async stream() { throw new Error('Commands must stay local'); } }();
  const agent = new AgentLoop({ workspace: root, client, session: false });
  const controller = new UiController(agent);
  let app: ReturnType<typeof render> | undefined;
  try {
    await controller.start(); app = render(<App controller={controller} version="0.0.1-alpha" />); await tick();
    app.stdin.write('/'); await tick();
    expect(app.lastFrame()).toContain('Commands');
    expect(app.lastFrame()).toContain('› /model');
    app.stdin.write('\x1b[A'); await tick();
    expect(app.lastFrame()).toContain('› /exit');
    app.stdin.write('\x1b[A'); await tick(); app.stdin.write('\r'); await tick();
    expect(controller.getSnapshot().history.at(-1)?.text).toContain('/compact');
    expect(app.lastFrame()).not.toContain('Commands');
    app.stdin.write('/mod'); await tick();
    expect(app.lastFrame()).toContain('/model'); expect(app.lastFrame()).toContain('/mode');
    expect(app.lastFrame()).toContain('Commands · 1–2 / 2');
    app.stdin.write('\x1b[B'); await tick(); app.stdin.write('\r'); await tick();
    expect(app.lastFrame()).toContain('❯ /mode');
    expect(app.lastFrame()).not.toContain('Commands');
    expect(controller.getSnapshot().history.at(-1)?.kind).not.toBe('error');
    app.stdin.write('plan'); await tick(); app.stdin.write('\r'); await tick();
    expect(agent.mode).toBe('plan');
    app.stdin.write('/'); await tick(); app.stdin.write('\x1b'); await tick();
    expect(app.lastFrame()).not.toContain('Commands');
    expect(app.lastFrame()).toContain('Ask a question');
    app.stdin.write('/'); await tick(); app.stdin.write('\x03'); await tick();
    expect(app.lastFrame()).not.toContain('Commands');
    expect(app.lastFrame()).toContain('Ask a question');
    app.stdin.write('/mo'); await tick(); app.stdin.write('\r'); await tick();
    expect(controller.getSnapshot().modelPickerOpen).toBe(true);
    app.stdin.write('\x1b'); await tick();
    expect(app.lastFrame()).toContain('Ask a question');
  } finally { app?.unmount(); await controller.close(); await rm(root, { recursive: true, force: true }); }
});
it('keeps the active custom model visible and scrolls a short model picker', async () => {
  const selected: string[] = [];
  const app = render(<ModelPicker model="custom/my-model" maxRows={9} onSelect={model => selected.push(model)} onCancel={() => {}} />);
  expect(app.lastFrame()).toContain('my-model');
  expect(app.lastFrame()).not.toContain('custom/');
  expect(app.lastFrame()).toContain('(current)');
  expect(app.lastFrame()!.split('\n').length).toBeLessThanOrEqual(9);
  await tick(); app.stdin.write('\x1b[A'); await tick();
  expect(app.lastFrame()).toContain('› 5. nemotron-3.5-bolt-e4b');
  app.stdin.write('\r'); await tick();
  expect(selected).toEqual(['nvidia/nemotron-3.5-bolt-e4b']);
});
it('shows discovered catalog models and selects their full API IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairos-catalog-ui-'));
  const client = new class extends EventEmitter { async stream() { throw new Error('No inference during discovery'); } }();
  const agent = new AgentLoop({ workspace: root, client, model: 'future/new-coder', session: false });
  const controller = new UiController(agent, ['future/new-coder', 'other/new-chat']);
  let app: ReturnType<typeof render> | undefined;
  try {
    await controller.start(); app = render(<App controller={controller} version="0.0.1-alpha" />); await tick();
    await controller.submit('/model'); await tick();
    expect(app.lastFrame()).toContain('› 1. new-coder (current)');
    expect(app.lastFrame()).not.toContain('future/');
    app.stdin.write('\x1b[B'); await tick(); app.stdin.write('\r'); await tick();
    expect(agent.model).toBe('other/new-chat');
    expect(app.lastFrame()).toContain('new-chat');
    expect(controller.getSnapshot().history.some(entry => entry.text.startsWith('Active:'))).toBe(false);
  } finally { app?.unmount(); await controller.close(); await rm(root, { recursive: true, force: true }); }
});
it('chooses effort with keyboard, cancels without applying and shows auto for unverified models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairos-effort-ui-'));
  const client = new class extends EventEmitter { async stream() { throw new Error('No NIM calls expected'); } }();
  const agent = new AgentLoop({ workspace: root, client, session: false });
  const controller = new UiController(agent);
  let app: ReturnType<typeof render> | undefined;
  try {
    await controller.start(); app = render(<App controller={controller} version="0.0.1-alpha" />); await tick();
    app.stdin.write('/effort'); await tick(); app.stdin.write('\r'); await tick();
    expect(app.lastFrame()).toContain('Reasoning effort');
    expect(app.lastFrame()).toContain('› auto · model default (current)');
    app.stdin.write('\x1b[A'); await tick(); app.stdin.write('\r'); await tick();
    expect(agent.effort).toBe('high'); expect(app.lastFrame()!.split('\n').at(-1)).toContain('Effort: high');
    expect(controller.getSnapshot().history.some(entry => entry.text.startsWith('Effort:'))).toBe(false);
    app.stdin.write('/effort'); await tick(); app.stdin.write('\r'); await tick();
    app.stdin.write('\x1b[B'); await tick(); app.stdin.write('\x1b'); await tick();
    expect(agent.effort).toBe('high');
    await controller.submit('/model custom/model'); await controller.submit('/effort'); await tick();
    expect(app.lastFrame()).toContain('Only auto: effort support unverified.');
    app.stdin.write('\x03'); await tick();
    expect(controller.getSnapshot().effortPickerOpen).toBe(false);
    expect(app.lastFrame()).toContain('Ask a question');
  } finally { app?.unmount(); await controller.close(); await rm(root, { recursive: true, force: true }); }
});
it('selects models with arrow keys and Enter, cancels with Escape and restores the prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairos-picker-'));
  let requests = 0;
  const client = new class extends EventEmitter {
    async stream() { requests++; throw new Error('Picker must not call NIM'); }
  }();
  const agent = new AgentLoop({ workspace: root, client, session: false });
  const controller = new UiController(agent);
  let app: ReturnType<typeof render> | undefined;
  try {
    await controller.start(); app = render(<App controller={controller} version="0.0.1-alpha" />); await tick();
    app.stdin.write('/model'); await tick(); app.stdin.write('\r'); await tick();
    expect(app.lastFrame()).toContain('Select model');
    expect(app.lastFrame()).toContain('› 1. mistral-large-4-1t-a52b (current)');
    expect(app.lastFrame()).not.toContain('Ask a question');
    const historyLength = controller.getSnapshot().history.length;
    app.stdin.write('zz'); await tick();
    expect(app.lastFrame()).toContain('No models found');
    app.stdin.write('\r'); await tick();
    expect(controller.getSnapshot().modelPickerOpen).toBe(true);
    app.stdin.write('\x7f'); await tick(); app.stdin.write('\x7f'); await tick();
    app.stdin.write('DEEPSEEK'); await tick();
    expect(app.lastFrame()).toContain('› 1. deepseek-v4.1-flash');
    app.stdin.write('\r'); await tick();
    expect(agent.model).toBe('deepseek-ai/deepseek-v4.1-flash');
    expect(controller.getSnapshot().history).toHaveLength(historyLength);
    expect(app.lastFrame()).toContain('Ask a question');
    expect(app.lastFrame()).not.toContain('Select model');
    expect(app.lastFrame()).not.toContain('DEEPSEEK');
    app.stdin.write('/model'); await tick(); app.stdin.write('\r'); await tick();
    expect(app.lastFrame()).toContain('› 2. deepseek-v4.1-flash (current)');
    app.stdin.write('\x1b[A'); await tick(); app.stdin.write('\x1b'); await tick();
    expect(agent.model).toBe('deepseek-ai/deepseek-v4.1-flash');
    expect(app.lastFrame()).not.toContain('Select model');
    app.stdin.write('/model'); await tick(); app.stdin.write('\r'); await tick();
    app.stdin.write('\x03'); await tick();
    expect(controller.getSnapshot().modelPickerOpen).toBe(false);
    expect(app.lastFrame()).toContain('Ask a question');
    expect(requests).toBe(0);
  } finally { app?.unmount(); await controller.close(); await rm(root, { recursive: true, force: true }); }
});
it('renders real banner metadata and fits narrow terminals', async () => {
  const app = render(<Banner version="0.0.1-alpha" model="custom/active-model" graphStats={{ files: 7, symbols: 13 }} columns={100} />);
  expect(app.lastFrame()).toContain('K A I R O S');
  expect(app.lastFrame()).toContain('v0.0.1-alpha');
  expect(app.lastFrame()).toContain('active-model');
  expect(app.lastFrame()).not.toContain('custom/');
  expect(app.lastFrame()).toContain('7 files (13 symbols)');
  expect(app.lastFrame()).toContain('███');
  app.rerender(<Banner version="0.0.1-alpha" model={'provider/' + 'long-model-name-'.repeat(8)} columns={40} />);
  await tick();
  expect(app.lastFrame()).toContain('K A I R O S');
  expect(app.lastFrame()).toContain('AST: indexing');
  expect(app.lastFrame()).not.toContain('███');
  expect(app.lastFrame()!.split('\n').every(line => [...line].length <= 40)).toBe(true);
});
it('renders diff content and strips terminal escape injections', () => {
  const app = render(<DiffBlock diff={'--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n'} />);
  expect(app.lastFrame()).toContain('-old'); expect(app.lastFrame()).toContain('+new');
  expect(safeText('\x1b[2Jhello\x1b]0;title\x07')).toBe('hello');
});
it('shows the NIM countdown and transitions to ready', async () => {
  const state = { history: [], model: 'test/model', busy: false, activity: 'Ready', streaming: '', graph: { files: 2, symbols: 5, diagnostics: 0 }, cooldownUntil: Date.now() + 200, cooldownReason: 'pacing' };
  const app = render(<StatusBar state={state} columns={120} />);
  expect(app.lastFrame()).toContain('AST 2/5');
  expect(app.lastFrame()).toContain('Wait ');
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(app.lastFrame()).toContain('Ready');
});
it('accepts slash commands, Tab completion and retains Static history across turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nim-render-'));
  const client = new class extends EventEmitter {
    async stream() { this.emit('onTokenStream', 'Done'); return { ok: true as const, value: [{ id: 'r', object: 'chat.completion.chunk' as const, model: 'test', created: 0, choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' as const }] }] }; }
  }();
  const controller = new UiController(new AgentLoop({ workspace: root, client }));
  try {
    await writeFile(join(root, 'sample.ts'), 'function example() {}');
    await controller.start();
    const app = render(<App controller={controller} version="0.0.1-alpha" />); await tick();
    expect(app.lastFrame()).toContain('Ask a question');
    expect(app.frames.join('')).toContain('K A I R O S');
    const footer = app.lastFrame()!.split('\n').at(-1)!;
    expect(footer).toMatch(/^ mistral-large-4-1t-a52b\s+· Effort: auto/);
    expect(app.lastFrame()!.split('\n').slice(-23)[0]).toContain('K A I R O S');
    expect(app.frames.join('')).toContain('v0.0.1-alpha');
    expect(app.frames.join('')).toContain('1 files (1 symbols)');
    app.stdin.write('/help'); await tick(); app.stdin.write('\r'); await tick();
    expect(controller.getSnapshot().history.some(e => e.text.includes('/compact'))).toBe(true);
    app.stdin.write('Read @sam'); await tick(); app.stdin.write('\t'); await tick();
    expect(app.lastFrame()).toContain('@sample.ts');
    const completed=once(controller.interaction,'result');app.stdin.write('\r');await completed;await tick();
    expect(controller.getSnapshot().history.some(e => e.kind === 'assistant' && e.text === 'Done')).toBe(true);
    expect(app.frames.join('')).toContain('● Done');
    expect(app.lastFrame()!.match(/K A I R O S/g)).toHaveLength(1);
    expect(app.frames.join('')).not.toContain('\x1b[?1049h');
    app.unmount();
  } finally { await controller.close(); await rm(root, { recursive: true, force: true }); }
});
it('renders the startup banner with real metadata and preserves scrollback across updates and resize', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairos-static-'));
  const client = new class extends EventEmitter {
    async stream() { return { ok: true as const, value: [{ id: 'r', object: 'chat.completion.chunk' as const, model: 'test', created: 0, choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' as const }] }] }; }
  }();
  const controller = new UiController(new AgentLoop({ workspace: root, client }));
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const writes: string[] = [];
  stdout.on('data', data => writes.push(data.toString()));
  let app: ReturnType<typeof renderInk> | undefined;
  try {
    await writeFile(join(root, 'sample.ts'), 'function example() {}');
    app = renderInk(<App controller={controller} version="0.0.1-alpha" />, {
      stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false,
    });
    await controller.start(); await tick();
    await controller.submit('/model custom/new-model'); await tick();
    stdout.columns = 40; stdout.emit('resize'); await tick();
    await controller.submit('Hello'); await tick();
    const output = safeText(writes.join(''));
    expect(output.match(/K A I R O S/g)!.length).toBeGreaterThanOrEqual(1);
    expect(output).toContain('1 files (1 symbols)');
    expect(output).toContain('● Done');
    expect(writes.join('')).not.toContain('\x1b[?1049h');
  } finally {
    app?.unmount(); app?.cleanup(); await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('keeps the terminal input usable while a turn is running and queues a follow-up',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nim-input-'));let release=()=>{};
 const client=new class extends EventEmitter {count=0;async stream(){this.count++;if(this.count===1)await new Promise<void>(r=>{release=r;});return {ok:true as const,value:[{id:'r',object:'chat.completion.chunk' as const,created:0,model:'test',choices:[{index:0,delta:{content:'Done'},finish_reason:'stop' as const}]}]};}}();
 const controller=new UiController(new AgentLoop({workspace:root,client}));let app:ReturnType<typeof render>|undefined;
 try{await controller.start();app=render(<App controller={controller} version="0.0.1-alpha"/>);await tick();app.stdin.write('first');await tick();app.stdin.write('\r');await tick();expect(controller.getSnapshot().busy).toBe(true);expect(app.lastFrame()).toContain('Queue a follow-up');
 app.stdin.write('second');await tick();app.stdin.write('\r');await tick();expect(controller.getSnapshot().queued).toBe(1);
 app.stdin.write('/');await tick();expect(app.lastFrame()).toContain('Commands');app.stdin.write('\x1b');await tick();expect(app.lastFrame()).not.toContain('Commands');expect(controller.getSnapshot().busy).toBe(true);expect(controller.getSnapshot().queued).toBe(1);
 release();await controller.interaction.drain();expect(controller.getSnapshot().history.filter(e=>e.kind==='user').map(e=>e.text)).toEqual(['first','second']);expect(client.count).toBe(2);
 }finally{release();app?.unmount();await controller.close();await rm(root,{recursive:true,force:true});}
});

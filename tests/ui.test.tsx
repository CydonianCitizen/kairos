import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { afterEach, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/ui/App.js';
import { DiffBlock } from '../src/ui/DiffBlock.js';
import { StatusBar } from '../src/ui/StatusBar.js';
import { UiController } from '../src/ui/controller.js';
import { AgentLoop } from '../src/core/agent-loop.js';
import { safeText } from '../src/ui/text.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 70));
afterEach(cleanup);
it('renders diff content and strips terminal escape injections', () => {
  const app = render(<DiffBlock diff={'--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n'} />);
  expect(app.lastFrame()).toContain('-old'); expect(app.lastFrame()).toContain('+new');
  expect(safeText('\x1b[2Jhello\x1b]0;title\x07')).toBe('hello');
});
it('shows the NIM countdown and transitions to ready', async () => {
  const state = { history: [], model: 'test/model', busy: false, activity: 'Ready', streaming: '', graph: { files: 2, symbols: 5, diagnostics: 0 }, cooldownUntil: Date.now() + 200, cooldownReason: 'pacing' };
  const app = render(<StatusBar state={state} />);
  expect(app.lastFrame()).toContain('Graph: 2 files | 5 symbols');
  expect(app.lastFrame()).toContain('Cooling down:');
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(app.lastFrame()).toContain('NIM Ready');
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
    const app = render(<App controller={controller} />); await tick();
    expect(app.lastFrame()).toContain('Ask a question');
    app.stdin.write('/help'); await tick(); app.stdin.write('\r'); await tick();
    expect(controller.getSnapshot().history.some(e => e.text.includes('/compact'))).toBe(true);
    app.stdin.write('Read @sam'); await tick(); app.stdin.write('\t'); await tick();
    expect(app.lastFrame()).toContain('@sample.ts');
    app.stdin.write('\r'); await new Promise(resolve => setTimeout(resolve, 250));
    expect(controller.getSnapshot().history.some(e => e.kind === 'assistant' && e.text === 'Done')).toBe(true);
    expect(app.frames.join('')).toContain('nim › Done');
    expect(app.frames.join('')).not.toContain('\x1b[?1049h');
    app.unmount();
  } finally { controller.dispose(); await rm(root, { recursive: true, force: true }); }
});
it('keeps the terminal input usable while a turn is running and queues a follow-up',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nim-input-'));let release=()=>{};
 const client=new class extends EventEmitter {count=0;async stream(){this.count++;if(this.count===1)await new Promise<void>(r=>{release=r;});return {ok:true as const,value:[{id:'r',object:'chat.completion.chunk' as const,created:0,model:'test',choices:[{index:0,delta:{content:'Done'},finish_reason:'stop' as const}]}]};}}();
 const controller=new UiController(new AgentLoop({workspace:root,client}));let app:ReturnType<typeof render>|undefined;
 try{await controller.start();app=render(<App controller={controller}/>);await tick();app.stdin.write('first');await tick();app.stdin.write('\r');await tick();expect(controller.getSnapshot().busy).toBe(true);expect(app.lastFrame()).toContain('Queue a follow-up');
 app.stdin.write('second');await tick();app.stdin.write('\r');await tick();expect(controller.getSnapshot().queued).toBe(1);release();await controller.interaction.drain();expect(controller.getSnapshot().history.filter(e=>e.kind==='user').map(e=>e.text)).toEqual(['first','second']);expect(client.count).toBe(2);
 }finally{release();app?.unmount();await controller.close();await rm(root,{recursive:true,force:true});}
});

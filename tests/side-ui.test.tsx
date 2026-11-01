import React from 'react';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, cleanup } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/ui/App.js';
import { UiController } from '../src/ui/controller.js';
import { AgentLoop } from '../src/core/agent-loop.js';

const roots: string[] = []; const controllers: UiController[] = [];
const tick = () => new Promise(resolve=>setTimeout(resolve,70));
const reply = (content: string) => ({ok:true as const,value:[{id:'x',object:'chat.completion.chunk' as const,created:0,model:'test',choices:[{index:0,delta:{content},finish_reason:'stop' as const}]}]});
class Client extends EventEmitter {
 children: Client[]=[]; requests:any[]=[];
 constructor(readonly answer='Main answer'){super();}
 async stream(input:any,_signal?:AbortSignal){this.requests.push(input);this.emit('onTokenStream',this.answer);return reply(this.answer);}
 fork(){const child=new Client('Side answer');this.children.push(child);return child;}
}
async function setup(){
 const root=await mkdtemp(join(tmpdir(),'kairos-side-ui-'));roots.push(root);const directory=join(root,'sessions');const client=new Client();
 const agent=new AgentLoop({workspace:root,client,session:{directory}});const controller=new UiController(agent);controllers.push(controller);
 await controller.start();await controller.submit('Remember blue');
 const app=render(<App controller={controller} version="0.0.1-alpha"/>);await tick();
 return {agent,controller,app,client,directory};
}
afterEach(async()=>{cleanup();for(const c of controllers.splice(0))await c.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

it('branches with another model and keeps the original available to resume',async()=>{
 const {agent,controller,directory}=await setup();const original=agent.sessionId!;const before=await readFile(join(directory,original+'.jsonl'),'utf8');
 await controller.submit('/branch --model custom/alternative Strategy B');
 expect(agent.sessionId).not.toBe(original);expect(agent.model).toBe('custom/alternative');expect(agent.sessionName).toBe('Strategy B');
 expect(controller.getSnapshot().history.at(-1)?.text).toContain(original);
 expect(await readFile(join(directory,original+'.jsonl'),'utf8')).toBe(before);
 await controller.submit(`/resume ${original}`);expect(agent.model).toBe('mistralai/mistral-large-4-1t-a52b');
});

it('shows and reopens a side answer with a different model without adding it to the main transcript',async()=>{
 const {agent,controller,app,directory,client}=await setup();const id=agent.sessionId!;const before=await readFile(join(directory,id+'.jsonl'),'utf8');
 const history=controller.getSnapshot().history;
 app.stdin.write('/btw --model custom/side What color?');await tick();app.stdin.write('\r');await tick();
 expect(app.lastFrame()).toContain('Side question');expect(app.lastFrame()).toContain('side');expect(app.lastFrame()).toContain('Side answer');
 expect(controller.getSnapshot().history).toEqual(history);expect(agent.model).toBe('mistralai/mistral-large-4-1t-a52b');
 expect(client.children[0]!.requests[0].model).toBe('custom/side');
 app.stdin.write('\x1b');await tick();expect(app.lastFrame()).toContain('Ask a question');
 await controller.submit('/btw');await tick();expect(app.lastFrame()).toContain('Side answer');expect(client.children).toHaveLength(1);
 expect(await readFile(join(directory,id+'.jsonl'),'utf8')).toBe(before);
});

it('hides the panel without stopping either task, then cancels only the side with Ctrl+C',async()=>{
 const {controller,client,app}=await setup();let finish=()=>{};let started=()=>{};
 const ready=new Promise<void>(resolve=>{started=resolve;});
 client.stream=async()=>{started();await new Promise<void>(resolve=>{finish=resolve;});return reply('Main completed');};
 client.fork=()=>{const child=new Client();client.children.push(child);child.stream=async(_input,signal)=>{await new Promise<void>(resolve=>signal?.addEventListener('abort',()=>resolve(),{once:true}));return reply('Side cancelled');};return child;};
 const main=controller.submit('Keep working');await ready;
 try{
  const side=controller.submit('/btw Separate');await tick();expect(controller.getSnapshot().sideBusy).toBe(true);
  app.stdin.write('\x1b');await tick();expect(controller.getSnapshot().sidePanelOpen).toBe(false);expect(controller.interaction.busy).toBe(true);expect(controller.interaction.sideBusy).toBe(true);
  await controller.submit('/btw');await tick();app.stdin.write('\x03');await side;await tick();
  expect(controller.getSnapshot().sidePanelOpen).toBe(false);expect(controller.interaction.busy).toBe(true);expect(controller.interaction.sideBusy).toBe(false);
  expect(controller.getSnapshot().sideQuestion?.result?.status).toBe('cancelled');
 }finally{finish();await main;}
});

it('keeps invalid side options out of the main transcript and clears transient answers with x',async()=>{
 const {controller,app}=await setup();const history=controller.getSnapshot().history;
 await controller.submit('/btw --model invalid Question');await tick();expect(app.lastFrame()).toContain('Expected --model provider/model');
 expect(controller.getSnapshot().history).toEqual(history);app.stdin.write('x');await tick();expect(controller.getSnapshot().sideQuestion).toBeUndefined();
 await controller.submit('/btw --model=custom/side Follow up');await tick();expect(app.lastFrame()).toContain('Side answer');
 app.stdin.write('x');await tick();expect(controller.getSnapshot().sidePanelOpen).toBe(false);
});

it('keeps terminal raw mode enabled across panel and input transitions',async()=>{
 const {controller,app}=await setup();const raw=vi.spyOn(app.stdin,'setRawMode');
 try{
  await controller.submit('/btw Question');await tick();app.stdin.write('\x1b');await tick();
  await controller.submit('/model');await tick();app.stdin.write('\x1b');await tick();
  expect(raw.mock.calls).not.toContainEqual([false]);
 }finally{raw.mockRestore();}
});

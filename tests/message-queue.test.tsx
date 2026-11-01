import React from 'react';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { AgentLoop } from '../src/core/agent-loop.js';
import type { CompletionInput } from '../src/core/nim-client.js';
import { UiController } from '../src/ui/controller.js';
import { App } from '../src/ui/App.js';

const roots:string[]=[],controllers:UiController[]=[];
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
afterEach(async()=>{
 cleanup();for(const controller of controllers.splice(0))await controller.close();
 for(const root of roots.splice(0)){if(!resolve(root).startsWith(resolve(tmpdir())+sep+'kairos-queue-'))throw new Error('Unexpected fixture');await rm(root,{recursive:true,force:true});}
});
async function setup(queueDuringStartup=false){
 const root=await mkdtemp(join(tmpdir(),'kairos-queue-'));roots.push(root);
 let release=()=>{};let began=()=>{};const started=new Promise<void>(resolve=>{began=resolve;});
 const prompts:string[]=[];
 const client=new class extends EventEmitter{
  async stream(input:CompletionInput,signal?:AbortSignal){
   const prompt=input.messages.filter(message=>message.role==='user').at(-1)!.content as string;prompts.push(prompt);
   if(prompts.length===1){await new Promise<void>(resolve=>{release=resolve;signal?.addEventListener('abort',()=>resolve(),{once:true});began();});signal?.throwIfAborted();}
   return {ok:true as const,value:[{id:'x',object:'chat.completion.chunk' as const,created:0,model:'test',choices:[{index:0,delta:{content:'Done '+prompt},finish_reason:'stop' as const}]}]};
  }
 }();
 const agent=new AgentLoop({workspace:root,client,session:false});const controller=new UiController(agent);controllers.push(controller);
 const app=render(<App controller={controller} version="test"/>);const boot=controller.start();
 const queuedTurn=queueDuringStartup?controller.submit('first'):undefined;await boot;await tick();
 return {controller,app,prompts,started,queuedTurn,release:()=>release()};
}
it('shows waiting messages while input remains usable, removes one and runs the rest in order',async()=>{
 const {controller,app,prompts,started,release}=await setup();
 const first=controller.submit('first');await started;
 app.stdin.write('second');await tick();app.stdin.write('\r');await tick();
 const third=controller.submit('/queue /model literal');await tick();
 expect(controller.getSnapshot().queue?.map(item=>item.text)).toEqual(['second','/model literal']);
 expect(app.lastFrame()).toContain('Queued 2');expect(app.lastFrame()).toContain('second');
 await controller.submit('/queue');expect(controller.getSnapshot().history.at(-1)?.text).toContain('/model literal');
 const id=controller.getSnapshot().queue![0]!.id;await controller.submit(`/queue remove ${id}`);
 expect(controller.getSnapshot().queue).toHaveLength(1);expect(controller.interaction.busy).toBe(true);
 release();await first;await third;await tick();
 expect(prompts).toEqual(['first','/model literal']);expect(controller.getSnapshot().queue).toEqual([]);
 expect(controller.getSnapshot().history.filter(item=>item.kind==='user').map(item=>item.text)).toEqual(['first','/model literal']);
});
it('clears only pending messages and lets the active turn finish',async()=>{
 const {controller,prompts,started,release}=await setup();const first=controller.submit('first');await started;
 const second=controller.submit('/queue second\nwith details');await tick();
 expect(controller.getSnapshot().queue?.[0]?.text).toBe('second\nwith details');
 await controller.submit('/queue clear');await second;expect(controller.interaction.busy).toBe(true);
 release();await first;expect(prompts).toEqual(['first']);expect(controller.getSnapshot().queue).toEqual([]);
});
it('preserves busy state when startup hands off to a queued turn and accepts natural remove prompts',async()=>{
 const {controller,started,queuedTurn,prompts,release}=await setup(true);await started;
 expect(controller.interaction.busy).toBe(true);expect(controller.getSnapshot().busy).toBe(true);
 const second=controller.submit('/queue remove unused imports');await tick();
 expect(controller.getSnapshot().queue?.[0]?.text).toBe('remove unused imports');
 release();await queuedTurn;await second;expect(prompts).toEqual(['first','remove unused imports']);
});
it('updates queued text and its preview without moving it or running a slash command',async()=>{
 const {controller,app,prompts,started,release}=await setup();const first=controller.submit('first');await started;
 const second=controller.submit('original');const third=controller.submit('last');await tick();const id=controller.getSnapshot().queue![0]!.id;
 const edit=controller.submit(`/queue edit ${id} /model literal\nwith details`);await tick();
 expect(controller.getSnapshot().queue).toEqual([{id,text:'/model literal\nwith details'},expect.objectContaining({text:'last'})]);
 await edit;expect(app.lastFrame()).toContain('/model literal');expect(prompts).toEqual(['first']);
 await controller.submit('/queue');expect(controller.getSnapshot().history.at(-1)?.text).toContain('/model literal\nwith details');
 release();await Promise.all([first,second,third]);
 expect(prompts).toEqual(['first','/model literal\nwith details','last']);
 expect(controller.getSnapshot().history.filter(item=>item.kind==='user').map(item=>item.text)).not.toContain('original');
 await controller.submit(`/queue edit ${id} too late`);
 expect(controller.getSnapshot().history.at(-1)).toMatchObject({kind:'error',text:expect.stringContaining('no longer waiting')});
 expect(prompts).toHaveLength(3);expect(controller.getSnapshot().queue).toEqual([]);
});
it('rejects missing or oversized replacements without adding a prompt or changing the queue',async()=>{
 const {controller,prompts,started,release}=await setup();const first=controller.submit('first');await started;
 const second=controller.submit('keep me');const id=controller.getSnapshot().queue![0]!.id;
 for(const command of [`/queue edit ${id}`,`/queue edit ${id}    `,`/queue edit ${id} ${'x'.repeat(64001)}`,`/queue edit 0 invalid`]){
  await controller.submit(command);expect(controller.getSnapshot().history.at(-1)?.kind).toBe('error');
  expect(controller.getSnapshot().queue).toEqual([{id,text:'keep me'}]);
 }
 const third=controller.submit('/queue edit unused comments');await tick();
 expect(controller.getSnapshot().queue?.[1]?.text).toBe('edit unused comments');expect(prompts).toEqual(['first']);
 release();await Promise.all([first,second,third]);expect(prompts).toEqual(['first','keep me','edit unused comments']);
});
it('selects with arrows, edits existing text in the input and pauses dispatch until save',async()=>{
 const {controller,app,prompts,started,release}=await setup();const first=controller.submit('first');await started;
 const second=controller.submit('second\nline');const third=controller.submit('third');const entries=controller.getSnapshot().queue!;
 for(const key of ['my draft','\x1b[A','\x1b[A']){app.stdin.write(key);await tick();}
 expect(controller.getSnapshot().selectedQueuedId).toBe(entries[0]!.id);expect(app.lastFrame()).toContain('Enter edit');
 app.stdin.write('\r');await tick();expect(controller.getSnapshot().queueEdit?.draft.text).toBe('second\nline');
 expect(controller.interaction.queuePaused).toBe(true);app.stdin.write(' changed');await tick();
 release();await first;await tick();expect(prompts).toEqual(['first']);expect(controller.getSnapshot().busy).toBe(false);
 expect(controller.getSnapshot().queue).toHaveLength(2);expect(app.lastFrame()).toContain('Enter save');
 app.stdin.write('\r');await tick();await Promise.all([second,third]);
 expect(prompts).toEqual(['first','second\nline changed','third']);expect(controller.interaction.queuePaused).toBe(false);
 expect(controller.getSnapshot().queueEdit).toBeUndefined();expect(app.lastFrame()).toContain('my draft');
});
it('cancels selection and editing with Esc, restores the draft and leaves the queued message unchanged',async()=>{
 const {controller,app,prompts,started,release}=await setup();const first=controller.submit('first');await started;
 const second=controller.submit('original');
 for(const key of ['keep draft','\x1b[A','\x1b']){app.stdin.write(key);await tick();}
 expect(controller.getSnapshot().selectedQueuedId).toBeUndefined();expect(prompts).toEqual(['first']);
 for(const key of ['\x1b[A','\r',' changed','\x1b']){app.stdin.write(key);await tick();}
 expect(controller.getSnapshot().queueEdit).toBeUndefined();expect(app.lastFrame()).toContain('keep draft');
 expect(controller.getSnapshot().queue?.[0]?.text).toBe('original');expect(controller.interaction.queuePaused).toBe(false);
 release();await Promise.all([first,second]);expect(prompts).toEqual(['first','original']);
});
it('saves slash-prefixed queued text literally and keeps a removed target draft instead of sending it',async()=>{
 const {controller,app,prompts,started,release}=await setup();const first=controller.submit('first');await started;
 const originalModel=controller.agent.model;const second=controller.submit('/queue /model custom/literal');
 for(const key of ['\x1b[A','\r','\r']){app.stdin.write(key);await tick();}
 expect(controller.agent.model).toBe(originalModel);expect(controller.getSnapshot().queue?.[0]?.text).toBe('/model custom/literal');
 for(const key of ['\x1b[A','\r',' details']){app.stdin.write(key);await tick();}
 controller.interaction.removeQueued(controller.getSnapshot().queueEdit!.id);await second;
 app.stdin.write('\r');await tick();expect(controller.getSnapshot().queueEdit?.draft.text).toBe('/model custom/literal details');
 expect(app.lastFrame()).toContain('no longer waiting');expect(prompts).toEqual(['first']);
 app.stdin.write('\x1b');await tick();release();await first;expect(prompts).toEqual(['first']);
});
it('scrolls the selected queue entry into view and restores the input with Down',async()=>{
 const {controller,app,started,release}=await setup();const first=controller.submit('first');await started;
 const waiting=Array.from({length:5},(_,i)=>controller.submit(`waiting ${i}`));
 app.stdin.write('\x1b[A');await tick();expect(app.lastFrame()).toContain('waiting 4');
 for(let i=0;i<4;i++){app.stdin.write('\x1b[A');await tick();}
 expect(controller.getSnapshot().selectedQueuedId).toBe(controller.getSnapshot().queue![0]!.id);
 expect(app.lastFrame()).toContain('waiting 0');
 for(let i=0;i<5;i++){app.stdin.write('\x1b[B');await tick();}
 expect(controller.getSnapshot().selectedQueuedId).toBeUndefined();expect(controller.interaction.queuePaused).toBe(false);
 release();await first;await Promise.all(waiting);
});
it.each([10,16])('keeps editing keys and the status bar visible in a %i-row terminal with stream and tool previews',async rows=>{
 const {controller,app,started,release}=await setup();const first=controller.submit('first');await started;
 Object.defineProperty(app.stdout,'rows',{value:rows,configurable:true});app.stdout.emit('resize');await tick();
 controller.agent.emit('onToolStart',{id:'preview',name:'read_files_batch',arguments:'{}'});
 controller.agent.emit('onTokenStream','Streaming preview');const waiting=controller.submit('queued text');await tick();
 for(const key of ['\x1b[A','\r']){app.stdin.write(key);await tick();}
 expect(app.lastFrame()).toContain('Enter save');expect(app.lastFrame()!.split('\n').at(-1)).toContain('Effort:');
 app.stdin.write('\x1b');await tick();release();await Promise.all([first,waiting]);
});
it.each(['removed','dispatched'])('does not send the old draft when a selected target is %s before loading',async outcome=>{
 const {controller,app,prompts,started,release}=await setup();const first=controller.submit('first');await started;
 const waiting=controller.submit('queued text');const id=controller.getSnapshot().queue![0]!.id;
 for(const key of ['keep unsent draft','\x1b[A']){app.stdin.write(key);await tick();}
 if(outcome==='removed'){controller.interaction.removeQueued(id);await waiting;}else{release();await Promise.all([first,waiting]);}
 await tick();app.stdin.write('\r');await tick();
 expect(controller.getSnapshot().history.at(-1)).toMatchObject({kind:'error',text:expect.stringContaining('no longer waiting')});
 expect(controller.getSnapshot().queue).toEqual([]);expect(prompts).not.toContain('keep unsent draft');
 expect(app.lastFrame()).toContain('keep unsent draft');release();await first;
});

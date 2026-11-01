import React from 'react';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {cleanup,render} from 'ink-testing-library';
import {AgentLoop} from '../src/core/agent-loop.js';
import {Interaction} from '../src/core/interaction.js';
import {UiController} from '../src/ui/controller.js';
import {App} from '../src/ui/App.js';
import {serveRpc} from '../src/integrations/rpc.js';
const roots:string[]=[],controllers:UiController[]=[];
const tick=()=>new Promise(resolve=>setTimeout(resolve,35));
afterEach(async()=>{cleanup();for(const controller of controllers.splice(0))await controller.close();for(const root of roots.splice(0)){if(!resolve(root).startsWith(resolve(tmpdir())+sep+'kairos-advanced-ui-'))throw new Error('Unexpected fixture');await rm(root,{recursive:true,force:true});}});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'kairos-advanced-ui-'));roots.push(root);const client=new class extends EventEmitter{calls=0;async stream(){this.calls++;return {ok:true as const,value:[{id:'x',object:'chat.completion.chunk' as const,created:0,model:'test',choices:[{index:0,delta:{content:'Done'},finish_reason:'stop' as const}]}]};}}();const agent=new AgentLoop({workspace:root,client,session:false,undoDirectory:join(root,'undo'),memory:{directory:join(root,'memory')},permissions:{shell:'allow'},shellInvocation:()=>({file:process.execPath,args:['-e','setTimeout(()=>{},20000)']})});return {root,client,agent};}
it('manages memory locally and selects a conversation rewind from the live App',async()=>{
 const {agent,client}=await fixture();const controller=new UiController(agent);controllers.push(controller);const app=render(<App controller={controller} version="test"/>);await controller.start();await tick();
 await controller.submit('/memory add Prefer small changes.');await controller.submit('/memory');expect(controller.getSnapshot().history.at(-1)?.text).toContain('Prefer small changes.');expect(client.calls).toBe(0);
 await controller.submit('First prompt');await controller.submit('/rewind');await tick();expect(app.lastFrame()).toContain('Rewind');
 app.stdin.write('\x1b[C');await tick();app.stdin.write('\r');
 for(let i=0;i<100&&controller.getSnapshot().rewindPoints;i++)await tick();
 expect(controller.getSnapshot().rewindPoints).toBeUndefined();expect(agent.messages).toEqual([]);expect(client.calls).toBe(1);
 await controller.submit('/memory clear');expect(await agent.listMemory()).toEqual([]);
});
it('starts, inspects and stops a supervised task through local commands without inference',async()=>{
 const {agent,client}=await fixture();const controller=new UiController(agent);controllers.push(controller);const app=render(<App controller={controller} version="test"/>);await controller.start();await tick();
 await controller.submit('/tasks start wait');const task=agent.backgroundTasks.list()[0]!;expect(task.status).toBe('running');await tick();expect(app.lastFrame()).toContain('Tasks 1');
 await controller.submit('/tasks');expect(controller.getSnapshot().history.at(-1)?.text).toContain(task.id);
 await controller.submit('/tasks stop all');expect(agent.backgroundTasks.list()[0]!.status).toBe('cancelled');expect(client.calls).toBe(0);
});
it('exposes memory and rewind workflows over RPC',async()=>{
 const {agent,client}=await fixture();const interaction=new Interaction(agent);const input=new PassThrough(),output=new PassThrough();const responses=new Map<number,any>();let buffered='';
 output.on('data',chunk=>{buffered+=chunk.toString();let newline;while((newline=buffered.indexOf('\n'))>=0){const row=JSON.parse(buffered.slice(0,newline));buffered=buffered.slice(newline+1);if(typeof row.id==='number')responses.set(row.id,row);}});
 const serving=serveRpc(interaction,input,output);let next=0;
 const request=async(method:string,params:Record<string,unknown>={})=>{const id=++next;input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');for(let i=0;i<200;i++){if(responses.has(id))return responses.get(id);await tick();}throw new Error('Missing RPC reply');};
 try{expect((await request('updateMemory',{changes:[{action:'add',text:'Run focused tests.'}]})).result).toHaveLength(1);expect((await request('memory')).result[0].text).toBe('Run focused tests.');expect((await request('prompt',{text:'One prompt'})).result.status).toBe('completed');const points=(await request('rewindPoints')).result;expect(points).toHaveLength(1);expect((await request('rewind',{id:points[0].id,scope:'conversation'})).result.ok).toBe(true);expect(agent.messages).toEqual([]);expect(client.calls).toBe(1);}finally{input.end();await serving;}
});

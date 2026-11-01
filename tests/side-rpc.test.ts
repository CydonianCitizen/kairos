import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { AgentLoop } from '../src/core/agent-loop.js';
import { Interaction } from '../src/core/interaction.js';
import { serveRpc } from '../src/integrations/rpc.js';

const reply=(text:string)=>({ok:true as const,value:[{id:'x',object:'chat.completion.chunk' as const,created:0,model:'test',choices:[{index:0,delta:{content:text},finish_reason:'stop' as const}]}]});
it('branches over RPC and routes side tokens, state and cancellation separately from the main turn',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kairos-side-rpc-'));const input=new PassThrough();const output=new PassThrough();
 const records:any[]=[];const waiting=new Map<number,(value:any)=>void>();
 output.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n')){const record=JSON.parse(line);records.push(record);waiting.get(record.id)?.(record);waiting.delete(record.id);}});
 let finish=()=>{};let mainStarted=()=>{};const mainRunning=new Promise<void>(resolve=>{mainStarted=resolve;});let sideStarted=()=>{};const running=new Promise<void>(resolve=>{sideStarted=resolve;});
 const client=new class extends EventEmitter{
  async stream(){await new Promise<void>(resolve=>{finish=resolve;mainStarted();});this.emit('onTokenStream','Main');return reply('Main');}
  fork(){return new class extends EventEmitter{async stream(_input:any,signal?:AbortSignal){this.emit('onTokenStream','Side');sideStarted();await new Promise<void>(resolve=>signal?.addEventListener('abort',()=>resolve(),{once:true}));return reply('Side');}}();}
 }();
 const agent=new AgentLoop({workspace:root,client,session:{directory:join(root,'sessions')}});await agent.initialize();const parent=agent.sessionId!;
 const serving=serveRpc(new Interaction(agent),input,output);
 const send=(id:number,method:string,params?:any)=>{const result=new Promise<any>(resolve=>waiting.set(id,resolve));input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return result;};
 try{
  expect((await send(1,'branch',{name:'RPC branch',model:'custom/branch'})).result).toMatchObject({parentId:parent});
  const branch=agent.sessionId!;const main=send(2,'prompt',{text:'Main turn'});
  // Wait for the main request to be dispatched before asking the side question.
  await mainRunning;
  const side=send(3,'btw',{text:'Independent',model:'custom/side'});await running;
  expect((await send(4,'state')).result).toMatchObject({model:'custom/branch',sessionId:branch,busy:true,sideBusy:true});
  await send(5,'cancelSide');expect((await side).result.status).toBe('cancelled');
  expect((await send(6,'state')).result.busy).toBe(true);finish();expect((await main).result.status).toBe('completed');
  const events=records.filter(r=>r.method==='event').map(r=>r.params);
  expect(events).toContainEqual({type:'side_token',data:'Side'});expect(events).toContainEqual({type:'token',data:'Main'});
  expect(events.filter(e=>e.type==='token')).not.toContainEqual({type:'token',data:'Side'});
  expect(events.find(e=>e.type==='side_start')?.data.model).toBe('custom/side');
  expect(events.find(e=>e.type==='side_result')?.data.result.status).toBe('cancelled');
 }finally{finish();input.end();await serving;await rm(root,{recursive:true,force:true});}
});

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect,it } from 'vitest';
import { Interaction } from '../src/core/interaction.js';
import { serveRpc } from '../src/integrations/rpc.js';
import { AgentLoop } from '../src/core/agent-loop.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function engine(){let release:()=>void=()=>{};const calls:string[]=[];const agent=Object.assign(new EventEmitter(),{model:'test/model',mode:'build',messages:[],close:async()=>{},run:async(prompt:string,{signal}:{signal:AbortSignal})=>{calls.push(prompt);if(prompt==='slow')await new Promise<void>(resolve=>{release=resolve;signal.addEventListener('abort',()=>resolve(),{once:true});});return {status:signal.aborted?'cancelled':'completed',text:prompt,iterations:1};},steer:()=>{}});return {agent:agent as unknown as AgentLoop,calls,release:()=>release()};}
it('queues prompts FIFO and cancels active and queued work without executing the queue',async()=>{
 const {agent,calls,release}=engine();const interaction=new Interaction(agent);
 const first=interaction.prompt('slow');const second=interaction.prompt('second');await Promise.resolve();expect(calls).toEqual(['slow']);release();await first;await second;await interaction.drain();expect(calls).toEqual(['slow','second']);
 const active=interaction.prompt('slow');const queued=interaction.prompt('never');interaction.cancel();expect((await active).status).toBe('cancelled');expect((await queued).status).toBe('cancelled');expect(calls).not.toContain('never');await interaction.close();
});
it('RPC accepts cancellation while a prompt is pending and drains on EOF',async()=>{
 const {agent,calls}=engine();const interaction=new Interaction(agent);const input=new PassThrough();const output=new PassThrough();let text='';output.on('data',d=>text+=d);
 const serving=serveRpc(interaction,input,output);
 input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'prompt',params:{text:'slow'}})+'\n');
 await new Promise(r=>setTimeout(r,10));input.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'cancel'})+'\n');input.end();await serving;
 const records=text.trim().split('\n').map(s=>JSON.parse(s));expect(records.find(r=>r.id===1)?.result.status).toBe('cancelled');expect(records.find(r=>r.id===2)?.result).toMatchObject({cancelled:true});expect(calls).toEqual(['slow']);
});
it('makes state-changing actions available immediately after awaiting a completed prompt',async()=>{
 const {agent}=engine();const interaction=new Interaction(agent);await interaction.prompt('fast');expect(interaction.busy).toBe(false);expect(await interaction.action(()=>42)).toBe(42);await interaction.close();
});
it('exposes FIFO queue entries and removes or clears only waiting prompts',async()=>{
 const {agent,calls,release}=engine();const interaction=new Interaction(agent);
 const first=interaction.prompt('slow');await Promise.resolve();
 const second=interaction.prompt('second');const third=interaction.prompt('/model literal prompt');
 const entries=interaction.queueSnapshot;
 expect(entries.map(item=>item.text)).toEqual(['second','/model literal prompt']);
 expect(new Set(entries.map(item=>item.id)).size).toBe(2);
 entries[0]!.text='changed outside';expect(interaction.queueSnapshot[0]!.text).toBe('second');
 expect(interaction.removeQueued(entries[0]!.id)).toBe(true);expect((await second).status).toBe('cancelled');
 expect(interaction.removeQueued(entries[0]!.id)).toBe(false);expect(interaction.busy).toBe(true);
 release();await first;await third;expect(calls).toEqual(['slow','/model literal prompt']);
 const next=interaction.prompt('slow');await Promise.resolve();const waiting=interaction.prompt('never');
 expect(interaction.clearQueue()).toBe(1);expect((await waiting).status).toBe('cancelled');expect(interaction.busy).toBe(true);
 release();expect((await next).status).toBe('completed');expect(calls).not.toContain('never');await interaction.close();
});
it('caps the waiting queue at twenty without rejecting the active prompt or losing entries',async()=>{
 const {agent,calls,release}=engine();const interaction=new Interaction(agent);
 const active=interaction.prompt('slow');await Promise.resolve();
 const waiting=Array.from({length:20},(_,i)=>interaction.prompt(`waiting ${i}`));
 expect(interaction.editQueued(interaction.queueSnapshot[0]!.id,'updated in a full queue')).toBe(true);
 await expect(interaction.prompt('overflow')).rejects.toThrow('queue full');
 expect(interaction.queueSnapshot).toHaveLength(20);interaction.clearQueue();
 expect((await Promise.all(waiting)).every(result=>result.status==='cancelled')).toBe(true);
 release();await active;expect(calls).toEqual(['slow']);await interaction.close();
});
it('edits a waiting prompt in place and resolves its original request with the new text',async()=>{
 const {agent,calls,release}=engine();const interaction=new Interaction(agent);
 try{
  const first=interaction.prompt('slow');await Promise.resolve();
  const second=interaction.prompt('original');const third=interaction.prompt('last');const entries=interaction.queueSnapshot;
  const events:number[]=[];interaction.on('queue',count=>events.push(count));
  expect(interaction.editQueued(entries[0]!.id,'updated\n/model literal')).toBe(true);
  expect(interaction.queueSnapshot).toEqual([{id:entries[0]!.id,text:'updated\n/model literal'},entries[1]]);
  expect(events).toEqual([2]);expect(calls).toEqual(['slow']);
  expect(interaction.editQueued(1,'cannot change active turn')).toBe(false);
  release();await first;expect((await second).text).toBe('updated\n/model literal');await third;
  expect(calls).toEqual(['slow','updated\n/model literal','last']);
  expect(interaction.editQueued(entries[0]!.id,'too late')).toBe(false);
 }finally{await interaction.close();}
});
it('rejects invalid queue edits without changing the accepted prompt',async()=>{
 const {agent,release}=engine();const interaction=new Interaction(agent);
 try{
  const first=interaction.prompt('slow');await Promise.resolve();const second=interaction.prompt('keep me');const id=interaction.queueSnapshot[0]!.id;
  for(const invalid of ['', ' \n\t', 'x'.repeat(64001)])expect(()=>interaction.editQueued(id,invalid)).toThrow();
  expect(()=>interaction.editQueued(id,42 as unknown as string)).toThrow();
  for(const invalid of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])expect(()=>interaction.editQueued(invalid,'updated')).toThrow();
  expect(interaction.queueSnapshot).toEqual([{id,text:'keep me'}]);
  expect(interaction.editQueued(id,'x'.repeat(64000))).toBe(true);
  expect(interaction.queueSnapshot[0]!.text.length).toBe(64000);
  interaction.clearQueue();expect(interaction.editQueued(id,'removed')).toBe(false);
  await second;release();await first;
 }finally{await interaction.close();}
});
it('pauses dispatch while the active turn finishes, then resumes the edited FIFO',async()=>{
 const {agent,calls,release}=engine();const interaction=new Interaction(agent);
 try{
  const first=interaction.prompt('slow');await Promise.resolve();const second=interaction.prompt('second');const third=interaction.prompt('third');
  interaction.pauseQueue();expect(interaction.queuePaused).toBe(true);release();await first;
  expect(interaction.busy).toBe(false);expect(calls).toEqual(['slow']);expect(interaction.queued).toBe(2);
  interaction.editQueued(interaction.queueSnapshot[0]!.id,'edited');interaction.resumeQueue();
  await Promise.all([second,third]);expect(interaction.queuePaused).toBe(false);expect(calls).toEqual(['slow','edited','third']);
 }finally{await interaction.close();}
});
it('cancels a paused queue and allows subsequent work to run normally',async()=>{
 const {agent,calls}=engine();const interaction=new Interaction(agent);
 try{
  interaction.pauseQueue();const pending=interaction.prompt('never');interaction.cancel();
  expect((await pending).status).toBe('cancelled');expect(interaction.queuePaused).toBe(false);
  expect((await interaction.prompt('next')).status).toBe('completed');expect(calls).toEqual(['next']);
  interaction.pauseQueue();const closing=interaction.prompt('also never');await interaction.close();expect((await closing).status).toBe('cancelled');
 }finally{await interaction.close();}
});
it('RPC exposes queue previews and supports removal and clearing while a prompt is running',async()=>{
 const {agent,calls,release}=engine();const interaction=new Interaction(agent);
 const input=new PassThrough(),output=new PassThrough();let body='';output.on('data',chunk=>{body+=chunk.toString();});
 const serving=serveRpc(interaction,input,output);
 const send=(id:number,method:string,params:Record<string,unknown>={})=>input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 const records=()=>body.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const response=async(id:number)=>{for(let i=0;i<100;i++){const row=records().find(row=>row.id===id);if(row)return row;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error(`Missing RPC response ${id}`);};
 try{
  send(1,'prompt',{text:'slow'});await Promise.resolve();send(2,'prompt',{text:'second'});send(3,'prompt',{text:'third'});
  send(4,'queue');const queue=(await response(4)).result.items;
  expect(queue.map((item:{preview:string})=>item.preview)).toEqual(['second','third']);
  send(7,'editQueued',{id:queue[0].id,text:'updated second'});expect((await response(7)).result).toEqual({updated:true});
  expect(records().some(row=>row.params?.type==='queue'&&row.params.data.items[0]?.preview==='updated second')).toBe(true);
  send(8,'editQueued',{id:queue[0].id,text:' '});expect((await response(8)).error).toBeDefined();
  send(9,'editQueued',{id:'invalid',text:'no'});expect((await response(9)).error).toBeDefined();
  send(5,'removeQueued',{id:queue[0].id});expect((await response(5)).result).toEqual({removed:true});
  expect((await response(2)).result.status).toBe('cancelled');
  send(10,'editQueued',{id:queue[0].id,text:'removed'});expect((await response(10)).result).toEqual({updated:false});
  send(6,'clearQueue');expect((await response(6)).result).toEqual({cleared:1});
  expect((await response(3)).result.status).toBe('cancelled');expect(calls).toEqual(['slow']);
  expect(records().some(row=>row.params?.type==='queue'&&row.params.data.items.length===2)).toBe(true);
  release();expect((await response(1)).result.status).toBe('completed');
 }finally{interaction.cancel();input.end();await serving;}
});
it('renames a persistent session through RPC and exposes its name in state and session metadata', async () => {
 const root = await mkdtemp(join(tmpdir(),'kairos-rename-rpc-'));
 const client = new class extends EventEmitter { async stream() { throw new Error('Rename must not call NIM'); } }();
 const agent = new AgentLoop({workspace:root,client,session:{directory:join(root,'sessions')}});
 const input = new PassThrough(); const output = new PassThrough(); let result = '';
 let renamed = () => {}; const saved = new Promise<void>(resolve => { renamed = resolve; });
 output.on('data', chunk => { result += chunk.toString(); if (chunk.toString().includes('"id":1,"result"')) renamed(); });
 const serving = serveRpc(new Interaction(agent),input,output);
 try {
  input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'rename',params:{name:'RPC session'}})+'\n'); await saved;
  input.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'state'})+'\n');
  input.end(JSON.stringify({jsonrpc:'2.0',id:3,method:'sessions'})+'\n'); await serving;
  const records = result.trim().split('\n').map(line=>JSON.parse(line));
  expect(records.find(row=>row.id===1)?.result).toMatchObject({name:'RPC session'});
  expect(records.find(row=>row.id===2)?.result).toMatchObject({sessionName:'RPC session'});
  expect(records.find(row=>row.id===3)?.result).toEqual(expect.arrayContaining([expect.objectContaining({name:'RPC session'})]));
 } finally { input.end(); await serving; await rm(root,{recursive:true,force:true}); }
});

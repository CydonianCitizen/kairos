import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect,it } from 'vitest';
import { Interaction } from '../src/core/interaction.js';
import { serveRpc } from '../src/integrations/rpc.js';
import type { AgentLoop } from '../src/core/agent-loop.js';
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

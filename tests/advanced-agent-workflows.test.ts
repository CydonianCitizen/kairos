import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {AgentLoop} from '../src/core/agent-loop.js';
import type {CompletionInput} from '../src/core/nim-client.js';
const roots:string[]=[],agents:AgentLoop[]=[];
afterEach(async()=>{for(const agent of agents.splice(0))await agent.close();for(const root of roots.splice(0)){if(!resolve(root).startsWith(resolve(tmpdir())+sep+'kairos-advanced-'))throw new Error('Unexpected fixture');await rm(root,{recursive:true,force:true});}});
async function root(){const root=await mkdtemp(join(tmpdir(),'kairos-advanced-'));roots.push(root);return root;}
function client(){return new class extends EventEmitter{inputs:CompletionInput[]=[];async stream(input:CompletionInput){this.inputs.push(structuredClone(input));return {ok:true as const,value:[{id:'x',object:'chat.completion.chunk' as const,created:0,model:'test',choices:[{index:0,delta:{content:'Done'},finish_reason:'stop' as const}]}]};}}();}
it('loads durable memory in a new session and supports explicit add/remove without inference',async()=>{
 const workspace=await root(),firstClient=client();const first=new AgentLoop({workspace,client:firstClient,session:false,memory:{directory:join(workspace,'notes')}});agents.push(first);
 const notes=await first.updateMemory([{action:'add',text:'Prefer Italian responses.'}]);expect(notes).toHaveLength(1);expect(firstClient.inputs).toEqual([]);
 const secondClient=client(),second=new AgentLoop({workspace,client:secondClient,session:false,memory:{directory:join(workspace,'notes')}});agents.push(second);
 expect((await second.run('Describe the project')).status).toBe('completed');expect(JSON.stringify(secondClient.inputs[0])).toContain('Prefer Italian responses.');
 await second.updateMemory([{action:'remove',id:notes[0]!.id}]);expect(await first.listMemory()).toEqual([]);
});
it('loads trusted nested instructions for explicit paths and omits them without trust',async()=>{
 const workspace=await root();await mkdir(join(workspace,'src'));await writeFile(join(workspace,'src/AGENTS.md'),'Nested rule: use descriptive function names.');await writeFile(join(workspace,'src/math.ts'),'export const answer = 42;');
 for(const trusted of [false,true]){const transport=client(),agent=new AgentLoop({workspace,client:transport,session:false,trustWorkspace:trusted});agents.push(agent);expect((await agent.run('Explain @file:src/math.ts')).status).toBe('completed');expect(JSON.stringify(transport.inputs[0]).includes('Nested rule:')).toBe(trusted);}
});
it('records prompt checkpoints and rewinds conversation and own edits together without inference',async()=>{
 const workspace=await root();await writeFile(join(workspace,'a.txt'),'original');let calls=0;
 const transport=new class extends EventEmitter{async stream(input:CompletionInput){calls++;const last=input.messages.at(-1);const edit=last?.role==='user';return {ok:true as const,value:[{id:'x',object:'chat.completion.chunk' as const,created:0,model:'test',choices:[{index:0,delta:edit?{tool_calls:[{index:0,id:'edit'+calls,type:'function' as const,function:{name:'apply_edits_batch',arguments:JSON.stringify({edits:[{path:'a.txt',old_text:calls===1?'original':'first change',new_text:calls===1?'first change':'second change'}]})}}]}:{content:'Done'},finish_reason:edit?'tool_calls' as const:'stop' as const}]}]};}}();
 const agent=new AgentLoop({workspace,client:transport,session:false,undoDirectory:join(workspace,'undo')});agents.push(agent);
 expect((await agent.run('First edit')).status).toBe('completed');expect((await agent.run('Second edit')).status).toBe('completed');const points=await agent.listRewinds();expect(points.map(point=>point.prompt)).toEqual(['First edit','Second edit']);
 expect((await agent.rewind(points[0]!.id,'both')).ok).toBe(true);expect(await readFile(join(workspace,'a.txt'),'utf8')).toBe('original');expect(agent.messages).toEqual([]);expect(calls).toBe(4);
}, 15000);
it.each(['start','undo','rewind'])('loads persisted plan mode before %s effects through a fresh SDK instance',async operation=>{
 const workspace=await root(),directory=join(workspace,'sessions'),undoDirectory=join(workspace,'undo');
 const seed=new AgentLoop({workspace,client:client(),session:{directory},undoDirectory});agents.push(seed);await seed.run('Checkpoint');const id=seed.sessionId!,point=(await seed.listRewinds())[0]!;seed.setMode('plan');await seed.close();
 const fresh=new AgentLoop({workspace,client:client(),session:{directory,id},undoDirectory});agents.push(fresh);
 const start=vi.spyOn(fresh.backgroundTasks,'start').mockResolvedValue({id:'never',command:'never',status:'running',startedAt:new Date().toISOString(),exitCode:null,timedOut:false,truncated:false});
 const attempt=operation==='start'?fresh.startBackground('never'):operation==='undo'?fresh.undoLast():fresh.rewind(point.id,'files');
 await expect(attempt).rejects.toThrow(/plan/i);expect(start).not.toHaveBeenCalled();
});
it('loads nested instructions for a reference introduced by steering before the next request',async()=>{
 const workspace=await root();await mkdir(join(workspace,'src'));await writeFile(join(workspace,'src/AGENTS.md'),'Steered rule: preserve documented interfaces.');await writeFile(join(workspace,'src/math.ts'),'export const answer=42;');
 let agent:AgentLoop;const inputs:CompletionInput[]=[];const transport=new class extends EventEmitter{async stream(input:CompletionInput){inputs.push(structuredClone(input));const first=inputs.length===1;if(first)agent.steer('Check @file:src/math.ts');return {ok:true as const,value:[{id:'x',object:'chat.completion.chunk' as const,created:0,model:'test',choices:[{index:0,delta:first?{tool_calls:[{index:0,id:'map',type:'function' as const,function:{name:'get_repo_map',arguments:'{}'}}]}:{content:'Done'},finish_reason:first?'tool_calls' as const:'stop' as const}]}]};}}();
 agent=new AgentLoop({workspace,client:transport,trustWorkspace:true,session:false});agents.push(agent);expect((await agent.run('Start work')).status).toBe('completed');expect(inputs).toHaveLength(2);expect(JSON.stringify(inputs[1])).toContain('Steered rule: preserve documented interfaces.');
});

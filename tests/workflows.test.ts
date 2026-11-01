import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { AgentLoop } from '../src/core/agent-loop.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true});});
async function root(){const r=await mkdtemp(join(tmpdir(),'nim-workflow-'));roots.push(r);await writeFile(join(r,'a.ts'),'export const n = 1;');return r;}
function response(content:string, tool?:string,args:unknown={}){return [{id:'x',object:'chat.completion.chunk' as const,created:0,model:'test',choices:[{index:0,delta:tool?{tool_calls:[{index:0,id:'call',type:'function' as const,function:{name:tool,arguments:JSON.stringify(args)}}]}:{content},finish_reason:tool?'tool_calls' as const:'stop' as const}]}];}
class Client extends EventEmitter { requests:any[]=[]; constructor(public replies:any[]=[]){super();} async stream(input:any){this.requests.push(input);const r=this.replies.shift();if(!r)return {ok:false as const,error:'offline'};for(const c of r)if(c.choices[0].delta.content)this.emit('onTokenStream',c.choices[0].delta.content);return {ok:true as const,value:r};} }
it('persists effort, sends it on every tool turn and restores it in a fresh engine', async () => {
  const r = await root(); const directory = join(r, 'sessions');
  const client = new Client([response('', 'get_repo_map'), response('Done')]);
  const agent = new AgentLoop({ workspace: r, client, session: { directory } });
  await agent.initialize(); agent.setEffort('high');
  expect((await agent.run('Inspect')).status).toBe('completed');
  expect(client.requests.map(request => request.effort)).toEqual(['high', 'high']);
  const id = agent.sessionId!; await agent.close();
  const restored = new AgentLoop({ workspace: r, client: new Client([]), session: { directory, id } });
  try {
    await restored.initialize(); expect(restored.effort).toBe('high');
    restored.setModel('custom/new-model'); expect(restored.effort).toBe('auto');
  } finally { await restored.close(); }
});
it('persists and resumes context in a fresh engine',async()=>{
 const r=await root();const dir=join(r,'sessions');const first=new AgentLoop({workspace:r,client:new Client([response('Remembered')]),session:{directory:dir}});
 await first.run('Remember blue');const id=first.sessionId!;await first.close();
 const client=new Client([response('Blue')]);const second=new AgentLoop({workspace:r,client,session:{directory:dir,id}});
 await second.run('Which color?');expect(JSON.stringify(client.requests[0].messages)).toContain('Remember blue');await second.close();
});
it('plan mode refuses edits and shell even if the model calls hidden tools',async()=>{
 const r=await root();const client=new Client([response('', 'apply_edits_batch',{edits:[{path:'a.ts',old_text:'1',new_text:'2'}]}),response('', 'run_bash',{command:'echo unsafe'}),response('Plan ready')]);
 const agent=new AgentLoop({workspace:r,client,mode:'plan'});expect((await agent.run('Plan a change')).status).toBe('completed');
 expect(await readFile(join(r,'a.ts'),'utf8')).toContain('1');expect(client.requests[0].tools.map((x:any)=>x.function.name)).not.toContain('run_bash');
 expect(JSON.stringify(client.requests.at(-1).messages)).toContain('plan mode');await agent.close();
});
it('compacts semantically without streaming the private summary and falls back locally',async()=>{
 const r=await root();const client=new Client([response('First answer'),response('Second answer'),response('Goal: blue; completed: two answers')]);
 const agent=new AgentLoop({workspace:r,client});await agent.run('Remember blue');await agent.run('Continue');
 const tokens:string[]=[];agent.on('onTokenStream',t=>tokens.push(t));expect(await agent.compactContext()).toBeGreaterThan(0);expect(tokens).toEqual([]);
 client.replies.push(response('Third'));await agent.run('Continue again');expect(JSON.stringify(client.requests.at(-1).messages)).toContain('Goal: blue');
 expect(await agent.compactContext()).toBeGreaterThan(0);await agent.close();
});
it('steers only after the current tool group and records every tool result',async()=>{
 const r=await root();const client=new Client([response('', 'get_repo_map'),response('Followed steering')]);const agent=new AgentLoop({workspace:r,client});
 agent.on('onToolStart',()=>agent.steer('Also mention tests'));
 await agent.run('Inspect');const messages=client.requests[1].messages;const index=messages.findIndex((m:any)=>m.role==='tool');
 expect(messages[index+1]).toMatchObject({role:'user',content:'Also mention tests'});await agent.close();
});
it('serializes direct session changes and rejects state mutation after close',async()=>{
 const r=await root();const agent=new AgentLoop({workspace:r,client:new Client([]),session:{directory:join(r,'sessions')}});
 const opening=agent.newSession();expect(()=>agent.setMode('plan')).toThrow(/busy|active/);await opening;
 await agent.close();expect(()=>agent.setModel('test/model')).toThrow(/closed/);await expect(agent.newSession()).rejects.toThrow(/closed/);
});
it('does not change conversation when summary generation is cancelled',async()=>{
 const r=await root();const client=new Client([response('One'),response('Two')]);const agent=new AgentLoop({workspace:r,client});await agent.run('First');await agent.run('Second');const before=agent.messages;
 const abort=new AbortController();client.stream=async()=>{abort.abort();return {ok:true as const,value:response('Partial summary')};};
 await expect(agent.compactContext({signal:abort.signal})).rejects.toThrow();expect(agent.messages).toEqual(before);await agent.close();
});
it('preserves an explicit SDK plan selection before lazy session restoration',async()=>{
 const r=await root();const dir=join(r,'sessions');const saved=new AgentLoop({workspace:r,client:new Client([]),session:{directory:dir}});await saved.initialize();const id=saved.sessionId!;await saved.close();
 const restored=new AgentLoop({workspace:r,client:new Client([]),session:{directory:dir,id}});restored.setMode('plan');restored.setModel('test/model');await restored.initialize();expect(restored.mode).toBe('plan');expect(restored.model).toBe('test/model');await restored.close();
});
it('executes a trusted plugin through the model dispatcher and refreshes repository context',async()=>{
 const {mkdir}=await import('node:fs/promises');const {createAgent}=await import('../src/index.js');const r=await root();await mkdir(join(r,'.nim'));
 await writeFile(join(r,'.nim','plugin.mjs'),`import {writeFile} from 'node:fs/promises';import {join} from 'node:path';export default api=>{api.registerTool({name:'replace',description:'Replace the source file',parameters:{type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false},execute:async(args,{workspace})=>{await writeFile(join(workspace,'a.ts'),'export const changed = '+args.value+';');return {changed:true};}});};`);
 await writeFile(join(r,'.nim','config.json'),JSON.stringify({plugins:['.nim/plugin.mjs']}));
 const client=new Client([response('', 'extension_tools_batch',{calls:[{name:'replace',arguments:{value:2}}]}),response('Changed')]);
 const agent=await createAgent({workspace:r,client,trustWorkspace:true});
 expect((await agent.run('Use replace to change the file')).status).toBe('completed');expect(await readFile(join(r,'a.ts'),'utf8')).toContain('changed = 2');
 expect(client.requests[0].tools.some((t:any)=>t.function.name==='extension_tools_batch')).toBe(true);expect(JSON.stringify(client.requests[1].messages)).toContain('changed');await agent.close();
},15000);
it('does not allow explicitly disabled persistence to create a session',async()=>{
 const r=await root();const agent=new AgentLoop({workspace:r,client:new Client([]),session:false});await expect(agent.newSession()).rejects.toThrow(/disabled/);await expect(agent.resumeSession('invalid')).rejects.toThrow(/disabled/);await agent.close();
});
it('notifies plugin turn-end hooks when the provider fails',async()=>{
 const {mkdir}=await import('node:fs/promises');const {createAgent}=await import('../src/index.js');const r=await root();await mkdir(join(r,'.nim'));
 await writeFile(join(r,'.nim','hook.mjs'),`import {writeFile} from 'node:fs/promises';export default api=>api.onTurnEnd(result=>writeFile(new URL('./ended.txt',import.meta.url),result.status));`);
 await writeFile(join(r,'.nim','config.json'),JSON.stringify({plugins:['.nim/hook.mjs']}));const agent=await createAgent({workspace:r,client:new Client([]),trustWorkspace:true});
 expect((await agent.run('Try')).status).toBe('error');expect(await readFile(join(r,'.nim','ended.txt'),'utf8')).toBe('error');await agent.close();
});

import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentLoop } from '../src/core/agent-loop.js';
import { Interaction } from '../src/core/interaction.js';
import { SessionStore } from '../src/core/session-store.js';

const roots: string[] = [];
const agents: AgentLoop[] = [];
const reply = (text: string) => ({ ok: true as const, value: [{ id: 'x', object: 'chat.completion.chunk' as const, created: 0, model: 'test', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' as const }] }] });
class Client extends EventEmitter {
  requests: any[] = [];
  children: Client[] = [];
  async stream(input: any, _signal?: AbortSignal) { this.requests.push(input); this.emit('onTokenStream', 'Answer'); return reply('Answer'); }
  fork(): Client { const child = new Client(); this.children.push(child); return child; }
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'kairos-side-')); roots.push(root);
  const directory = join(root, 'sessions'); const client = new Client();
  await writeFile(join(root,'a.ts'),'export const value = 1;');
  const agent = new AgentLoop({ workspace: root, client, session: { directory } }); agents.push(agent);
  await agent.run('Remember the blue architecture'); await agent.renameSession('Original'); agent.setEffort('high');
  return { root, directory, client, agent };
}
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  for (const root of roots.splice(0)) await rm(root, {recursive:true,force:true});
});

it('branches context into another journal and model while leaving the original bytes and settings untouched', async () => {
  const { agent, root, directory, client } = await setup(); const original = agent.sessionId!;
  const file = join(directory,original+'.jsonl'); await agent.renameSession('Original');
  const before = await readFile(file,'utf8'); const messages = agent.messages;
  await agent.branchSession({name:'Alternative',model:'custom/other-model'});
  const branch = agent.sessionId!;
  expect(branch).not.toBe(original); expect(agent.sessionName).toBe('Alternative');
  expect(agent.model).toBe('custom/other-model'); expect(agent.effort).toBe('auto'); expect(agent.messages).toEqual(messages);
  expect(await readFile(file,'utf8')).toBe(before);
  await agent.run('Try the alternative');
  expect(client.requests.at(-1).model).toBe('custom/other-model');
  await agent.resumeSession(original);
  expect(agent.messages).toEqual(messages); expect(agent.model).toBe('mistralai/mistral-large-4-1t-a52b');
  expect(agent.effort).toBe('high'); expect(agent.sessionName).toBe('Original');
  expect(await readFile(file,'utf8')).toBe(before);
  expect((await agent.listSessions()).find(session=>session.id===branch)?.parentId).toBe(original);
  expect(await readFile(join(root,'a.ts'),'utf8')).toBe('export const value = 1;');
});

it('answers a side question with an isolated client and model without changing the original context or journal', async () => {
  const { agent, directory, client } = await setup(); const id = agent.sessionId!;
  await agent.renameSession('Original'); const before = await readFile(join(directory,id+'.jsonl'),'utf8'); const messages = agent.messages;
  const mainTokens: string[] = []; const sideTokens: string[] = [];
  agent.on('onTokenStream', t=>mainTokens.push(t)); agent.on('onSideTokenStream', t=>sideTokens.push(t));
  const result = await agent.sideQuestion('What color did we choose?', {model:'custom/other-model'});
  expect(result.status).toBe('completed'); expect(client.children).toHaveLength(1);
  const request = client.children[0]!.requests[0];
  expect(request.model).toBe('custom/other-model'); expect(request.tools).toBeUndefined();
  expect(JSON.stringify(request.messages)).toContain('Remember the blue architecture');
  expect(mainTokens).toEqual([]); expect(sideTokens).toEqual(['Answer']);
  expect(agent.messages).toEqual(messages); expect(agent.sessionId).toBe(id); expect(agent.sessionName).toBe('Original');
  expect(agent.model).toBe('mistralai/mistral-large-4-1t-a52b'); expect(agent.effort).toBe('high');
  expect(await readFile(join(directory,id+'.jsonl'),'utf8')).toBe(before);
});

it('keeps a main turn active while a side question runs and cancels only the side question', async () => {
  const { agent, client } = await setup(); const interaction = new Interaction(agent);
  let finish = () => {}; let started = () => {};
  const running = new Promise<void>(resolve=>{started=resolve;});
  client.stream = async input => { client.requests.push(input); started(); await new Promise<void>(resolve=>{finish=resolve;}); return reply('Main completed'); };
  client.fork = () => {
    const child = new Client(); client.children.push(child);
    child.stream = async (_input, signal) => { await new Promise<void>(resolve=>signal?.addEventListener('abort',()=>resolve(),{once:true})); return reply('Cancelled side'); };
    return child;
  };
  const main = interaction.prompt('Keep working');
  await running;
  try {
    const side = interaction.sideQuestion('Separate question'); await new Promise(resolve=>setTimeout(resolve,20));
    expect(interaction.busy).toBe(true); expect(interaction.sideBusy).toBe(true);
    interaction.cancelSide(); expect((await side).status).toBe('cancelled'); expect(interaction.busy).toBe(true);
    finish(); expect((await main).status).toBe('completed');
  } finally { finish(); await main; await interaction.close(); }
});

it('inherits restored model, effort and context when branching before SDK initialization', async () => {
  const {agent,root,directory,client}=await setup(); agent.setModel('minimaxai/minimax-m3.1-flash'); agent.setEffort('max');
  const original=agent.sessionId!; const messages=agent.messages; await agent.close();
  const fresh=new AgentLoop({workspace:root,client,session:{directory,id:original}}); agents.push(fresh);
  await fresh.branchSession(); expect(fresh.model).toBe('minimaxai/minimax-m3.1-flash'); expect(fresh.effort).toBe('max');
  expect(fresh.messages).toEqual(messages); expect(fresh.sessionName).toBeUndefined();
});

it('keeps the original session usable if creating the branch fails and validates options before writing', async () => {
  const {agent,directory}=await setup(); const id=agent.sessionId!; const messages=agent.messages;
  await expect(agent.branchSession({model:'invalid'})).rejects.toThrow(/provider\/model/);
  await expect(agent.branchSession({name:'bad\nname'})).rejects.toThrow();
  const create=vi.spyOn(SessionStore,'create').mockRejectedValueOnce(new Error('Disk full'));
  try { await expect(agent.branchSession()).rejects.toThrow('Disk full'); } finally { create.mockRestore(); }
  expect(agent.sessionId).toBe(id); expect(agent.messages).toEqual(messages);
  await agent.renameSession('Still writable'); expect((await agent.listSessions())).toHaveLength(1);
  const before=await readFile(join(directory,id+'.jsonl'),'utf8'); expect(before).toContain('Still writable');
});

it('limits side exchanges to twenty and resets them when switching session',async()=>{
  const {agent,client}=await setup();
  for(let n=0;n<22;n++)await agent.sideQuestion(`Side ${n}`);
  const messages=client.children[21]!.requests[0].messages;
  expect(messages.filter((m:any)=>m.role==='assistant')).toHaveLength(20);
  expect(messages.some((m:any)=>m.content==='Side 0')).toBe(false);
  expect(messages.some((m:any)=>m.content==='Side 1')).toBe(true);
  await agent.branchSession(); await agent.sideQuestion('Fresh side');
  expect(client.children.at(-1)!.requests[0].messages.some((m:any)=>m.content==='Side 21')).toBe(false);
});

it('rejects side tool calls and provider errors without dispatching tools or contaminating later questions',async()=>{
  const {agent,client,root}=await setup(); const history=agent.messages;
  client.fork=()=>{
    const child=new Client();client.children.push(child);
    child.stream=async()=>({ok:true,value:[{id:'x',object:'chat.completion.chunk',created:0,model:'test',choices:[{index:0,delta:{tool_calls:[{index:0,id:'t',type:'function',function:{name:'apply_edits_batch',arguments:JSON.stringify({edits:[{path:'a.ts',old_text:'1',new_text:'2'}]})}}]},finish_reason:'tool_calls'}]}]} as any);
    return child;
  };
  expect(await agent.sideQuestion('Side edit')).toMatchObject({status:'error',error:expect.stringContaining('cannot execute tools')});
  expect(await readFile(join(root,'a.ts'),'utf8')).toBe('export const value = 1;');
  const child=client.children[0]!; expect(child.listenerCount('onTokenStream')).toBe(0);expect(child.listenerCount('onRateLimitWait')).toBe(0);
  client.fork=()=>{const c=new Client(); c.stream=async()=>({ok:false,error:'HTTP 401'} as any);return c;};
  expect(await agent.sideQuestion('Failed question')).toMatchObject({status:'error',error:'HTTP 401'});
  client.fork=()=>{const c=new Client();client.children.push(c);return c;};await agent.sideQuestion('Successful question');
  expect(JSON.stringify(client.children.at(-1)!.requests[0])).not.toContain('Side edit');expect(agent.messages).toEqual(history);
});

it('bounds side context locally, leaves main history intact and makes no request for an oversized question',async()=>{
  const {agent,client}=await setup();await agent.run('Large context '+ 'x'.repeat(40000));const history=agent.messages;
  const small=new AgentLoop({workspace:roots.at(-1)!,client,maxContextChars:16000});agents.push(small);
  expect(await small.sideQuestion('x'.repeat(16000))).toMatchObject({status:'context_limit',iterations:0});expect(client.children).toHaveLength(0);
  await agent.sideQuestion('y'.repeat(40000));expect(JSON.stringify(client.children[0]!.requests[0].messages).length).toBeLessThanOrEqual(64000);
  expect(agent.messages).toEqual(history);
});

it('excludes an in-flight tool group from the frozen side context',async()=>{
  const {agent,client}=await setup();const interaction=new Interaction(agent);
  let count=0;let side:Promise<any>|undefined;
  client.stream=async()=>++count===1?({ok:true,value:[{id:'x',object:'chat.completion.chunk',created:0,model:'test',choices:[{index:0,delta:{tool_calls:[{index:0,id:'in-flight',type:'function',function:{name:'get_repo_map',arguments:'{}'}}]},finish_reason:'tool_calls'}]}]} as any):reply('Done');
  agent.once('onToolStart',()=>{side=interaction.sideQuestion('During tools');});
  try {
    expect((await interaction.prompt('Inspect the graph')).status).toBe('completed');expect((await side).status).toBe('completed');
    const request=JSON.stringify(client.children[0]!.requests[0]);expect(request).not.toContain('in-flight');expect(request).not.toContain('Not executed: turn interrupted');
    expect(request).toContain('Inspect the graph');
  }finally{await interaction.close();}
});

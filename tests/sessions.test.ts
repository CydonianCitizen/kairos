import { mkdtemp, readFile, appendFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionStore, type SessionState } from '../src/core/session-store.js';
import { AgentLoop } from '../src/core/agent-loop.js';
import { EventEmitter } from 'node:events';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive:true, force:true}); });
const state: SessionState = { model:'meta/llama-3.3-70b-instruct', mode:'build', memory:'', messages:[{role:'user',content:'Remember the goal'},{role:'assistant',content:'Understood'}] };
async function directory() { const root = await mkdtemp(join(tmpdir(),'nim-session-')); roots.push(root); return root; }
it('restores legacy journals without effort as auto and rejects malformed effort values', async () => {
 const dir = await directory(); const store = await SessionStore.create(dir, dir, state); const id = store.id; await store.close();
 const client = new class extends EventEmitter { async stream() { throw new Error('No NIM calls expected'); } }();
 const agent = new AgentLoop({ workspace: dir, client, session: { directory: dir, id } });
 try { await agent.initialize(); expect(agent.effort).toBe('auto'); } finally { await agent.close(); }
 await expect(SessionStore.create(dir, dir, { ...state, effort: 'invalid' as never })).rejects.toThrow('Invalid session effort');
});
it('restores checkpoints and retains pre-compaction messages', async () => {
 const dir = await directory(); const first = await SessionStore.create(dir, dir, state);
 await first.append({...state,memory:'Goal summary',messages:[]}); const id = first.id; await first.close();
 const restored = await SessionStore.open(dir,id,dir); expect(restored.state.memory).toBe('Goal summary');
 expect(await readFile(join(dir,`${id}.jsonl`),'utf8')).toContain('Remember the goal');
 expect((await SessionStore.list(dir,dir)).map(s=>s.id)).toContain(id); await restored.close();
});
it('finds prompts across project sessions and before compaction without returning another workspace', async () => {
 const dir = await directory(); const other = await directory();
 const first = await SessionStore.create(dir, dir, state);
 await first.append({ ...state, messages: [...state.messages, { role: 'user', content: 'Investigate\nthe graph' }] });
 await first.append({ ...state, messages: [], memory: 'Compacted' }); await first.close();
 const second = await SessionStore.create(dir, dir, { ...state, messages: [{ role: 'user', content: 'New session prompt' }] }); await second.close();
 const foreign = await SessionStore.create(dir, other, { ...state, messages: [{ role: 'user', content: 'private other workspace' }] }); await foreign.close();
 await appendFile(join(dir, `${second.id}.jsonl`), '{"partial":');
 // Back-to-back Windows writes can have equal mtimes; the fixture requires a known order.
 await utimes(join(dir, `${first.id}.jsonl`), 1700000000, 1700000000);
 await utimes(join(dir, `${second.id}.jsonl`), 1700000010, 1700000010);
 const prompts = await SessionStore.promptHistory(dir, dir);
 expect(prompts).toContain('Remember the goal'); expect(prompts).toContain('Investigate\nthe graph');
 expect(prompts).toContain('New session prompt'); expect(prompts).not.toContain('private other workspace');
 expect(prompts.filter(p => p === 'Remember the goal')).toHaveLength(1);
 expect(prompts.indexOf('New session prompt')).toBeGreaterThan(prompts.indexOf('Investigate\nthe graph'));
});
it('keeps prompt history bounded and ignores malformed journal records', async () => {
 const dir = await directory();
 const store = await SessionStore.create(dir, dir, { ...state, messages: Array.from({length:250}, (_, i) => ({role:'user' as const, content:`Prompt ${i}`})) });
 await store.close(); await appendFile(join(dir, `${store.id}.jsonl`), 'null\n{"invalid":true}\n');
 const prompts = await SessionStore.promptHistory(dir, dir);
 expect(prompts).toHaveLength(200); expect(prompts[0]).toBe('Prompt 50'); expect(prompts.at(-1)).toBe('Prompt 249');
});
it('lists the first prompt as a stable session title after clear or compaction', async () => {
 const dir = await directory(); const store = await SessionStore.create(dir, dir, { ...state, messages: [] });
 await store.append(state);
 await store.append({ ...state, memory: 'Summary', messages: [{role:'user',content:'A later prompt'}] });
 await store.append({ ...state, messages: [] }); await store.close();
 const sessions = await SessionStore.list(dir, dir);
 expect(sessions.find(s => s.id === store.id)?.title).toBe('Remember the goal');
});
it('persists a chosen session name through clear, compaction, restart and resume without inheriting it in a new session', async () => {
 const dir = await directory();
 const saved = await SessionStore.create(dir, dir, state); const id = saved.id; await saved.close();
 const client = new class extends EventEmitter { async stream() { throw new Error('Rename must not call NIM'); } }();
 const agent = new AgentLoop({ workspace: dir, client, session: { directory: dir, id } });
 try {
  await agent.initialize(); await agent.renameSession('  Piano   AST κ  ');
  expect(agent.sessionName).toBe('Piano AST κ'); expect(agent.messages).toEqual(state.messages);
  agent.compact(); agent.clear();
 } finally { await agent.close(); }
 const resumed = new AgentLoop({ workspace: dir, client, session: { directory: dir, id } });
 try {
  await resumed.initialize(); expect(resumed.sessionName).toBe('Piano AST κ');
  expect((await resumed.listSessions()).find(session => session.id === id)?.name).toBe('Piano AST κ');
  await resumed.newSession(); expect(resumed.sessionName).toBeUndefined();
  await resumed.resumeSession(id); expect(resumed.sessionName).toBe('Piano AST κ');
 } finally { await resumed.close(); }
});
it('rejects malformed names and keeps the previous name when a rename cannot be persisted', async () => {
 const dir = await directory(); const client = new class extends EventEmitter { async stream() { throw new Error('No NIM'); } }();
 const agent = new AgentLoop({ workspace: dir, client, session: { directory: dir } });
 try {
  await agent.initialize(); await agent.renameSession('Original');
  for (const name of ['', '   ', 'line\nbreak', '\x1b[2J', 'x'.repeat(121)]) await expect(agent.renameSession(name)).rejects.toThrow(/name/i);
  const append = vi.spyOn(SessionStore.prototype, 'append').mockRejectedValueOnce(new Error('Disk full'));
  try { await expect(agent.renameSession('Unsaved')).rejects.toThrow('Disk full'); } finally { append.mockRestore(); }
  expect(agent.sessionName).toBe('Original');
  expect((await agent.listSessions()).find(session => session.id === agent.sessionId)?.name).toBe('Original');
 } finally { await agent.close(); }
 await expect(SessionStore.create(dir,dir,{...state,name:'bad\nname'})).rejects.toThrow(/name/i);
});
it('repairs an incomplete last line and refuses concurrent or cross-workspace resume',async()=>{
 const dir=await directory(); const store=await SessionStore.create(dir,dir,state);
 await expect(SessionStore.open(dir,store.id,dir)).rejects.toThrow(/in use/);
 await store.close(); await appendFile(join(dir,`${store.id}.jsonl`),'{"incomplete":');
 const resumed=await SessionStore.open(dir,store.id,dir); await resumed.append({...state,memory:'after recovery'}); await resumed.close();
 const again=await SessionStore.open(dir,store.id,dir); expect(again.state.memory).toBe('after recovery'); await again.close();
 await expect(SessionStore.open(dir,store.id,join(dir,'other'))).rejects.toThrow(/workspace/);
 await expect(SessionStore.open(dir,'../outside',dir)).rejects.toThrow(/ID/);
});
it('rejects broken tool-result pairing instead of sending it to a provider',async()=>{
 const dir=await directory(); await expect(SessionStore.create(dir,dir,{...state,messages:[{role:'tool',tool_call_id:'orphan',content:'bad'}]})).rejects.toThrow(/tool/i);
});
it('allows only one writer when two clients recover a dead owner lock',async()=>{
 const {spawn}=await import('node:child_process');const child=spawn(process.execPath,['-e',''],{windowsHide:true});const pid=child.pid!;await new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('exit',()=>resolve());});
 const {writeFile}=await import('node:fs/promises');const dir=await directory();const store=await SessionStore.create(dir,dir,state);await store.close();
 await writeFile(join(dir,`${store.id}.jsonl.lock`),String(pid));
 const attempts=await Promise.allSettled([SessionStore.open(dir,store.id,dir),SessionStore.open(dir,store.id,dir)]);
 const writers=attempts.filter((r):r is PromiseFulfilledResult<SessionStore>=>r.status==='fulfilled');
 try{expect(writers.length).toBe(1);}finally{for(const writer of writers)await writer.value.close();}
});

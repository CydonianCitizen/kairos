import { mkdtemp, readFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SessionStore, type SessionState } from '../src/core/session-store.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive:true, force:true}); });
const state: SessionState = { model:'meta/llama-3.3-70b-instruct', mode:'build', memory:'', messages:[{role:'user',content:'Remember the goal'},{role:'assistant',content:'Understood'}] };
async function directory() { const root = await mkdtemp(join(tmpdir(),'nim-session-')); roots.push(root); return root; }
it('restores checkpoints and retains pre-compaction messages', async () => {
 const dir = await directory(); const first = await SessionStore.create(dir, dir, state);
 await first.append({...state,memory:'Goal summary',messages:[]}); const id = first.id; await first.close();
 const restored = await SessionStore.open(dir,id,dir); expect(restored.state.memory).toBe('Goal summary');
 expect(await readFile(join(dir,`${id}.jsonl`),'utf8')).toContain('Remember the goal');
 expect((await SessionStore.list(dir,dir)).map(s=>s.id)).toContain(id); await restored.close();
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

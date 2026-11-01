import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, realpath, stat, truncate, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { EFFORTS, type Effort } from '../config/effort.js';
export type AgentMode = 'build' | 'plan';
export interface SessionState { messages: ChatCompletionMessageParam[]; memory: string; model: string; mode: AgentMode; effort?: Effort; name?: string; parentId?: string }
interface RecordEntry { version: 1; id: string; workspace: string; updatedAt: string; state: SessionState }
export interface SessionInfo { id: string; updatedAt: string; model: string; mode: AgentMode; title?: string; name?: string; parentId?: string }
export const defaultSessionDirectory = () => join(homedir(), '.nim-codex', 'sessions');
const validId = (id: string) => { if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid session ID'); return id; };
export function validateSessionName(name: unknown): asserts name is string {
 if (typeof name !== 'string' || !name.trim() || Array.from(name).length > 120 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) throw new Error('Session name must be 1–120 characters on one line, without control characters');
}
export function validateSessionState(value: unknown): asserts value is SessionState {
 const s = value as SessionState;
 if (!s || !Array.isArray(s.messages) || typeof s.memory !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(s.model) || !['build','plan'].includes(s.mode)) throw new Error('Invalid session state');
 if (s.effort !== undefined && !EFFORTS.includes(s.effort)) throw new Error('Invalid session effort');
 if (s.name !== undefined) validateSessionName(s.name);
 if (s.parentId !== undefined) validId(s.parentId);
 const pending = new Set<string>();
 for (const message of s.messages) {
  if (!message || !['user','assistant','tool'].includes(message.role) || (message.content !== null && typeof message.content !== 'string')) throw new Error('Invalid session message');
  if (message.role === 'tool') { if (!pending.delete(message.tool_call_id)) throw new Error('Orphan or duplicate tool result'); }
  else {
   if (pending.size) throw new Error('Missing tool results');
   if (message.role === 'assistant') for (const call of message.tool_calls ?? []) {
    if (call.type !== 'function' || !call.id || pending.has(call.id) || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') throw new Error('Invalid tool call');
    pending.add(call.id);
   }
  }
 }
 if (pending.size) throw new Error('Missing tool results');
}
async function workspacePath(path: string): Promise<string> { return realpath(path).catch(() => resolve(path)); }
async function latest(file: string, includeTitle = false): Promise<{entry: RecordEntry; bytes: number; total: number; title?: string}> {
 if ((await stat(file)).size > 64 * 1024 * 1024) throw new Error('Session journal exceeds 64 MiB; export/archive it before resuming');
 const data = await readFile(file); const end = data.lastIndexOf(10);
 if (end < 0) throw new Error('Session has no committed checkpoint');
 const lines = data.subarray(0,end).toString('utf8').split('\n');
 const entry = JSON.parse(lines.at(-1)!) as RecordEntry;
 if (entry.version !== 1 || typeof entry.workspace !== 'string' || typeof entry.updatedAt !== 'string') throw new Error('Unsupported session journal');
 validId(entry.id); validateSessionState(entry.state);
 let title: string | undefined;
 if (includeTitle) for (const line of lines) {
  try {
   const checkpoint = JSON.parse(line) as RecordEntry;
   if (checkpoint?.version !== 1 || checkpoint.id !== entry.id || checkpoint.workspace !== entry.workspace || !Array.isArray(checkpoint.state?.messages)) continue;
   const prompt = checkpoint.state.messages.find(message => message?.role === 'user' && typeof message.content === 'string' && message.content.trim());
   if (typeof prompt?.content === 'string') { title = Array.from(prompt.content.replace(/\s+/g, ' ').trim()).slice(0, 120).join(''); break; }
  } catch { /* An old malformed checkpoint cannot provide a title. */ }
 }
 return {entry,bytes:end+1,total:data.length,title};
}
export class SessionStore {
 private closed = false;
 private queue: Promise<void> = Promise.resolve();
 private constructor(readonly id: string, private readonly file: string, private readonly workspace: string, public state: SessionState) {}
 private static async lock(file: string): Promise<void> {
  try { const handle=await open(file+'.lock','wx',0o600); try {await handle.writeFile(String(process.pid));} finally {await handle.close();} }
  catch(error) {
   if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
   // Serialize stale-lock recovery too: two recoverers must not remove each other's new lock.
   const recovery = await open(file+'.recover','wx',0o600).catch(e=>{if((e as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Session is in use or an interrupted lock recovery needs inspection');throw e;});
   try {
    const pid = Number(await readFile(file+'.lock','utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Session lock is invalid; inspect it before removing');
    try {process.kill(pid,0);} catch(e) {
     if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
      await unlink(file+'.lock'); const handle=await open(file+'.lock','wx',0o600);
      try{await handle.writeFile(String(process.pid));}finally{await handle.close();}return;
     }
    }
    throw new Error('Session is in use by another process');
   } finally {await recovery.close();await unlink(file+'.recover');}
  }
 }
 static async create(directory: string, workspace: string, state: SessionState): Promise<SessionStore> {
  validateSessionState(state); await mkdir(directory,{recursive:true,mode:0o700});
  const id=randomUUID(); const file=join(directory,id+'.jsonl'); await this.lock(file);
  const store=new SessionStore(id,file,await workspacePath(workspace),structuredClone(state));
  try {const handle=await open(file,'wx',0o600); await handle.close(); await store.append(state); return store;}
  catch(error) {await store.close(); throw error;}
 }
 static async open(directory: string, id: string, workspace: string): Promise<SessionStore> {
  const file=join(directory,validId(id)+'.jsonl'); await this.lock(file);
  try {
   const {entry,bytes,total}=await latest(file); const canonical=await workspacePath(workspace);
   if (entry.id !== id || entry.workspace !== canonical) throw new Error('Session belongs to a different workspace');
   if (bytes !== total) await truncate(file,bytes);
   return new SessionStore(id,file,canonical,entry.state);
  } catch(error) {await unlink(file+'.lock'); throw error;}
 }
 static async list(directory: string, workspace: string): Promise<SessionInfo[]> {
  const canonical=await workspacePath(workspace); const results: SessionInfo[]=[];
  let names: string[]; try {names=await readdir(directory);} catch(e) {if ((e as NodeJS.ErrnoException).code==='ENOENT') return []; throw e;}
  for (const name of names.filter(name=>/^[0-9a-f-]{36}\.jsonl$/.test(name))) {
   try {const {entry,title}=await latest(join(directory,name),true); if(entry.workspace===canonical&&entry.id===name.slice(0,-6)) results.push({id:entry.id,updatedAt:entry.updatedAt,model:entry.state.model,mode:entry.state.mode,title,name:entry.state.name,parentId:entry.state.parentId});} catch { /* Invalid/incomplete journals are not resumable. */ }
  }
  return results.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
 }
 static async promptHistory(directory: string, workspace: string): Promise<string[]> {
  const canonical = await workspacePath(workspace); const prompts = new Set<string>();
  let names: string[];
  try { names = await readdir(directory); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  const files = await Promise.all(names.filter(name => /^[0-9a-f-]{36}\.jsonl$/.test(name)).map(async name => {
   const file = join(directory, name); return { file, name, modified: await stat(file).then(s => s.mtimeMs, () => 0) };
  }));
  let budget = 16 * 1024 * 1024;
  for (const { file, name } of files.sort((a, b) => b.modified - a.modified).slice(0, 100)) {
   if (prompts.size >= 200 || budget <= 0) break;
   const handle = await open(file, 'r').catch(() => undefined); if (!handle) continue;
   try {
    const size = (await handle.stat()).size; const length = Math.min(size, 1024 * 1024, budget); budget -= length;
    const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    const text = buffer.subarray(0, bytesRead).toString('utf8'); const end = text.lastIndexOf('\n');
    if (end < 0) continue;
    const lines = text.slice(size > length ? text.indexOf('\n') + 1 : 0, end).split('\n');
    for (const line of lines.reverse()) {
     let entry: RecordEntry; try { entry = JSON.parse(line) as RecordEntry; } catch { continue; }
     if (entry?.version !== 1 || entry.id !== name.slice(0, -6) || entry.workspace !== canonical || !Array.isArray(entry.state?.messages)) continue;
     for (const message of [...entry.state.messages].reverse()) {
      if (message?.role === 'user' && typeof message.content === 'string' && message.content.trim() && message.content.length <= 64000) prompts.add(message.content);
      if (prompts.size >= 200) break;
     }
     if (prompts.size >= 200) break;
    }
   } finally { await handle.close(); }
  }
  return [...prompts].reverse();
 }
 append(state: SessionState): Promise<void> {
  if(this.closed) return Promise.reject(new Error('Session is closed')); validateSessionState(state);
  const copy=structuredClone(state);
  const record: RecordEntry={version:1,id:this.id,workspace:this.workspace,updatedAt:new Date().toISOString(),state:copy};
  const work=this.queue.then(async()=>{await appendFile(this.file,JSON.stringify(record)+'\n',{encoding:'utf8',mode:0o600}); this.state=copy;});
  this.queue=work; return work;
 }
 async close(): Promise<void> { if(this.closed) return; this.closed=true; try {await this.queue;} finally {await unlink(this.file+'.lock').catch(e=>{if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e;});} }
}

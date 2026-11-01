import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FsTools } from '../src/tools/fs-tools.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { PermissionGate } from '../src/core/permissions.js';
import { RepoGraph } from '../src/graph/repo-graph.js';
import { ExtensionHost } from '../src/extensions/host.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'kairos-permission-')) throw new Error('Unexpected fixture');
  await rm(root, { recursive: true, force: true });
} });
async function workspace() { const root = await mkdtemp(join(tmpdir(), 'kairos-permission-')); roots.push(root); await writeFile(join(root, 'a.txt'), 'before'); return root; }
const edit = JSON.stringify({ edits: [{ path: 'a.txt', old_text: 'before', new_text: 'after' }] });

it('refuses denied edits and shell without executing either operation', async () => {
  const root = await workspace();
  const registry = new ToolRegistry(new FsTools(root), () => new RepoGraph(root), undefined, new PermissionGate({ edits: 'deny', shell: 'deny' }));
  expect(await registry.execute('apply_edits_batch', edit)).toMatchObject({ ok: false, mutated: false, permissionDenied: true });
  expect(await registry.execute('run_bash', '{"command":"echo side-effect > shell.txt"}')).toMatchObject({ ok: false, mutated: false, permissionDenied: true });
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('before');
  await expect(readFile(join(root, 'shell.txt'))).rejects.toThrow();
});

it('returns approval_required to noninteractive callers before editing', async () => {
  const root = await workspace();
  const registry = new ToolRegistry(new FsTools(root), () => new RepoGraph(root), undefined, new PermissionGate({ edits: 'ask' }));
  expect(await registry.execute('apply_edits_batch', edit)).toMatchObject({ ok: false, mutated: false, approvalRequired: true });
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('before');
});

it('validates tool arguments before asking and preserves plan-mode denial', async () => {
  const root = await workspace(); let approvals = 0;
  const gate = new PermissionGate({ edits: 'ask', shell: 'ask' }, async () => { approvals++; return true; });
  const registry = new ToolRegistry(new FsTools(root), () => new RepoGraph(root), undefined, gate);
  expect((await registry.execute('apply_edits_batch', '{"edits":[{}]}')).ok).toBe(false);
  expect((await registry.execute('run_bash', '{"command":"echo hi","timeoutMs":0}')).ok).toBe(false);
  expect((await registry.execute('apply_edits_batch', edit, undefined, 'plan')).ok).toBe(false);
  expect(approvals).toBe(0);
});

it('shows the bound diff and refuses a target changed during approval', async () => {
  const root = await workspace(); let preview = '';
  const gate = new PermissionGate({ edits: 'ask' }, async request => {
    preview = request.preview;
    await writeFile(join(root, 'a.txt'), 'human change');
    return true;
  });
  const registry = new ToolRegistry(new FsTools(root), () => new RepoGraph(root), undefined, gate);
  expect((await registry.execute('apply_edits_batch', edit)).ok).toBe(false);
  expect(preview).toContain('-before'); expect(preview).toContain('+after');
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('human change');
});
it('validates external arguments before asking and refuses the complete batch before effects',async()=>{
 const root=await workspace();await mkdir(join(root,'.nim'));
 await writeFile(join(root,'.nim/plugin.mjs'),`import {writeFile} from 'node:fs/promises';export default api=>api.registerTool({name:'effect',description:'write marker',parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},execute:async({value})=>{await writeFile(new URL('../effect.txt',import.meta.url),value);return value;}});`);
 await writeFile(join(root,'.nim/config.json'),JSON.stringify({plugins:['.nim/plugin.mjs']}));
 const host=await ExtensionHost.load(root,true);await host.prepare('build');let approvals=0;
 const gate=new PermissionGate({external:'ask'},async request=>{approvals++;expect(request.preview).toContain('effect');return false;});
 const registry=new ToolRegistry(new FsTools(root),()=>new RepoGraph(root),host,gate);
 try{
  expect((await registry.execute('extension_tools_batch',JSON.stringify({calls:[{name:'effect',arguments:{value:42}}]}))).ok).toBe(false);expect(approvals).toBe(0);
  expect(await registry.execute('extension_tools_batch',JSON.stringify({calls:[{name:'effect',arguments:{value:'marker'}}]}))).toMatchObject({ok:false,mutated:false,permissionDenied:true});
  expect(approvals).toBe(1);await expect(readFile(join(root,'effect.txt'))).rejects.toThrow();
 }finally{await host.close();}
});

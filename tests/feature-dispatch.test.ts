import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {FsTools} from '../src/tools/fs-tools.js';
import {ToolRegistry} from '../src/tools/registry.js';
import {PermissionGate} from '../src/core/permissions.js';
import {RepoGraph} from '../src/graph/repo-graph.js';
import {ProjectMemory} from '../src/core/project-memory.js';

const roots:string[]=[],filesystems:FsTools[]=[];
afterEach(async()=>{for(const fs of filesystems.splice(0))await fs.close();for(const root of roots.splice(0)){if(!resolve(root).startsWith(resolve(tmpdir())+sep+'kairos-dispatch-'))throw new Error('Unexpected fixture');await rm(root,{recursive:true,force:true});}});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'kairos-dispatch-'));roots.push(root);await mkdir(join(root,'secret'));await writeFile(join(root,'a.txt'),'before');await writeFile(join(root,'secret/a.txt'),'private');const fs=new FsTools(root);filesystems.push(fs);return {root,fs};}
it('applies granular deny to the whole edit batch before any write',async()=>{
 const {root,fs}=await fixture();const registry=new ToolRegistry(fs,()=>new RepoGraph(root),undefined,new PermissionGate({edits:'allow',rules:[{kind:'edits',mode:'deny',pattern:'secret/**'}]}));
 expect(await registry.execute('apply_edits_batch',JSON.stringify({edits:[{path:'a.txt',old_text:'before',new_text:'after'},{path:'secret/a.txt',old_text:'private',new_text:'changed'}]}))).toMatchObject({ok:false,mutated:false,permissionDenied:true});
 expect(await readFile(join(root,'a.txt'),'utf8')).toBe('before');expect(await readFile(join(root,'secret/a.txt'),'utf8')).toBe('private');
});
it('checks complete shell command rules including background starts',async()=>{
 const {root,fs}=await fixture();const registry=new ToolRegistry(fs,()=>new RepoGraph(root),undefined,new PermissionGate({shell:'allow',rules:[{kind:'shell',mode:'deny',pattern:'echo denied > denied.txt'}]}));
 for(const background of [false,true])expect(await registry.execute('run_bash',JSON.stringify({command:'echo denied > denied.txt',...(background?{background:true}:{})}))).toMatchObject({ok:false,mutated:false,permissionDenied:true});
 expect(fs.background.list()).toEqual([]);await expect(readFile(join(root,'denied.txt'))).rejects.toThrow();
});
it('persists memory only after permission and never enables memory writes in plan',async()=>{
 const {root,fs}=await fixture();const memory=new ProjectMemory(root,{directory:join(root,'memory')});let asks=0;
 const registry=new ToolRegistry(fs,()=>new RepoGraph(root),undefined,new PermissionGate({edits:'ask'},async()=>{asks++;return true;}),{memory});
 const input=JSON.stringify({changes:[{action:'add',text:'Prefer small changes and run tests.'}]});
 expect((await registry.execute('memory_update_batch',input,undefined,'plan')).ok).toBe(false);expect(asks).toBe(0);
 expect(await registry.execute('memory_update_batch',input)).toMatchObject({ok:true,mutated:false});expect(asks).toBe(1);expect(await memory.list()).toHaveLength(1);
});

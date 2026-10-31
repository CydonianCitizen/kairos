import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { ExtensionHost } from '../src/extensions/host.js';
const roots:string[]=[]; afterEach(async()=>{for(const r of roots.splice(0))await rm(r,{recursive:true,force:true});});
async function setup(){const r=await mkdtemp(join(tmpdir(),'nim-ext-'));roots.push(r);await mkdir(join(r,'.nim','skills','review'),{recursive:true});await writeFile(join(r,'.nim','skills','review','SKILL.md'),'---\nname: review\ndescription: Review changes\n---\nCheck correctness first.');await writeFile(join(r,'AGENTS.md'),'Use small changes.');return r;}
it('loads explicit trusted skills and project instructions but never untrusted config',async()=>{
 const r=await setup();await writeFile(join(r,'.nim','config.json'),'{bad config');
 const untrusted=await ExtensionHost.load(r,false);expect(untrusted.context()).toBe('');await untrusted.close();
 await writeFile(join(r,'.nim','config.json'),'{}');const host=await ExtensionHost.load(r,true);
 expect(host.context()).toContain('Use small changes');expect(host.context()).toContain('review');
 expect(await host.execute('load_skills_batch',{names:['review']})).toMatchObject({ok:true});
 expect(JSON.stringify(await host.execute('load_skills_batch',{names:['../secret']}))).not.toContain('Use small');await host.close();
});
it('validates plugin arguments, blocks plugin callbacks in plan mode and disposes resources',async()=>{
 const r=await setup();await writeFile(join(r,'.nim','plugin.mjs'),`export default api=>{ api.registerTool({name:'double',description:'Double values',parameters:{type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false},execute:async args=>args.value*2}); api.registerCommand('hello',async args=>'hello '+args); };`);
 await writeFile(join(r,'.nim','config.json'),JSON.stringify({plugins:['.nim/plugin.mjs']}));const host=await ExtensionHost.load(r,true);
 await host.prepare('plan');expect(host.commands).toEqual([]);await host.prepare('build');
 expect(await host.command('hello','world','build')).toBe('hello world');await expect(host.command('hello','','plan')).rejects.toThrow(/plan/);
 const valid=await host.execute('extension_tools_batch',{calls:[{name:'double',arguments:{value:4}}]});expect(JSON.stringify(valid)).toContain('8');
 expect(await host.execute('extension_tools_batch',{calls:[{name:'double',arguments:{value:'bad'}}]})).toMatchObject({ok:false});
 expect(await host.execute('extension_tools_batch',{calls:[{name:'double',arguments:{value:4}}]},undefined,'plan')).toMatchObject({ok:false});await host.close();
});
it('retries a failed plugin setup without retaining partially registered tools',async()=>{
 const r=await setup();await writeFile(join(r,'.nim','retry.mjs'),`let attempt=0; export default api=>{api.registerTool({name:'retry',description:'retry',parameters:{type:'object'},execute:async()=>42}); if(attempt++===0)throw Error('temporary startup failure');};`);
 await writeFile(join(r,'.nim','config.json'),JSON.stringify({plugins:['.nim/retry.mjs']}));const host=await ExtensionHost.load(r,true);
 await expect(host.prepare('build')).rejects.toThrow('temporary');await host.prepare('build');expect(await host.execute('extension_tools_batch',{calls:[{name:'retry',arguments:{}}]})).toMatchObject({ok:true});await host.close();
});

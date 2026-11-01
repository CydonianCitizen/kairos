import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {acquireNimLease} from '../src/core/nim-pacing.js';
import {NimClient} from '../src/core/nim-client.js';
const fault=vi.hoisted(()=>({remaining:0,attempts:0}));
vi.mock('node:fs/promises',async importOriginal=>{const fs=await importOriginal<typeof import('node:fs/promises')>();return {...fs,rename:async(...args:Parameters<typeof fs.rename>)=>{if(String(args[1]).endsWith('.json')&&fault.remaining){fault.attempts++;fault.remaining--;throw Object.assign(new Error('Simulated Windows sharing violation'),{code:'EPERM'});}return fs.rename(...args);}};});
const roots:string[]=[];
afterEach(async()=>{fault.remaining=0;fault.attempts=0;for(const root of roots.splice(0)){if(!resolve(root).startsWith(resolve(tmpdir())+sep+'kairos-pacing-retry-'))throw new Error('Unexpected fixture');await rm(root,{recursive:true,force:true});}});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'kairos-pacing-retry-'));roots.push(root);return root;}
it.runIf(process.platform==='win32')('retries transient Windows sharing errors while retaining the exclusive lease',async()=>{
 const directory=await fixture(),lease=await acquireNimLease('fake-retry-key',directory);fault.remaining=2;
 await expect(lease.beforeDispatch()).resolves.toBeUndefined();expect(fault.attempts).toBe(2);
 expect((await readdir(directory)).some(name=>name.endsWith('.json'))).toBe(true);await lease.release();
});
it('keeps dispatch blocked and reports the local coordinator when cooldown publication cannot complete',async()=>{
 const directory=await fixture();fault.remaining=1000;let dispatched=0;
 const client=new NimClient({apiKey:'fake-retry-key',rateLimitDirectory:directory,fetch:async()=>{dispatched++;return Response.json({});}});
 const result=await client.complete({messages:[]});expect(result).toMatchObject({ok:false,error:expect.stringContaining('NIM shared rate-limit coordinator')});
 expect(dispatched).toBe(0);expect((await readdir(directory)).some(name=>name.endsWith('.lock'))).toBe(true);
});

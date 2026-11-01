import {expect,it} from 'vitest';
import {createSandboxInvocation,linuxSandboxInvocation} from '../src/core/sandbox.js';
it('keeps isolation opt-in and rejects unsupported hosts without an unwrapped fallback',async()=>{
 expect(createSandboxInvocation('off')).toBeUndefined();
 if(process.platform!=='linux')await expect(createSandboxInvocation('required')!({shell:'bash',command:'echo test',args:['-c','echo test'],cwd:process.cwd()})).rejects.toThrow('Linux');
});
it('isolates writes and network and strips credentials from the child environment',()=>{
 const invocation=linuxSandboxInvocation('/usr/bin/bwrap',{shell:'/bin/bash',command:'echo test',args:['--noprofile','--norc','-c','echo test'],cwd:'/work/project'},{PATH:'/usr/bin',NVIDIA_API_KEY:'fake',SERVICE_TOKEN:'fake'});
 expect(invocation.file).toBe('/usr/bin/bwrap');expect(invocation.args).toContain('--unshare-net');expect(invocation.args).toContain('--unshare-user');expect(invocation.args).toContain('--unshare-pid');
 expect(invocation.args.slice(0,3)).toEqual(['--ro-bind','/','/']);expect(invocation.args).toContain('--die-with-parent');
 expect(invocation.args.slice(-6)).toEqual(['--','/bin/bash','--noprofile','--norc','-c','echo test']);
 expect(invocation.env).not.toHaveProperty('NVIDIA_API_KEY');expect(invocation.env).not.toHaveProperty('SERVICE_TOKEN');expect(invocation.env?.PATH).toBe('/usr/bin');
});

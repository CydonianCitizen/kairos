import {access,constants} from 'node:fs/promises';
import type {ShellInvocation,ShellInvocationBuilder} from './shell-runner.js';
type Request=Parameters<ShellInvocationBuilder>[0];

/** Read-only host filesystem, writable workspace/private tmp, isolated network/processes. */
export function linuxSandboxInvocation(executable:string,request:Request,environment:NodeJS.ProcessEnv=process.env):ShellInvocation{
 const env:NodeJS.ProcessEnv={};for(const key of ['PATH','LANG','LC_ALL','TERM','TZ'])if(environment[key]!==undefined)env[key]=environment[key];
 env.HOME='/tmp';env.TMPDIR='/tmp';
 return {file:executable,args:['--ro-bind','/','/','--tmpfs','/tmp','--proc','/proc','--dev','/dev','--bind',request.cwd,request.cwd,
  '--unshare-user','--unshare-pid','--unshare-ipc','--unshare-uts','--unshare-net','--cap-drop','ALL','--die-with-parent','--new-session','--chdir',request.cwd,'--',request.shell,...request.args],cwd:request.cwd,env};
}
export function createSandboxInvocation(mode:'off'|'required'):ShellInvocationBuilder|undefined{
 if(mode==='off')return undefined;
 return async request=>{
  if(process.platform!=='linux')throw new Error('Required shell isolation needs Linux/WSL2 with bubblewrap; this host has no supported OS sandbox.');
  for(const executable of ['/usr/bin/bwrap','/bin/bwrap']){
   try{await access(executable,constants.X_OK);}catch{continue;}
   return linuxSandboxInvocation(executable,request,request.env??process.env);
  }
  throw new Error('Required shell isolation needs bubblewrap (bwrap). No unsandboxed fallback was executed.');
 };
}

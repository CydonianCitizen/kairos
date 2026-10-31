#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from 'dotenv';
import { render } from 'ink';
import { createAgent } from './index.js';
import { Interaction } from './core/interaction.js';
import { SessionStore, defaultSessionDirectory } from './core/session-store.js';
import { serveRpc, subscribeEvents } from './integrations/rpc.js';
import { UiController } from './ui/controller.js';
import { App } from './ui/App.js';
import { safeText } from './ui/text.js';
import { parseCliArgs, CLI_HELP } from './cli-options.js';
async function main():Promise<void>{
 const options=parseCliArgs(process.argv.slice(2));
 if(options.help){process.stdout.write(CLI_HELP);return;}
 if(options.version){const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));process.stdout.write(`${pkg.version}\n`);return;}
 const directory=options.sessionDir??defaultSessionDirectory();
 if(options.listSessions){process.stdout.write(JSON.stringify(await SessionStore.list(directory,options.cwd),null,2)+'\n');return;}
 if(options.prompt===undefined&&!options.rpc&&(!process.stdin.isTTY||!process.stdout.isTTY))throw new Error('Interactive mode requires a terminal. Use --prompt or --rpc for pipes.');
 const id=options.continue?(await SessionStore.list(directory,options.cwd))[0]?.id:options.session;
 if(options.continue&&!id)throw new Error('No saved session for this workspace');
 config({path:join(options.cwd,'.env'),quiet:true});
 if(options.json||options.rpc){console.log=console.info=console.debug=(...args:unknown[])=>console.error(...args);}
 const agent=await createAgent({workspace:options.cwd,model:options.model,mode:options.mode,maxIterations:options.maxIterations,maxContextChars:options.maxContextChars,
  session:options.noSession?false:{directory,id},compaction:options.compaction,trustWorkspace:options.trustWorkspace});
 if(options.rpc||options.prompt!==undefined){
  const interaction=new Interaction(agent);const stop=()=>{interaction.cancel();if(options.rpc){process.exitCode=130;process.stdin.destroy();}};process.on('SIGINT',stop);process.on('SIGTERM',stop);
  let detach:()=>void=()=>{};
  try{
   if(options.rpc){await interaction.action(signal=>agent.initialize(signal));await serveRpc(interaction,process.stdin,process.stdout);return;}
   if(options.json)detach=subscribeEvents(agent,(type,data)=>process.stdout.write(JSON.stringify({type,data})+'\n'));
   else{const token=(value:string)=>process.stdout.write(safeText(value));const tool=(event:{name:string;result:{ok:boolean}})=>process.stderr.write(`\n${safeText(event.name)}: ${event.result.ok?'done':'failed'}\n`);agent.on('onTokenStream',token);agent.on('onToolEnd',tool);detach=()=>{agent.off('onTokenStream',token);agent.off('onToolEnd',tool);};}
   const result=await interaction.prompt(options.prompt!);
   if(options.json)process.stdout.write(JSON.stringify({type:'result',sessionId:agent.sessionId,result})+'\n');
   else{process.stdout.write('\n');if(result.status!=='completed')process.stderr.write(`${safeText(result.error??result.status)}\n`);}
   if(result.status!=='completed')process.exitCode=result.status==='cancelled'?130:1;
  }finally{detach();await interaction.close();process.off('SIGINT',stop);process.off('SIGTERM',stop);}
  return;
 }
 const controller=new UiController(agent);const instance=render(<App controller={controller}/>,{exitOnCtrlC:false});
 const terminate=()=>{controller.dispose();instance.unmount();process.exitCode=130;};process.on('SIGTERM',terminate);
 try{await instance.waitUntilExit();}finally{process.off('SIGTERM',terminate);instance.unmount();await controller.close();}
}
main().catch(error=>{process.stderr.write(`nim-codex: ${safeText(error instanceof Error?error.message:String(error))}\n`);process.exitCode=1;});

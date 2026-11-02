#!/usr/bin/env node
import { loadEnvironment, personalEnvPath, savePersonalApiKey } from './config/env.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink';
import { createAgent } from './index.js';
import { Interaction } from './core/interaction.js';
import { SessionStore, defaultSessionDirectory } from './core/session-store.js';
import { serveRpc, subscribeEvents } from './integrations/rpc.js';
import { UiController } from './ui/controller.js';
import { App } from './ui/App.js';
import { safeText } from './ui/text.js';
import { parseCliArgs, CLI_HELP } from './cli-options.js';
import { VERSION } from './config/project.js';
import { NimClient } from './core/nim-client.js';
import { loadModelCatalog } from './core/model-catalog.js';
import { loadSettings } from './config/settings.js';
import { MODELS } from './config/models.js';
import { checkModels, defaultModelCheckPath, saveModelChecks } from './core/model-checks.js';
import { rememberModel } from './config/model-preferences.js';
async function main():Promise<void>{
 const options=parseCliArgs(process.argv.slice(2));
 if(options.help){process.stdout.write(CLI_HELP);return;}
 if(options.version){process.stdout.write(`${VERSION}\n`);return;}
 const directory=options.sessionDir??defaultSessionDirectory();
 if(options.listSessions){process.stdout.write(JSON.stringify(await SessionStore.list(directory,options.cwd),null,2)+'\n');return;}
 if(options.prompt===undefined&&!options.rpc&&!options.checkModels&&(!process.stdin.isTTY||!process.stdout.isTTY))throw new Error('Interactive mode requires a terminal. Use --prompt or --rpc for pipes.');
 const id=options.continue?(await SessionStore.list(directory,options.cwd))[0]?.id:options.session;
 if(options.continue&&!id)throw new Error('No saved session for this workspace');
 loadEnvironment(options.cwd);
 const settings=await loadSettings(options.cwd,{trustWorkspace:options.trustWorkspace,overrides:{
  model:id?undefined:options.model,effort:options.checkModels?'auto':id?undefined:options.effort,timeoutMs:options.timeoutMs,systemPromptFile:options.systemPromptFile,
  permissions:options.permissions?{edits:options.permissions,shell:options.permissions,external:options.permissions}:undefined,
  memory:options.noMemory?false:undefined,sandbox:options.sandbox,scope:options.scope}});
 if(options.json||options.rpc){console.log=console.info=console.debug=(...args:unknown[])=>console.error(...args);}
 const timeoutMs=options.timeoutMs??(process.env.NVIDIA_TIMEOUT_MS===undefined?settings.timeoutMs:Number(process.env.NVIDIA_TIMEOUT_MS));
 const interactive=options.prompt===undefined&&!options.rpc&&!options.checkModels;
 const needsKey=!process.env.NVIDIA_API_KEY?.trim();
 const client=new NimClient({timeoutMs,allowMissingApiKey:interactive});
 if(options.checkModels){
  const abort=new AbortController();const cancel=()=>abort.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  try{
   const report=await checkModels(client,options.model?[options.model]:MODELS.map(model=>model.id),{
    signal:abort.signal,timeoutMs:options.timeoutMs??settings.timeoutMs??45000,
    onProgress:(model,probe)=>process.stderr.write(`Checking ${model}: ${probe}\n`)});
   await saveModelChecks(report);
   if(options.json)process.stdout.write(JSON.stringify(report,null,2)+'\n');
   else for(const result of report.models){
    process.stdout.write(`${result.model}\n  streaming: ${result.streaming.status}; system prompt: ${result.systemPrompt.status}; batch tools: ${result.tools.status}\n`);
    for(const [effort,probe] of Object.entries(result.efforts))process.stdout.write(`  effort ${effort}: ${probe.status}\n`);
   }
   process.stderr.write(`Report: ${defaultModelCheckPath()}\n`);
   if(report.models.some(model=>[model.streaming,model.systemPrompt,model.tools,...Object.values(model.efforts)].some(probe=>probe.status==='failed')))process.exitCode=1;
  }finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
  return;
 }
 const agent=await createAgent({workspace:options.cwd,client,model:options.model??(id?undefined:settings.model),effort:options.effort??(id?undefined:settings.effort),systemPrompt:settings.systemPrompt,
  permissions:{edits:'ask',shell:'ask',external:'ask',...settings.permissions},undoDirectory:join(homedir(),'.kairos','undo'),
  rewindDirectory:join(homedir(),'.kairos','rewind'),memory:settings.memory===false?false:{},sandbox:settings.sandbox,scope:options.scope??settings.scope,
  mode:options.mode,maxIterations:options.maxIterations,maxContextChars:options.maxContextChars,
  session:options.noSession?false:{directory,id},compaction:options.compaction,trustWorkspace:options.trustWorkspace});
 let modelPreferences=Promise.resolve();
 const selectedModel=(model:string)=>{modelPreferences=modelPreferences.then(()=>rememberModel(model)).catch(error=>{process.stderr.write(`kairos: could not save selected model: ${safeText(error instanceof Error?error.message:String(error))}\n`);});};
 const finishPreferences=async()=>{agent.off('onModelSelected',selectedModel);await modelPreferences;};
 agent.on('onModelSelected',selectedModel);
 if(options.model){selectedModel(options.model);await modelPreferences;}
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
  }finally{detach();try{await interaction.close();}finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);await finishPreferences();}}
  return;
 }
 const catalog=needsKey?{models:MODELS.map(model=>model.id)}:await loadModelCatalog(client);
 const controller=new UiController(agent,catalog.models,{showThinking:options.thinking,keySettings:{
  path:personalEnvPath(),required:needsKey,save:async key=>{
   await savePersonalApiKey(key);client.setApiKey(key);process.env.NVIDIA_API_KEY=key.trim();
  }}});
 // End input before Ink restores the Windows TTY, so it cannot queue another console read.
 const endInput=()=>{process.stdin.push(null);};controller.on('exit',endInput);
 const instance=render(<App controller={controller} version={VERSION}/>,{exitOnCtrlC:false});
 const terminate=()=>{endInput();controller.dispose();instance.unmount();process.exitCode=130;};process.on('SIGTERM',terminate);
 try{await instance.waitUntilExit();}finally{
  process.off('SIGTERM',terminate);controller.off('exit',endInput);instance.unmount();
  try{await controller.close();}finally{
   await finishPreferences();
   // Ink can leave a Windows TTY read pending after switching input components.
   process.stdin.pause();process.stdin.destroy();
  }
 }
}
main().catch(error=>{process.stderr.write(`kairos: ${safeText(error instanceof Error?error.message:String(error))}\n`);process.exitCode=1;});

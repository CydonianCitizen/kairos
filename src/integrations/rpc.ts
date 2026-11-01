import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { Interaction } from '../core/interaction.js';
import type { AgentMode } from '../core/session-store.js';
import type { AgentLoop } from '../core/agent-loop.js';
import { serializeToolResult, type ToolResult } from '../tools/registry.js';
import type { MemoryChange } from '../core/project-memory.js';
export function subscribeEvents(agent:AgentLoop,send:(type:string,data:unknown)=>void):()=>void{
 const token=(data:string)=>send('token',data);
 const toolStart=(data:{id:string;name:string;arguments:string})=>send('tool_start',{...data,arguments:data.arguments.slice(0,64000)});
 const toolEnd=(data:{id:string;name:string;result:ToolResult})=>send('tool_end',{...data,result:JSON.parse(serializeToolResult(data.result,12000))});
 const wait=(data:unknown)=>send('wait',data);const compact=(data:unknown)=>send('compaction',data);const session=(data:unknown)=>send('session',data);const steering=(data:string)=>send('steering',data);
 const sideStart=(data:unknown)=>send('side_start',data);const sideToken=(data:string)=>send('side_token',data);const sideWait=(data:unknown)=>send('side_wait',data);const sideEnd=(data:unknown)=>send('side_result',data);
 const context=(data:AgentLoop['contextSnapshot'])=>send('context',{references:data.references,chars:data.chars,maxChars:data.maxChars});
 const background=(data:unknown)=>send('background_tasks',data);agent.on('onBackgroundUpdate',background);
 agent.on('onTokenStream',token);agent.on('onToolStart',toolStart);agent.on('onToolEnd',toolEnd);agent.on('onRateLimitWait',wait);agent.on('onCompaction',compact);agent.on('onSession',session);agent.on('onSteering',steering);
 agent.on('onSideStart',sideStart);agent.on('onSideTokenStream',sideToken);agent.on('onSideRateLimitWait',sideWait);agent.on('onSideEnd',sideEnd);
 agent.on('onContextUpdate',context);
 return()=>{agent.off('onBackgroundUpdate',background);agent.off('onContextUpdate',context);agent.off('onTokenStream',token);agent.off('onToolStart',toolStart);agent.off('onToolEnd',toolEnd);agent.off('onRateLimitWait',wait);agent.off('onCompaction',compact);agent.off('onSession',session);agent.off('onSteering',steering);agent.off('onSideStart',sideStart);agent.off('onSideTokenStream',sideToken);agent.off('onSideRateLimitWait',sideWait);agent.off('onSideEnd',sideEnd);};
}
function text(value:unknown):string{if(typeof value!=='string'||!value.trim())throw new Error('Expected non-empty text');return value;}
function optionalText(value:unknown):string|undefined{return value===undefined?undefined:text(value);}
export async function serveRpc(interaction:Interaction,input:Readable,output:Writable):Promise<void>{
 const agent=interaction.agent;const pending=new Set<Promise<void>>();const ids=new Set<string|number>();
 const send=(value:unknown)=>output.write(JSON.stringify(value)+'\n');
 const detach=subscribeEvents(agent,(type,data)=>send({jsonrpc:'2.0',method:'event',params:{type,data}}));
 const queueSnapshot=()=>({items:interaction.queueSnapshot.map(({id,text})=>({id,preview:text.slice(0,200),chars:text.length,truncated:text.length>200})),limit:20});
 const queue=()=>send({jsonrpc:'2.0',method:'event',params:{type:'queue',data:queueSnapshot()}});
 interaction.on('queue',queue);
 const lines=createInterface({input,crlfDelay:Infinity});
 async function dispatch(method:string,p:Record<string,unknown>):Promise<unknown>{
  switch(method){
   case 'prompt':return interaction.prompt(text(p.text));
   case 'steer':interaction.steer(text(p.text));return {accepted:true};
   case 'cancel':interaction.cancel();return {cancelled:true};
   case 'cancelSide':interaction.cancelSide();return {cancelled:true};
   case 'queue':return queueSnapshot();
   case 'editQueued':if(!Number.isSafeInteger(p.id)||Number(p.id)<1)throw new Error('Expected a positive queue ID');return {updated:interaction.editQueued(Number(p.id),text(p.text))};
   case 'removeQueued':if(!Number.isSafeInteger(p.id)||Number(p.id)<1)throw new Error('Expected a positive queue ID');return {removed:interaction.removeQueued(Number(p.id))};
   case 'clearQueue':return {cleared:interaction.clearQueue()};
   case 'state':return {model:agent.model,effort:agent.effort,mode:agent.mode,sessionId:agent.sessionId,sessionName:agent.sessionName,busy:interaction.busy,sideBusy:interaction.sideBusy,queued:interaction.queued,queuePaused:interaction.queuePaused,memoryEnabled:agent.memoryEnabled,backgroundRunning:agent.backgroundTasks?.list().filter(task=>task.status==='running').length??0};
   case 'tasks':return agent.backgroundTasks.list();
   case 'taskLogs':if(!Array.isArray(p.ids))throw new Error('Expected task IDs');return agent.backgroundTasks.logs(p.ids as string[]);
   case 'stopTasks':if(!Array.isArray(p.ids))throw new Error('Expected task IDs');return agent.backgroundTasks.stop(p.ids as string[]);
   case 'startTask':if(p.timeoutMs!==undefined&&(typeof p.timeoutMs!=='number'||!Number.isInteger(p.timeoutMs)))throw new Error('Invalid timeoutMs');return interaction.action(signal=>agent.startBackground(text(p.command),{timeoutMs:p.timeoutMs as number|undefined,signal}));
   case 'memory':return agent.listMemory();
   case 'updateMemory':if(!Array.isArray(p.changes))throw new Error('Expected memory changes');return interaction.action(signal=>agent.updateMemory(p.changes as MemoryChange[],signal));
   case 'clearMemory':return interaction.action(async signal=>{await agent.clearMemory(signal);return {cleared:true};});
   case 'rewindPoints':return agent.listRewinds();
   case 'rewind':if(p.scope!==undefined&&!['conversation','files','both'].includes(String(p.scope)))throw new Error('Invalid rewind scope');return interaction.action(signal=>agent.rewind(text(p.id),(p.scope??'both') as 'conversation'|'files'|'both',signal));
   case 'context':{const context=agent.contextSnapshot;return {references:context.references,chars:context.chars,maxChars:context.maxChars};}
   case 'undo':return interaction.action(signal=>agent.undoLast(signal));
   case 'sessions':return agent.listSessions();
   case 'resume':return interaction.action(async()=>{await agent.resumeSession(text(p.id));return {sessionId:agent.sessionId};});
   case 'rename':return interaction.action(async()=>{await agent.renameSession(text(p.name));return {sessionId:agent.sessionId,name:agent.sessionName};});
   case 'branch':return interaction.action(()=>agent.branchSession({name:optionalText(p.name),model:optionalText(p.model)}));
   case 'btw':return interaction.sideQuestion(text(p.text),{model:optionalText(p.model)});
   case 'clearSide':agent.clearSideQuestions();return {cleared:true};
   case 'newSession':return interaction.action(async()=>{await agent.newSession();return {sessionId:agent.sessionId};});
   case 'clear':return interaction.action(()=>{agent.clear();return {cleared:true};});
   case 'compact':if(p.strategy!==undefined&&p.strategy!=='local'&&p.strategy!=='model')throw new Error('Invalid compaction strategy');return interaction.action(async signal=>({removedMessages:await agent.compactContext({strategy:p.strategy as 'local'|'model'|undefined,signal})}));
   case 'mode':return interaction.action(()=>{agent.setMode(text(p.mode) as AgentMode);return {mode:agent.mode};});
   case 'model':return interaction.action(()=>{agent.setModel(text(p.model));return {model:agent.model};});
   case 'commands':return {commands:agent.extensions?.commands??[],skills:agent.extensions?.skillNames??[],mcp:agent.extensions?.serverNames??[]};
   case 'command':return interaction.action(signal=>agent.command(text(p.name),typeof p.args==='string'?p.args:'',signal));
   default:throw new Error(`Unknown RPC method: ${method}`);
  }
 }
 try{
  for await(const line of lines){
   let id:string|number|null=null;
   try{
    if(line.length>128000)throw new Error('RPC message exceeds 128000 characters');
    const q=JSON.parse(line) as {jsonrpc?:unknown;id?:unknown;method?:unknown;params?:unknown};
    if(!q||q.jsonrpc!=='2.0'||!['string','number'].includes(typeof q.id)||typeof q.method!=='string'||(q.params!==undefined&&(!q.params||typeof q.params!=='object'||Array.isArray(q.params))))throw new Error('Expected a JSON-RPC request with id, method and object params');
    id=q.id as string|number;if(ids.has(id)||pending.size>=32)throw new Error('Duplicate request ID or too many pending requests');ids.add(id);
    const requestId=id;const work=dispatch(q.method,(q.params??{}) as Record<string,unknown>).then(result=>{send({jsonrpc:'2.0',id:requestId,result});},error=>{send({jsonrpc:'2.0',id:requestId,error:{code:-32000,message:error instanceof Error?error.message:String(error)}});}).finally(()=>{ids.delete(requestId);pending.delete(work);});pending.add(work);
   }catch(error){send({jsonrpc:'2.0',id,error:{code:-32600,message:error instanceof Error?error.message:String(error)}});}
  }
  await Promise.all(pending);await interaction.drain();
 }finally{lines.close();detach();interaction.off('queue',queue);await interaction.close();}
}

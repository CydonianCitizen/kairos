import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { Interaction } from '../core/interaction.js';
import type { AgentMode } from '../core/session-store.js';
import type { AgentLoop } from '../core/agent-loop.js';
import { serializeToolResult, type ToolResult } from '../tools/registry.js';
export function subscribeEvents(agent:AgentLoop,send:(type:string,data:unknown)=>void):()=>void{
 const token=(data:string)=>send('token',data);
 const toolStart=(data:{id:string;name:string;arguments:string})=>send('tool_start',{...data,arguments:data.arguments.slice(0,64000)});
 const toolEnd=(data:{id:string;name:string;result:ToolResult})=>send('tool_end',{...data,result:JSON.parse(serializeToolResult(data.result,12000))});
 const wait=(data:unknown)=>send('wait',data);const compact=(data:unknown)=>send('compaction',data);const session=(data:unknown)=>send('session',data);const steering=(data:string)=>send('steering',data);
 agent.on('onTokenStream',token);agent.on('onToolStart',toolStart);agent.on('onToolEnd',toolEnd);agent.on('onRateLimitWait',wait);agent.on('onCompaction',compact);agent.on('onSession',session);agent.on('onSteering',steering);
 return()=>{agent.off('onTokenStream',token);agent.off('onToolStart',toolStart);agent.off('onToolEnd',toolEnd);agent.off('onRateLimitWait',wait);agent.off('onCompaction',compact);agent.off('onSession',session);agent.off('onSteering',steering);};
}
function text(value:unknown):string{if(typeof value!=='string'||!value.trim())throw new Error('Expected non-empty text');return value;}
export async function serveRpc(interaction:Interaction,input:Readable,output:Writable):Promise<void>{
 const agent=interaction.agent;const pending=new Set<Promise<void>>();const ids=new Set<string|number>();
 const send=(value:unknown)=>output.write(JSON.stringify(value)+'\n');
 const detach=subscribeEvents(agent,(type,data)=>send({jsonrpc:'2.0',method:'event',params:{type,data}}));
 const lines=createInterface({input,crlfDelay:Infinity});
 async function dispatch(method:string,p:Record<string,unknown>):Promise<unknown>{
  switch(method){
   case 'prompt':return interaction.prompt(text(p.text));
   case 'steer':interaction.steer(text(p.text));return {accepted:true};
   case 'cancel':interaction.cancel();return {cancelled:true};
   case 'state':return {model:agent.model,mode:agent.mode,sessionId:agent.sessionId,busy:interaction.busy,queued:interaction.queued};
   case 'sessions':return agent.listSessions();
   case 'resume':return interaction.action(async()=>{await agent.resumeSession(text(p.id));return {sessionId:agent.sessionId};});
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
 }finally{lines.close();detach();await interaction.close();}
}

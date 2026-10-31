import { EventEmitter } from 'node:events';
import { AgentLoop } from '../core/agent-loop.js';
import { Interaction } from '../core/interaction.js';
import type { AgentMode } from '../core/session-store.js';
import { MODELS } from '../config/models.js';
import { serializeToolResult, type ToolResult } from '../tools/registry.js';
import { safeText } from './text.js';
export interface ToolDisplay { name:string;id:string;result?:ToolResult;arguments?:string }
export interface HistoryEntry { id:number;kind:'user'|'assistant'|'info'|'error'|'tool'|'diff';text:string;tool?:ToolDisplay }
export interface UiState {
 history:HistoryEntry[];busy:boolean;activity:string;streaming:string;model:string;mode?:AgentMode;sessionId?:string;queued?:number;
 graph?:{files:number;symbols:number;diagnostics:number};cooldownUntil:number;cooldownReason:string;lastTool?:ToolDisplay;
}
const COMMANDS=['/model','/mode','/plan','/build','/graph','/clear','/compact','/sessions','/resume','/new','/skills','/skill','/extensions','/mcp','/steer','/queue','/help','/exit'];
export const HELP=`/model [provider/model]  select or list NIM models
/plan | /build           switch execution mode (idle only)
/graph [directory]       rebuild and inspect the local graph
/sessions | /resume ID   list or resume persistent sessions
/new | /clear            new session or clear current context
/compact [local]         summarize context via NIM (local skips API)
/skills | /skill NAME    list or apply a local skill
/extensions | /mcp       list plugin commands or MCP connections
/steer TEXT              add guidance at the next tool-group boundary
/queue TEXT              enqueue a follow-up (plain input also queues)
/help | /exit            show help or leave the CLI
Tab: complete or toggle tool details · Esc: cancel and clear queue · Ctrl+C: cancel, or exit when idle`;
export class UiController extends EventEmitter<{change:[];exit:[]}> {
 private state:UiState;private nextId=0;private started=false;private disposed=false;private readonly detach:()=>void;
 readonly interaction:Interaction;
 constructor(readonly agent:AgentLoop){
  super();this.interaction=new Interaction(agent);
  this.state={history:[{id:this.nextId++,kind:'info',text:'nim-codex · NVIDIA NIM · /help for commands'}],busy:false,activity:'Ready',streaming:'',model:agent.model,mode:agent.mode,queued:0,cooldownUntil:0,cooldownReason:''};
  const token=(text:string)=>this.update({streaming:this.state.streaming+safeText(text)});
  const wait=(e:{remainingMs:number;reason:string})=>this.update({cooldownUntil:Date.now()+e.remainingMs,cooldownReason:e.reason});
  const graph=(stats:{files:number;symbols:number;diagnostics:number})=>this.update({graph:stats});
  const compact=(e:{removedMessages:number})=>this.add('info',`Compacted ${e.removedMessages} messages.`);
  const session=(e:{id:string})=>this.update({sessionId:e.id,model:agent.model,mode:agent.mode});
  const steering=(text:string)=>{this.flush();this.add('user',text);};
  const start=(e:ToolDisplay)=>{this.flush();this.update({lastTool:{...e,arguments:e.arguments?.slice(0,2000)},activity:safeText(e.name)});};
  const end=(e:ToolDisplay&{result:ToolResult})=>{
   const {id,name,result}=e;this.update({lastTool:{id,name,result:JSON.parse(serializeToolResult(result,2000)) as ToolResult},activity:'Waiting for NIM'});
   this.add('tool',name,{id,name,result:{ok:result.ok,error:result.error,mutated:result.mutated}});
   if(Array.isArray(result.result))for(const item of result.result)if(item&&typeof item==='object'&&item.ok===true&&typeof item.diff==='string')this.add('diff',item.diff);
  };
  const turnStart=(prompt:string)=>{this.add('user',prompt);this.update({busy:true,activity:'Thinking',streaming:'',cooldownUntil:0});};
  // Explicit listeners keep UI state independent from callers awaiting queued prompts.
  const completed=(event:{result:{status:string;text:string;error?:string}})=>{const r=event.result;this.flush(r.status==='completed'?r.text:'');if(r.status!=='completed')this.add(r.status==='cancelled'?'info':'error',`${r.status}: ${r.error??''}`);this.update({busy:this.interaction.queued>0,activity:'Ready',cooldownUntil:0});};
  const queue=(count:number)=>this.update({queued:count});
  agent.on('onTokenStream',token);agent.on('onRateLimitWait',wait);agent.on('onGraphUpdate',graph);agent.on('onCompaction',compact);agent.on('onSession',session);agent.on('onSteering',steering);agent.on('onToolStart',start);agent.on('onToolEnd',end);
  this.interaction.on('start',turnStart);this.interaction.on('result',completed);this.interaction.on('queue',queue);
  this.detach=()=>{agent.off('onTokenStream',token);agent.off('onRateLimitWait',wait);agent.off('onGraphUpdate',graph);agent.off('onCompaction',compact);agent.off('onSession',session);agent.off('onSteering',steering);agent.off('onToolStart',start);agent.off('onToolEnd',end);this.interaction.off('start',turnStart);this.interaction.off('result',completed);this.interaction.off('queue',queue);};
 }
 getSnapshot=():UiState=>this.state;
 subscribe=(listener:()=>void):(()=>void)=>{this.on('change',listener);return()=>{this.off('change',listener);};};
 private update(patch:Partial<UiState>):void{if(!this.disposed){this.state={...this.state,...patch};this.emit('change');}}
 private add(kind:HistoryEntry['kind'],text:string,tool?:ToolDisplay):void{this.update({history:[...this.state.history,{id:this.nextId++,kind,text:safeText(text),tool}]});}
 private flush(fallback=''):void{const text=this.state.streaming||fallback;if(text)this.add('assistant',text);this.update({streaming:''});}
 async start():Promise<void>{if(this.started)return;this.started=true;await this.action('Loading workspace',signal=>this.agent.initialize(signal));this.showRestored();}
 private showRestored():void{if(this.agent.messages.length){this.add('info',`Resumed session ${this.agent.sessionId??''}`);for(const m of this.agent.messages)if((m.role==='user'||m.role==='assistant')&&typeof m.content==='string')this.add(m.role,m.content);}}
 private async action(label:string,operation:(signal:AbortSignal)=>Promise<unknown>|unknown):Promise<void>{
  if(this.interaction.busy){this.add('error','Command requires an idle agent. Use /steer or queue a follow-up.');return;}
  this.update({busy:true,activity:label});try{await this.interaction.action(operation);}catch(e){this.add('error',e instanceof Error?e.message:String(e));}finally{this.update({busy:false,activity:'Ready',model:this.agent.model,mode:this.agent.mode,sessionId:this.agent.sessionId,cooldownUntil:0});}
 }
 suggestions(input:string):string[]{
  if(input.startsWith('/')&&!input.includes(' '))return [...COMMANDS,...(this.agent.extensions?.commands.map(c=>'/'+c)??[])].filter(s=>s.startsWith(input));
  const match=input.match(/(?:^|\s)@([^\s]*)$/);const graph=this.agent.graphSnapshot;if(!match||!graph)return [];
  const term=match[1]!.toLowerCase();const names=new Set<string>();graph.graph.forEachNode((_id,attrs)=>{const candidate=attrs.kind==='file'?attrs.path:attrs.symbol?.qualifiedName;if(candidate&&candidate.toLowerCase().includes(term))names.add(candidate);});return [...names].sort().slice(0,8);
 }
 cancelOrExit():void{if(this.state.busy||this.interaction.busy)this.cancel();else this.emit('exit');}
 cancel():void{this.interaction.cancel();if(this.state.busy)this.update({activity:'Cancelling'});}
 async submit(input:string):Promise<void>{
  const prompt=input.trim();if(!prompt||this.disposed)return;
  if(!prompt.startsWith('/')){try{await this.interaction.prompt(prompt);}catch(e){this.add('error',e instanceof Error?e.message:String(e));}return;}
  const [command,...parts]=prompt.split(/\s+/);const args=parts.join(' ');
  if(command==='/help'){this.add('info',HELP);return;}
  if(command==='/steer'){try{this.interaction.steer(args);this.add('info','Steering queued.');}catch(e){this.add('error',String(e));}return;}
  if(command==='/queue'){await this.submit(args);return;}
  if(command==='/exit'){if(this.interaction.busy)this.add('error','Cancel active work before exiting.');else this.emit('exit');return;}
  await this.action(command!,async signal=>{
   switch(command){
    case '/model':if(args)this.agent.setModel(args);this.add('info',`Active: ${this.agent.model}\n${args?'':MODELS.map(m=>m.id).join('\n')}`);break;
    case '/mode':case '/plan':case '/build':this.agent.setMode((command==='/mode'?args:command.slice(1)) as AgentMode);this.add('info',`Mode: ${this.agent.mode}`);break;
    case '/clear':this.agent.clear();this.add('info','Conversation cleared. Terminal scrollback preserved.');break;
    case '/compact':if(args&&args!=='local')throw new Error('Use /compact or /compact local');if(!await this.agent.compactContext({strategy:args==='local'?'local':'model',signal}))this.add('info','Nothing to compact.');break;
    case '/graph':await this.agent.initialize(signal);this.add('info',this.agent.graphSnapshot!.getRepoMap(args||undefined));break;
    case '/sessions':this.add('info',(await this.agent.listSessions()).map(s=>`${s.id} ${s.updatedAt} ${s.mode} ${s.model}`).join('\n')||'No sessions.');break;
    case '/resume':if(!args)throw new Error('Use /resume SESSION_ID');await this.agent.resumeSession(args);this.showRestored();break;
    case '/new':await this.agent.newSession();this.add('info',`New session: ${this.agent.sessionId}`);break;
    case '/skills':this.add('info',this.agent.extensions?.skillNames.join('\n')||'No skills. Use --trust-workspace to load .nim/skills.');break;
    case '/skill':if(!this.agent.extensions)throw new Error('No skills configured');this.agent.extensions.activateSkill(args);this.add('info',`Skill ${args} added to the next turn context.`);break;
    case '/extensions':this.add('info',this.agent.extensions?.commands.join('\n')||'No plugin commands.');break;
    case '/mcp':this.add('info',this.agent.extensions?.serverNames.join('\n')||'No MCP servers connected (loaded in build mode).');break;
    default:if(!this.agent.extensions?.commands.includes(command!.slice(1)))throw new Error(`Unknown command: ${command}. Use /help.`);this.add('info',await this.agent.command(command!.slice(1),args,signal));
   }
  });
 }
 dispose():void{if(this.disposed)return;this.interaction.cancel();this.disposed=true;this.detach();this.removeAllListeners();}
 async close():Promise<void>{this.dispose();await this.interaction.close();}
}

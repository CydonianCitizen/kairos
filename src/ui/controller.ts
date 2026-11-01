import { EventEmitter } from 'node:events';
import { AgentLoop, type AgentResult, type SideQuestionEvent } from '../core/agent-loop.js';
import { Interaction, type QueuedPrompt } from '../core/interaction.js';
import type { AgentMode, SessionInfo } from '../core/session-store.js';
import { serializeToolResult, type ToolResult } from '../tools/registry.js';
import { safeText, modelName } from './text.js';
import { COMMANDS, conversationArgs, type CommandSuggestion } from './commands.js';
import { MODELS } from '../config/models.js';
import type { Effort } from '../config/effort.js';
import type { ApprovalRequest } from '../core/permissions.js';
import type { Draft } from './prompt-editor.js';
import type { RewindSummary } from '../core/rewind-store.js';
import type { TaskInfo } from '../core/background-tasks.js';
import type { WorkspaceScope } from '../tools/fs-tools.js';
export interface ToolDisplay { name:string;id:string;result?:ToolResult;arguments?:string }
export interface HistoryEntry { id:number;kind:'user'|'assistant'|'info'|'error'|'tool'|'diff'|'thinking';text:string;tool?:ToolDisplay }
export interface SideQuestionDisplay extends SideQuestionEvent { streaming:string; result?:AgentResult; cooldownUntil:number; cooldownReason:string }
export interface QueueEditState {id:number;draft:Draft;previousDraft:Draft;error?:string}
export interface UiState {
 history:HistoryEntry[];busy:boolean;activity:string;streaming:string;thinkingStream?:string;showThinking?:boolean;model:string;modelPickerOpen?:boolean;effort?:Effort;effortPickerOpen?:boolean;mode?:AgentMode;sessionId?:string;queued?:number;
 graph?:{files:number;symbols:number;diagnostics:number};cooldownUntil:number;cooldownReason:string;lastTool?:ToolDisplay;
 resumeSessions?: SessionInfo[]; resumeError?: string;
 sidePanelOpen?:boolean; sideBusy?:boolean; sideQuestion?:SideQuestionDisplay;
 approval?:ApprovalRequest;context?:{chars:number;maxChars:number;references:number};queue?:QueuedPrompt[];
 selectedQueuedId?:number;queueEdit?:QueueEditState;queuePaused?:boolean;
 rewindPoints?:RewindSummary[];backgroundRunning?:number;scope?:WorkspaceScope;
}
const HELP=`/model [provider/model]  open model picker or select directly
/effort [level]         choose model reasoning effort
/plan | /build           switch execution mode (idle only)
/graph [directory]       rebuild and inspect the local graph
/context                 show explicit file/symbol references and budget
/undo                    preview and undo the last KAIROS edit batch
/rewind [ID scope]       choose a prompt; scope: both, conversation or files
/tasks [logs ID|stop ID] inspect background tasks; /tasks start COMMAND starts one
/memory [add|remove|clear] inspect and manage durable project notes
/sessions | /resume [ID] list sessions, open picker or resume directly
/rename NAME            rename the current persistent session
/branch [--model ID] [NAME] copy conversation and switch to the new session
/btw [--model ID] TEXT    ask a separate, read-only side question (no text: reopen)
/new | /clear            new session or clear current context
/compact [local]         summarize context via NIM (local skips API)
/skills | /skill NAME    list or apply a local skill
/extensions | /mcp       list plugin commands or MCP connections
/steer TEXT              add guidance at the next tool-group boundary
/thinking [on|off]       toggle or set model CoT reasoning visibility
/scope [level]           set workspace scope (none, read-only, workspace, full)
/queue TEXT              enqueue a follow-up (plain input also queues)
/queue [list|clear|remove ID] inspect or remove waiting messages
/queue edit ID TEXT      replace a waiting message in place
/help | /exit            show help or leave the CLI
Type / for commands · ↑↓: choose · Enter: send/select · Tab: complete or tool details
Ctrl+J or backslash then Enter: newline · Shift+Enter: newline when supported · Ctrl+R: search project prompts
History: ↑↓ or Ctrl+R to choose · Enter/Tab: load draft · Esc: restore draft
Queue: ↑ at first input line, ↑↓ choose, Enter/Tab edit · Enter save · Esc restore draft
Esc: close menu, or cancel work · Ctrl+C: cancel, or exit when idle`;
export class UiController extends EventEmitter<{change:[];exit:[]}> {
 private state:UiState;private nextId=0;private startPromise?:Promise<void>;private disposed=false;private readonly detach:()=>void;
 private submittedPrompts: string[] = [];
 private approvalResolve?: (allowed:boolean)=>void;
 readonly interaction:Interaction;
 constructor(readonly agent:AgentLoop,readonly availableModels:readonly string[]=MODELS.map(model=>model.id),options:{showThinking?:boolean}={}){
  super();this.interaction=new Interaction(agent);
  this.state={history:[],busy:false,activity:'Ready',streaming:'',showThinking:options.showThinking??false,model:agent.model,effort:agent.effort,mode:agent.mode,scope:agent.scope,queued:0,queue:[],cooldownUntil:0,cooldownReason:''};
  agent.setApprovalHandler((request,signal)=>new Promise<boolean>((resolve,reject)=>{
   if(this.disposed){reject(new Error('Approval UI is closed'));return;}
   let settled=false;
   const finish=(allowed:boolean)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);this.approvalResolve=undefined;this.update({approval:undefined,activity:allowed?'Executing approved operation':'Operation denied'});this.add('info',`${allowed?'Allowed once':'Denied'}: ${request.tool}`);resolve(allowed);};
   const abort=()=>finish(false);this.approvalResolve=finish;
   this.update({approval:request,activity:'Awaiting approval',sidePanelOpen:false,modelPickerOpen:false,effortPickerOpen:false,resumeSessions:undefined,rewindPoints:undefined});
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  }));
  const context=(value:{chars:number;maxChars:number;references:unknown[]})=>this.update({context:{chars:value.chars,maxChars:value.maxChars,references:value.references.length}});
  const background=(tasks:TaskInfo[])=>this.update({backgroundRunning:tasks.filter(task=>task.status==='running').length});agent.on('onBackgroundUpdate',background);
  const token=(text:string)=>{
   if(this.state.thinkingStream){this.add('thinking',this.state.thinkingStream);this.update({thinkingStream:'',streaming:safeText(text)});}
   else this.update({streaming:this.state.streaming+safeText(text)});
  };
  const reasoning=(text:string)=>{if(this.state.showThinking)this.update({thinkingStream:(this.state.thinkingStream??'')+safeText(text)});};
  const wait=(e:{remainingMs:number;reason:string})=>this.update({cooldownUntil:Date.now()+e.remainingMs,cooldownReason:e.reason});
  const graph=(stats:{files:number;symbols:number;diagnostics:number})=>this.update({graph:stats});
  const compact=(e:{removedMessages:number})=>this.add('info',`Compacted ${e.removedMessages} messages.`);
  const session=(e:{id:string})=>this.update({sessionId:e.id,model:agent.model,mode:agent.mode,effort:agent.effort,...(this.state.sessionId&&this.state.sessionId!==e.id?{sideQuestion:undefined,sidePanelOpen:false}: {})});
  const sideStart=(e:SideQuestionEvent)=>this.update({sidePanelOpen:true,sideBusy:true,sideQuestion:{...e,streaming:'',cooldownUntil:0,cooldownReason:''}});
  const sideToken=(text:string)=>{if(this.state.sideQuestion)this.update({sideQuestion:{...this.state.sideQuestion,streaming:this.state.sideQuestion.streaming+safeText(text)}});};
  const sideWait=(e:{remainingMs:number;reason:string})=>{if(this.state.sideQuestion)this.update({sideQuestion:{...this.state.sideQuestion,cooldownUntil:Date.now()+e.remainingMs,cooldownReason:e.reason}});};
  const sideEnd=(e:SideQuestionEvent&{result:AgentResult})=>{if(this.state.sideQuestion)this.update({sideBusy:false,sideQuestion:{...this.state.sideQuestion,result:e.result,cooldownUntil:0}});};
  const steering=(text:string)=>{this.flush();this.add('user',text);};
  const start=(e:ToolDisplay)=>{
   if(this.state.thinkingStream){this.add('thinking',this.state.thinkingStream);this.update({thinkingStream:''});}
   this.flush();this.update({lastTool:{...e,arguments:e.arguments?.slice(0,2000)},activity:safeText(e.name)});
  };
  const end=(e:ToolDisplay&{result:ToolResult})=>{
   const {id,name,result}=e;this.update({lastTool:{id,name,result:JSON.parse(serializeToolResult(result,2000)) as ToolResult},activity:'Waiting for NIM'});
   this.add('tool',name,{id,name,result:{ok:result.ok,error:result.error,mutated:result.mutated}});
   if(Array.isArray(result.result))for(const item of result.result)if(item&&typeof item==='object'&&item.ok===true&&typeof item.diff==='string')this.add('diff',item.diff);
  };
  const turnStart=(prompt:string)=>{this.add('user',prompt);this.update({busy:true,activity:'Thinking',streaming:'',thinkingStream:'',cooldownUntil:0,modelPickerOpen:false,effortPickerOpen:false,resumeSessions:undefined,resumeError:undefined,rewindPoints:undefined});};
  // Explicit listeners keep UI state independent from callers awaiting queued prompts.
  const completed=(event:{result:{status:string;text:string;error?:string}})=>{
   const r=event.result;
   if(this.state.thinkingStream){this.add('thinking',this.state.thinkingStream);}
   this.flush(r.status==='completed'?r.text:'');if(r.status!=='completed')this.add(r.status==='cancelled'?'info':'error',`${r.status}: ${r.error??''}`);
   this.update({busy:this.interaction.queued>0&&!this.interaction.queuePaused,activity:this.interaction.queuePaused?'Queue paused':'Ready',cooldownUntil:0,thinkingStream:''});
  };
  const queue=(count:number)=>{const entries=this.interaction.queueSnapshot;this.update({queued:count,queue:entries,queuePaused:this.interaction.queuePaused,busy:this.interaction.busy,
   ...(this.state.queueEdit&&!entries.some(item=>item.id===this.state.queueEdit!.id)?{queueEdit:{...this.state.queueEdit,error:'Message is no longer waiting. Esc restores your previous draft.'}}:{}),
   ...(this.interaction.busy?{}:{activity:this.interaction.queuePaused?'Queue paused':'Ready'})});};
  agent.on('onTokenStream',token);agent.on('onReasoningStream',reasoning);agent.on('onRateLimitWait',wait);agent.on('onGraphUpdate',graph);agent.on('onCompaction',compact);agent.on('onSession',session);agent.on('onSteering',steering);agent.on('onToolStart',start);agent.on('onToolEnd',end);
  agent.on('onSideStart',sideStart);agent.on('onSideTokenStream',sideToken);agent.on('onSideRateLimitWait',sideWait);agent.on('onSideEnd',sideEnd);
  agent.on('onContextUpdate',context);
  this.interaction.on('start',turnStart);this.interaction.on('result',completed);this.interaction.on('queue',queue);
  this.detach=()=>{agent.off('onBackgroundUpdate',background);agent.off('onContextUpdate',context);agent.off('onTokenStream',token);agent.off('onReasoningStream',reasoning);agent.off('onRateLimitWait',wait);agent.off('onGraphUpdate',graph);agent.off('onCompaction',compact);agent.off('onSession',session);agent.off('onSteering',steering);agent.off('onToolStart',start);agent.off('onToolEnd',end);agent.off('onSideStart',sideStart);agent.off('onSideTokenStream',sideToken);agent.off('onSideRateLimitWait',sideWait);agent.off('onSideEnd',sideEnd);this.interaction.off('start',turnStart);this.interaction.off('result',completed);this.interaction.off('queue',queue);};
 }
 getSnapshot=():UiState=>this.state;
 selectQueued(direction:-1|1):void{
  const entries=this.interaction.queueSnapshot;if(!entries.length||this.state.queueEdit)return;
  const index=entries.findIndex(item=>item.id===this.state.selectedQueuedId);
  if(index<0){if(direction<0)this.update({selectedQueuedId:entries.at(-1)?.id});return;}
  this.update({selectedQueuedId:entries[Math.max(0,index+direction)]?.id});
 }
 clearQueueSelection():void{this.update({selectedQueuedId:undefined});}
 beginQueueEdit(id:number,previousDraft:Draft):boolean{
  if(this.state.queueEdit||this.disposed)return false;
  const item=this.interaction.queueSnapshot.find(item=>item.id===id);
  if(!item){this.clearQueueSelection();this.add('error','Message is no longer waiting. Use /queue to list waiting messages.');return false;}
  const text=safeText(item.text.replace(/\r\n?/g,'\n'));
  this.interaction.pauseQueue();this.update({selectedQueuedId:undefined,queueEdit:{id,draft:{text,cursor:text.length},previousDraft:{...previousDraft}}});return true;
 }
 updateQueueDraft(draft:Draft):void{if(this.state.queueEdit)this.update({queueEdit:{...this.state.queueEdit,draft:{...draft},error:undefined}});}
 saveQueueEdit():boolean{
  const edit=this.state.queueEdit;if(!edit)return false;
  try{
   if(!this.interaction.editQueued(edit.id,edit.draft.text))throw new Error('Message is no longer waiting. Esc restores your previous draft.');
  }catch(error){this.update({queueEdit:{...edit,error:error instanceof Error?error.message:String(error)}});return false;}
  this.update({queueEdit:undefined});this.add('info',`Updated queued message #${edit.id}.`);this.interaction.resumeQueue();return true;
 }
 cancelQueueEdit():void{if(!this.state.queueEdit)return;this.update({queueEdit:undefined});this.interaction.resumeQueue();}
 respondApproval(allowed:boolean):void{this.approvalResolve?.(allowed);}
 async promptHistory(): Promise<string[]> {
  const saved = await this.agent.promptHistory();
  const live = this.state.history.filter(entry => entry.kind === 'user').map(entry => entry.text);
  return [...new Set([...saved, ...live, ...this.submittedPrompts].reverse())].slice(0, 200).reverse();
 }
 subscribe=(listener:()=>void):(()=>void)=>{this.on('change',listener);return()=>{this.off('change',listener);};};
 private update(patch:Partial<UiState>):void{if(!this.disposed){this.state={...this.state,...patch};this.emit('change');}}
 private add(kind:HistoryEntry['kind'],text:string,tool?:ToolDisplay):void{this.update({history:[...this.state.history,{id:this.nextId++,kind,text:safeText(text),tool}]});}
 private flush(fallback=''):void{const text=this.state.streaming||fallback;if(text)this.add('assistant',text);this.update({streaming:''});}
 start():Promise<void>{return this.startPromise??=(async()=>{await this.action('Loading workspace',signal=>this.agent.initialize(signal));this.showRestored();})();}
 private showRestored():void{if(this.agent.messages.length){this.add('info',`Resumed session ${this.agent.sessionId??''}`);for(const m of this.agent.messages)if((m.role==='user'||m.role==='assistant')&&typeof m.content==='string')this.add(m.role,m.content);}}
 private async action(label:string,operation:(signal:AbortSignal)=>Promise<unknown>|unknown):Promise<void>{
  if(this.interaction.busy){this.add('error','Command requires an idle agent. Use /steer or queue a follow-up.');return;}
  this.update({busy:true,activity:label});try{await this.interaction.action(operation);}catch(e){this.add('error',e instanceof Error?e.message:String(e));}finally{
   // The completed action may already have handed control to a queued turn.
   this.update({busy:this.interaction.busy,...(this.interaction.busy?{}:{activity:'Ready',cooldownUntil:0}),model:this.agent.model,effort:this.agent.effort,mode:this.agent.mode,sessionId:this.agent.sessionId});
  }
 }
 commandSuggestions(input:string):CommandSuggestion[]{
  if(!/^\/\S*$/.test(input))return [];
  return [...COMMANDS,...(this.agent.extensions?.commands.map(name=>({name:'/'+name,description:'Workspace plugin command'}))??[])].filter(command=>command.name.startsWith(input));
 }
 suggestions(input:string):string[]{
  if(/^\/\S*$/.test(input))return this.commandSuggestions(input).map(command=>command.name);
  if(input.startsWith('/skill ')){
   const term=input.slice(7).toLowerCase();
   return (this.agent.extensions?.skillNames??[]).filter(name=>name.toLowerCase().includes(term)).map(name=>`/skill ${name}`);
  }
  const match=input.match(/(?:^|\s)@([^\s]*)$/);const graph=this.agent.graphSnapshot;if(!match||!graph)return [];
  const prefix=match[1]!.match(/^(file:|symbol:)/)?.[1]??'';
  const term=match[1]!.slice(prefix.length).toLowerCase();const names=new Set<string>();
  graph.graph.forEachNode((_id,attrs)=>{if(prefix==='file:'&&attrs.kind!=='file'||prefix==='symbol:'&&attrs.kind==='file')return;const candidate=attrs.kind==='file'?attrs.path:attrs.symbol?.qualifiedName;if(candidate&&candidate.toLowerCase().includes(term))names.add(prefix+candidate);});return [...names].sort().slice(0,8);
 }
 hideSideQuestion():void{this.update({sidePanelOpen:false});}
 cancelSideQuestion():void{this.interaction.cancelSide();this.hideSideQuestion();}
 clearSideQuestions():void{this.agent.clearSideQuestions();this.update({sidePanelOpen:false,sideQuestion:undefined});}
 cancelOrExit():void{if(this.state.sidePanelOpen||this.state.modelPickerOpen||this.state.effortPickerOpen||this.state.resumeSessions||this.state.rewindPoints||this.state.busy||this.interaction.busy)this.cancel();else this.emit('exit');}
 cancel():void{if(this.state.approval){this.interaction.cancel();this.update({activity:'Cancelling'});return;}if(this.state.sidePanelOpen){this.hideSideQuestion();return;}if(this.state.modelPickerOpen||this.state.effortPickerOpen||this.state.resumeSessions||this.state.rewindPoints){this.update({modelPickerOpen:false,effortPickerOpen:false,resumeSessions:undefined,resumeError:undefined,rewindPoints:undefined});return;}this.interaction.cancel();if(this.state.busy)this.update({activity:'Cancelling'});}
 private async sideQuestion(args:string):Promise<void>{
  if((!args&&this.state.sideQuestion)||this.interaction.sideBusy){this.update({sidePanelOpen:true});return;}
  let model=this.agent.model;let question=args;
  try{
   const parsed=conversationArgs(args);model=parsed.model??model;question=parsed.text;
   if(!question)throw new Error('Use /btw [--model provider/model] QUESTION');
   this.update({sidePanelOpen:true,sideBusy:true,modelPickerOpen:false,effortPickerOpen:false,resumeSessions:undefined,sideQuestion:{question,model,sessionId:this.agent.sessionId,streaming:'',cooldownUntil:0,cooldownReason:''}});
   const result=await this.interaction.sideQuestion(question,{model});
   if(this.state.sideQuestion)this.update({sideBusy:false,sideQuestion:{...this.state.sideQuestion,result,cooldownUntil:0}});
  }catch(error){this.update({sidePanelOpen:true,sideBusy:false,sideQuestion:{question,model,streaming:'',cooldownUntil:0,cooldownReason:'',result:{status:'error',text:'',iterations:0,error:error instanceof Error?error.message:String(error)}}});}
 }
 private async sendPrompt(prompt:string):Promise<void>{
  if(prompt.length<=64000)this.submittedPrompts=[...this.submittedPrompts,prompt].slice(-200);
  try{await this.interaction.prompt(prompt);}catch(e){this.add('error',e instanceof Error?e.message:String(e));}
 }
 async submit(input:string):Promise<void>{
  const prompt=input.replace(/\r\n?/g,'\n').trim();if(!prompt||this.disposed)return;
  const queue=prompt.match(/^\/queue(?:\s+([\s\S]*))?$/);
  if(queue){
   const args=queue[1]?.trim()??'';
   if(!args||args==='list'){const entries=this.interaction.queueSnapshot;this.add('info',entries.length?`Queued ${entries.length}/20 (FIFO):\n`+entries.map(item=>`#${item.id} ${item.text}`).join('\n'):'Queue is empty.');return;}
   if(args==='clear'){this.add('info',`Removed ${this.interaction.clearQueue()} waiting messages. Active work continues.`);return;}
   if(args==='remove'||/^remove [+-]?\d+$/.test(args)){const id=args.match(/^remove ([1-9]\d*)$/)?.[1];if(!id||!this.interaction.removeQueued(Number(id)))this.add('error','Use /queue remove ID with an ID from /queue.');else this.add('info',`Removed queued message #${id}.`);return;}
   if(/^edit(?:$|\s+[+-]?\d+(?:\s|$))/.test(args)){
    const edit=args.match(/^edit\s+([1-9]\d*)\s+([\s\S]+)$/);
    if(!edit){this.add('error','Use /queue edit ID TEXT with an ID from /queue.');return;}
    try{if(this.interaction.editQueued(Number(edit[1]),edit[2]!))this.add('info',`Updated queued message #${edit[1]}.`);else this.add('error',`Cannot edit message #${edit[1]}: it is no longer waiting. Use /queue to list waiting messages.`);}
    catch(error){this.add('error',error instanceof Error?error.message:String(error));}return;
   }
   await this.sendPrompt(args);return;
  }
  if(!prompt.startsWith('/')||prompt.includes('\n')){await this.sendPrompt(prompt);return;}
  const [command,...parts]=prompt.split(/\s+/);const args=parts.join(' ');
  if(command==='/help'){this.add('info',HELP);return;}
  if(command==='/tasks'&&!args.startsWith('start ')){
   try{const [action,...ids]=args.split(/\s+/);if(!args||action==='list')this.add('info',this.agent.backgroundTasks.list().map(task=>`${task.id} ${task.status} · ${task.command.slice(0,180)}`).join('\n')||'No background tasks.');
    else if(action==='logs'&&ids.length===1){const task=this.agent.backgroundTasks.logs(ids)[0]!;this.add('info',`${task.id} ${task.status}\nstdout:\n${task.stdout}\nstderr:\n${task.stderr}`);}
    else if(action==='stop'&&ids.length){const targets=ids[0]==='all'?this.agent.backgroundTasks.list().filter(task=>task.status==='running').map(task=>task.id):ids;if(targets.length)this.add('info',(await this.agent.backgroundTasks.stop(targets)).map(task=>`${task.id} ${task.status}`).join('\n'));else this.add('info','No running tasks.');}
    else throw new Error('Use /tasks, /tasks logs ID, /tasks stop ID|all, /tasks start COMMAND');
   }catch(error){this.add('error',error instanceof Error?error.message:String(error));}return;
  }
  if(command==='/memory'&&(!args||args==='list')){try{this.add('info',this.agent.memoryEnabled?(await this.agent.listMemory()).map(note=>`${note.id} ${note.text}`).join('\n')||'No durable project notes. Use /memory add TEXT.':'Project memory is disabled.');}catch(error){this.add('error',error instanceof Error?error.message:String(error));}return;}
  if(command==='/btw'){await this.sideQuestion(args);return;}
  if(command==='/steer'){try{this.interaction.steer(args);this.add('info','Steering queued.');}catch(e){this.add('error',String(e));}return;}
  if(command==='/exit'){if(this.interaction.busy)this.add('error','Cancel active work before exiting.');else this.emit('exit');return;}
  await this.action(command!,async signal=>{
   switch(command){
    case '/tasks':{const task=await this.agent.startBackground(args.slice(6),{signal});this.add('info',`Started ${task.id} · ${task.command}`);break;}
    case '/memory':{const [action,id,...rest]=args.split(/\s+/);if(action==='add')await this.agent.updateMemory([{action:'add',text:args.slice(4)}],signal);else if(action==='remove'&&id&&!rest.length)await this.agent.updateMemory([{action:'remove',id}],signal);else if(action==='update'&&id&&rest.length)await this.agent.updateMemory([{action:'update',id,text:rest.join(' ')}],signal);else if(action==='clear'&&!id)await this.agent.clearMemory(signal);else throw new Error('Use /memory [add TEXT|update ID TEXT|remove ID|clear]');this.add('info','Project memory updated.');break;}
    case '/rewind':{if(!args){const points=await this.agent.listRewinds();if(!points.length)this.add('info','No prompt checkpoints yet.');else this.update({rewindPoints:points,modelPickerOpen:false,effortPickerOpen:false,resumeSessions:undefined});break;}const [id,scope='both',...extra]=args.split(/\s+/);if(extra.length||!['conversation','files','both'].includes(scope))throw new Error('Use /rewind ID [conversation|files|both]');const result=await this.agent.rewind(id!,scope as 'conversation'|'files'|'both',signal);if(!result.ok){for(const file of result.files)if(!file.ok)this.add('error',`${file.path}: ${file.error}`);break;}this.update({rewindPoints:undefined,lastTool:undefined,streaming:''});for(const file of result.files)if(file.ok&&file.diff)this.add('diff',file.diff);this.add('info',`Rewound ${scope} to before checkpoint ${id}. Terminal scrollback is preserved.`);break;}
    case '/model':if(!args){this.update({modelPickerOpen:true,effortPickerOpen:false,resumeSessions:undefined,resumeError:undefined});break;}this.agent.setModel(args);this.update({modelPickerOpen:false});break;
    case '/effort':if(!args){this.update({effortPickerOpen:true,modelPickerOpen:false,resumeSessions:undefined,resumeError:undefined});break;}this.agent.setEffort(args);this.update({effortPickerOpen:false});break;
    case '/mode':case '/plan':case '/build':this.agent.setMode((command==='/mode'?args:command.slice(1)) as AgentMode);this.add('info',`Mode: ${this.agent.mode}`);break;
    case '/clear':this.agent.clear();this.clearSideQuestions();this.add('info','Conversation cleared. Terminal scrollback preserved.');break;
    case '/compact':if(args&&args!=='local')throw new Error('Use /compact or /compact local');if(!await this.agent.compactContext({strategy:args==='local'?'local':'model',signal}))this.add('info','Nothing to compact.');break;
    case '/graph':await this.agent.initialize(signal);this.add('info',this.agent.graphSnapshot!.getRepoMap(args||undefined));break;
    case '/context':{const snapshot=this.agent.contextSnapshot;this.add('info',`Explicit references: ${snapshot.references.length} · ${snapshot.chars}/${snapshot.maxChars} characters\n`+snapshot.references.map(ref=>`${ref.kind}: ${ref.path}:${ref.startLine}–${ref.endLine}${ref.name?` ${ref.name}`:''}${ref.truncated?' [truncated]':''}`).join('\n'));break;}
    case '/undo':{if(args)throw new Error('Use /undo without arguments');const results=await this.agent.undoLast(signal);if(!results.length)this.add('info','No KAIROS edit batch to undo.');for(const result of results){if(result.ok&&result.diff)this.add('diff',result.diff);else if(!result.ok)this.add('error',`${result.path}: ${result.error}`);}break;}
    case '/sessions':this.add('info',(await this.agent.listSessions()).map(s=>`${s.id} ${s.updatedAt} ${s.mode} ${s.model} · ${s.name??s.title??'Empty session'}`).join('\n')||'No sessions.');break;
    case '/rename':if(!args)throw new Error('Use /rename SESSION_NAME');await this.agent.renameSession(args);this.add('info',`Session renamed: ${this.agent.sessionName}`);break;
    case '/branch':{const {model,text}=conversationArgs(args);const branch=await this.agent.branchSession({model,name:text||undefined});this.update({lastTool:undefined,streaming:''});this.add('info',`Branched to ${branch.sessionId}${this.agent.sessionName?` · ${this.agent.sessionName}`:''} · ${modelName(this.agent.model)}. Original: /resume ${branch.parentId}`);break;}
    case '/resume': {
     if (!args) {
      if (!this.agent.persistenceEnabled) throw new Error('Persistence is disabled for this invocation');
      const sessions = await this.agent.listSessions(); signal.throwIfAborted();
      this.update({resumeSessions:sessions,resumeError:undefined,modelPickerOpen:false,effortPickerOpen:false}); break;
     }
     const same = args === this.agent.sessionId;
     try { await this.agent.resumeSession(args); }
     catch (error) { if(this.state.resumeSessions)this.update({resumeError:error instanceof Error?error.message:String(error)}); throw error; }
     this.update({resumeSessions:undefined,resumeError:undefined,lastTool:undefined,streaming:''});
     if(!same)this.showRestored(); break;
    }
    case '/thinking':{
      const v=args?.trim().toLowerCase();let enabled:boolean;
      if(!v)enabled=!this.state.showThinking;
      else if(['on','true','1'].includes(v))enabled=true;
      else if(['off','false','0'].includes(v))enabled=false;
      else throw new Error('Use /thinking [on|off]');
      this.update({showThinking:enabled});
      this.add('info',`CoT thinking visibility ${enabled?'enabled':'disabled'}.`);
      break;
    }
    case '/scope':{
      const val=args?.trim().toLowerCase();
      if(!val){this.add('info',`Current workspace scope: ${this.agent.scope} (options: none, read-only, workspace, full)`);break;}
      if(!['none','read-only','workspace','full'].includes(val))throw new Error('Use /scope [none|read-only|workspace|full]');
      this.agent.setScope(val as WorkspaceScope);
      this.update({scope:val as WorkspaceScope});
      this.add('info',`Workspace scope set to: ${val}`);
      break;
    }
    case '/new':await this.agent.newSession();this.add('info',`New session: ${this.agent.sessionId}`);break;
    case '/skills':{
      const skills=this.agent.extensions?.skillsList??[];
      if(!skills.length)this.add('info','No skills available.');
      else this.add('info',`Available skills (${skills.length}):\n`+skills.map(s=>`  ${s.name.padEnd(25)} · ${s.description}`).join('\n'));
      break;
    }
    case '/skill':{
      const name=args.trim();
      if(!name)throw new Error('Use /skill SKILL_NAME');
      if(!this.agent.extensions)throw new Error('No skills configured');
      this.agent.extensions.activateSkill(name);
      this.add('info',`Skill ${name} added to the next turn context.`);
      break;
    }
    case '/extensions':this.add('info',this.agent.extensions?.commands.join('\n')||'No plugin commands.');break;
    case '/mcp':this.add('info',this.agent.extensions?.serverNames.join('\n')||'No MCP servers connected (loaded in build mode).');break;
    default:if(!this.agent.extensions?.commands.includes(command!.slice(1)))throw new Error(`Unknown command: ${command}. Use /help.`);this.add('info',await this.agent.command(command!.slice(1),args,signal));
   }
  });
 }
 dispose():void{if(this.disposed)return;this.interaction.cancel();this.approvalResolve?.(false);this.agent.setApprovalHandler(undefined);this.disposed=true;this.detach();this.removeAllListeners();}
 async close():Promise<void>{this.dispose();await this.interaction.close();}
}

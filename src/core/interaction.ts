import { EventEmitter } from 'node:events';
import type { AgentLoop, AgentResult } from './agent-loop.js';
export interface QueuedPrompt {id:number;text:string}
interface Pending extends QueuedPrompt {resolve:(result:AgentResult)=>void}
const cancelled=():AgentResult=>({status:'cancelled',text:'',iterations:0,error:'Queued prompt cancelled'});
export class Interaction extends EventEmitter<{start:[string];result:[{prompt:string;result:AgentResult}];queue:[number]}> {
 private pending:Pending[]=[];private active?:Promise<unknown>;private abort?:AbortController;private closed=false;private nextId=1;private paused=false;
 private sideWork?:Promise<AgentResult>;private sideAbort?:AbortController;
 constructor(readonly agent:AgentLoop){super();}
 get busy():boolean{return !!this.active;}
 get queued():number{return this.pending.length;}
 get queuePaused():boolean{return this.paused;}
 pauseQueue():void{if(this.closed||this.paused)return;this.paused=true;this.emit('queue',this.queued);}
 resumeQueue():void{if(!this.paused)return;this.paused=false;this.pump();this.emit('queue',this.queued);}
 get queueSnapshot():QueuedPrompt[]{return this.pending.map(({id,text})=>({id,text}));}
 editQueued(id:number,text:string):boolean{
  if(!Number.isSafeInteger(id)||id<1)throw new Error('Expected a positive queue ID');
  if(typeof text!=='string'||!text.trim()||text.length>64000)throw new Error('Prompt rejected: empty or over 64000 characters');
  const item=this.pending.find(item=>item.id===id);if(!item)return false;
  item.text=text;this.emit('queue',this.queued);return true;
 }
 removeQueued(id:number):boolean{
  const index=this.pending.findIndex(item=>item.id===id);if(index<0)return false;
  this.pending.splice(index,1)[0]!.resolve(cancelled());this.emit('queue',this.queued);return true;
 }
 clearQueue():number{
  const removed=this.pending.splice(0);for(const item of removed)item.resolve(cancelled());
  this.emit('queue',this.queued);return removed.length;
 }
 get sideBusy():boolean{return !!this.sideWork;}
 sideQuestion(question:string,options:{model?:string}={}):Promise<AgentResult>{
  if(this.closed||this.sideWork)return Promise.reject(new Error('A side question is active or the interaction is closed'));
  this.sideAbort=new AbortController();const signal=this.sideAbort.signal;
  const work=Promise.resolve().then(()=>this.agent.sideQuestion(question,{...options,signal}));
  this.sideWork=work.finally(()=>{this.sideWork=undefined;this.sideAbort=undefined;});return this.sideWork;
 }
 cancelSide():void{this.sideAbort?.abort();}
 prompt(text:string):Promise<AgentResult>{
  if(this.closed||!text.trim()||text.length>64000||this.pending.length>=20)return Promise.reject(new Error('Prompt rejected: closed, empty, over 64000 characters or queue full (20)'));
  return new Promise(resolve=>{this.pending.push({id:this.nextId++,text,resolve});this.pump();this.emit('queue',this.queued);});
 }
 private pump():void{
  if(this.active||this.closed||this.paused)return;const item=this.pending.shift();if(!item)return;
  this.abort=new AbortController();const signal=this.abort.signal;
  // Reserve the queue before exposing events or invoking user/plugin code.
  const work=Promise.resolve().then(async()=>{if(signal.aborted)return cancelled();this.emit('queue',this.queued);this.emit('start',item.text);return this.agent.run(item.text,{signal});});
  this.active=work.catch((error:unknown):AgentResult=>({status:'error',text:'',iterations:0,error:error instanceof Error?error.message:String(error)})).then(result=>{
   try{this.emit('result',{prompt:item.text,result});}
   finally{this.active=undefined;this.abort=undefined;this.pump();item.resolve(result);}
  });
 }
 steer(text:string):void{if(!this.busy)throw new Error('No active turn to steer');this.agent.steer(text);}
 cancel():void{this.abort?.abort();this.cancelSide();this.paused=false;this.clearQueue();}
 async action<T>(operation:(signal:AbortSignal)=>Promise<T>|T):Promise<T>{
  if(this.closed||this.active||this.pending.length)throw new Error('Agent is busy or closed');
  this.abort=new AbortController();const signal=this.abort.signal;
  const work=Promise.resolve().then(()=>{signal.throwIfAborted();return operation(signal);});this.active=work;
  try{return await work;}finally{this.active=undefined;this.abort=undefined;this.pump();}
 }
 async drain():Promise<void>{while(this.active||this.sideWork)await Promise.allSettled([this.active,this.sideWork]);}
 async close():Promise<void>{if(this.closed)return;this.closed=true;this.cancel();try{await this.drain();}finally{await this.agent.close();this.removeAllListeners();}}
}

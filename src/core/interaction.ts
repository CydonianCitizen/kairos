import { EventEmitter } from 'node:events';
import type { AgentLoop, AgentResult } from './agent-loop.js';
interface Pending {text:string;resolve:(result:AgentResult)=>void}
const cancelled=():AgentResult=>({status:'cancelled',text:'',iterations:0,error:'Queued prompt cancelled'});
export class Interaction extends EventEmitter<{start:[string];result:[{prompt:string;result:AgentResult}];queue:[number]}> {
 private pending:Pending[]=[];private active?:Promise<unknown>;private abort?:AbortController;private closed=false;
 constructor(readonly agent:AgentLoop){super();}
 get busy():boolean{return !!this.active;}
 get queued():number{return this.pending.length;}
 prompt(text:string):Promise<AgentResult>{
  if(this.closed||!text.trim()||text.length>64000||this.pending.length>=20)return Promise.reject(new Error('Prompt rejected: closed, empty, over 64000 characters or queue full (20)'));
  return new Promise(resolve=>{this.pending.push({text,resolve});this.emit('queue',this.queued);this.pump();});
 }
 private pump():void{
  if(this.active||this.closed)return;const item=this.pending.shift();if(!item)return;
  this.abort=new AbortController();const signal=this.abort.signal;
  // Reserve the queue before exposing events or invoking user/plugin code.
  const work=Promise.resolve().then(async()=>{if(signal.aborted)return cancelled();this.emit('queue',this.queued);this.emit('start',item.text);return this.agent.run(item.text,{signal});});
  this.active=work.catch((error:unknown):AgentResult=>({status:'error',text:'',iterations:0,error:error instanceof Error?error.message:String(error)})).then(result=>{
   try{this.emit('result',{prompt:item.text,result});}
   finally{this.active=undefined;this.abort=undefined;this.pump();item.resolve(result);}
  });
 }
 steer(text:string):void{if(!this.busy)throw new Error('No active turn to steer');this.agent.steer(text);}
 cancel():void{this.abort?.abort();for(const item of this.pending.splice(0))item.resolve(cancelled());this.emit('queue',0);}
 async action<T>(operation:(signal:AbortSignal)=>Promise<T>|T):Promise<T>{
  if(this.closed||this.active||this.pending.length)throw new Error('Agent is busy or closed');
  this.abort=new AbortController();const signal=this.abort.signal;
  const work=Promise.resolve().then(()=>{signal.throwIfAborted();return operation(signal);});this.active=work;
  try{return await work;}finally{this.active=undefined;this.abort=undefined;this.pump();}
 }
 async drain():Promise<void>{while(this.active)await this.active;}
 async close():Promise<void>{if(this.closed)return;this.closed=true;this.cancel();try{await this.drain();}finally{await this.agent.close();this.removeAllListeners();}}
}

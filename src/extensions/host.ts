import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { AgentMode } from '../core/session-store.js';
import type { ToolResult } from '../tools/registry.js';
import { McpConnection, type McpConfig } from './mcp.js';
export interface ExtensionTool { name:string; description:string; parameters:Record<string,unknown>; execute:(args:Record<string,unknown>,context:{workspace:string;signal?:AbortSignal})=>Promise<unknown> }
export interface PluginApi {
 registerTool(tool:ExtensionTool):void;
 registerCommand(name:string,handler:(args:string,context:{workspace:string;signal?:AbortSignal})=>Promise<string>):void;
 onTurnEnd(handler:(result:{status:string;text:string})=>void|Promise<void>):void;
}
interface Config {plugins?:string[];mcpServers?:Record<string,McpConfig>}
interface Skill {name:string;description:string;content:string}
const reserved=new Set(['help','model','mode','plan','build','graph','clear','compact','exit','sessions','resume','new','skills','skill','extensions','mcp','steer','queue']);
const ajv=new Ajv({strict:false,allErrors:false,validateFormats:false});
const schemas:Record<string,Record<string,unknown>>={
 load_skills_batch:{type:'object',properties:{names:{type:'array',minItems:1,maxItems:20,items:{type:'string'}}},required:['names'],additionalProperties:false},
 inspect_extension_tools:{type:'object',properties:{names:{type:'array',minItems:1,maxItems:20,items:{type:'string'}}},required:['names'],additionalProperties:false},
 extension_tools_batch:{type:'object',properties:{calls:{type:'array',minItems:1,maxItems:20,items:{type:'object',properties:{name:{type:'string'},arguments:{type:'object'}},required:['name','arguments'],additionalProperties:false}}},required:['calls'],additionalProperties:false},
 mcp_resources_batch:{type:'object',properties:{requests:{type:'array',minItems:1,maxItems:20,items:{type:'object',properties:{server:{type:'string'},uri:{type:'string',minLength:1}},required:['server'],additionalProperties:false}}},required:['requests'],additionalProperties:false},
};
const descriptions:Record<string,string>={load_skills_batch:'Load local skill instructions by name.',inspect_extension_tools:'Inspect full schemas for named extension tools before calling them.',extension_tools_batch:'Execute plugin/MCP tools in order. Inspect their schemas first. Each call has its own result.',mcp_resources_batch:'List MCP resources (omit uri) or read resource URIs in a batch.'};
const validators=Object.fromEntries(Object.entries(schemas).map(([k,v])=>[k,ajv.compile(v)]));
async function boundedFile(file:string):Promise<string>{if((await stat(file)).size>64000)throw new Error(`Configuration or skill file exceeds 64000 bytes: ${file}`);return readFile(file,'utf8');}
async function inside(root:string,path:string):Promise<string>{const canonical=await realpath(resolve(root,path));const rel=relative(await realpath(root),canonical);if(rel==='..'||rel.startsWith('../')||rel.startsWith('..\\')||isAbsolute(rel))throw new Error('Extension path is outside the workspace');return canonical;}
export class ExtensionHost {
 private skills=new Map<string,Skill>();
 private activeSkills=new Set<string>();
 private tools=new Map<string,ExtensionTool & {validate:ValidateFunction}>();
 private handlers=new Map<string,Parameters<PluginApi['registerCommand']>[1]>();
 private hooks:Parameters<PluginApi['onTurnEnd']>[0][]=[];
 private disposers:(()=>void|Promise<void>)[]=[];
 private servers=new Map<string,McpConnection>();
 private instructions=''; private config:Config={}; private prepared=false; private preparing?:Promise<void>; private closed=false;
 private constructor(readonly workspace:string){}
 static async load(workspace:string,trusted=false):Promise<ExtensionHost>{
  const host=new ExtensionHost(workspace);if(!trusted)return host;
  try{host.config=JSON.parse(await boundedFile(await inside(workspace,'.nim/config.json')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const c=host.config;if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['plugins','mcpServers'].includes(k))||(c.plugins&&(!Array.isArray(c.plugins)||c.plugins.some(p=>typeof p!=='string')))||(c.mcpServers&&(typeof c.mcpServers!=='object'||Array.isArray(c.mcpServers))))throw new Error('Invalid .nim/config.json');
  if((c.plugins?.length??0)>20||Object.keys(c.mcpServers??{}).length>10)throw new Error('Too many extensions');
  try{host.instructions=await boundedFile(await inside(workspace,'AGENTS.md'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  let names:string[]=[];try{names=await readdir(join(workspace,'.nim','skills'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const name of names.sort().slice(0,100)){
   if(!/^[\w-]+$/.test(name))continue;
   const file=await inside(workspace,join('.nim','skills',name,'SKILL.md'));const content=await boundedFile(file);
   const description=content.match(/^description:\s*(.+)$/m)?.[1]?.slice(0,200)??name;
   host.skills.set(name,{name,description,content});
  }
  return host;
 }
 async prepare(mode:AgentMode,signal?:AbortSignal):Promise<void>{
  if(this.closed)throw new Error('Extension host is closed');
  if(mode==='plan'||this.prepared)return;
  this.preparing??=this.loadCode(signal).then(()=>{this.prepared=true;}).catch(error=>{this.preparing=undefined;throw error;});return this.preparing;
 }
 private async loadCode(signal?:AbortSignal):Promise<void>{
  try{
   const api:PluginApi={registerTool:tool=>this.register(tool),registerCommand:(name,handler)=>{if(!/^[\w-]{1,40}$/.test(name)||reserved.has(name)||this.handlers.has(name)||typeof handler!=='function')throw new Error(`Invalid or duplicate command: ${name}`);this.handlers.set(name,handler);},onTurnEnd:handler=>{if(typeof handler!=='function')throw new Error('Expected a hook function');this.hooks.push(handler);}};
   for(const path of this.config.plugins??[]){signal?.throwIfAborted();const file=await inside(this.workspace,path);if(!/\.(mjs|js)$/.test(file))throw new Error('Plugins must be local ESM .mjs/.js modules');const plugin=await import(pathToFileURL(file).href) as {default?:(api:PluginApi)=>unknown};if(typeof plugin.default!=='function')throw new Error('Plugin must default-export a setup function');const dispose=await plugin.default(api);if(typeof dispose==='function')this.disposers.push(dispose as ()=>void);}
   for(const [name,config] of Object.entries(this.config.mcpServers??{})){
    const server=await McpConnection.connect(name,config,this.workspace,signal);this.servers.set(name,server);
    for(const tool of server.tools)this.register({name:`${name}:${tool.name}`,description:tool.description??tool.name,parameters:tool.inputSchema,execute:(args,ctx)=>server.call(tool.name,args,ctx.signal)});
   }
  }catch(error){await this.reset();throw error;}
 }
 private register(tool:ExtensionTool):void{
  if(!tool||typeof tool.name!=='string'||!/^[\w:.-]{1,100}$/.test(tool.name)||this.tools.has(tool.name)||this.tools.size>=200||typeof tool.description!=='string'||typeof tool.execute!=='function'||!tool.parameters||tool.parameters.type!=='object')throw new Error('Invalid or duplicate extension tool');
  this.tools.set(tool.name,{...tool,validate:ajv.compile(tool.parameters)});
 }
 get commands():string[]{return [...this.handlers.keys()];}
 get skillNames():string[]{return [...this.skills.keys()];}
 activateSkill(name:string):void{if(!this.skills.has(name))throw new Error(`Unknown skill: ${name}`);this.activeSkills.add(name);}
 get serverNames():string[]{return [...this.servers.keys()];}
 context():string{
  const parts:string[]=[];
  if(this.instructions)parts.push(`Authorized workspace instructions (subordinate to system rules):\n${this.instructions.slice(0,8000)}`);
  if(this.skills.size)parts.push('Available skills; load only relevant ones with load_skills_batch:\n'+[...this.skills.values()].map(s=>`${s.name}: ${s.description}`).join('\n').slice(0,4000));
  for(const name of this.activeSkills)parts.push(`User-selected skill ${name} (subordinate to system rules):\n${this.skills.get(name)!.content.slice(0,8000)}`);
  if(this.tools.size)parts.push('Extension tools; inspect schemas with inspect_extension_tools, then use extension_tools_batch:\n'+[...this.tools.values()].map(t=>`${t.name}: ${t.description.slice(0,150)}`).join('\n').slice(0,8000));
  return parts.join('\n\n');
 }
 schemas(mode:AgentMode):ChatCompletionTool[]{
  const names=[...(this.skills.size?['load_skills_batch']:[]),...(mode==='build'&&this.tools.size?['inspect_extension_tools','extension_tools_batch']:[]),...(mode==='build'&&this.servers.size?['mcp_resources_batch']:[])];
  return names.map(name=>({type:'function',function:{name,description:descriptions[name]!,parameters:schemas[name]!}}));
 }
 async execute(name:string,raw:unknown,signal?:AbortSignal,mode:AgentMode='build'):Promise<ToolResult>{
  let mutated=false;
  try{
   signal?.throwIfAborted();if(mode==='plan'&&name!=='load_skills_batch')throw new Error('External operations are disabled in plan mode');
   const validate=validators[name];if(!validate||!validate(raw))throw new Error('Invalid extension arguments');
   const args=raw as {names:string[];calls:{name:string;arguments:Record<string,unknown>}[];requests:{server:string;uri?:string}[]};
   if(name==='load_skills_batch')return {ok:true,mutated:false,result:args.names.map(n=>{const skill=this.skills.get(n);if(!skill)throw new Error(`Unknown skill: ${n}`);return skill;})};
   if(name==='inspect_extension_tools')return {ok:true,mutated:false,result:args.names.map(n=>{const tool=this.tools.get(n);if(!tool)throw new Error(`Unknown extension tool: ${n}`);return {name:n,description:tool.description,parameters:tool.parameters};})};
   const operations = name==='extension_tools_batch' ? args.calls.map(call=>{const tool=this.tools.get(call.name);if(!tool||!tool.validate(call.arguments))throw new Error(`Invalid arguments or unknown tool: ${call.name}`);return ()=>tool.execute(call.arguments,{workspace:this.workspace,signal});}) : args.requests.map(req=>{const server=this.servers.get(req.server);if(!server)throw new Error(`Unknown MCP server: ${req.server}`);return ()=>server.resource(req.uri,signal);});
   const results:unknown[]=[];let ok=true;
   for(const operation of operations){signal?.throwIfAborted();mutated=true;try{results.push({ok:true,result:await operation()});}catch(error){ok=false;results.push({ok:false,error:error instanceof Error?error.message:String(error)});}}
   return {ok,mutated,result:results};
  }catch(error){return {ok:false,mutated,error:error instanceof Error?error.message:String(error)};}
 }
 async command(name:string,args:string,mode:AgentMode,signal?:AbortSignal):Promise<string>{if(mode==='plan')throw new Error('Plugin commands are disabled in plan mode');await this.prepare(mode,signal);const handler=this.handlers.get(name);if(!handler)throw new Error(`Unknown command: ${name}`);signal?.throwIfAborted();return handler(args,{workspace:this.workspace,signal});}
 async turnEnd(result:{status:string;text:string},mode:AgentMode):Promise<void>{if(mode==='build')for(const hook of this.hooks)await hook(result);}
 private async reset():Promise<void>{const errors:unknown[]=[];for(const server of this.servers.values())try{await server.close();}catch(e){errors.push(e);}this.servers.clear();for(const dispose of this.disposers.splice(0).reverse())try{await dispose();}catch(e){errors.push(e);}this.tools.clear();this.handlers.clear();this.hooks=[];this.prepared=false;if(errors.length)throw new AggregateError(errors,'Extension cleanup failed');}
 async close():Promise<void>{if(this.closed)return;this.closed=true;await this.reset();}
}

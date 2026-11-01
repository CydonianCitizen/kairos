import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { VERSION } from '../config/project.js';
export interface McpConfig { command?: string; args?: string[]; url?: string; env?: Record<string,string>; headers?: Record<string,string> }
function environment(refs: Record<string,string> = {}): Record<string,string> {
 const result:Record<string,string>={};
 for(const [key,ref] of Object.entries(refs)) {
  if(typeof ref!=='string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error('MCP secrets must reference environment variable names');
  const value=process.env[ref]; if(value===undefined)throw new Error(`Missing environment variable ${ref}`);result[key]=value;
 }
 return result;
}
export class McpConnection {
 private constructor(readonly name:string,private readonly client:Client,readonly tools:Tool[]){}
 static async connect(name:string,config:McpConfig,workspace:string,signal?:AbortSignal):Promise<McpConnection>{
  if(!/^[\w-]{1,40}$/.test(name))throw new Error('Invalid MCP server name');
  if(!config || typeof config!=='object' || Object.keys(config).some(k=>!['command','args','url','env','headers'].includes(k)) || !!config.command===!!config.url)throw new Error(`MCP ${name}: specify exactly one command or URL`);
  if(config.args && (!Array.isArray(config.args)||config.args.some(a=>typeof a!=='string')))throw new Error('Invalid MCP arguments');
  const client=new Client({name:'kairos',version:VERSION},{capabilities:{}});
  let transport;
  if(config.url){
   const url=new URL(config.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('MCP URL must be HTTP(S), without embedded credentials');
   transport=new StreamableHTTPClientTransport(url,{requestInit:{headers:environment(config.headers),redirect:'error'}});
  }else{
   if(typeof config.command!=='string'||!config.command.trim())throw new Error('Invalid MCP command');
   transport=new StdioClientTransport({command:config.command,args:config.args,cwd:workspace,env:{...getDefaultEnvironment(),...environment(config.env)},stderr:'pipe',maxBufferSize:1024*1024});
   transport.stderr?.on('data',()=>{}); // Drain child diagnostics without corrupting JSON/RPC or exposing secrets.
  }
  try{
   signal?.throwIfAborted();await client.connect(transport,{signal,timeout:15000});
   const tools=client.getServerCapabilities()?.tools ? (await client.listTools(undefined,{signal,timeout:15000})).tools : [];
   if(tools.length>100)throw new Error('MCP server exposes more than 100 tools');
   return new McpConnection(name,client,tools);
  }catch(error){await client.close().catch(()=>{});await transport.close().catch(()=>{});throw error;}
 }
 async call(name:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>{
  const result=await this.client.callTool({name,arguments:args},{signal,timeout:30000});
  if(result.isError)throw new Error(`MCP tool failed: ${JSON.stringify(result.content).slice(0,2000)}`);
  return result;
 }
 async resource(uri:string|undefined,signal?:AbortSignal):Promise<unknown>{return uri ? this.client.readResource({uri},{signal,timeout:30000}) : this.client.listResources(undefined,{signal,timeout:30000});}
 async close():Promise<void>{await this.client.close();}
}

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect,it } from 'vitest';
import { McpConnection } from '../src/extensions/mcp.js';
it('discovers and invokes a real stdio MCP server, resources and cancellation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nim-mcp-'));const file=join(root,'server.mjs');
 await writeFile(file,`import {createInterface} from 'node:readline';
 const lines=createInterface({input:process.stdin});lines.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result;
 switch(q.method){
 case 'initialize':result={protocolVersion:'2025-11-25',capabilities:{tools:{},resources:{}},serverInfo:{name:'fixture',version:'1'}};break;
 case 'tools/list':result={tools:[{name:'echo',description:'Echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};break;
 case 'tools/call':if(q.params.arguments.text==='wait')return;result={content:[{type:'text',text:q.params.arguments.text}]};break;
 case 'resources/list':result={resources:[{uri:'fixture://one',name:'One'}]};break;
 case 'resources/read':result={contents:[{uri:q.params.uri,text:'resource body'}]};break;
 default:result={};}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`);
 let server:McpConnection|undefined;
 try{
 server=await McpConnection.connect('local',{command:process.execPath,args:[file]},root);
 expect(server.tools[0]?.name).toBe('echo');expect(JSON.stringify(await server.call('echo',{text:'hello'}))).toContain('hello');
 expect(JSON.stringify(await server.resource(undefined))).toContain('fixture://one');expect(JSON.stringify(await server.resource('fixture://one'))).toContain('resource body');
 const abort=new AbortController();const waiting=server.call('echo',{text:'wait'},abort.signal);abort.abort();await expect(waiting).rejects.toThrow();
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
it('uses Streamable HTTP and resolves authentication from environment references',async()=>{
 const {createServer}=await import('node:http');const calls:{method:string;authorization:string|undefined}[]=[];
 const http=createServer((req,res)=>{if(req.method!=='POST'){res.writeHead(405).end();return;}let body='';req.on('data',c=>body+=c);req.on('end',()=>{const q=JSON.parse(body);calls.push({method:q.method,authorization:req.headers.authorization});if(q.id===undefined){res.writeHead(202).end();return;}
 const result=q.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'http-fixture',version:'1'}}:q.method==='tools/list'?{tools:[{name:'ping',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'pong'}]};
 res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));});});
 await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const address=http.address() as {port:number};process.env.NIM_TEST_MCP_AUTH='Bearer fixture-only';let connection:McpConnection|undefined;
 try{connection=await McpConnection.connect('http',{url:`http://127.0.0.1:${address.port}/mcp`,headers:{Authorization:'NIM_TEST_MCP_AUTH'}},process.cwd());expect(JSON.stringify(await connection.call('ping',{}))).toContain('pong');expect(calls.every(c=>c.authorization==='Bearer fixture-only')).toBe(true);}
 finally{await connection?.close();http.closeAllConnections();await new Promise<void>((resolve,reject)=>http.close(e=>e?reject(e):resolve()));delete process.env.NIM_TEST_MCP_AUTH;}
});

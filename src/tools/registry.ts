import { FsTools, FS_TOOL_SCHEMAS, type Edit } from './fs-tools.js';
import { GraphTools, GRAPH_TOOL_SCHEMAS } from './graph-tools.js';
import type { RepoGraph } from '../graph/repo-graph.js';
import type { ExtensionHost } from '../extensions/host.js';
import { PermissionError, PermissionGate } from '../core/permissions.js';
import type { ProjectMemory, MemoryChange } from '../core/project-memory.js';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

const BACKGROUND_SCHEMA:ChatCompletionTool={type:'function',function:{name:'background_tasks_batch',description:'List, read logs or stop supervised background shell tasks. IDs are returned by run_bash with background:true.',parameters:{type:'object',properties:{requests:{type:'array',minItems:1,maxItems:100,items:{type:'object',properties:{action:{type:'string',enum:['list','logs','stop']},ids:{type:'array',minItems:1,maxItems:100,items:{type:'string'}}},required:['action'],additionalProperties:false}}},required:['requests'],additionalProperties:false}}};
const MEMORY_SCHEMA:ChatCompletionTool={type:'function',function:{name:'memory_update_batch',description:'Propose durable project notes for explicit user preferences, corrections and confirmed conventions. Never store credentials or raw tool output. Host approval and validation apply.',parameters:{type:'object',properties:{changes:{type:'array',minItems:1,maxItems:100,items:{type:'object',properties:{action:{type:'string',enum:['add','update','remove']},id:{type:'string'},text:{type:'string'}},required:['action'],additionalProperties:false}}},required:['changes'],additionalProperties:false}}};
export interface RegistryFeatures {memory?:ProjectMemory;onRead?:(paths:string[],signal?:AbortSignal)=>Promise<void>}

const TOOL_SCHEMAS = [...FS_TOOL_SCHEMAS, ...GRAPH_TOOL_SCHEMAS,BACKGROUND_SCHEMA];
export interface ToolResult { ok: boolean; result?: unknown; error?: string; mutated: boolean; approvalRequired?: boolean; permissionDenied?: boolean }
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
function object(value: unknown, allowed: string[], required: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an argument object');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(result, key))) throw new Error('Missing or unexpected tool arguments');
  return result;
}
function text(value: unknown, nonEmpty = true): string {
  if (typeof value !== 'string' || (nonEmpty && !value.trim())) throw new Error('Expected a non-empty string');
  return value;
}
function batch(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new Error('Expected a batch of 1–100 entries');
  return value;
}

/** Validates every entry before allowing the first side effect. */
export class ToolRegistry {
  constructor(private readonly fs: FsTools, private readonly getGraph: () => RepoGraph, private readonly extensions?: ExtensionHost,
    private readonly permissions = new PermissionGate(),private readonly features:RegistryFeatures={}) {}

  schemas(mode: 'build' | 'plan') {
    const scope = this.fs.getScope();
    if (scope === 'none') return [];
    let tools = TOOL_SCHEMAS;
    if (scope === 'read-only' || mode === 'plan') {
      tools = tools.filter(t => t.type === 'function' && !['run_bash', 'apply_edits_batch', 'background_tasks_batch'].includes(t.function.name));
    }
    return [
      ...(mode === 'build' && scope !== 'read-only' ? [...tools, ...(this.features.memory ? [MEMORY_SCHEMA] : [])] : tools),
      ...(this.extensions?.schemas(scope === 'read-only' ? 'plan' : mode) ?? [])
    ];
  }

  async execute(name: string, json: string, signal?: AbortSignal, mode: 'build' | 'plan' = 'build'): Promise<ToolResult> {
    try {
      signal?.throwIfAborted();
      const scope = this.fs.getScope();
      if (scope === 'none') throw new Error(`Tool ${name} is disabled (scope: none)`);
      if (scope === 'read-only' && !['read_files_batch', 'get_repo_map', 'inspect_symbol_graph', 'load_skills_batch'].includes(name)) {
        throw new Error(`Tool ${name} is disabled in read-only scope`);
      }
      if (mode === 'plan' && !['read_files_batch', 'get_repo_map', 'inspect_symbol_graph', 'load_skills_batch'].includes(name)) throw new Error(`Tool ${name} is disabled in plan mode`);
      if (json.length > 64000) throw new Error('Tool arguments exceed 64000 characters');
      const raw: unknown = JSON.parse(json);
      switch (name) {
        case 'read_files_batch': {
          const args = object(raw, ['paths'], ['paths']);
          const paths = batch(args.paths).map(value => text(value));
          const result = await this.fs.read_files_batch(paths);
          await this.features.onRead?.(paths,signal);
          return { ok: result.every(item => item.ok), result, mutated: false };
        }
        case 'apply_edits_batch': {
          const args = object(raw, ['edits'], ['edits']);
          const edits: Edit[] = batch(args.edits).map(value => {
            const edit = object(value, ['path', 'old_text', 'new_text'], ['path', 'old_text', 'new_text']);
            return { path: text(edit.path), old_text: text(edit.old_text, false), new_text: text(edit.new_text, false) };
          });
          let result;
          const prepared = await this.fs.prepare_edits_batch(edits, signal);
          const metadata={paths:prepared.paths??edits.map(edit=>edit.path),allowOutsideWorkspace:scope==='full'};
          if (this.permissions.mode('edits',metadata) === 'ask') {
            if (prepared.preview.every(item => !item.ok)) return { ok: false, result: prepared.preview, mutated: false };
            await this.permissions.authorize('edits', name, `Edit ${new Set(edits.map(edit => edit.path)).size} file(s)`,
              prepared.preview.map(item => item.ok ? item.diff ?? item.path : `${item.path}: ${item.error}`).join('\n'), signal,metadata);
            result = await prepared.apply(signal);
          } else {
            await this.permissions.authorize('edits', name, 'Edit workspace files', '', signal,metadata);
            result = await prepared.apply(signal);
          }
          return { ok: result.every(item => item.ok), result, mutated: result.some(item => item.ok || item.mutated === true) };
        }
        case 'run_bash': {
          const args = object(raw, ['command', 'timeoutMs','background'], ['command']);
          const command = text(args.command);
          if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isInteger(args.timeoutMs) || args.timeoutMs < 1 || args.timeoutMs > 300000)) throw new Error('timeoutMs must be an integer from 1 to 300000');
          if(args.background!==undefined&&typeof args.background!=='boolean')throw new Error('background must be boolean');
          await this.permissions.authorize('shell', name, args.background?'Start a background shell task':'Run a shell command', `${command}\n\nTimeout: ${args.timeoutMs ?? 30000} ms`, signal,{command});
          if(args.background)return {ok:true,result:await this.fs.background.start(command,{timeoutMs:args.timeoutMs as number|undefined,signal}),mutated:true};
          const result = await this.fs.run_bash(command, args.timeoutMs as number | undefined, signal);
          // A command may have changed files even when it failed or was interrupted.
          return { ok: result.exitCode === 0 && !result.error && !result.timedOut && !result.aborted, result, mutated: true };
        }
        case 'background_tasks_batch':{
          const args=object(raw,['requests'],['requests']);const requests=batch(args.requests).map(value=>{const request=object(value,['action','ids'],['action']);if(!['list','logs','stop'].includes(String(request.action)))throw new Error('Unknown task action');if(request.action==='list'){if(request.ids!==undefined)throw new Error('list takes no IDs');return {action:'list' as const,ids:[]};}const ids=batch(request.ids).map(value=>text(value));this.fs.background.logs(ids);return {action:request.action as 'logs'|'stop',ids};});
          const result=[];let mutated=false;for(const request of requests){if(request.action==='list')result.push(this.fs.background.list());else if(request.action==='logs')result.push(this.fs.background.logs(request.ids));else{mutated=true;result.push(await this.fs.background.stop(request.ids));}}return {ok:true,result,mutated};
        }
        case 'memory_update_batch':{
          if(!this.features.memory)throw new Error('Project memory is disabled');const args=object(raw,['changes'],['changes']);const changes=batch(args.changes).map(value=>{const change=object(value,['action','id','text'],['action']);if(!['add','update','remove'].includes(String(change.action)))throw new Error('Invalid memory action');return {action:change.action as MemoryChange['action'],...(change.id!==undefined?{id:text(change.id)}:{}),...(change.text!==undefined?{text:text(change.text)}:{})};});
          const prepared=await this.features.memory.prepare(changes);
          await this.permissions.authorize('edits',name,'Update durable project memory',JSON.stringify(prepared.preview,null,2),signal,{paths:['.kairos/memory']});signal?.throwIfAborted();
          return {ok:true,result:await prepared.apply(signal),mutated:false};
        }
        case 'inspect_symbol_graph': {
          const args = object(raw, ['symbol_names'], ['symbol_names']);
          const names = batch(args.symbol_names).map(value => text(value));
          const result=new GraphTools(this.getGraph()).inspect_symbol_graph(names);await this.features.onRead?.(this.getGraph().inspect(names).flatMap(symbol=>symbol.matches.map(match=>match.path)),signal);return { ok: true, result, mutated: false };
        }
        case 'get_repo_map': {
          const args = object(raw, ['directory'], []);
          const directory = args.directory === undefined ? undefined : text(args.directory, false);
          return { ok: true, result: new GraphTools(this.getGraph()).get_repo_map(directory), mutated: false };
        }
        default:
          if (this.extensions?.schemas(mode).some(t => t.type === 'function' && t.function.name === name)) return this.extensions.execute(name, raw, signal, mode,
            () => {const args=raw as {calls?:{name:string}[];requests?:{server:string}[]};return this.permissions.authorize('external', name, 'Call external tools or resources', JSON.stringify(raw, null, 2), signal,{tools:args.calls?.map(call=>call.name)??args.requests?.map(request=>`${request.server}:resources`)??[name]});},
            () => this.fs.assertWritable('External operations'));
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) { return { ok: false, error: signal?.aborted ? 'Tool cancelled' : errorText(error), mutated: false,
      ...(error instanceof PermissionError ? { approvalRequired: error.code === 'approval_required', permissionDenied: error.code === 'permission_denied' } : {}) }; }
  }
}

/** Keep the transport valid JSON even when a large source/result needs truncation. */
export function serializeToolResult(result: ToolResult, maxChars = 12000): string {
  const json = JSON.stringify(result);
  if (json.length <= maxChars) return json;
  let preview = json.slice(0, Math.floor(maxChars / 2));
  let bounded = JSON.stringify({ ok: result.ok, mutated: result.mutated, truncated: true, note: 'Result truncated; request fewer files or symbols.', preview });
  while (bounded.length > maxChars && preview.length) {
    preview = preview.slice(0, Math.floor(preview.length / 2));
    bounded = JSON.stringify({ ok: result.ok, mutated: result.mutated, truncated: true, preview });
  }
  return bounded;
}

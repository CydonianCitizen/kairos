import { FsTools, FS_TOOL_SCHEMAS, type Edit } from './fs-tools.js';
import { GraphTools, GRAPH_TOOL_SCHEMAS } from './graph-tools.js';
import type { RepoGraph } from '../graph/repo-graph.js';
import type { ExtensionHost } from '../extensions/host.js';

export const TOOL_SCHEMAS = [...FS_TOOL_SCHEMAS, ...GRAPH_TOOL_SCHEMAS];
export interface ToolResult { ok: boolean; result?: unknown; error?: string; mutated: boolean }
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
  constructor(private readonly fs: FsTools, private readonly getGraph: () => RepoGraph, private readonly extensions?: ExtensionHost) {}

  schemas(mode: 'build' | 'plan') { return [...(mode === 'build' ? TOOL_SCHEMAS : TOOL_SCHEMAS.filter(t => t.type === 'function' && !['run_bash', 'apply_edits_batch'].includes(t.function.name))), ...(this.extensions?.schemas(mode) ?? [])]; }

  async execute(name: string, json: string, signal?: AbortSignal, mode: 'build' | 'plan' = 'build'): Promise<ToolResult> {
    try {
      signal?.throwIfAborted();
      if (mode === 'plan' && !['read_files_batch', 'get_repo_map', 'inspect_symbol_graph', 'load_skills_batch'].includes(name)) throw new Error(`Tool ${name} is disabled in plan mode`);
      if (json.length > 64000) throw new Error('Tool arguments exceed 64000 characters');
      const raw: unknown = JSON.parse(json);
      switch (name) {
        case 'read_files_batch': {
          const args = object(raw, ['paths'], ['paths']);
          const paths = batch(args.paths).map(value => text(value));
          const result = await this.fs.read_files_batch(paths);
          return { ok: result.every(item => item.ok), result, mutated: false };
        }
        case 'apply_edits_batch': {
          const args = object(raw, ['edits'], ['edits']);
          const edits: Edit[] = batch(args.edits).map(value => {
            const edit = object(value, ['path', 'old_text', 'new_text'], ['path', 'old_text', 'new_text']);
            return { path: text(edit.path), old_text: text(edit.old_text, false), new_text: text(edit.new_text, false) };
          });
          const result = await this.fs.apply_edits_batch(edits, signal);
          return { ok: result.every(item => item.ok), result, mutated: result.some(item => item.ok) };
        }
        case 'run_bash': {
          const args = object(raw, ['command', 'timeoutMs'], ['command']);
          const command = text(args.command);
          if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isInteger(args.timeoutMs) || args.timeoutMs < 1 || args.timeoutMs > 300000)) throw new Error('timeoutMs must be an integer from 1 to 300000');
          const result = await this.fs.run_bash(command, args.timeoutMs as number | undefined, signal);
          // A command may have changed files even when it failed or was interrupted.
          return { ok: result.exitCode === 0 && !result.error && !result.timedOut && !result.aborted, result, mutated: true };
        }
        case 'inspect_symbol_graph': {
          const args = object(raw, ['symbol_names'], ['symbol_names']);
          const names = batch(args.symbol_names).map(value => text(value));
          return { ok: true, result: new GraphTools(this.getGraph()).inspect_symbol_graph(names), mutated: false };
        }
        case 'get_repo_map': {
          const args = object(raw, ['directory'], []);
          const directory = args.directory === undefined ? undefined : text(args.directory, false);
          return { ok: true, result: new GraphTools(this.getGraph()).get_repo_map(directory), mutated: false };
        }
        default:
          if (this.extensions?.schemas(mode).some(t => t.type === 'function' && t.function.name === name)) return this.extensions.execute(name, raw, signal, mode);
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) { return { ok: false, error: signal?.aborted ? 'Tool cancelled' : errorText(error), mutated: false }; }
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

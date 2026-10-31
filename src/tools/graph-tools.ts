import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { RepoGraph } from '../graph/repo-graph.js';

export const GRAPH_TOOL_SCHEMAS: ChatCompletionTool[] = [
  { type: 'function', function: { name: 'inspect_symbol_graph', description: 'Inspect exact symbol sources, locations, candidate callees and file dependents from the local AST snapshot. Qualify duplicates as path:qualifiedName. Empty targets mean unresolved calls.', parameters: {
    type: 'object', properties: { symbol_names: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1 } } }, required: ['symbol_names'], additionalProperties: false,
  } } },
  { type: 'function', function: { name: 'get_repo_map', description: 'Return a compact local repository map with paths, line numbers, signatures and imports. Optionally filter by a relative directory.', parameters: {
    type: 'object', properties: { directory: { type: 'string' } }, additionalProperties: false,
  } } },
];
export class GraphTools {
  constructor(readonly repo: RepoGraph) {}
  inspect_symbol_graph(symbol_names: string[]): ReturnType<RepoGraph['inspect']> {
    if (!Array.isArray(symbol_names) || symbol_names.length < 1 || symbol_names.length > 100 || symbol_names.some(name => typeof name !== 'string' || !name.trim())) throw new Error('Expected 1–100 non-empty symbol names');
    return this.repo.inspect(symbol_names);
  }
  get_repo_map(directory?: string): string {
    if (directory !== undefined && typeof directory !== 'string') throw new Error('directory must be a string');
    return this.repo.getRepoMap(directory);
  }
}

import { MultiDirectedGraph } from 'graphology';
import { posix } from 'node:path';

export interface CallReference { name: string; line: number }
export interface SymbolRecord {
  id: string; name: string; qualifiedName: string; path: string; kind: string;
  startLine: number; endLine: number; signature: string; source: string; exported: boolean;
  calls: CallReference[];
}
export interface ImportRecord { module: string; bindings: { local: string; imported: string }[]; line: number }
export interface FileRecord { path: string; language: string; symbols: SymbolRecord[]; imports: ImportRecord[]; exports: string[]; mtimeMs?: number; size?: number }
export interface Diagnostic { path: string; kind: 'parse' | 'read' | 'size'; message: string }
export interface SymbolLocation { id: string; name: string; path: string; startLine: number }
export interface InspectedSymbol extends Omit<SymbolRecord, 'calls'> {
  calls: (CallReference & { targets: SymbolLocation[] })[];
  dependents: string[];
}
interface NodeAttributes { kind: 'file' | 'symbol'; path: string; symbol?: SymbolRecord }
interface EdgeAttributes { kind: 'contains' | 'imports' | 'calls' }
const location = (s: SymbolRecord): SymbolLocation => ({ id: s.id, name: s.name, path: s.path, startLine: s.startLine });
const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.py', '.rs', '.go'];

/** A snapshot: rebuild and swap it after edits. No model or network access. */
export class RepoGraph {
  readonly graph = new MultiDirectedGraph<NodeAttributes, EdgeAttributes>();
  readonly diagnostics: Diagnostic[] = [];
  private readonly files = new Map<string, FileRecord>();
  private readonly symbols = new Map<string, SymbolRecord>();
  private readonly dependencies = new Map<string, Set<string>>();
  private readonly resolvedCalls = new Map<string, InspectedSymbol['calls']>();

  constructor(readonly root: string, private readonly goModule?: string) {}
  get stats(): { files: number; symbols: number; edges: number } {
    return { files: this.files.size, symbols: this.symbols.size, edges: this.graph.size };
  }
  getFile(path: string): FileRecord | undefined { return this.files.get(path); }
  getFileDiagnostics(path: string): Diagnostic[] { return this.diagnostics.filter(d => d.path === path); }

  addFile(file: FileRecord): void {
    if (this.files.has(file.path)) throw new Error(`Duplicate file: ${file.path}`);
    this.files.set(file.path, file);
    this.graph.addNode(`file:${file.path}`, { kind: 'file', path: file.path });
    for (const symbol of file.symbols) {
      this.symbols.set(symbol.id, symbol);
      this.graph.addNode(symbol.id, { kind: 'symbol', path: file.path, symbol });
      this.graph.addDirectedEdge(`file:${file.path}`, symbol.id, { kind: 'contains' });
    }
  }

  private resolveModule(file: FileRecord, module: string): string[] {
    const base = posix.dirname(file.path);
    let stem: string | undefined;
    if (file.language === 'python') {
      const dots = module.match(/^\.+/)?.[0].length ?? 0;
      stem = dots ? posix.join(base, ...Array(Math.max(0, dots - 1)).fill('..'), module.slice(dots).replaceAll('.', '/')) : module.replaceAll('.', '/');
    } else if (file.language === 'rust') {
      if (module.startsWith('crate::')) stem = posix.join(this.files.has('src/lib.rs') || this.files.has('src/main.rs') ? 'src' : '.', module.slice(7).replaceAll('::', '/'));
      else if (module.startsWith('self::')) stem = posix.join(base, module.slice(6).replaceAll('::', '/'));
      else if (module.startsWith('super::')) stem = posix.join(base, '..', module.slice(7).replaceAll('::', '/'));
      else return [];
    } else if (file.language === 'go') {
      if (!this.goModule || !module.startsWith(`${this.goModule}/`)) return [];
      const dir = module.slice(this.goModule.length + 1);
      return [...this.files.keys()].filter(path => posix.dirname(path) === dir && path.endsWith('.go'));
    } else if (module.startsWith('.')) stem = posix.normalize(posix.join(base, module));
    if (stem === undefined || stem.startsWith('../')) return [];
    const candidates = [stem];
    // NodeNext source imports conventionally use .js even when the source is .ts.
    if (/\.[cm]?js$/.test(stem)) candidates.push(stem.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts'), stem.replace(/\.js$/, '.tsx'));
    for (const ext of extensions) candidates.push(stem + ext, posix.join(stem, `index${ext}`));
    candidates.push(posix.join(stem, '__init__.py'), posix.join(stem, 'mod.rs'));
    const target = candidates.find(path => this.files.has(path));
    return target ? [target] : [];
  }

  link(): void {
    for (const edge of this.graph.edges()) if (this.graph.getEdgeAttribute(edge, 'kind') !== 'contains') this.graph.dropEdge(edge);
    this.dependencies.clear(); this.resolvedCalls.clear();
    for (const file of this.files.values()) {
      const imports = file.imports.map(item => ({ ...item, paths: this.resolveModule(file, item.module) }));
      const bindings = imports.flatMap(item => item.bindings.map(b => ({ ...b, paths: item.paths })));
      for (const item of imports) for (const path of item.paths) {
        const reverse = this.dependencies.get(path) ?? new Set<string>();
        reverse.add(file.path); this.dependencies.set(path, reverse);
        this.graph.addDirectedEdge(`file:${file.path}`, `file:${path}`, { kind: 'imports' });
      }
      for (const symbol of file.symbols) {
        const calls = symbol.calls.map(call => {
          let targets: SymbolRecord[] = [];
          const binding = bindings.find(b => call.name === b.local || (b.imported === '*' && (call.name.startsWith(`${b.local}.`) || call.name.startsWith(`${b.local}::`))));
          if (binding) {
            const imported = binding.imported === '*' ? call.name.slice(binding.local.length).replace(/^(\.|::)/, '') : binding.imported;
            targets = binding.paths.flatMap(path => {
              const targetFile = this.files.get(path)!;
              const localName = targetFile.exports.find(name => name.startsWith(`${imported}:`))?.slice(imported.length + 1) ?? imported;
              return targetFile.symbols.filter(s => s.name === localName || s.qualifiedName === localName);
            });
          } else if (!/[.:]/.test(call.name)) {
            targets = file.symbols.filter(s => s.name === call.name);
          } else if (/^(this|self)\./.test(call.name)) {
            const owner = symbol.qualifiedName.split('.').slice(0, -1).join('.');
            targets = file.symbols.filter(s => s.qualifiedName === `${owner}.${call.name.split('.').at(-1)}`);
          }
          for (const target of targets) this.graph.addDirectedEdge(symbol.id, target.id, { kind: 'calls' });
          return { ...call, targets: targets.map(location) };
        });
        this.resolvedCalls.set(symbol.id, calls);
      }
    }
  }

  inspect(names: string[]): { name: string; matches: InspectedSymbol[] }[] {
    return names.map(name => ({ name, matches: [...this.symbols.values()]
      .filter(s => s.name === name || s.qualifiedName === name || `${s.path}:${s.qualifiedName}` === name)
      .map(s => ({ ...s, calls: this.resolvedCalls.get(s.id) ?? [], dependents: [...(this.dependencies.get(s.path) ?? [])].sort() })) }));
  }

  search(query: string, limit = 20): SymbolLocation[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1–100');
    const terms = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length) return [];
    return [...this.symbols.values()].map(s => ({ s, score: terms.reduce((score, term) => score + (s.name.toLowerCase() === term ? 10 : s.name.toLowerCase().includes(term) ? 5 : `${s.path} ${s.signature}`.toLowerCase().includes(term) ? 1 : 0), 0) }))
      .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id)).slice(0, limit).map(item => location(item.s));
  }

  getRepoMap(directory?: string, maxChars = 12000): string {
    if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('maxChars must be positive');
    let dir = directory?.replaceAll('\\', '/') ?? '';
    if (dir.startsWith('/') || /^[A-Za-z]:/.test(dir) || dir.split('/').includes('..')) throw new Error('Expected a relative workspace directory');
    dir = posix.normalize(dir).replace(/\/$/, '');
    const lines = [`Repo Skeleton Map | ${this.stats.files} files | ${this.stats.symbols} symbols`];
    for (const file of this.files.values()) {
      if (dir && dir !== '.' && !file.path.startsWith(`${dir}/`)) continue;
      lines.push(`${file.path} [${file.language}]`);
      for (const s of file.symbols) lines.push(`  ${s.path}:${s.startLine} ${s.signature.replace(/\s+/g, ' ')}`);
      for (const item of file.imports) lines.push(`  imports ${item.module}`);
      if (file.exports.length) lines.push(`  exports ${file.exports.join(', ')}`);
    }
    const output = lines.join('\n');
    const suffix = '\n[truncated]';
    return output.length <= maxChars ? output : maxChars <= suffix.length ? suffix.slice(0, maxChars) : output.slice(0, maxChars - suffix.length) + suffix;
  }
}

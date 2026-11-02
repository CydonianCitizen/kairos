import { readFile, realpath, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, relative, isAbsolute, posix } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import fg from 'fast-glob';
import ignore from 'ignore';
import { Parser, Language, type Node } from 'web-tree-sitter';
import { RepoGraph, type FileRecord, type ImportRecord, type SymbolRecord } from './repo-graph.js';
import { ignored, type IgnoreScope } from '../tools/search-tools.js';

const require = createRequire(import.meta.url);
const languages: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp', '.hh': 'cpp', '.cxx': 'cpp', '.hxx': 'cpp',
  '.java': 'java',
  '.cs': 'c_sharp',
};
const excluded = ['**/.git/**', '**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/target/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**'];
let initialized: Promise<void> | undefined;
const grammarCache = new Map<string, Promise<Language>>();
async function grammar(name: string): Promise<Language> {
  initialized ??= Parser.init();
  await initialized;
  let value = grammarCache.get(name);
  if (!value) { value = Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`)); grammarCache.set(name, value); }
  return value;
}
const declarations = new Set([
  'function_declaration', 'generator_function_declaration', 'function_definition',
  'function_item', 'method_definition', 'method_declaration', 'method_signature',
  'function_signature_item', 'class_declaration', 'abstract_class_declaration',
  'class_definition', 'interface_declaration', 'struct_item', 'enum_item',
  'trait_item', 'type_alias_declaration', 'type_item', 'type_spec',
  'struct_specifier', 'class_specifier', 'enum_specifier', 'enum_declaration',
  'record_declaration', 'constructor_declaration'
]);
const callTypes = new Set(['call_expression', 'call', 'macro_invocation', 'method_invocation']);
const importTypes = new Set([
  'import_statement', 'import_from_statement', 'export_statement',
  'use_declaration', 'import_spec', 'mod_item',
  'preproc_include', 'import_declaration', 'using_directive'
]);
const unquote = (text: string): string => text.replace(/^["'`]|["'`]$/g, '');

function declaratorName(node: Node | null): string | undefined {
  if (!node) return undefined;
  if (['identifier', 'field_identifier', 'type_identifier', 'destructor_name'].includes(node.type)) return node.text;
  if (node.type === 'scoped_identifier') {
    const name = node.childForFieldName('name');
    return name ? name.text : node.text;
  }
  const childDecl = node.childForFieldName('declarator');
  if (childDecl) return declaratorName(childDecl);
  for (const child of node.namedChildren.filter((c): c is Node => c !== null)) {
    const found = declaratorName(child);
    if (found) return found;
  }
  return undefined;
}

function symbolName(node: Node): string | undefined {
  if (declarations.has(node.type)) {
    const directName = node.childForFieldName('name')?.text;
    if (directName) return directName;
    const declarator = node.childForFieldName('declarator');
    if (declarator) return declaratorName(declarator);
  }
  if (node.type === 'variable_declarator') {
    const value = node.childForFieldName('value');
    if (value && ['arrow_function', 'function_expression', 'generator_function'].includes(value.type)) return node.childForFieldName('name')?.text;
  }
  return undefined;
}
function importsFrom(node: Node, language: string): ImportRecord[] {
  const line = node.startPosition.row + 1;
  if (['typescript', 'tsx', 'javascript'].includes(language)) {
    const source = node.childForFieldName('source');
    if (!source) return [];
    const bindings: ImportRecord['bindings'] = [];
    const walk = (n: Node): void => {
      if (n.type === 'import_specifier') {
        const imported = n.childForFieldName('name')?.text;
        if (imported) bindings.push({ imported, local: n.childForFieldName('alias')?.text ?? imported });
      } else if (n.type === 'namespace_import') {
        const local = n.namedChildren.filter((child): child is Node => child !== null).at(-1)?.text;
        if (local) bindings.push({ local, imported: '*' });
      } else if (n.type === 'import_clause') {
        const local = n.namedChildren.filter((child): child is Node => child !== null).find(c => c.type === 'identifier')?.text;
        if (local) bindings.push({ local, imported: 'default' });
      }
      for (const child of n.namedChildren.filter((child): child is Node => child !== null)) walk(child);
    };
    walk(node);
    return [{ module: unquote(source.text), bindings, line }];
  }
  if (language === 'python') {
    if (node.type === 'import_from_statement') {
      const module = node.childForFieldName('module_name')?.text;
      if (!module) return [];
      const bindings = node.childrenForFieldName('name').filter((child): child is Node => child !== null).map(n => ({ imported: n.type === 'aliased_import' ? n.childForFieldName('name')!.text : n.text, local: n.childForFieldName('alias')?.text ?? n.text }));
      return [{ module, bindings, line }];
    }
    if (node.type === 'import_statement') return node.namedChildren.filter((child): child is Node => child !== null).map(n => {
      const module = n.type === 'aliased_import' ? n.childForFieldName('name')!.text : n.text;
      return { module, bindings: [{ local: n.childForFieldName('alias')?.text ?? module, imported: '*' }], line };
    });
  }
  if (language === 'go' && node.type === 'import_spec') {
    const path = node.childForFieldName('path');
    if (!path) return [];
    const module = unquote(path.text);
    return [{ module, bindings: [{ local: node.childForFieldName('name')?.text ?? module.split('/').at(-1)!, imported: '*' }], line }];
  }
  if (language === 'rust') {
    if (node.type === 'mod_item' && !node.childForFieldName('body')) return [{ module: `self::${node.childForFieldName('name')?.text}`, bindings: [], line }];
    // Basic scoped use paths; grouped/glob use remains an unresolved reference.
    const text = node.text.replace(/^(pub\s+)?use\s+/, '').replace(/;$/, '');
    const match = text.match(/^(.*)::([A-Za-z_][\w]*)(?:\s+as\s+(\w+))?$/);
    if (match) return [{ module: match[1]!, bindings: [{ local: match[3] ?? match[2]!, imported: match[2]! }], line }];
    return [{ module: text, bindings: [], line }];
  }
  if (['c', 'cpp'].includes(language) && node.type === 'preproc_include') {
    const pathNode = node.childForFieldName('path');
    if (!pathNode) return [];
    const raw = pathNode.text.replace(/^[<"']|[>"']$/g, '');
    const base = raw.split('/').at(-1)!.replace(/\.[^/.]+$/, '');
    return [{ module: raw, bindings: [{ local: base, imported: '*' }], line }];
  }
  if (language === 'java' && node.type === 'import_declaration') {
    const children = node.namedChildren.filter((c): c is Node => c !== null);
    const scoped = children.find(c => c.type === 'scoped_identifier');
    if (!scoped) return [];
    const full = scoped.text;
    const isAsterisk = children.some(c => c.type === 'asterisk');
    if (isAsterisk) {
      return [{ module: full, bindings: [{ local: full.split('.').at(-1)!, imported: '*' }], line }];
    } else {
      const lastDot = full.lastIndexOf('.');
      const pkg = lastDot > 0 ? full.slice(0, lastDot) : full;
      const name = lastDot > 0 ? full.slice(lastDot + 1) : full;
      return [{ module: pkg, bindings: [{ local: name, imported: name }], line }];
    }
  }
  if (language === 'c_sharp' && node.type === 'using_directive') {
    const children = node.namedChildren.filter((c): c is Node => c !== null);
    const nameNode = children.find(c => ['identifier', 'qualified_name'].includes(c.type));
    if (!nameNode) return [];
    return [{ module: nameNode.text, bindings: [{ local: nameNode.text.split('.').at(-1)!, imported: '*' }], line }];
  }
  return [];
}

function extract(root: Node, path: string, language: string): FileRecord {
  const file: FileRecord = { path, language, symbols: [], imports: [], exports: [] };
  const stack: { node: Node; scope: string[]; owner?: SymbolRecord }[] = [{ node: root, scope: [] }];
  while (stack.length) {
    const { node, scope, owner } = stack.pop()!;
    let current = owner;
    let childScope = scope;
    const name = symbolName(node);
    if (name) {
      const value = node.type === 'variable_declarator' ? node.childForFieldName('value') : node;
      const body = value?.childForFieldName('body');
      const exported = node.parent?.type === 'export_statement' || node.parent?.parent?.type === 'export_statement' || node.text.startsWith('pub ') || (language === 'go' && /^[A-Z]/.test(name)) || (language === 'python' && !name.startsWith('_')) || (['c', 'cpp'].includes(language) && !node.text.startsWith('static ')) || (['java', 'c_sharp'].includes(language) && (node.text.startsWith('public ') || node.text.includes('public ')));
      const qualifiedName = [...scope, name].join('.');
      current = { id: `symbol:${path}:${node.startIndex}:${qualifiedName}`, path, name, qualifiedName, kind: node.type, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1,
        source: node.text, signature: (body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text).trim().replace(/\s+/g, ' '), exported, calls: [] };
      file.symbols.push(current); childScope = [...scope, name];
      if (exported) file.exports.push(name);
      if (node.parent?.type === 'export_statement' && /^export\s+default\b/.test(node.parent.text)) file.exports.push(`default:${name}`);
    }
    if (importTypes.has(node.type)) file.imports.push(...importsFrom(node, language));
    if (node.type === 'export_statement' && node.childForFieldName('source')) file.exports.push(node.text);
    if (node.type === 'export_specifier') {
      const local = node.childForFieldName('name')?.text;
      const alias = node.childForFieldName('alias')?.text;
      if (local) file.exports.push(alias ? `${alias}:${local}` : local);
    }
    if (current && callTypes.has(node.type)) {
      const callee = node.childForFieldName('function') ?? node.childForFieldName('macro') ?? node.childForFieldName('name');
      if (callee) current.calls.push({ name: callee.text, line: node.startPosition.row + 1 });
    }
    for (const child of [...node.namedChildren.filter((child): child is Node => child !== null)].reverse()) stack.push({ node: child, scope: childScope, owner: current });
  }
  for (const symbol of file.symbols) {
    if (file.exports.some(name => name === symbol.name || name.endsWith(`:${symbol.name}`))) symbol.exported = true;
  }
  file.exports = [...new Set(file.exports)];
  return file;
}

export interface IndexOptions {
  maxFileBytes?: number;
  signal?: AbortSignal;
  onProgress?: (stats: { files: number; symbols: number }) => void;
  previous?: RepoGraph;
}
export async function indexWorkspace(workspace: string, options: IndexOptions = {}): Promise<RepoGraph> {
  options.signal?.throwIfAborted();
  const root = await realpath(workspace);
  const maxBytes = options.maxFileBytes ?? 1024 * 1024;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('maxFileBytes must be positive');
  const globOptions = { cwd: root, dot: true, onlyFiles: true, followSymbolicLinks: false, ignore: excluded };
  const safe = async (path: string): Promise<boolean> => {
    const absolute = join(root, path);
    if ((await lstat(absolute)).isSymbolicLink()) return false;
    const rel = relative(root, await realpath(absolute));
    return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel);
  };
  const scopes: IgnoreScope[] = [];
  const ignoreFiles = (await fg('**/.gitignore', globOptions)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const path of ignoreFiles) {
    options.signal?.throwIfAborted();
    if (ignored(path, scopes) || !await safe(path)) continue;
    const directory = posix.dirname(path);
    scopes.push({ directory: directory === '.' ? '' : directory, rules: ignore().add(await readFile(join(root, path), 'utf8')) });
  }
  let goModule: string | undefined;
  try { if (await safe('go.mod')) goModule = (await readFile(join(root, 'go.mod'), 'utf8')).match(/^module\s+(\S+)/m)?.[1]; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const graph = new RepoGraph(root, goModule);
  const paths = (await fg('**/*', globOptions)).filter(path => languages[extname(path)] && !ignored(path, scopes)).sort();
  const parsers = new Map<string, Parser>();
  const previous = options.previous?.root === root ? options.previous : undefined;
  try {
    for (const path of paths) {
      options.signal?.throwIfAborted();
      const language = languages[extname(path)]!;
      try {
        if (!await safe(path)) continue;
        const info = await lstat(join(root, path));
        if (info.size > maxBytes) { graph.diagnostics.push({ path, kind: 'size', message: `File exceeds ${maxBytes} bytes` }); continue; }
        const cached = previous?.getFile(path);
        if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
          graph.addFile(cached);
          for (const d of previous!.getFileDiagnostics(path)) graph.diagnostics.push(d);
          options.onProgress?.(graph.stats);
          await setImmediate();
          continue;
        }
        let parser = parsers.get(language);
        if (!parser) { const loaded = await grammar(language); parser = new Parser(); parser.setLanguage(loaded); parsers.set(language, parser); }
        const source = await readFile(join(root, path), 'utf8');
        const tree = parser.parse(source);
        if (!tree) throw new Error('Parser returned no tree');
        try {
          if (tree.rootNode.hasError) graph.diagnostics.push({ path, kind: 'parse', message: 'Syntax errors: extracted symbols may be incomplete' });
          const fileRecord = extract(tree.rootNode, path, language);
          fileRecord.mtimeMs = info.mtimeMs;
          fileRecord.size = info.size;
          graph.addFile(fileRecord);
        } finally { tree.delete(); }
      } catch (error) { graph.diagnostics.push({ path, kind: 'read', message: error instanceof Error ? error.message : String(error) }); }
      options.onProgress?.(graph.stats);
      await setImmediate();
    }
  } finally { for (const parser of parsers.values()) parser.delete(); }
  graph.link();
  options.signal?.throwIfAborted();
  return graph;
}

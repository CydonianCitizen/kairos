import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { indexWorkspace } from '../src/graph/indexer.js';
import { GraphTools } from '../src/tools/graph-tools.js';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'nim-graph-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function file(path: string, source: string) { const target = join(root, path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, source); }
it('indexes five languages with exact source and one-based lines', async () => {
  await file('a.ts', '// Unicode: è 😀\nexport function greet(name: string): string { return name; }\nexport interface User { name: string }\nexport const arrow = (n: number) => n + 1;');
  await file('b.js', 'export class Greeter { hello() { return "hi"; } }');
  await file('c.py', 'class Person:\n    def greet(self, name):\n        return name\n');
  await file('d.rs', 'pub struct User { name: String }\npub fn greet(name: &str) -> &str { name }');
  await file('e.go', 'package main\ntype User struct { Name string }\nfunc Greet(name string) string { return name }');
  const graph = await indexWorkspace(root);
  expect(graph.stats.files).toBe(5);
  expect(graph.diagnostics).toEqual([]);
  const tools = new GraphTools(graph);
  const results = tools.inspect_symbol_graph(['greet', 'User', 'arrow', 'hello', 'Greet']);
  const ts = results[0]!.matches.find(s => s.path === 'a.ts')!;
  expect(ts.startLine).toBe(2);
  expect(ts.source).toBe('function greet(name: string): string { return name; }');
  expect(ts.signature).toBe('function greet(name: string): string');
  expect(results.every(r => r.matches.length > 0)).toBe(true);
  expect(graph.search('greet').length).toBeGreaterThanOrEqual(3);
});
it('resolves JS extension imports, aliases, calls and reverse dependencies without conflating duplicates', async () => {
  await file('src/math.ts', 'export function sum(a: number, b: number) { return a + b; }');
  await file('src/other.ts', 'export function sum() { return 0; }');
  await file('src/main.ts', "import { sum as add } from './math.js';\nexport function run() { return add(1, 2); }");
  const graph = await indexWorkspace(root);
  const tools = new GraphTools(graph);
  const run = tools.inspect_symbol_graph(['run'])[0]!.matches[0]!;
  expect(run.calls[0]).toMatchObject({ name: 'add', targets: [expect.objectContaining({ path: 'src/math.ts', name: 'sum' })] });
  const sums = tools.inspect_symbol_graph(['sum'])[0]!.matches;
  expect(sums).toHaveLength(2);
  expect(sums.find(s => s.path === 'src/math.ts')!.dependents).toEqual(['src/main.ts']);
  expect(tools.get_repo_map('src')).toContain('src/main.ts:2');
  expect(tools.get_repo_map('elsewhere')).not.toContain('run');
});
it('honors nested ignores, default exclusions, and removes deleted symbols on reindex', async () => {
  await file('.gitignore', '*.secret.ts\nignored/\n');
  await file('src/.gitignore', '*.ts\n!keep.ts');
  for (const path of ['a.ts', 'src/keep.ts', 'src/drop.ts', 'hidden.secret.ts', 'ignored/a.ts', 'node_modules/a.ts', 'dist/a.ts']) await file(path, 'function old() {}');
  const graph = await indexWorkspace(root);
  expect(graph.stats.files).toBe(2);
  await file('a.ts', 'function fresh() {}');
  await rm(join(root, 'src/keep.ts'));
  const updated = await indexWorkspace(root);
  expect(updated.stats.files).toBe(1);
  expect(updated.inspect(['old'])[0]!.matches).toEqual([]);
  expect(updated.inspect(['fresh'])[0]!.matches).toHaveLength(1);
});
it('reports parse errors, bounds output, and validates batch and directory parameters', async () => {
  await file('broken.ts', 'function incomplete( {');
  const graph = await indexWorkspace(root);
  expect(graph.diagnostics.some(d => d.kind === 'parse')).toBe(true);
  const tools = new GraphTools(graph);
  expect(() => tools.inspect_symbol_graph([])).toThrow();
  expect(() => tools.get_repo_map('../')).toThrow();
  expect(graph.getRepoMap(undefined, 50).length).toBeLessThanOrEqual(50);
});
it('resolves local Python, Rust and Go imports without inventing external dependencies', async () => {
  await file('pkg/math.py', 'def sum(a, b):\n    return a + b\n');
  await file('pkg/main.py', 'from .math import sum as add\ndef run():\n    return add(1, 2)\n');
  await file('src/math.rs', 'pub fn sum(a: i32, b: i32) -> i32 { a + b }');
  await file('src/main.rs', 'use crate::math::sum as add;\nfn run() -> i32 { add(1, 2) }');
  await file('go.mod', 'module example.com/demo\n');
  await file('calc/math.go', 'package calc\nfunc Sum(a int, b int) int { return a + b }');
  await file('main.go', 'package main\nimport c "example.com/demo/calc"\nfunc Run() int { return c.Sum(1, 2) }');
  const graph = await indexWorkspace(root);
  expect(graph.diagnostics).toEqual([]);
  const python = graph.inspect(['pkg/main.py:run'])[0]!.matches[0]!;
  const rust = graph.inspect(['src/main.rs:run'])[0]!.matches[0]!;
  const go = graph.inspect(['main.go:Run'])[0]!.matches[0]!;
  expect(python.calls[0]!.targets[0]?.path).toBe('pkg/math.py');
  expect(rust.calls[0]!.targets[0]?.path).toBe('src/math.rs');
  expect(go.calls[0]!.targets[0]?.path).toBe('calc/math.go');
});
it('handles TSX, default imports, exports and unresolved external calls', async () => {
  await file('view.tsx', 'export default function View() { return <div>Hello</div>; }');
  await file('main.ts', "import Render from './view.js';\nfunction run() { external(); return Render(); }\nexport { run };");
  const graph = await indexWorkspace(root);
  const calls = graph.inspect(['run'])[0]!.matches[0]!.calls;
  expect(calls.find(c => c.name === 'external')!.targets).toEqual([]);
  expect(calls.find(c => c.name === 'Render')!.targets[0]?.name).toBe('View');
  expect(graph.getRepoMap()).toContain('exports run');
});
it('excludes symlinks, refuses re-including an ignored parent, supports cancellation and size limits', async () => {
  const { symlink } = await import('node:fs/promises');
  await file('kept.ts', 'function kept() {}');
  await file('.gitignore', 'ignored/');
  await file('ignored/.gitignore', '!a.ts');
  await file('ignored/a.ts', 'function secret() {}');
  await symlink(join(root, 'ignored'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  expect((await indexWorkspace(root)).stats.files).toBe(1);
  const limited = await indexWorkspace(root, { maxFileBytes: 1 });
  expect(limited.stats.files).toBe(0);
  expect(limited.diagnostics[0]?.kind).toBe('size');
  const abort = new AbortController(); abort.abort();
  await expect(indexWorkspace(root, { signal: abort.signal })).rejects.toThrow();
});
it('leaves imported object methods unresolved and normalizes ./ directory filters', async () => {
  await file('src/service.ts', 'export class Service { run() {} }');
  await file('src/main.ts', "import { Service } from './service.js'; function main() { Service.run(); }");
  const graph = await indexWorkspace(root);
  expect(graph.inspect(['main'])[0]!.matches[0]!.calls[0]!.targets).toEqual([]);
  expect(graph.getRepoMap('./src/')).toBe(graph.getRepoMap('src'));
});
it('reuses cached file records and diagnostics incrementally when previous graph is provided', async () => {
  await file('src/a.ts', 'export function alpha() { return 1; }');
  await file('src/b.ts', 'export function beta() { return 2; }');
  await file('src/broken.ts', 'function broken( {');

  const initial = await indexWorkspace(root);
  expect(initial.stats.files).toBe(3);
  expect(initial.getFile('src/a.ts')?.mtimeMs).toBeTypeOf('number');
  expect(initial.getFile('src/a.ts')?.size).toBeTypeOf('number');
  expect(initial.diagnostics.some(d => d.path === 'src/broken.ts' && d.kind === 'parse')).toBe(true);

  // 1. Unchanged workspace with previous: reuses exact FileRecord objects and diagnostics
  const unchanged = await indexWorkspace(root, { previous: initial });
  expect(unchanged.stats.files).toBe(3);
  expect(unchanged.getFile('src/a.ts')).toBe(initial.getFile('src/a.ts'));
  expect(unchanged.getFile('src/b.ts')).toBe(initial.getFile('src/b.ts'));
  expect(unchanged.getFile('src/broken.ts')).toBe(initial.getFile('src/broken.ts'));
  expect(unchanged.diagnostics.some(d => d.path === 'src/broken.ts' && d.kind === 'parse')).toBe(true);

  // 2. Modify one file: only that file is re-parsed, others stay cached
  await file('src/a.ts', 'export function alphaUpdated() { return 42; }');
  const afterEdit = await indexWorkspace(root, { previous: unchanged });
  expect(afterEdit.stats.files).toBe(3);
  expect(afterEdit.getFile('src/a.ts')).not.toBe(unchanged.getFile('src/a.ts'));
  expect(afterEdit.getFile('src/b.ts')).toBe(unchanged.getFile('src/b.ts'));
  expect(afterEdit.getFile('src/broken.ts')).toBe(unchanged.getFile('src/broken.ts'));
  expect(afterEdit.inspect(['alphaUpdated'])[0]!.matches).toHaveLength(1);
  expect(afterEdit.inspect(['alpha'])[0]!.matches).toHaveLength(0);

  // 3. Delete a file: removed from new graph while remaining cached files stay cached
  await rm(join(root, 'src/broken.ts'));
  const afterDelete = await indexWorkspace(root, { previous: afterEdit });
  expect(afterDelete.stats.files).toBe(2);
  expect(afterDelete.getFile('src/broken.ts')).toBeUndefined();
  expect(afterDelete.getFile('src/b.ts')).toBe(afterEdit.getFile('src/b.ts'));
  expect(afterDelete.diagnostics.some(d => d.path === 'src/broken.ts')).toBe(false);

  // 4. Cross-workspace safety: previous with different root is ignored
  const otherRoot = await mkdtemp(join(tmpdir(), 'nim-graph-other-'));
  try {
    const freshInOther = await indexWorkspace(root, { previous: new (initial.constructor as any)(otherRoot) });
    expect(freshInOther.getFile('src/b.ts')).not.toBe(afterDelete.getFile('src/b.ts'));
  } finally {
    await rm(otherRoot, { recursive: true, force: true });
  }
});
it('indexes C, C++ and Java with symbols, includes, packages and cross-file calls', async () => {
  // C files
  await file('include/math.h', 'struct Vector { int x; int y; };\nint add(int a, int b);');
  await file('src/math.c', '#include "math.h"\nint add(int a, int b) { return a + b; }');

  // C++ files
  await file('include/service.hpp', 'class Service {\npublic:\n  void execute();\n};');
  await file('src/service.cpp', '#include "service.hpp"\nvoid Service::execute() {}');

  // Java files
  await file('src/com/example/util/Calculator.java', 'package com.example.util;\npublic class Calculator {\n  public int multiply(int a, int b) { return a * b; }\n}');
  await file('src/com/example/app/Main.java', 'package com.example.app;\nimport com.example.util.Calculator;\npublic class Main {\n  public void run() {\n    Calculator calc = new Calculator();\n    calc.multiply(2, 3);\n  }\n}');

  const graph = await indexWorkspace(root);
  expect(graph.stats.files).toBe(6);
  expect(graph.diagnostics).toEqual([]);

  const tools = new GraphTools(graph);

  // Inspect C symbols and dependencies
  const cInspect = tools.inspect_symbol_graph(['add', 'Vector']);
  const addFn = cInspect.find(s => s.name === 'add')?.matches.find(m => m.path === 'src/math.c');
  expect(addFn).toBeDefined();
  expect(addFn?.signature).toContain('int add(int a, int b)');
  expect(cInspect.find(s => s.name === 'Vector')?.matches).toHaveLength(1);

  // Inspect C++ symbols
  const cppInspect = tools.inspect_symbol_graph(['Service', 'execute']);
  expect(cppInspect.find(s => s.name === 'Service')?.matches).toHaveLength(1);
  const execFn = cppInspect.find(s => s.name === 'execute')?.matches.find(m => m.path === 'src/service.cpp');
  expect(execFn).toBeDefined();

  // Inspect Java symbols, packages and calls
  const javaInspect = tools.inspect_symbol_graph(['multiply', 'Main']);
  const multMethod = javaInspect.find(s => s.name === 'multiply')?.matches.find(m => m.path === 'src/com/example/util/Calculator.java');
  expect(multMethod).toBeDefined();
  expect(multMethod?.signature).toContain('public int multiply(int a, int b)');

  const mainInspect = tools.inspect_symbol_graph(['run'])[0]!.matches[0]!;
  expect(mainInspect.calls.some(c => c.name === 'multiply')).toBe(true);
});

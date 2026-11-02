import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsTools } from '../src/tools/fs-tools.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { RepoGraph } from '../src/graph/repo-graph.js';

describe('Local Zero-API Search Tools (find_files & search_text)', () => {
  let root: string;
  let fsTools: FsTools;
  let registry: ToolRegistry;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kairos-search-test-'));
    fsTools = new FsTools(root);
    registry = new ToolRegistry(fsTools, () => new RepoGraph(root));
  });

  afterEach(async () => {
    await fsTools.close();
    await rm(root, { recursive: true, force: true });
  });

  async function createFile(relPath: string, content: string | Buffer) {
    const full = join(root, relPath);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }

  describe('find_files', () => {
    it('finds files matching glob patterns and respects .gitignore', async () => {
      await createFile('src/index.ts', 'console.log("hello");');
      await createFile('src/utils/math.ts', 'export const add = (a: number, b: number) => a + b;');
      await createFile('package.json', '{"name": "test"}');
      await createFile('README.md', '# Readme');
      await createFile('secret.key', 'topsecret');
      await createFile('.gitignore', '*.key\nignored_dir/\n');
      await createFile('ignored_dir/data.ts', 'export const x = 1;');
      await createFile('node_modules/dep/index.js', 'module.exports = {};');

      const allTs = await fsTools.find_files({ pattern: '**/*.ts' });
      expect(allTs.files).toEqual(['src/index.ts', 'src/utils/math.ts']);
      expect(allTs.totalMatches).toBe(2);
      expect(allTs.truncated).toBe(false);

      // Multiple patterns
      const mixed = await fsTools.find_files({ patterns: ['**/*.md', '**/*.json'] });
      expect(mixed.files).toEqual(['README.md', 'package.json']);

      // Scoped directory
      const insideUtils = await fsTools.find_files({ directory: 'src/utils' });
      expect(insideUtils.files).toEqual(['src/utils/math.ts']);
    });

    it('enforces limit and signals truncation', async () => {
      for (let i = 0; i < 10; i++) {
        await createFile(`file${i}.txt`, `content ${i}`);
      }
      const limited = await fsTools.find_files({ pattern: '*.txt', limit: 3 });
      expect(limited.files).toHaveLength(3);
      expect(limited.totalMatches).toBe(10);
      expect(limited.truncated).toBe(true);
    });

    it('rejects path traversal outside workspace', async () => {
      await expect(fsTools.find_files({ directory: '../' })).rejects.toThrow(/Directory must be relative/);
    });
  });

  describe('search_text', () => {
    it('searches literal text across files with line numbers', async () => {
      await createFile('src/app.ts', 'const API_KEY = "xyz";\nconst port = 3000;\nconsole.log(API_KEY);');
      await createFile('src/config.json', '{\n  "apiKey": "xyz"\n}');
      await createFile('docs/notes.md', 'Remember to set API_KEY in env.');

      const result = await fsTools.search_text({ query: 'API_KEY' });
      expect(result.totalMatches).toBe(3);
      expect(result.matches).toEqual([
        { path: 'docs/notes.md', line: 1, text: 'Remember to set API_KEY in env.' },
        { path: 'src/app.ts', line: 1, text: 'const API_KEY = "xyz";' },
        { path: 'src/app.ts', line: 3, text: 'console.log(API_KEY);' },
      ]);
    });

    it('supports case sensitivity and regular expressions', async () => {
      await createFile('src/main.ts', 'const Alpha = 1;\nconst alpha = 2;\nconst ALPHABET = 3;');

      const caseSensitive = await fsTools.search_text({ query: 'Alpha', caseSensitive: true });
      expect(caseSensitive.matches).toHaveLength(1);
      expect(caseSensitive.matches[0]?.text).toBe('const Alpha = 1;');

      const regexResult = await fsTools.search_text({ query: 'alpha\\s*=\\s*\\d+', isRegex: true });
      expect(regexResult.matches).toHaveLength(2); // Alpha = 1, alpha = 2
    });

    it('restricts search with filePattern and skips binary files', async () => {
      await createFile('src/code.ts', 'FIND_ME');
      await createFile('src/style.css', '/* FIND_ME */');
      await createFile('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x46, 0x49, 0x4e, 0x44, 0x5f, 0x4d, 0x45]));
      await createFile('binary.dat', Buffer.from([0x00, 0x46, 0x49, 0x4e, 0x44, 0x5f, 0x4d, 0x45]));

      const tsOnly = await fsTools.search_text({ query: 'FIND_ME', filePattern: '*.ts' });
      expect(tsOnly.matches).toHaveLength(1);
      expect(tsOnly.matches[0]?.path).toBe('src/code.ts');

      const all = await fsTools.search_text({ query: 'FIND_ME' });
      expect(all.matches.map(m => m.path)).toEqual(['src/code.ts', 'src/style.css']);
    });

    it('enforces limit and truncates search_text early', async () => {
      for (let i = 0; i < 10; i++) {
        await createFile(`src/file${i}.ts`, `const MATCH_TARGET = ${i};`);
      }
      const limited = await fsTools.search_text({ query: 'MATCH_TARGET', limit: 3 });
      expect(limited.matches).toHaveLength(3);
      expect(limited.truncated).toBe(true);
      expect(limited.totalMatches).toBeGreaterThanOrEqual(4);
    });
  });

  describe('ToolRegistry integration', () => {
    it('executes find_files and search_text via registry', async () => {
      await createFile('src/hello.ts', 'export function hello() { return "world"; }');

      const findResult = await registry.execute('find_files', JSON.stringify({ pattern: '**/*.ts' }));
      expect(findResult.ok).toBe(true);
      expect(findResult.mutated).toBe(false);
      expect((findResult.result as any).files).toContain('src/hello.ts');

      const searchResult = await registry.execute('search_text', JSON.stringify({ query: 'world' }));
      expect(searchResult.ok).toBe(true);
      expect(searchResult.mutated).toBe(false);
      expect((searchResult.result as any).matches[0]?.text).toContain('return "world";');
    });

    it('allows find_files and search_text in read-only scope and plan mode', async () => {
      fsTools.setScope('read-only');
      await createFile('src/plan.ts', 'const plan = true;');

      const inReadOnly = await registry.execute('find_files', JSON.stringify({ pattern: '*.ts' }));
      expect(inReadOnly.ok).toBe(true);

      const inPlanMode = await registry.execute('search_text', JSON.stringify({ query: 'plan' }), undefined, 'plan');
      expect(inPlanMode.ok).toBe(true);
    });

    it('blocks find_files and search_text when scope is none', async () => {
      fsTools.setScope('none');
      const res = await registry.execute('find_files', JSON.stringify({ pattern: '*.ts' }));
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/scope: none/);
    });
  });
});

import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { indexWorkspace } from '../../dist/graph/indexer.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cache = join(root, 'node_modules/.cache/kairos-tests');
await mkdir(cache, { recursive: true });
const synthetic = await mkdtemp(join(cache, 'graph-benchmark-'));
const addition = join(root, 'tests/fixtures', `graph-benchmark-change-${randomUUID()}.ts`);
const source = index => `${index ? `import { value0 as previous } from './file${index - 1}.js';\n` : ''}` +
  Array.from({ length: 10 }, (_, symbol) => `export function value${symbol}(input: number): number { return ${symbol ? `value${symbol - 1}(input)` : index ? 'previous(input)' : 'input'} + ${index}; }`).join('\n');
const measurements = [];
async function measure(workspace, label) {
  const started = performance.now();
  const graph = await indexWorkspace(workspace);
  measurements.push({ label, milliseconds: Number((performance.now() - started).toFixed(1)), ...graph.stats, diagnostics: graph.diagnostics.length });
}
try {
  await measure(root, 'repo: first index (grammar cold)');
  for (let run = 1; run <= 3; run++) await measure(root, `repo: unchanged ${run}`);
  await writeFile(addition, 'export function benchmarkAddition() { return 1; }\n', { flag: 'wx' });
  await measure(root, 'repo: one file added');
  await unlink(addition);
  for (let index = 0; index < 500; index++) await writeFile(join(synthetic, `file${index}.ts`), source(index));
  await measure(synthetic, 'synthetic 500: first index (grammar warm)');
  for (let run = 1; run <= 3; run++) await measure(synthetic, `synthetic 500: unchanged ${run}`);
  await writeFile(join(synthetic, 'file0.ts'), source(0).replace('return input + 0', 'return input + 1'));
  await measure(synthetic, 'synthetic 500: one file changed');
  process.stdout.write(JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version,
    os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, measurements }, null, 2) + '\n');
} finally {
  await unlink(addition).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const target = resolve(synthetic);
  if (!target.startsWith(resolve(cache) + sep + 'graph-benchmark-')) throw new Error('Unexpected benchmark cleanup directory');
  await rm(target, { recursive: true, force: true });
}

import { expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli-options.js';

it('accepts explicit settings and bounded model checks without requiring a prompt', () => {
  expect(parseCliArgs(['--model', 'custom/model', '--effort', 'auto', '--system-prompt', 'rules.md', '--timeout-ms', '60000'])).toMatchObject({
    model: 'custom/model', effort: 'auto', systemPromptFile: 'rules.md', timeoutMs: 60000,
  });
  expect(parseCliArgs(['--check-models', '--json'])).toMatchObject({ checkModels: true, json: true });
  expect(parseCliArgs(['--permissions', 'deny'])).toMatchObject({ permissions: 'deny' });
  expect(parseCliArgs([])).toMatchObject({ checkModels: false, effort: undefined, timeoutMs: undefined, systemPromptFile: undefined });
});

it.each([
  ['--effort', 'extreme'], ['--timeout-ms', '0'], ['--timeout-ms', '2147483648'],
  ['--check-models', '--rpc'], ['--check-models', '--prompt', 'hi'],
  ['--check-models', '--continue'], ['--check-models', '--list-sessions'],
  ['--check-models', '--effort', 'high'], ['--check-models', '--system-prompt', 'rules.md'],
  ['--permissions', 'sometimes'],
])('rejects invalid settings or conflicting model-check flags: %j', (...args) => {
  expect(() => parseCliArgs(args)).toThrow();
});

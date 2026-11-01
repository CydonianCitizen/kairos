import { expect, it } from 'vitest';
import { PermissionGate, type PermissionRules } from '../src/core/permissions.js';

it('combines overlapping edit policies and every path before approving a batch', async () => {
  const gate = new PermissionGate({ edits: 'ask', rules: [
    { kind: 'edits', mode: 'allow', pattern: 'src/**' },
    { kind: 'edits', mode: 'ask', pattern: 'src/critical/**' },
    { kind: 'edits', mode: 'deny', pattern: '**/secrets.*' },
  ] });
  expect(gate.mode('edits', { paths: ['src/index.ts'] })).toBe('allow');
  expect(gate.mode('edits', { paths: ['src/index.ts', 'README.md'] })).toBe('ask');
  expect(gate.mode('edits', { paths: ['src/critical/main.ts'] })).toBe('ask');
  expect(gate.mode('edits', { paths: ['src/index.ts', 'src/secrets.json'] })).toBe('deny');
  await expect(gate.authorize('edits', 'apply_edits_batch', 'Edit files', '', undefined,
    { paths: ['src/index.ts', 'src/secrets.json'] })).rejects.toMatchObject({ code: 'permission_denied' });
});

it('normalizes Windows edit paths without broadening single-segment wildcards or traversal', () => {
  const gate = new PermissionGate({ edits: 'ask', rules: [
    { kind: 'edits', mode: 'allow', pattern: '.\\src\\*.ts' },
    { kind: 'edits', mode: 'deny', pattern: 'private/**' },
  ] });
  expect(gate.mode('edits', { paths: ['.\\src\\main.ts'] })).toBe('allow');
  expect(gate.mode('edits', { paths: ['src/deep/main.ts'] })).toBe('ask');
  expect(gate.mode('edits', { paths: ['private\\key.txt'] })).toBe('deny');
  expect(gate.mode('edits', { paths: ['src/../private/key.txt'] })).toBe('deny');
  expect(gate.mode('edits', { paths: ['C:\\outside\\main.ts'] })).toBe('deny');
});

it.skipIf(process.platform !== 'win32')('matches Windows edit patterns and targets without case-sensitive deny bypasses', () => {
  const denied = new PermissionGate({ edits: 'allow', rules: [{ kind: 'edits', mode: 'deny', pattern: '**/*.env' }] });
  expect(denied.mode('edits', { paths: ['private/SECRET.ENV'] })).toBe('deny');
  const allowed = new PermissionGate({ edits: 'ask', rules: [{ kind: 'edits', mode: 'allow', pattern: 'SRC/*.TS' }] });
  expect(allowed.mode('edits', { paths: ['src/main.ts'] })).toBe('allow');
});

it.skipIf(process.platform === 'win32')('keeps edit rule paths case-sensitive outside Windows', () => {
  const gate = new PermissionGate({ edits: 'allow', rules: [{ kind: 'edits', mode: 'deny', pattern: '**/*.env' }] });
  expect(gate.mode('edits', { paths: ['private/SECRET.ENV'] })).toBe('allow');
  expect(gate.mode('edits', { paths: ['private/secret.env'] })).toBe('deny');
});

it('keeps category deny final and leaves metadata-free legacy calls unchanged', () => {
  const gate = new PermissionGate({ shell: 'deny', edits: 'ask', rules: [
    { kind: 'shell', mode: 'allow', pattern: '*' },
    { kind: 'edits', mode: 'allow', pattern: '**' },
  ] });
  expect(gate.mode('shell', { command: 'npm test' })).toBe('deny');
  expect(gate.mode('edits')).toBe('ask');
  expect(gate.isAllowed('edits', { paths: ['src/main.ts'] })).toBe(true);
});

it('matches complete shell commands, preserving arguments and command separators', () => {
  const gate = new PermissionGate({ shell: 'ask', rules: [
    { kind: 'shell', mode: 'allow', pattern: 'npm test' },
    { kind: 'shell', mode: 'deny', pattern: '*private*' },
  ] });
  expect(gate.mode('shell', { command: 'npm test' })).toBe('allow');
  for (const command of ['npm test --watch', 'npm test; echo danger', 'npm test && echo danger', 'npm test\necho danger', 'npm test\r\necho danger', 'npm test | echo danger', 'npm test$(echo danger)']) {
    expect(gate.mode('shell', { command })).toBe('ask');
  }
  expect(gate.mode('shell', { command: 'echo private' })).toBe('deny');
  const wildcard = new PermissionGate({ shell: 'ask', rules: [{ kind: 'shell', mode: 'allow', pattern: 'npm run test:*' }] });
  expect(wildcard.mode('shell', { command: 'npm run test:unit' })).toBe('allow');
  expect(wildcard.mode('shell', { command: 'prefix npm run test:unit' })).toBe('ask');
});

it.each([
  'npm run test:unit; echo danger',
  'npm run test:unit & echo danger',
  'npm run test:unit && echo danger',
  'npm run test:unit | echo danger',
  'npm run test:unit || echo danger',
  'npm run test:unit > output.txt',
  'npm run test:unit < input.txt',
  'npm run test:unit `echo danger`',
  'npm run test:unit $(echo danger)',
  'npm run test:unit ${COMMAND}',
  'npm run test:unit $COMMAND',
  'npm run test:unit\necho danger',
  'npm run test:unit\r\necho danger',
  'npm run test:unit\recho danger',
])('requires approval when a partial shell allow glob would span shell syntax (%s)', async command => {
  const gate = new PermissionGate({ shell: 'ask', rules: [{ kind: 'shell', mode: 'allow', pattern: 'npm run test:*' }] });
  expect(gate.mode('shell', { command })).toBe('ask');
  await expect(gate.authorize('shell', 'run_bash', 'Run command', command, undefined, { command }))
    .rejects.toMatchObject({ code: 'approval_required' });
});

it('allows plain shell glob arguments and explicit complete command policies', () => {
  const partial = new PermissionGate({ shell: 'ask', rules: [{ kind: 'shell', mode: 'allow', pattern: 'npm test *' }] });
  expect(partial.mode('shell', { command: 'npm test -- --runInBand' })).toBe('allow');
  const exact = new PermissionGate({ shell: 'ask', rules: [{ kind: 'shell', mode: 'allow', pattern: 'npm test; echo done' }] });
  expect(exact.mode('shell', { command: 'npm test; echo done' })).toBe('allow');
  const unrestricted = new PermissionGate({ shell: 'ask', rules: [{ kind: 'shell', mode: 'allow', pattern: '*' }] });
  expect(unrestricted.mode('shell', { command: 'npm test; echo $RESULT\necho done > output.txt' })).toBe('allow');
});

it('keeps shell deny and ask glob rules broad across compound commands', () => {
  const denied = new PermissionGate({ shell: 'allow', rules: [{ kind: 'shell', mode: 'deny', pattern: 'npm test *' }] });
  expect(denied.mode('shell', { command: 'npm test --unit; echo danger' })).toBe('deny');
  const asking = new PermissionGate({ shell: 'allow', rules: [{ kind: 'shell', mode: 'ask', pattern: 'npm test *' }] });
  expect(asking.mode('shell', { command: 'npm test --unit; echo danger' })).toBe('ask');
});

it('checks each external tool and matches qualified names without prefix matching', () => {
  const gate = new PermissionGate({ external: 'ask', rules: [
    { kind: 'external', mode: 'allow', pattern: 'github:*' },
    { kind: 'external', mode: 'allow', pattern: 'format' },
    { kind: 'external', mode: 'deny', pattern: 'github:delete*' },
  ] });
  expect(gate.mode('external', { tools: ['github:read', 'format'] })).toBe('allow');
  expect(gate.mode('external', { tools: ['github:read', 'slack:send'] })).toBe('ask');
  expect(gate.mode('external', { tools: ['github:read', 'github:delete_issue'] })).toBe('deny');
  expect(gate.mode('external', { tools: ['formatter'] })).toBe('ask');
});

it('does not let callers mutate a previously validated host policy', () => {
  const policy: PermissionRules = { shell: 'ask', rules: [{ kind: 'shell', mode: 'deny', pattern: 'rm *' }] };
  const gate = new PermissionGate(policy);
  policy.rules![0]!.mode = 'allow';
  policy.shell = 'allow';
  expect(gate.mode('shell', { command: 'rm file' })).toBe('deny');
  expect(gate.mode('shell', { command: 'echo safe' })).toBe('ask');
});

it.each([
  { rules: null }, { rules: {} }, { rules: Array(1) },
  { rules: [{ kind: 'edits', mode: 'allow', pattern: 'src/**', extra: true }] },
  { rules: [{ kind: 'edits', mode: 'allow' }] },
  { rules: [{ kind: 'read', mode: 'allow', pattern: '*' }] },
  { rules: [{ kind: 'shell', mode: 'sometimes', pattern: '*' }] },
  { rules: [{ kind: 'edits', mode: 'allow', pattern: '../outside/**' }] },
  { rules: [{ kind: 'edits', mode: 'allow', pattern: '/outside/**' }] },
  { rules: [{ kind: 'edits', mode: 'allow', pattern: 'src/[abc' }] },
  { rules: [{ kind: 'external', mode: 'allow', pattern: 'server:tool\nsecret' }] },
  { rules: [{ kind: 'shell', mode: 'allow', pattern: '' }] },
  { rules: [{ kind: 'shell', mode: 'allow', pattern: 'x'.repeat(513) }] },
  { rules: Array.from({ length: 129 }, () => ({ kind: 'shell', mode: 'allow', pattern: '*' })) },
])('rejects malformed, ambiguous or unbounded granular policy (%j)', value => {
  expect(() => new PermissionGate(value as PermissionRules)).toThrow(/permission/i);
});

it('fails closed for invalid target metadata even with permissive defaults', () => {
  const gate = new PermissionGate({ rules: [{ kind: 'edits', mode: 'allow', pattern: '**' }] });
  expect(gate.mode('edits', { paths: ['../outside'] })).toBe('deny');
  expect(gate.mode('external', { tools: ['server:tool\nother'] })).toBe('deny');
  expect(gate.mode('shell', { command: 'echo\0secret' })).toBe('deny');
});

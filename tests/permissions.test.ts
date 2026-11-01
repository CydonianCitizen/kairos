import { expect, it } from 'vitest';
import { PermissionGate } from '../src/core/permissions.js';

it('enforces deny and requires an approval handler for ask', async () => {
  const denied = new PermissionGate({ shell: 'deny' });
  await expect(denied.authorize('shell', 'run_bash', 'Run command', 'echo test')).rejects.toMatchObject({ code: 'permission_denied' });
  const asking = new PermissionGate({ edits: 'ask' });
  await expect(asking.authorize('edits', 'apply_edits_batch', 'Edit files', '-before\n+after')).rejects.toMatchObject({ code: 'approval_required' });
});

it('waits for an explicit decision and delivers the concrete preview', async () => {
  let decide: (allowed: boolean) => void = () => {};
  let preview = '';
  const gate = new PermissionGate({ edits: 'ask' }, async request => {
    preview = request.preview;
    return new Promise<boolean>(resolve => { decide = resolve; });
  });
  let finished = false;
  const work = gate.authorize('edits', 'apply_edits_batch', 'Change a.ts', '-before\n+after').then(() => { finished = true; });
  await Promise.resolve();
  expect(preview).toContain('+after');
  expect(finished).toBe(false);
  decide(true);
  await work;
  expect(finished).toBe(true);
});

it('cancels a pending approval even when the host callback ignores its signal', async () => {
  const abort = new AbortController();
  const gate = new PermissionGate({ external: 'ask' }, async () => new Promise<boolean>(() => {}));
  const work = gate.authorize('external', 'extension_tools_batch', 'External call', '{}', abort.signal);
  abort.abort();
  await expect(work).rejects.toThrow();
});

it('preserves allow for low-level callers and rejects an explicitly denied decision', async () => {
  await expect(new PermissionGate().authorize('edits', 'apply_edits_batch', 'Edit', '')).resolves.toBeUndefined();
  await expect(new PermissionGate({ edits: 'ask' }, async () => false).authorize('edits', 'apply_edits_batch', 'Edit', '')).rejects.toMatchObject({ code: 'permission_denied' });
});

import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentLoop } from '../src/core/agent-loop.js';
import type { CompletionInput } from '../src/core/nim-client.js';
import { FsTools } from '../src/tools/fs-tools.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'kairos-host-')) throw new Error('Unexpected fixture');
  await rm(root, { recursive: true, force: true });
} });
async function workspace() { const root = await mkdtemp(join(tmpdir(), 'kairos-host-')); roots.push(root); await writeFile(join(root, 'a.ts'), 'export const SOME_REFERENCE = 42;'); return root; }
const answer = () => ({ ok: true as const, value: [{ id: 'x', object: 'chat.completion.chunk' as const, created: 0, model: 'test', choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' as const }] }] });
class Client extends EventEmitter {
  requests: CompletionInput[] = [];
  constructor(private edit = false) { super(); }
  async stream(input: CompletionInput) {
    this.requests.push(input);
    if (!this.edit || this.requests.length > 1) return answer();
    return { ok: true as const, value: [{ id: 'x', object: 'chat.completion.chunk' as const, created: 0, model: 'test', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'edit', type: 'function' as const, function: { name: 'apply_edits_batch', arguments: JSON.stringify({ edits: [{ path: 'a.ts', old_text: '42', new_text: '43' }] }) } }] }, finish_reason: 'tool_calls' as const }] }] };
  }
}

it('stops after a noninteractive approval requirement without making another model request', async () => {
  const root = await workspace(), client = new Client(true);
  const agent = new AgentLoop({ workspace: root, client, session: false, permissions: { edits: 'ask' } });
  try {
    expect(await agent.run('Change the constant')).toMatchObject({ status: 'error', iterations: 1, error: expect.stringMatching(/Approval required/) });
    expect(client.requests).toHaveLength(1);
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toContain('42');
    expect(agent.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'edit' });
  } finally { await agent.close(); }
});

it('previews edits and undo through the same policy and restores without model calls', async () => {
  const root = await workspace(), client = new Client(true); const previews: string[] = [];
  const agent = new AgentLoop({ workspace: root, client, session: false, undoDirectory: join(root, 'undo'), permissions: { edits: 'ask' }, approve: async request => { previews.push(request.preview); return true; } });
  try {
    expect((await agent.run('Change the constant')).status).toBe('completed');
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toContain('43');
    expect((await agent.undoLast()).every(file => file.ok)).toBe(true);
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toContain('42');
    expect(previews).toHaveLength(2); expect(previews[0]).toContain('+export const SOME_REFERENCE = 43;');
    expect(client.requests).toHaveLength(2);
  } finally { await agent.close(); }
});

it('injects only current explicit reference snapshots and reports their budget', async () => {
  const root = await workspace(), client = new Client();
  const agent = new AgentLoop({ workspace: root, client, session: false });
  try {
    expect((await agent.run('Explain @file:a.ts')).status).toBe('completed');
    expect(JSON.stringify(client.requests[0]!.messages)).toContain('SOME_REFERENCE = 42');
    expect(agent.contextSnapshot.references).toHaveLength(1);
    expect(agent.contextSnapshot.chars).toBeGreaterThan(0);
    expect((await agent.run('Another question')).status).toBe('completed');
    expect(JSON.stringify(client.requests[1]!.messages)).not.toContain('SOME_REFERENCE = 42');
    expect(agent.contextSnapshot.chars).toBe(0);
  } finally { await agent.close(); }
});

it('rejects missing references before inference and reports manual model selections', async () => {
  const root = await workspace(), client = new Client(); const selected: string[] = [];
  const agent = new AgentLoop({ workspace: root, client, session: false });
  agent.on('onModelSelected', model => selected.push(model));
  try {
    expect((await agent.run('Explain @file:missing.ts')).status).toBe('error');
    expect(client.requests).toHaveLength(0);
    agent.setModel('custom/chosen');
    expect(selected).toEqual(['custom/chosen']);
  } finally { await agent.close(); }
});

it('refreshes the graph after a failed edit that may already have changed a file', async () => {
  const root = await workspace(), client = new Client(true);
  await writeFile(join(root, 'a.ts'), 'export function value() { return 42; }');
  const apply = vi.spyOn(FsTools.prototype, 'apply_edits_batch').mockImplementationOnce(async () => {
    await writeFile(join(root, 'a.ts'), 'export function value() { return 43; }');
    return [{ path: 'a.ts', ok: false, mutated: true, error: 'Post-write snapshot failed' }];
  });
  const agent = new AgentLoop({ workspace: root, client, session: false });
  try {
    expect((await agent.run('Change the value')).status).toBe('completed');
    expect(agent.graphSnapshot!.inspect(['value'])[0]!.matches[0]!.source).toContain('return 43');
    const tool = client.requests[1]!.messages.find(message => message.role === 'tool')!;
    expect(JSON.parse(tool.content as string)).toMatchObject({ mutated: true });
  } finally { apply.mockRestore(); await agent.close(); }
});

it.each(['Inspect (@file:missing.ts)', 'Inspect `@file:missing.ts`'])('rejects wrapped missing steering references before the next inference: %s', async steering => {
  const root = await workspace(), client = new Client(true);
  const agent = new AgentLoop({ workspace: root, client, session: false, permissions: { edits: 'deny' } });
  agent.once('onToolEnd', () => agent.steer(steering));
  try {
    expect((await agent.run('Inspect the project')).status).toBe('error');
    expect(client.requests).toHaveLength(1);
  } finally { await agent.close(); }
});

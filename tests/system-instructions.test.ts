import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { AgentLoop } from '../src/core/agent-loop.js';
import type { CompletionInput, NimResult } from '../src/core/nim-client.js';
import { SessionStore } from '../src/core/session-store.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'kairos-instructions-')); });
afterEach(async () => {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'kairos-instructions-')) throw new Error('Unexpected test directory');
  await rm(root, { recursive: true, force: true });
});
class Client extends EventEmitter {
  requests: CompletionInput[] = [];
  async stream(input: CompletionInput): Promise<NimResult<ChatCompletionChunk[]>> {
    this.requests.push(structuredClone(input));
    return { ok: true, value: [{ id: 'r', object: 'chat.completion.chunk', created: 0, model: 'test',
      choices: [{ index: 0, delta: { content: 'Verified' }, finish_reason: 'stop' }] }] };
  }
}

it('retains the core rules and additional instructions after compaction, clear and session restart', async () => {
  const client = new Client();
  const agent = new AgentLoop({ workspace: root, client, systemPrompt: 'Use Italian for explanations.', session: { directory: join(root, 'sessions') } });
  let id: string | undefined;
  try {
    expect((await agent.run('First request')).status).toBe('completed');
    expect((await agent.run('Second request')).status).toBe('completed');
    expect(await agent.compactContext({ strategy: 'local' })).toBeGreaterThan(0);
    agent.setMode('plan');
    expect((await agent.run('Inspect after compaction')).status).toBe('completed');
    agent.clear();
    expect((await agent.run('Inspect after clear')).status).toBe('completed');
    id = agent.sessionId;
  } finally { await agent.close(); }
  const resumed = new AgentLoop({ workspace: root, client, systemPrompt: 'Use Italian for explanations.', session: { directory: join(root, 'sessions'), id } });
  try { expect((await resumed.run('Inspect after restart')).status).toBe('completed'); }
  finally { await resumed.close(); }
  expect(client.requests).toHaveLength(5);
  for (const request of client.requests) {
    const system = request.messages[0];
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('Use Italian for explanations.');
    expect(system?.content).toContain('Batch related reads with read_files_batch');
    expect(system?.content).toContain('The host controls pacing and retries');
  }
  expect(client.requests[2]!.messages[0]!.content).toContain('PLAN MODE');
  expect(client.requests[4]!.messages[0]!.content).toContain('PLAN MODE');
});

it('applies an initial effort, persists it and restores it without an explicit override', async () => {
  const client = new Client();
  const agent = new AgentLoop({ workspace: root, client, effort: 'high', session: { directory: join(root, 'sessions') } });
  let id: string | undefined;
  try { await agent.run('First request'); id = agent.sessionId; expect(agent.effort).toBe('high'); }
  finally { await agent.close(); }
  const resumed = new AgentLoop({ workspace: root, client, session: { directory: join(root, 'sessions'), id } });
  try { await resumed.run('Second request'); expect(resumed.effort).toBe('high'); }
  finally { await resumed.close(); }
  expect(client.requests.map(request => request.effort)).toEqual(['high', 'high']);
});

it('validates explicit resumed effort against the saved model and preserves explicit auto', async () => {
  const directory = join(root, 'sessions');
  const store = await SessionStore.create(directory, root, { model: 'minimaxai/minimax-m3.1-flash', effort: 'high', mode: 'build', messages: [], memory: '' });
  const id = store.id; await store.close();
  const client = new Client();
  for (const effort of ['max', 'auto'] as const) {
    const agent = new AgentLoop({ workspace: root, client, effort, session: { directory, id } });
    try { await agent.run('Use chosen effort'); expect(agent.model).toBe('minimaxai/minimax-m3.1-flash'); expect(agent.effort).toBe(effort); }
    finally { await agent.close(); }
  }
  expect(client.requests.map(request => request.effort)).toEqual(['max', 'auto']);
});

it('rejects unsupported explicit effort and releases a resumed session after failed validation', async () => {
  const directory = join(root, 'sessions');
  const store = await SessionStore.create(directory, root, { model: 'custom/model', mode: 'build', messages: [], memory: '' });
  const id = store.id; await store.close();
  const client = new Client();
  expect(() => new AgentLoop({ workspace: root, client, effort: 'max' })).toThrow(/Effort/);
  const agent = new AgentLoop({ workspace: root, client, effort: 'high', session: { directory, id } });
  try { await expect(agent.initialize()).rejects.toThrow(/Effort/); }
  finally { await agent.close(); }
  const reopened = await SessionStore.open(directory, id, root);
  await reopened.close();
  expect(client.requests).toHaveLength(0);
});

it('resets incompatible saved effort when an explicit model override is resumed', async () => {
  const directory = join(root, 'sessions');
  const store = await SessionStore.create(directory, root, { model: 'minimaxai/minimax-m3.1-flash', effort: 'max', mode: 'build', messages: [], memory: '' });
  const id = store.id; await store.close();
  const client = new Client();
  const agent = new AgentLoop({ workspace: root, client, model: 'custom/model', session: { directory, id } });
  try {
    expect((await agent.run('Use selected model')).status).toBe('completed');
    expect(client.requests[0]).toMatchObject({ model: 'custom/model', effort: 'auto' });
  } finally { await agent.close(); }
});

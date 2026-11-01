import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, expect, it } from 'vitest';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { CompletionInput, NimResult } from '../src/core/nim-client.js';
import { AgentLoop } from '../src/core/agent-loop.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'nim-loop-')); await writeFile(join(root, 'calc.ts'), 'export function add(a: number, b: number) { return a + b; }'); });
afterEach(async () => { await rm(root, { force: true, recursive: true }); });
function chunk(delta: any, finish: 'stop' | 'tool_calls' | 'length' | null = null): ChatCompletionChunk {
  return { id: 'r', object: 'chat.completion.chunk', created: 0, model: 'test', choices: [{ index: 0, delta, finish_reason: finish }] };
}
function calls(items: { id: string; name: string; args: unknown }[]): ChatCompletionChunk[] {
  // Arguments are deliberately split across SSE chunks.
  return [chunk({ tool_calls: items.map((item, index) => ({ index, id: item.id, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.args).slice(0, 4) } })) }),
    chunk({ tool_calls: items.map((item, index) => ({ index, function: { arguments: JSON.stringify(item.args).slice(4) } })) }, 'tool_calls')];
}
class FakeClient extends EventEmitter {
  requests: CompletionInput[] = [];
  constructor(private responses: ChatCompletionChunk[][]) { super(); }
  async stream(input: CompletionInput): Promise<NimResult<ChatCompletionChunk[]>> {
    this.requests.push(structuredClone(input));
    const value = this.responses.shift();
    if (!value) return { ok: false, error: 'Simulated NIM failure', status: 429 };
    for (const c of value) if (c.choices[0]?.delta.content) this.emit('onTokenStream', c.choices[0].delta.content);
    return { ok: true, value };
  }
}
it('injects symbol signatures, assembles split tool calls and returns a final response', async () => {
  const client = new FakeClient([calls([{ id: 'inspect', name: 'inspect_symbol_graph', args: { symbol_names: ['add'] } }]), [chunk({ content: 'Found add.' }, 'stop')]]);
  const agent = new AgentLoop({ workspace: root, client });
  const tokens: string[] = []; const events: string[] = [];
  agent.on('onTokenStream', token => tokens.push(token));
  agent.on('onToolStart', e => events.push(e.id));
  const result = await agent.run('Explain add');
  expect(result).toMatchObject({ status: 'completed', text: 'Found add.', iterations: 2 });
  expect(JSON.stringify(client.requests[0]!.messages)).toContain('calc.ts:1');
  expect(JSON.stringify(client.requests[0]!.messages)).toContain('function add(a: number, b: number)');
  expect(client.requests[0]!.tools).toHaveLength(6);
  expect(client.requests[1]!.messages.find(m => m.role === 'tool')).toMatchObject({ tool_call_id: 'inspect' });
  expect(tokens).toEqual(['Found add.']); expect(events).toEqual(['inspect']);
  expect(client.listenerCount('onTokenStream')).toBe(0);
});
it('preserves NIM reasoning content across tool turns without displaying it as answer text', async () => {
  const client = new FakeClient([
    [chunk({ reasoning_content: 'Inspect ' }), chunk({ reasoning_content: 'the graph.' }),
      ...calls([{ id: 'map', name: 'get_repo_map', args: {} }])],
    [chunk({ content: 'Done.' }, 'stop')],
  ]);
  const agent = new AgentLoop({ workspace: root, client });
  const tokens: string[] = [];
  agent.on('onTokenStream', token => tokens.push(token));
  expect(await agent.run('Inspect')).toMatchObject({ status: 'completed', text: 'Done.' });
  expect(client.requests[1]!.messages.find(message => message.role === 'assistant')).toMatchObject({
    content: null, reasoning_content: 'Inspect the graph.', tool_calls: [{ id: 'map' }],
  });
  expect(tokens).toEqual(['Done.']);
});
it('executes edits before graph inspection in the same batch and refreshes context', async () => {
  const client = new FakeClient([calls([
    { id: 'edit', name: 'apply_edits_batch', args: { edits: [{ path: 'calc.ts', old_text: 'add', new_text: 'sum' }] } },
    { id: 'inspect', name: 'inspect_symbol_graph', args: { symbol_names: ['sum'] } },
  ]), [chunk({ content: 'Renamed.' }, 'stop')]]);
  const agent = new AgentLoop({ workspace: root, client });
  expect((await agent.run('Rename add to sum')).status).toBe('completed');
  expect(await readFile(join(root, 'calc.ts'), 'utf8')).toContain('function sum');
  const messages = client.requests[1]!.messages;
  const result = messages.find(m => m.role === 'tool' && m.tool_call_id === 'inspect');
  expect(JSON.stringify(result)).toContain('function sum');
  expect(JSON.stringify(messages[1])).toContain('sum');
});
it('returns tool validation errors to the model without executing malformed edits', async () => {
  const client = new FakeClient([calls([
    { id: 'unknown', name: 'read_file', args: { path: 'calc.ts' } },
    { id: 'bad', name: 'apply_edits_batch', args: { edits: [{ path: 'calc.ts', old_text: 'add' }] } },
  ]), [chunk({ content: 'Cannot execute these tools.' }, 'stop')]]);
  const result = await new AgentLoop({ workspace: root, client }).run('Inspect add');
  expect(result.status).toBe('completed');
  expect(client.requests[1]!.messages.filter(m => m.role === 'tool').every(m => JSON.parse(m.content as string).ok === false)).toBe(true);
  expect(await readFile(join(root, 'calc.ts'), 'utf8')).toContain('function add');
});
it('limits runaway loops, reports NIM failure and does not execute truncated tool calls', async () => {
  const client = new FakeClient([calls([{ id: 'one', name: 'get_repo_map', args: {} }])]);
  expect((await new AgentLoop({ workspace: root, client, maxIterations: 1 }).run('Inspect')).status).toBe('iteration_limit');
  const failed = new AgentLoop({ workspace: root, client: new FakeClient([]) });
  expect(await failed.run('Inspect')).toMatchObject({ status: 'error', error: 'Simulated NIM failure' });
  const partial = new FakeClient([[chunk({ tool_calls: [{ index: 0, id: 'x', type: 'function', function: { name: 'apply_edits_batch', arguments: '{}' } }] }, 'length')]]);
  expect((await new AgentLoop({ workspace: root, client: partial }).run('Edit')).status).toBe('error');
});
it('retains conversation across runs and compacts locally within the request budget', async () => {
  const client = new FakeClient(Array.from({ length: 10 }, () => [chunk({ content: 'Done ' + 'x'.repeat(7000) }, 'stop')]));
  const agent = new AgentLoop({ workspace: root, client, maxContextChars: 18000 });
  let compacted = 0; agent.on('onCompaction', () => compacted++);
  for (let i = 0; i < 5; i++) expect((await agent.run(`Request ${i} for add`)).status).toBe('completed');
  expect(compacted).toBeGreaterThan(0);
  expect(client.requests).toHaveLength(5);
  expect(client.requests.every(r => JSON.stringify({ messages: r.messages, tools: r.tools }).length <= 18000)).toBe(true);
  expect(JSON.stringify(client.requests.at(-1)!.messages)).toContain('Request 4');
});
it('handles cancellation before indexing and prevents overlapping runs', async () => {
  const client = new FakeClient([[chunk({ content: 'Done' }, 'stop')]]);
  const agent = new AgentLoop({ workspace: root, client });
  const aborted = new AbortController(); aborted.abort();
  expect((await agent.run('Inspect', { signal: aborted.signal })).status).toBe('cancelled');
  expect(client.requests).toHaveLength(0);
  const first = agent.run('Inspect');
  expect(await agent.run('Another')).toMatchObject({ status: 'busy' });
  await first;
});
it('preserves protocol pairing after cancellation mid-batch and can continue later', async () => {
  const client = new FakeClient([calls([
    { id: 'first', name: 'get_repo_map', args: {} },
    { id: 'never', name: 'apply_edits_batch', args: { edits: [{ path: 'never.txt', old_text: '', new_text: 'no' }] } },
  ]), [chunk({ content: 'Continued' }, 'stop')]]);
  const agent = new AgentLoop({ workspace: root, client });
  const controller = new AbortController();
  agent.once('onToolEnd', () => controller.abort());
  expect((await agent.run('Inspect', { signal: controller.signal })).status).toBe('cancelled');
  expect(agent.messages.filter(m => m.role === 'tool')).toHaveLength(2);
  expect((await agent.run('Continue')).status).toBe('completed');
  await expect(readFile(join(root, 'never.txt'))).rejects.toThrow();
});
it('rejects duplicate IDs before side effects and protects oversized current prompts', async () => {
  const client = new FakeClient([calls([
    { id: 'same', name: 'get_repo_map', args: {} },
    { id: 'same', name: 'get_repo_map', args: {} },
  ])]);
  const agent = new AgentLoop({ workspace: root, client, maxContextChars: 16000 });
  expect(await agent.run('Inspect')).toMatchObject({ status: 'error', error: 'Missing or duplicate tool call IDs/names' });
  expect(agent.messages.some(m => m.role === 'tool')).toBe(false);
  expect((await agent.run('z'.repeat(20000))).status).toBe('context_limit');
  expect(client.requests).toHaveLength(1);
});
it('compacts completed tool groups without orphaning tool call IDs', async () => {
  await writeFile(join(root, 'big.txt'), 'value\n'.repeat(3000));
  const client = new FakeClient([
    ...Array.from({ length: 8 }, (_, i) => calls([{ id: `read-${i}`, name: 'read_files_batch', args: { paths: ['big.txt'] } }])),
    [chunk({ content: 'Done' }, 'stop')],
  ]);
  const agent = new AgentLoop({ workspace: root, client, maxContextChars: 16000 });
  let compactions = 0; agent.on('onCompaction', () => compactions++);
  expect((await agent.run('Read big.txt')).status).toBe('completed');
  expect(compactions).toBeGreaterThan(0);
  for (const request of client.requests) {
    const pending = new Set<string>();
    for (const message of request.messages) {
      if (message.role === 'assistant') for (const call of message.tool_calls ?? []) pending.add(call.id);
      if (message.role === 'tool') { expect(pending.has(message.tool_call_id)).toBe(true); pending.delete(message.tool_call_id); expect(() => JSON.parse(message.content as string)).not.toThrow(); }
    }
    expect(pending.size).toBe(0);
    expect(JSON.stringify({ messages: request.messages, tools: request.tools }).length).toBeLessThanOrEqual(16000);
  }
});
it('integrates the real NIM SDK stream, limiter, graph and filesystem dispatcher', async () => {
  const { NimClient } = await import('../src/core/nim-client.js');
  const requests: CompletionInput[] = [];
  const started: number[] = [];
  const client = new NimClient({ apiKey: 'local-test-only', rateLimitDirectory: join(root, '.rate-limits'), fetch: async (_url, init) => {
    started.push(Date.now());
    requests.push(JSON.parse(init!.body as string));
    const response = requests.length === 1 ? calls([{ id: 'read', name: 'read_files_batch', args: { paths: ['calc.ts'] } }]) : [chunk({ content: 'Verified add' }, 'stop')];
    return new Response(response.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const agent = new AgentLoop({ workspace: root, client });
  let waits = 0; agent.on('onRateLimitWait', e => { if (e.remainingMs > 0) waits++; });
  expect(await agent.run('Explain add')).toMatchObject({ status: 'completed', text: 'Verified add' });
  expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(1600);
  expect(waits).toBeGreaterThan(0);
  expect(JSON.stringify(requests[1]!.messages.find(m => m.role === 'tool'))).toContain('function add');
}, 10000);
it('supports startup indexing, model switching without clearing history and manual compaction', async () => {
  const client = new FakeClient([[chunk({ content: 'First' }, 'stop')], [chunk({ content: 'Second' }, 'stop')], [chunk({ content: 'Third' }, 'stop')]]);
  const agent = new AgentLoop({ workspace: root, client });
  await agent.initialize();
  expect(agent.graphSnapshot?.stats.files).toBe(1);
  await agent.run('First request'); await agent.run('Second request');
  agent.setModel('meta/llama-3.3-70b-instruct');
  expect(agent.compact()).toBeGreaterThan(0);
  await agent.run('Third request');
  expect(client.requests[2]!.model).toBe('meta/llama-3.3-70b-instruct');
  expect(JSON.stringify(client.requests[2]!.messages)).toContain('Second request');
});

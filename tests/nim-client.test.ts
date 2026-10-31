import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NimClient } from '../src/core/nim-client.js';

const payload = { id: 'test', object: 'chat.completion', created: 0, model: 'test', choices: [] };
const messages = [{ role: 'user' as const, content: 'hello' }];
let clock = Date.now();
beforeEach(() => { clock += 200000; vi.useFakeTimers({ now: clock }); });
afterEach(() => vi.useRealTimers());
describe('NIM request protection', () => {
  it('paces concurrent requests FIFO, disables SDK retries, and uses only NIM', async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const bodies: any[] = [];
    const fetch = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
      starts.push(Date.now()); bodies.push(JSON.parse(init.body));
      return Response.json(payload);
    });
    const client = new NimClient({ apiKey: 'test', fetch });
    const results = Promise.all([client.complete({ messages }), client.complete({ messages })]);
    await vi.advanceTimersByTimeAsync(4000);
    expect((await results).every(r => r.ok)).toBe(true);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1600);
    expect(bodies[0]).toMatchObject({ model: 'mistralai/mistral-large-4-1t-a52b', temperature: 0.5, top_p: 1, max_tokens: 4096 });
  });
  it('retries 429 after 5, 10, 20 seconds, emits countdowns, and recovers after exhaustion', async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const fetch = vi.fn(async () => {
      starts.push(Date.now());
      return new Response('{}', { status: 429 });
    });
    const client = new NimClient({ apiKey: 'test', fetch });
    const waits: number[] = [];
    client.on('onRateLimitWait', e => { if (e.reason === 'retry') waits.push(e.remainingMs); });
    const pending = client.complete({ messages });
    await vi.advanceTimersByTimeAsync(45000);
    expect((await pending).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(starts.slice(1).map((t, i) => t - starts[i]!)).toEqual([5000, 10000, 20000]);
    expect(waits).toContain(5000);
    fetch.mockImplementation(async () => Response.json(payload));
    const recovery = client.complete({ messages });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await recovery).ok).toBe(true);
  });
});
it('uses current NIM profiles, preserves overrides and accepts custom model IDs', async () => {
  const bodies: any[] = [];
  const client = new NimClient({ apiKey: 'test', fetch: async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    return Response.json(payload);
  } });
  const tools = [{ type: 'function' as const, function: { name: 'get_repo_map' } }];
  const results = Promise.all([
    client.complete({ messages, tools, model: 'nvidia/nemotron-3.5-bolt-e4b' }),
    client.complete({ messages, tools, model: 'deepseek-ai/deepseek-v4.1-flash' }),
    client.complete({ messages, tools, model: 'minimaxai/minimax-m3.1-flash' }),
    client.complete({ messages, tools, model: 'z-ai/glm-5.3-flash' }),
    client.complete({ messages, tools, temperature: 0.3, top_p: 0.8, max_tokens: 512 }),
    client.complete({ messages, tools, model: 'custom/model' }),
  ]);
  await vi.advanceTimersByTimeAsync(20000);
  expect((await results).every(result => result.ok)).toBe(true);
  expect(bodies[0]).toMatchObject({ temperature: 1, top_p: 0.95, parallel_tool_calls: true });
  expect(bodies[1]).toMatchObject({ temperature: 1, top_p: 0.95, max_tokens: 16384 });
  expect(bodies[2]).toMatchObject({ temperature: 1, top_p: 0.95, max_tokens: 16384 });
  expect(bodies[3]).toMatchObject({ temperature: 0.5, top_p: 1 });
  expect(bodies[4]).toMatchObject({ temperature: 0.3, top_p: 0.8, max_tokens: 512 });
  expect(bodies[5]).toMatchObject({ model: 'custom/model', temperature: 0.2, max_tokens: 4096 });
  for (const body of bodies.slice(1)) expect(body).not.toHaveProperty('parallel_tool_calls');
  expect(bodies[5]).not.toHaveProperty('top_p');
});
it('does not retry non-429 errors and supports cancellation before dispatch', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => new Response('{}', { status: 401 }));
  const client = new NimClient({ apiKey: 'test', fetch });
  const pending = client.complete({ messages });
  await vi.advanceTimersByTimeAsync(60000);
  expect((await pending).ok).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  const controller = new AbortController(); controller.abort();
  const cancelled = client.complete({ messages }, controller.signal);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await cancelled).toMatchObject({ ok: false, error: 'Request cancelled' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('respects Retry-After and shares pacing across client instances', async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  const fetch = vi.fn(async () => {
    starts.push(Date.now());
    return starts.length === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '8' } }) : Response.json(payload);
  });
  const a = new NimClient({ apiKey: 'test', fetch });
  const b = new NimClient({ apiKey: 'test', fetch });
  const results = Promise.all([a.complete({ messages }), b.complete({ messages })]);
  await vi.advanceTimersByTimeAsync(80000);
  expect((await results).every(r => r.ok)).toBe(true);
  expect(starts[1]! - starts[0]!).toBe(8000);
  expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(1600);
});
it('streams text and tool deltas and enables supported parallel calls', async () => {
  vi.useFakeTimers();
  const chunk = { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'test', choices: [{ index: 0, delta: { content: 'Hello', tool_calls: [{ index: 0, id: 't', type: 'function', function: { name: 'read_files_batch', arguments: '{}' } }] }, finish_reason: null }] };
  const fetch = vi.fn(async (_url: any, init: any) => {
    expect(JSON.parse(init.body).parallel_tool_calls).toBe(true);
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const client = new NimClient({ apiKey: 'test', fetch, parallelToolCalls: true });
  const tokens: string[] = [];
  client.on('onTokenStream', token => tokens.push(token));
  const result = client.stream({ messages, tools: [{ type: 'function', function: { name: 'read_files_batch' } }] });
  await vi.advanceTimersByTimeAsync(100000);
  expect(await result).toMatchObject({ ok: true, value: [chunk] });
  expect(tokens).toEqual(['Hello']);
});
it('publishes the pacing countdown while Bottleneck queues a request', async () => {
  vi.useFakeTimers();
  const client = new NimClient({ apiKey: 'test', fetch: async () => Response.json(payload) });
  const waits: number[] = [];
  client.on('onRateLimitWait', event => { if (event.reason === 'pacing') waits.push(event.remainingMs); });
  const result = Promise.all([client.complete({ messages }), client.complete({ messages })]);
  await vi.advanceTimersByTimeAsync(110000);
  await result;
  expect(waits.some(ms => ms > 500)).toBe(true);
});


it('forwards streamed refusal text to plain-output consumers', async () => {
  const chunk = { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'test', choices: [{ index: 0, delta: { refusal: 'Cannot comply.' }, finish_reason: 'stop' }] };
  const client = new NimClient({ apiKey: 'test', fetch: async () => new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }) });
  const tokens: string[] = [];
  client.on('onTokenStream', token => tokens.push(token));
  const result = client.stream({ messages });
  await vi.advanceTimersByTimeAsync(4000);
  expect((await result).ok).toBe(true);
  expect(tokens.join('')).toBe('Cannot comply.');
});

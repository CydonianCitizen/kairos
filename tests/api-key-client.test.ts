import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NimClient } from '../src/core/nim-client.js';
import { acquireNimLease } from '../src/core/nim-pacing.js';

vi.mock('../src/core/nim-pacing.js', () => ({ acquireNimLease: vi.fn(async () => ({
  beforeDispatch: async () => {}, deferUntil: async () => {}, release: async () => {},
})) }));
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('NVIDIA_API_KEY', undefined); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const input = { messages: [{ role: 'user' as const, content: 'hello' }] };
const reply = { id: 'test', object: 'chat.completion', created: 0, model: 'test', choices: [] };

it('keeps strict SDK startup but supports offline interactive key setup', async () => {
  expect(() => new NimClient()).toThrow('NVIDIA_API_KEY is required');
  const fetch = vi.fn(async () => Response.json(reply));
  const client = new NimClient({ allowMissingApiKey: true, fetch });
  expect(await client.complete(input)).toMatchObject({ ok: false, error: expect.stringContaining('NVIDIA_API_KEY') });
  expect(fetch).not.toHaveBeenCalled();
  client.setApiKey('new-test-key');
  const pending = client.complete(input); await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toMatchObject({ ok: true });
});

it('uses the new key for HTTP, coordination and subsequent forks', async () => {
  const headers: string[] = [];
  const client = new NimClient({ apiKey: 'old-test-key', fetch: async (_url, init) => {
    headers.push(new Headers(init?.headers).get('Authorization') ?? ''); return Response.json(reply);
  } });
  client.setApiKey('new-test-key');
  const pending = Promise.all([client.complete(input), client.fork().complete(input)]);
  await vi.advanceTimersByTimeAsync(10000);
  expect((await pending).every(result => result.ok)).toBe(true);
  expect(headers).toEqual(['Bearer new-test-key', 'Bearer new-test-key']);
  expect(acquireNimLease).toHaveBeenLastCalledWith('new-test-key', undefined, undefined, expect.any(Function));
});

it('does not change credentials while a request is queued or active', async () => {
  const client = new NimClient({ apiKey: 'old-test-key', fetch: async () => Response.json(reply) });
  const pending = client.complete(input);
  expect(() => client.setApiKey('new-test-key')).toThrow(/request|busy/i);
  await vi.advanceTimersByTimeAsync(5000); await pending;
  expect(() => client.setApiKey('')).toThrow(/key/i);
  expect(() => client.setApiKey('new-test-key')).not.toThrow();
});

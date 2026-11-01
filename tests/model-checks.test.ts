import { expect, it } from 'vitest';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { CompletionInput, NimResult } from '../src/core/nim-client.js';
import { checkModels } from '../src/core/model-checks.js';

function chunk(delta: Record<string, unknown>, finish: 'stop' | 'tool_calls' | 'length' | null = 'stop'): ChatCompletionChunk {
  return { id: 'probe', object: 'chat.completion.chunk', created: 0, model: 'probe',
    choices: [{ index: 0, delta, finish_reason: finish }] } as ChatCompletionChunk;
}

function client(replace?: (input: CompletionInput, count: number) => NimResult<ChatCompletionChunk[]> | undefined) {
  const requests: CompletionInput[] = [];
  return {
    requests,
    async stream(input: CompletionInput) {
      requests.push(input);
      const result = replace?.(input, requests.length);
      if (result) return result;
      const tool = input.messages.find(message => message.role === 'tool');
      if (tool) return { ok: true as const, value: [chunk({ content: JSON.parse(tool.content as string).marker })] };
      if (input.tools?.length) return { ok: true as const, value: [
        chunk({ reasoning_content: 'Preserve this reasoning on the following turn.', tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'echo_batch', arguments: '{"values":' } }] }, null),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '["kairos"]}' } }] }, 'tool_calls'),
      ] };
      const system = input.messages.find(message => message.role === 'system')!.content as string;
      return { ok: true as const, value: [chunk({ content: system.match(/KAIROS_PROBE_[a-f0-9]+/)![0] })] };
    },
  };
}

it('verifies streaming, system instructions, batch tool round trips and every configured explicit effort', async () => {
  const transport = client();
  const report = await checkModels(transport, ['mistralai/mistral-large-4-1t-a52b']);
  const result = report.models[0]!;
  expect(result.streaming.status).toBe('passed');
  expect(result.systemPrompt.status).toBe('passed');
  expect(result.tools.status).toBe('passed');
  expect(result.efforts.none?.status).toBe('passed');
  expect(result.efforts.high?.status).toBe('passed');
  expect(transport.requests).toHaveLength(5);
  const roundTrip = transport.requests.find(request => request.messages.some(message => message.role === 'tool'))!;
  expect(roundTrip.messages.find(message => message.role === 'assistant')).toMatchObject({ reasoning_content: 'Preserve this reasoning on the following turn.' });
  expect(roundTrip.tools).toBeUndefined();
});

it('does not infer effort support for unknown catalog models', async () => {
  const transport = client();
  const report = await checkModels(transport, ['custom/model']);
  expect(report.models[0]!.efforts).toEqual({});
  expect(transport.requests).toHaveLength(3);
});

it('does not report a truncated stream or matching partial marker as a success', async () => {
  const transport = client((input, count) => count === 1 ? { ok: true, value: [chunk({ content: (input.messages[0]!.content as string).match(/KAIROS_PROBE_[a-f0-9]+/)![0] }, 'length')] } : undefined);
  const result = (await checkModels(transport, ['custom/model'])).models[0]!;
  expect(result.streaming.status).toBe('failed');
  expect(result.systemPrompt.status).toBe('failed');
  expect(result.tools.status).toBe('passed');
});

it('distinguishes complete streaming from a system instruction that was not followed', async () => {
  const transport = client((_input, count) => count === 1 ? { ok: true, value: [chunk({ content: 'A different answer' })] } : undefined);
  const result = (await checkModels(transport, ['custom/model'])).models[0]!;
  expect(result.streaming.status).toBe('passed');
  expect(result.systemPrompt.status).toBe('failed');
});

it('rejects wrong batch arguments before attempting a tool continuation', async () => {
  const transport = client(input => input.tools?.length ? { ok: true, value: [chunk({ tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'echo_batch', arguments: '{"values":["wrong"]}' } }] }, 'tool_calls')] } : undefined);
  const result = (await checkModels(transport, ['custom/model'])).models[0]!;
  expect(result.tools.status).toBe('failed');
  expect(transport.requests).toHaveLength(2);
});

it('skips redundant probes for unavailable endpoints and never records provider error bodies', async () => {
  const transport = client(() => ({ ok: false, status: 404, error: 'Authorization Bearer private-api-key' }));
  const report = await checkModels(transport, ['mistralai/mistral-large-4-1t-a52b']);
  expect(report.models[0]!.streaming).toMatchObject({ status: 'failed', httpStatus: 404 });
  expect(report.models[0]!.tools.status).toBe('skipped');
  expect(report.models[0]!.efforts.high?.status).toBe('skipped');
  expect(transport.requests).toHaveLength(1);
  expect(JSON.stringify(report)).not.toContain('private-api-key');
});

it('cancels remaining probes when the caller aborts', async () => {
  const controller = new AbortController();
  const transport = client(() => { controller.abort(); return { ok: false, error: 'cancelled' }; });
  await expect(checkModels(transport, ['custom/model', 'other/model'], { signal: controller.signal })).rejects.toThrow();
  expect(transport.requests).toHaveLength(1);
});

it('validates all model IDs before sending a request', async () => {
  const transport = client();
  await expect(checkModels(transport, ['custom/model', 'invalid'])).rejects.toThrow(/model/i);
  expect(transport.requests).toHaveLength(0);
});

it('reports a deadline even if an aborted stream resolves normally', async () => {
  let requests = 0;
  const transport = { async stream(_input: CompletionInput, signal?: AbortSignal) {
    requests++;
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
    return { ok: true as const, value: [] };
  } };
  const result = (await checkModels(transport, ['custom/model'], { timeoutMs: 5 })).models[0]!;
  expect(result.streaming).toMatchObject({ status: 'failed', detail: expect.stringMatching(/timed out/) });
  expect(result.tools.status).toBe('skipped');
  expect(requests).toBe(1);
});

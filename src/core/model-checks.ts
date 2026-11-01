import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChatCompletionAssistantMessageParam, ChatCompletionChunk, ChatCompletionMessageFunctionToolCall } from 'openai/resources/chat/completions';
import { effortLevels, type Effort } from '../config/effort.js';
import { NIM_BASE_URL } from '../config/models.js';
import type { CompletionInput, NimClient } from './nim-client.js';

export interface ModelProbe {
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  detail: string;
  httpStatus?: number;
}
export interface ModelCheck {
  model: string;
  streaming: ModelProbe;
  systemPrompt: ModelProbe;
  tools: ModelProbe;
  efforts: Partial<Record<Effort, ModelProbe>>;
}
export interface ModelCheckReport {
  version: 1;
  checkedAt: string;
  endpoint: string;
  models: ModelCheck[];
}
interface CheckOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (model: string, probe: string) => void;
}
const skipped = (): ModelProbe => ({ status: 'skipped', durationMs: 0, detail: 'Endpoint unavailable; no further probes sent.' });
export const defaultModelCheckPath = () => join(homedir(), '.kairos', 'model-checks.json');

function assemble(chunks: ChatCompletionChunk[]) {
  let content = '', reasoning = '', finish: string | null = null;
  const calls = new Map<number, ChatCompletionMessageFunctionToolCall>();
  for (const chunk of chunks) {
    const choice = chunk.choices.find(value => value.index === 0);
    if (!choice) continue;
    if (choice.finish_reason !== null) finish = choice.finish_reason;
    content += choice.delta.content ?? '';
    const delta = choice.delta as typeof choice.delta & { reasoning_content?: string };
    reasoning += delta.reasoning_content ?? '';
    for (const part of delta.tool_calls ?? []) {
      if (!Number.isInteger(part.index) || part.index < 0 || part.index > 31) throw new Error('Invalid tool stream');
      const call = calls.get(part.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (part.type && part.type !== 'function') throw new Error('Invalid tool type');
      if (part.id && call.id && part.id !== call.id) throw new Error('Changing tool ID');
      call.id = part.id ?? call.id;
      call.function.name += part.function?.name ?? '';
      call.function.arguments += part.function?.arguments ?? '';
      if (call.function.arguments.length > 64000) throw new Error('Oversized tool arguments');
      calls.set(part.index, call);
    }
  }
  return { content, reasoning, finish, calls: [...calls.values()] };
}

/** Synthetic, explicitly invoked checks only. No workspace files or provider error bodies enter the report. */
export async function checkModels(client: Pick<NimClient, 'stream'>, models: readonly string[],
  { signal, timeoutMs = 45000, onProgress }: CheckOptions = {}): Promise<ModelCheckReport> {
  if (!models.length || models.length > 100 || models.some(model => !/^[\w.-]+\/[\w.-]+$/.test(model))) throw new Error('Expected 1–100 NIM model IDs (provider/model)');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('Invalid model check timeout');
  const report: ModelCheckReport = { version: 1, checkedAt: new Date().toISOString(), endpoint: NIM_BASE_URL, models: [] };
  async function request(input: CompletionInput, name: string) {
    signal?.throwIfAborted();
    onProgress?.(input.model!, name);
    const started = Date.now();
    const deadline = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const response = await client.stream(input, requestSignal);
      signal?.throwIfAborted();
      if (deadline.aborted) throw new Error('Probe deadline reached');
      const durationMs = Date.now() - started;
      if (!response.ok) return { probe: { status: 'failed', durationMs,
        detail: deadline.aborted ? `Probe timed out after ${timeoutMs} ms, including queue wait.` : response.status ? `NIM returned HTTP ${response.status}.` : 'The request did not complete.',
        ...(response.status ? { httpStatus: response.status } : {}),
      } satisfies ModelProbe };
      return { value: assemble(response.value), probe: { status: 'passed', durationMs, detail: 'Request completed.' } satisfies ModelProbe };
    } catch {
      signal?.throwIfAborted();
      return { probe: { status: 'failed', durationMs: Date.now() - started,
        detail: deadline.aborted ? `Probe timed out after ${timeoutMs} ms, including queue wait.` : 'The request or response stream was invalid.' } satisfies ModelProbe };
    }
  }
  async function textProbe(model: string, effort: Effort = 'auto'): Promise<{ streaming: ModelProbe; systemPrompt: ModelProbe }> {
    const marker = `KAIROS_PROBE_${randomUUID().replaceAll('-', '')}`;
    const result = await request({ model, effort, max_tokens: 4096, messages: [
      { role: 'system', content: `Reply with exactly ${marker} and no other text.` },
      { role: 'user', content: 'Follow the system instruction.' },
    ] }, effort === 'auto' ? 'streaming + system prompt' : `effort ${effort}`);
    const complete = result.value?.finish === 'stop' && !!result.value.content.trim() && !result.value.calls.length;
    return { streaming: complete ? { ...result.probe, detail: 'Complete streamed text response.' } : { ...result.probe, status: 'failed' as const, detail: result.value ? 'Missing, truncated or non-text final response.' : result.probe.detail },
      systemPrompt: complete && result.value!.content.trim() === marker ? { ...result.probe, detail: 'The system instruction marker was followed.' } : { ...result.probe, status: 'failed' as const, detail: result.value ? 'The complete expected system marker was not returned.' : result.probe.detail } };
  }
  for (const model of [...new Set(models)]) {
    signal?.throwIfAborted();
    const baseline = await textProbe(model);
    const result: ModelCheck = { model, ...baseline, tools: skipped(), efforts: {} };
    report.models.push(result);
    const unavailable = baseline.streaming.httpStatus !== undefined || /timed out|did not complete|invalid/.test(baseline.streaming.detail);
    if (!unavailable) {
      const marker = `KAIROS_PROBE_${randomUUID().replaceAll('-', '')}`;
      const messages: CompletionInput['messages'] = [
        { role: 'system', content: 'Call the requested function. After its tool result, reply only with the marker in that result.' },
        { role: 'user', content: 'Call echo_batch exactly once with {"values":["kairos"]}.' },
      ];
      const start = Date.now();
      const first = await request({ model, max_tokens: 4096, messages, tools: [{ type: 'function', function: {
        name: 'echo_batch', description: 'Return a verification marker for a batch of strings.',
        parameters: { type: 'object', properties: { values: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 } }, required: ['values'], additionalProperties: false },
      } }] }, 'batch tool call');
      result.tools = first.probe;
      try {
        const call = first.value?.calls[0];
        if (first.value?.finish !== 'tool_calls' || first.value.calls.length !== 1 || !call?.id || call.function.name !== 'echo_batch') throw new Error('Missing tool call');
        const args = JSON.parse(call.function.arguments);
        if (!args || Object.keys(args).length !== 1 || !Array.isArray(args.values) || args.values.length !== 1 || args.values[0] !== 'kairos') throw new Error('Invalid batch arguments');
        const assistant: ChatCompletionAssistantMessageParam = { role: 'assistant', content: first.value.content || null, tool_calls: [call],
          ...(first.value.reasoning ? { reasoning_content: first.value.reasoning } : {}) };
        const follow = await request({ model, max_tokens: 4096, messages: [...messages, assistant, { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ marker }) }] }, 'tool result continuation');
        result.tools = { ...follow.probe, durationMs: Date.now() - start };
        if (follow.value) result.tools = { ...result.tools, status: follow.value.finish === 'stop' && follow.value.content.trim() === marker && !follow.value.calls.length ? 'passed' : 'failed', detail: 'Batch call, arguments and tool result continuation checked.' };
      } catch {
        signal?.throwIfAborted();
        if (first.value) result.tools = { ...first.probe, status: 'failed', detail: 'Expected one complete echo_batch call with the requested array arguments.' };
      }
    }
    for (const effort of effortLevels(model).filter(value => value !== 'auto')) {
      result.efforts[effort] = unavailable ? skipped() : (await textProbe(model, effort)).systemPrompt;
    }
  }
  return report;
}

export async function saveModelChecks(report: ModelCheckReport, path = defaultModelCheckPath()): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

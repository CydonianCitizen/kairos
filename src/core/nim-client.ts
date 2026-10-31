import { EventEmitter } from 'node:events';
import Bottleneck from 'bottleneck';
import OpenAI from 'openai';
import type { ChatCompletion, ChatCompletionChunk, ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { DEFAULT_MODEL, MODELS, NIM_BASE_URL } from '../config/models.js';

const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 1600 });
let lastStart = 0;
const backoffs = [5000, 10000, 20000] as const;
export interface WaitEvent { reason: 'pacing' | 'retry'; remainingMs: number; retry: number }
interface NimEvents {
  onRateLimitWait: [WaitEvent];
  onTokenStream: [string];
}
export type NimResult<T> = { ok: true; value: T } | { ok: false; error: string; status?: number };
export type CompletionInput = Omit<ChatCompletionCreateParamsNonStreaming, 'model' | 'stream'> & { model?: string };
export interface NimClientOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  parallelToolCalls?: boolean;
}

/** All instances share one FIFO limiter in this process. SDK retries are disabled. */
export class NimClient extends EventEmitter<NimEvents> {
  private readonly sdk: OpenAI;
  private readonly parallelToolCalls?: boolean;
  constructor(options: NimClientOptions = {}) {
    super();
    const apiKey = options.apiKey ?? process.env.NVIDIA_API_KEY;
    if (!apiKey?.trim()) throw new Error('NVIDIA_API_KEY is required');
    this.parallelToolCalls = options.parallelToolCalls;
    const transport = options.fetch ?? globalThis.fetch;
    this.sdk = new OpenAI({ apiKey, baseURL: NIM_BASE_URL, maxRetries: 0,
      timeout: options.timeoutMs ?? 60000, fetch: async (input, init) => {
        // Measure actual HTTP dispatch, not SDK preparation (which takes variable time).
        await this.wait(Math.max(0, lastStart + 1600 - Date.now()), 'pacing', 0, init?.signal ?? undefined);
        lastStart = Date.now();
        return transport(input, init);
      } });
  }

  private params(input: CompletionInput): ChatCompletionCreateParamsNonStreaming {
    const model = input.model ?? DEFAULT_MODEL;
    const config = MODELS.find(entry => entry.id === model);
    const { parallel_tool_calls: requested, ...rest } = input;
    const parallel = this.parallelToolCalls ?? config?.parallelToolCalls ?? false;
    return { temperature: config?.temperature ?? 0.2, max_tokens: config?.maxTokens ?? 4096,
      ...(config ? { top_p: config.topP } : {}),
      ...rest, model, stream: false,
      ...(input.tools?.length && parallel ? { parallel_tool_calls: requested ?? true } : {}) };
  }

  private async wait(ms: number, reason: WaitEvent['reason'], retry: number, signal?: AbortSignal): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      signal?.throwIfAborted();
      const remainingMs = end - Date.now();
      this.emit('onRateLimitWait', { reason, remainingMs, retry });
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, remainingMs)));
    }
    this.emit('onRateLimitWait', { reason, remainingMs: 0, retry });
    signal?.throwIfAborted();
  }

  private execute<T>(operation: () => Promise<T>, signal?: AbortSignal, canRetry = () => true): Promise<NimResult<T>> {
    // Bottleneck's own delay happens before the callback; expose it to the UI too.
    const queuedCountdown = setInterval(() => {
      const remainingMs = Math.max(0, lastStart + 1600 - Date.now());
      if (remainingMs > 0) this.emit('onRateLimitWait', { reason: 'pacing', remainingMs, retry: 0 });
    }, 100);
    return limiter.schedule(async (): Promise<NimResult<T>> => {
      clearInterval(queuedCountdown);
      for (let retry = 0; ; retry++) {
        try {
          signal?.throwIfAborted();
          return { ok: true, value: await operation() };
        } catch (error) {
          const status = error instanceof OpenAI.APIError ? error.status : undefined;
          const delay = backoffs[retry];
          if (status === 429 && delay !== undefined && canRetry() && !signal?.aborted) {
            // Keep this FIFO job active during backoff so other calls cannot bypass the cooldown.
            const header = error instanceof OpenAI.APIError ? error.headers?.get('retry-after') : null;
            const seconds = header ? Number(header) : NaN;
            const retryAfter = header ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()) : 0;
            try { await this.wait(Math.max(delay, retryAfter || 0), 'retry', retry + 1, signal); }
            catch { return { ok: false, error: 'Request cancelled' }; }
            continue;
          }
          return { ok: false, error: signal?.aborted ? 'Request cancelled' : error instanceof Error ? error.message : String(error), status };
        }
      }
    }).finally(() => clearInterval(queuedCountdown));
  }

  complete(input: CompletionInput, signal?: AbortSignal): Promise<NimResult<ChatCompletion>> {
    return this.execute(() => this.sdk.chat.completions.create(this.params(input), { signal }), signal);
  }

  stream(input: CompletionInput, signal?: AbortSignal): Promise<NimResult<ChatCompletionChunk[]>> {
    let received = false;
    return this.execute(async () => {
      const chunks: ChatCompletionChunk[] = [];
      const stream = await this.sdk.chat.completions.create({ ...this.params(input), stream: true }, { signal });
      for await (const chunk of stream) {
        received = true;
        chunks.push(chunk);
        const delta = chunk.choices.find(choice => choice.index === 0)?.delta;
        const content = delta?.content ?? delta?.refusal;
        if (content) this.emit('onTokenStream', content);
      }
      return chunks;
    }, signal, () => !received);
  }
}

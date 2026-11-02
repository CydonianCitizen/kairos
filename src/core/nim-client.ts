import { EventEmitter } from 'node:events';
import Bottleneck from 'bottleneck';
import OpenAI from 'openai';
import type { ChatCompletion, ChatCompletionChunk, ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { DEFAULT_MODEL, MODELS, NIM_BASE_URL } from '../config/models.js';
import { effortParameters, type Effort } from '../config/effort.js';
import { acquireNimLease, type NimLease } from './nim-pacing.js';

const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 1600 });
let lastStart = 0;
const backoffs = [5000, 10000, 20000] as const;
export interface WaitEvent { reason: 'pacing' | 'retry'; remainingMs: number; retry: number }
interface NimEvents {
  onRateLimitWait: [WaitEvent];
  onTokenStream: [string];
  onReasoningStream: [string];
}
export type NimResult<T> = { ok: true; value: T } | { ok: false; error: string; status?: number };
export type CompletionInput = Omit<ChatCompletionCreateParamsNonStreaming, 'model' | 'stream'> & { model?: string; effort?: Effort; chat_template_kwargs?: Record<string, unknown> };
export interface NimClientOptions {
  apiKey?: string;
  allowMissingApiKey?: boolean;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  parallelToolCalls?: boolean;
  rateLimitDirectory?: string;
}

/** All instances share one FIFO limiter in this process. SDK retries are disabled. */
export class NimClient extends EventEmitter<NimEvents> {
  private readonly options: NimClientOptions;
  private sdk?: OpenAI;
  private readonly timeoutMs: number;
  private readonly parallelToolCalls?: boolean;
  private apiKey: string;
  private pendingRequests = 0;
  private lease?: NimLease;
  constructor(options: NimClientOptions = {}) {
    super();
    const apiKey = options.apiKey ?? process.env.NVIDIA_API_KEY;
    if (!apiKey?.trim() && !options.allowMissingApiKey) throw new Error('NVIDIA_API_KEY is required');
    this.apiKey = apiKey?.trim() ?? '';
    this.timeoutMs = options.timeoutMs ?? Number(process.env.NVIDIA_TIMEOUT_MS ?? 300000);
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2147483647) throw new Error('NVIDIA_TIMEOUT_MS / timeoutMs must be a positive integer up to 2147483647');
    this.options = { ...options, apiKey, timeoutMs: this.timeoutMs };
    this.parallelToolCalls = options.parallelToolCalls;
    if (this.apiKey) this.sdk = this.createSdk(this.apiKey);
  }

  private createSdk(apiKey: string): OpenAI {
    const transport = this.options.fetch ?? globalThis.fetch;
    return new OpenAI({ apiKey, baseURL: NIM_BASE_URL, maxRetries: 0,
      timeout: this.timeoutMs, fetch: async (input, init) => {
        // Measure actual HTTP dispatch, not SDK preparation (which takes variable time).
        await this.wait(Math.max(0, lastStart + 1600 - Date.now()), 'pacing', 0, init?.signal ?? undefined);
        const lease = this.lease;
        if (!lease) throw new Error('NIM shared rate-limit lease is required before HTTP dispatch');
        await lease.beforeDispatch(init?.signal ?? undefined, remainingMs => this.emit('onRateLimitWait', { reason: 'pacing', remainingMs, retry: 0 }));
        lastStart = Date.now();
        const started = lastStart;
        try { return await transport(input, init); }
        finally { await lease.deferUntil(started + 1600); }
      } });
  }

  fork(): NimClient { return new NimClient(this.options); }

  setApiKey(value: string): void {
    if (this.pendingRequests) throw new Error('Cannot change API key while requests are pending');
    const key = value.trim();
    if (!/^[A-Za-z0-9._/-]{1,4096}$/.test(key)) throw new Error('Invalid API key');
    const sdk = this.createSdk(key);
    this.sdk = sdk;
    this.apiKey = key;
    this.options.apiKey = key;
  }

  private params(input: CompletionInput): ChatCompletionCreateParamsNonStreaming {
    const model = input.model ?? DEFAULT_MODEL;
    const config = MODELS.find(entry => entry.id === model);
    const { effort = 'auto', parallel_tool_calls: requested, ...rest } = input;
    const reasoning = effortParameters(model, effort);
    const parallel = this.parallelToolCalls ?? config?.parallelToolCalls ?? false;
    return { temperature: config?.temperature ?? 0.2, max_tokens: reasoning.reasoning_effort === 'high' ? Math.max(16384, config?.maxTokens ?? 4096) : config?.maxTokens ?? 4096,
      ...(config ? { top_p: config.topP } : {}),
      ...rest, ...reasoning,
      ...(reasoning.chat_template_kwargs ? { chat_template_kwargs: { ...input.chat_template_kwargs, ...reasoning.chat_template_kwargs } } : {}),
      model, stream: false,
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

  private execute<T>(operation: () => Promise<T>, signal?: AbortSignal, canRetry = () => true, model?: string): Promise<NimResult<T>> {
    if (!this.sdk) return Promise.resolve({ ok: false, error: 'NVIDIA_API_KEY is required. Use /key to configure it.' });
    this.pendingRequests++;
    // Bottleneck's own delay happens before the callback; expose it to the UI too.
    const queuedCountdown = setInterval(() => {
      const remainingMs = Math.max(0, lastStart + 1600 - Date.now());
      if (remainingMs > 0) this.emit('onRateLimitWait', { reason: 'pacing', remainingMs, retry: 0 });
    }, 100);
    return limiter.schedule(async (): Promise<NimResult<T>> => {
      clearInterval(queuedCountdown);
      let lease: NimLease | undefined;
      try {
        signal?.throwIfAborted();
        lease = await acquireNimLease(this.apiKey, this.options.rateLimitDirectory, signal,
          remainingMs => this.emit('onRateLimitWait', { reason: 'pacing', remainingMs, retry: 0 }));
        this.lease = lease;
        for (let retry = 0; ; retry++) {
          try {
            signal?.throwIfAborted();
            const value = await operation();
            signal?.throwIfAborted();
            return { ok: true, value };
          } catch (error) {
            const status = error instanceof OpenAI.APIError ? error.status : undefined;
            const delay = backoffs[retry];
            let cooldown = 0;
            if (status === 429) {
              // Keep this FIFO job active during backoff so other calls cannot bypass the cooldown.
              const header = error instanceof OpenAI.APIError ? error.headers?.get('retry-after') : null;
              const seconds = header ? Number(header) : NaN;
              const retryAfter = header ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()) : 0;
              cooldown = Math.max(delay ?? backoffs[backoffs.length - 1]!, retryAfter || 0);
              await lease.deferUntil(Date.now() + cooldown);
            }
            if (status === 429 && delay !== undefined && canRetry() && !signal?.aborted) {
              try { await this.wait(cooldown, 'retry', retry + 1, signal); }
              catch { return { ok: false, error: 'Request cancelled' }; }
              continue;
            }
            const coordinatorError=error instanceof OpenAI.APIConnectionError&&error.cause instanceof Error&&error.cause.message.startsWith('NIM shared rate-limit coordinator')?error.cause.message:undefined;
            const message = coordinatorError??(model && error instanceof OpenAI.APIConnectionTimeoutError
              ? `NIM ${model}: request timed out after ${this.timeoutMs} ms waiting for a response. Adjust NVIDIA_TIMEOUT_MS if needed; the endpoint may be slow or unavailable.`
              : error instanceof Error ? error.message : String(error));
            return { ok: false, error: signal?.aborted ? 'Request cancelled' : message, status };
          }
        }
      } finally { this.lease = undefined; await lease?.release(); }
    }).catch((error: unknown): NimResult<T> => ({ ok: false,
      error: signal?.aborted ? 'Request cancelled' : error instanceof Error ? error.message : String(error) }))
      .finally(() => { clearInterval(queuedCountdown); this.pendingRequests--; });
  }

  complete(input: CompletionInput, signal?: AbortSignal): Promise<NimResult<ChatCompletion>> {
    return this.execute(() => this.sdk!.chat.completions.create(this.params(input), { signal }), signal, () => true, input.model ?? DEFAULT_MODEL);
  }

  listModels(signal?: AbortSignal): Promise<NimResult<string[]>> {
    // Discovery is optional metadata: use the same pacing, but fall back instead of retrying.
    return this.execute(async () => {
      const page = await this.sdk!.models.list({ signal, timeout: 5000 });
      return page.data.map(model => model.id);
    }, signal, () => false);
  }

  stream(input: CompletionInput, signal?: AbortSignal): Promise<NimResult<ChatCompletionChunk[]>> {
    let received = false;
    return this.execute(async () => {
      const chunks: ChatCompletionChunk[] = [];
      const stream = await this.sdk!.chat.completions.create({ ...this.params(input), stream: true }, { signal });
      for await (const chunk of stream) {
        received = true;
        chunks.push(chunk);
        const delta = chunk.choices.find(choice => choice.index === 0)?.delta;
        const content = delta?.content ?? delta?.refusal;
        if (content) this.emit('onTokenStream', content);
        const reasoning = (delta as { reasoning_content?: string })?.reasoning_content;
        if (reasoning) this.emit('onReasoningStream', reasoning);
      }
      return chunks;
    }, signal, () => !received, input.model ?? DEFAULT_MODEL);
  }
}

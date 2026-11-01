import { pathToFileURL } from 'node:url';

const { NimClient } = await import(pathToFileURL(process.env.NIM_CLIENT_MODULE).href);
const controller = new AbortController();
const hold = Number(process.env.NIM_HOLD_MS ?? 0);
const mode = process.env.NIM_TEST_MODE ?? 'complete';
const send = value => process.stdout.write(`${JSON.stringify({ ...value, at: Date.now(), pid: process.pid })}\n`);
process.on('message', message => { if (message === 'abort') controller.abort(); });
const payload = { id: 'test', object: 'chat.completion', created: 0, model: 'test', choices: [] };
const client = new NimClient({
  apiKey: process.env.NIM_TEST_KEY,
  rateLimitDirectory: process.env.NIM_RATE_DIRECTORY,
  fetch: async (_url, init) => {
    send({ type: 'start' });
    if (mode === 'error') return new Response('{}', { status: 401 });
    if (mode === 'retry') return new Response('{}', { status: 429 });
    if (mode === 'stream') {
      return new Response(new ReadableStream({
        start(stream) {
          const timer = setTimeout(() => {
            send({ type: 'end' });
            stream.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            stream.close();
          }, hold);
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer); stream.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, hold);
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
    send({ type: 'end' });
    return Response.json(payload);
  },
});
client.on('onRateLimitWait', event => { if (event.remainingMs > 0) send({ type: 'wait', reason: event.reason }); });
send({ type: 'ready' });
const result = await (mode === 'stream' ? client.stream({ messages: [] }, controller.signal) : client.complete({ messages: [] }, controller.signal));
send({ type: 'result', result });
process.disconnect();

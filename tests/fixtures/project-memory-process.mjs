import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const { ProjectMemory } = await import(pathToFileURL(process.env.KAIROS_MEMORY_MODULE).href);
const memory = new ProjectMemory(process.env.KAIROS_MEMORY_WORKSPACE, { directory: process.env.KAIROS_MEMORY_DIRECTORY });
if (process.env.KAIROS_MEMORY_MODE === 'hold') {
  await writeFile(process.env.KAIROS_MEMORY_LOCK, JSON.stringify({ version: 1, pid: process.pid, id: randomUUID() }), { flag: 'wx', mode: 0o600 });
  process.on('message', () => {});
  process.send({ type: 'ready' });
} else {
  process.once('message', async message => {
    if (message !== 'go') throw new Error('Unexpected fixture message');
    let result;
    try {
      await memory.update([{ action: 'add', text: process.env.KAIROS_MEMORY_TEXT }]);
      result = { type: 'result', ok: true };
    } catch (error) {
      result = { type: 'result', ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    process.send(result, () => process.disconnect());
  });
  process.send({ type: 'ready' });
}

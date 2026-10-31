import { expect, it, vi } from 'vitest';
const loading = vi.hoisted(() => ({ dotenv: 0 }));
vi.mock('dotenv/config', () => { loading.dotenv++; return {}; });
import { NimClient } from '../src/core/nim-client.js';
it('does not implicitly load a different workspace dotenv file when importing the client', () => {
  expect(NimClient).toBeDefined();
  expect(loading.dotenv).toBe(0);
});

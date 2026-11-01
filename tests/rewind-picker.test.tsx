import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { afterEach, expect, it } from 'vitest';
import { RewindPicker } from '../src/ui/RewindPicker.js';
import type { RewindSummary } from '../src/core/rewind-store.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 80));
const points: RewindSummary[] = [
  { id: 'point-first', prompt: 'Fix graph traversal', createdAt: '2026-10-29T12:00:00Z' },
  { id: 'point-middle', prompt: 'Document the parser', createdAt: '2026-10-30T12:00:00Z' },
  { id: 'point-latest', prompt: 'Add command completion', createdAt: '2026-10-31T12:00:00Z' },
];
afterEach(cleanup);

it('starts at the latest prompt and sends the selected prompt and restore scope', async () => {
  const selected: Array<[string, string]> = [];
  const app = render(<RewindPicker points={points} maxRows={12} onSelect={(id, scope) => selected.push([id, scope])} onCancel={() => {}} />);
  expect(app.lastFrame()).toContain('› Add command completion');
  expect(app.lastFrame()).toContain('Conversation + files');
  expect(app.lastFrame()).toContain('←→ scope');
  expect(app.lastFrame()).toContain('Shell/plugin changes are not restored');
  expect(points[0]?.id).toBe('point-first');
  await tick(); app.stdin.write('\r'); await tick();
  app.stdin.write('\x1b[B'); await tick();
  expect(app.lastFrame()).toContain('› Document the parser');
  app.stdin.write('\x1b[C'); await tick();
  expect(app.lastFrame()).toContain('Conversation only');
  app.stdin.write('\r'); await tick();
  app.stdin.write('\x1b[C'); await tick();
  expect(app.lastFrame()).toContain('Files only');
  app.stdin.write('\r'); await tick();
  app.stdin.write('\x1b[C'); await tick();
  expect(app.lastFrame()).toContain('Conversation + files');
  app.stdin.write('\x1b[D'); await tick(); app.stdin.write('\r'); await tick();
  expect(selected).toEqual([
    ['point-latest', 'both'], ['point-middle', 'conversation'], ['point-middle', 'files'], ['point-middle', 'files'],
  ]);
});

it.each([
  ['FIX GRAPH', 'Fix graph traversal', 'point-first'],
  ['POINT-MIDDLE', 'Document the parser', 'point-middle'],
  ['2026-10-31', 'Add command completion', 'point-latest'],
])('filters by %s and ignores submissions without a match', async (query, prompt, id) => {
  const selected: string[] = [];
  const app = render(<RewindPicker points={points} onSelect={id => selected.push(id)} onCancel={() => {}} />);
  await tick(); app.stdin.write('\x1b[B'); await tick();
  app.stdin.write(query); await tick();
  expect(app.lastFrame()).toContain(`› ${prompt}`);
  expect(app.lastFrame()).toContain('1/1');
  app.stdin.write('\r'); await tick();
  app.stdin.write('missing'); await tick();
  expect(app.lastFrame()).toContain('No matching prompts');
  app.stdin.write('\r'); await tick();
  expect(selected).toEqual([id]);
});

it('resets navigation to the first matching prompt when the search changes', async () => {
  const selected: string[] = [];
  const app = render(<RewindPicker points={points} onSelect={id => selected.push(id)} onCancel={() => {}} />);
  await tick(); app.stdin.write('\x1b[B'); await tick();
  expect(app.lastFrame()).toContain('› Document the parser');
  app.stdin.write('POINT'); await tick();
  expect(app.lastFrame()).toContain('› Add command completion');
  app.stdin.write('\r'); await tick();
  expect(selected).toEqual(['point-latest']);
});

it('wraps navigation and scrolls within the row budget at small heights', async () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ id: `point-${index}`, prompt: `Prompt ${index}`, createdAt: '2026-10-31T12:00:00Z' }));
  const selected: string[] = [];
  const app = render(<RewindPicker points={many} maxRows={4} onSelect={id => selected.push(id)} onCancel={() => {}} />);
  expect(app.lastFrame()).toContain('› Prompt 19');
  expect(app.lastFrame()!.split('\n').length).toBeLessThanOrEqual(4);
  await tick(); app.stdin.write('\x1b[A'); await tick();
  expect(app.lastFrame()).toContain('› Prompt 0');
  app.stdin.write('\r'); await tick();
  app.stdin.write('\x1b[B'); await tick();
  expect(app.lastFrame()).toContain('› Prompt 19');
  expect(selected).toEqual(['point-0']);
  for (const maxRows of [5, 6, 7, 8, 9, 10, 12]) {
    app.rerender(<RewindPicker points={many} maxRows={maxRows} onSelect={id => selected.push(id)} onCancel={() => {}} />);
    await tick();
    expect(app.lastFrame()!.split('\n').length).toBeLessThanOrEqual(maxRows);
  }
});

it('shows the empty state and cancels with Esc or Ctrl+C without selecting', async () => {
  const selected: string[] = []; let cancelled = 0;
  const app = render(<RewindPicker points={[]} maxRows={4} onSelect={id => selected.push(id)} onCancel={() => { cancelled++; }} />);
  expect(app.lastFrame()).toContain('No rewind points yet');
  expect(app.lastFrame()!.split('\n').length).toBeLessThanOrEqual(4);
  await tick(); app.stdin.write('\x1b[A'); app.stdin.write('\r'); await tick();
  app.stdin.write('\x1b'); await tick(); app.stdin.write('\x03'); await tick();
  expect(selected).toEqual([]); expect(cancelled).toBe(2);
});

it('keeps untrusted prompts and dates on one safe row', () => {
  const app = render(<RewindPicker points={[{ id: 'safe-id', prompt: '\x1b[31mFirst\x1b[0m\nsecond\tpart\x07', createdAt: 'invalid\n\x1b[31mdate\x1b[0m' }]} maxRows={8} onSelect={() => {}} onCancel={() => {}} />);
  expect(app.lastFrame()).toContain('First second part');
  expect(app.lastFrame()).toContain('invalid date');
  expect(app.lastFrame()).not.toMatch(/[\u0007\u001b]/);
  expect(app.lastFrame()!.split('\n').length).toBeLessThanOrEqual(8);
});

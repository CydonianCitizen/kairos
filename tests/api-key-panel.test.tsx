import React from 'react';
import { Box } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it } from 'vitest';
import { ApiKeyPanel } from '../src/ui/ApiKeyPanel.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 60));
const path = '~/.kairos/.env';
const fixture = 'nvapi-panel-fixture-only';
afterEach(cleanup);

it('keeps typed and pasted key content masked in every frame and submits a clean key', async () => {
  const saved: string[] = [];
  const app = render(<ApiKeyPanel path={path} onSave={key => saved.push(key)} onCancel={() => {}} />);
  await tick();
  app.stdin.write(` \t${fixture.slice(0, 6)}`); await tick();
  app.stdin.write(`${fixture.slice(6)}\n`); await tick();
  expect(app.lastFrame()).toContain('NVIDIA API key');
  expect(app.lastFrame()).toContain(path);
  expect(app.lastFrame()).toContain('******');
  for (const frame of app.frames) {
    expect(frame).not.toContain('nvapi-');
    expect(frame).not.toContain('panel-fixture');
  }
  app.stdin.write('\r'); await tick();
  expect(saved).toEqual([fixture]);
});

it('does not submit empty or whitespace-only input', async () => {
  const saved: string[] = [];
  const app = render(<ApiKeyPanel path={path} onSave={key => saved.push(key)} onCancel={() => {}} />);
  await tick(); app.stdin.write('\r'); await tick();
  app.stdin.write('   '); await tick(); app.stdin.write('\r'); await tick();
  expect(saved).toEqual([]);
});

it.each(['\x1b', '\x03'])('cancels with %j without submitting', async input => {
  let cancelled = 0; const saved: string[] = [];
  const app = render(<ApiKeyPanel path={path} required onSave={key => saved.push(key)} onCancel={() => { cancelled++; }} />);
  await tick(); app.stdin.write(fixture); await tick(); app.stdin.write(input); await tick();
  expect(cancelled).toBe(1); expect(saved).toEqual([]);
});

it('blocks changes, duplicate submissions and cancellation while saving', async () => {
  const saved: string[] = []; let cancelled = 0;
  const props = { path, onSave: (key: string) => saved.push(key), onCancel: () => { cancelled++; } };
  const app = render(<ApiKeyPanel {...props} />);
  await tick(); app.stdin.write(fixture); await tick(); app.stdin.write('\r'); await tick();
  app.rerender(<ApiKeyPanel {...props} saving />); await tick();
  app.stdin.write('extra'); app.stdin.write('\r'); app.stdin.write('\x1b'); app.stdin.write('\x03'); await tick();
  expect(saved).toEqual([fixture]); expect(cancelled).toBe(0);
  expect(app.lastFrame()).toContain('Saving');
  app.rerender(<ApiKeyPanel {...props} error={`Untrusted error ${fixture}`} />); await tick();
  expect(app.lastFrame()).toContain('failed');
  expect(app.lastFrame()).toContain('******');
  expect(app.frames.join('\n')).not.toContain(fixture);
  expect(app.lastFrame()).not.toContain('Untrusted');
  app.stdin.write('\r'); await tick(); expect(saved).toEqual([fixture, fixture]);
});

it('rejects an oversized paste without silently saving a truncated key', async () => {
  const saved: string[] = [];
  const app = render(<ApiKeyPanel path={path} onSave={key => saved.push(key)} onCancel={() => {}} />);
  await tick(); app.stdin.write('x'.repeat(4097)); await tick(); app.stdin.write('\r'); await tick();
  expect(saved).toEqual([]);
  expect(app.lastFrame()).toContain('4096');
});

it.each(['bad key', 'bad\nkey', 'bad\x00key', 'bad\x1b[31mkey', '[31mbadkey', 'bad=key', 'bad"key'])('rejects malformed paste %j instead of submitting a changed or previous key', async malformed => {
  const saved: string[] = [];
  const app = render(<ApiKeyPanel path={path} onSave={key => saved.push(key)} onCancel={() => {}} />);
  await tick(); app.stdin.write(fixture); await tick();
  app.stdin.write(malformed); await tick(); app.stdin.write('\r'); await tick();
  expect(saved).toEqual([]);
  expect(app.lastFrame()).toContain('Invalid');
  expect(app.frames.join('\n')).not.toContain(fixture);
});

it('keeps short and narrow layouts within their row budgets', async () => {
  const app = render(<Box width={28}><ApiKeyPanel path={path} maxRows={3} onSave={() => {}} onCancel={() => {}} /></Box>);
  await tick(); app.stdin.write(fixture.repeat(8)); await tick();
  const frame = app.lastFrame()!;
  expect(frame).toContain('NVIDIA API key');
  expect(frame).toContain('Enter'); expect(frame).toContain('Esc');
  expect(frame.split('\n')).toHaveLength(3);
  expect(frame.split('\n').every(line => line.length <= 28)).toBe(true);
  expect(frame).not.toContain('nvapi-');
});

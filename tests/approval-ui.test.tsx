import React from 'react';
import { Box } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it } from 'vitest';
import { ApprovalPanel } from '../src/ui/ApprovalPanel.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 70));
afterEach(cleanup);
const request = { id: 'request', kind: 'edits' as const, tool: 'apply_edits_batch', summary: 'Edit a.ts', preview: '-before\n+after' };

it('shows the exact preview and requires an explicit yes instead of Enter', async () => {
  const decisions: boolean[] = [];
  const app = render(<Box width={60}><ApprovalPanel request={request} columns={60} maxRows={12} onDecision={value => decisions.push(value)} onCancel={() => {}} /></Box>);
  await tick();
  expect(app.lastFrame()).toContain('-before'); expect(app.lastFrame()).toContain('+after');
  app.stdin.write('\r'); await tick(); expect(decisions).toEqual([]);
  app.stdin.write('y'); await tick(); expect(decisions).toEqual([true]);
});

it('supports denial and scrolls a long preview without terminal escape injection', async () => {
  const decisions: boolean[] = [];
  const preview = Array.from({ length: 30 }, (_, index) => `+line-${index}`).join('\n') + '\n\x1b[2JEND';
  const app = render(<Box width={40}><ApprovalPanel request={{ ...request, preview }} columns={40} maxRows={10} onDecision={value => decisions.push(value)} onCancel={() => {}} /></Box>);
  await tick(); expect(app.lastFrame()).toContain('+line-0'); expect(app.lastFrame()).not.toContain('END');
  app.stdin.write('\x05'); await tick(); expect(app.lastFrame()).toContain('END');
  app.stdin.write('n'); await tick(); expect(decisions).toEqual([false]);
});

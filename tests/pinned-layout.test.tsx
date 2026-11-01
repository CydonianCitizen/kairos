import React from 'react';
import { Box, Text } from 'ink';
import { render, cleanup } from 'ink-testing-library';
import { afterEach, expect, it } from 'vitest';
import { PinnedLayout } from '../src/ui/PinnedLayout.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 80));
afterEach(cleanup);

it('keeps the header and footer visible while long history is clipped between them', async () => {
  const header=<Text>KAIROS fixed header</Text>;const dock=<Text>model · Effort: auto · Ready</Text>;
  const entries=Array.from({length:40},(_,n)=><Box key={n} flexShrink={0}><Text>{`Message ${n}\nMore details ${n}`}</Text></Box>);
  const app=render(<PinnedLayout header={header} headerRows={1} entries={entries} rows={16} columns={60} minDockRows={1}>{dock}</PinnedLayout>);await tick();
  const viewport=app.lastFrame()!.split('\n').slice(-15);
  expect(viewport[0]).toBe('KAIROS fixed header');expect(viewport.at(-1)).toContain('model · Effort: auto · Ready');
  expect(viewport.join('\n')).toContain('Message 39');expect(viewport.join('\n')).not.toContain('Message 0\n');
});

it('uses remaining terminal rows to keep the input and footer at the bottom after history grows', async () => {
  const entries = [<Box key="first" marginBottom={1}><Text>{'First message\nSecond line'}</Text></Box>];
  const dock = <Box flexDirection="column"><Text>❯ Prompt</Text><Text>model · Effort: high</Text></Box>;
  const app = render(<PinnedLayout entries={entries} rows={16} columns={50} minDockRows={2}>{dock}</PinnedLayout>);
  await tick();
  expect(app.lastFrame()!.split('\n')).toHaveLength(15);
  expect(app.lastFrame()!.split('\n').at(-1)).toContain('model · Effort: high');
  const more = [...entries, <Box key="second" marginBottom={1}><Text>{'A new message '.repeat(12)}</Text></Box>];
  app.rerender(<PinnedLayout entries={more} rows={16} columns={50} minDockRows={2}>{dock}</PinnedLayout>); await tick();
  expect(app.lastFrame()!.split('\n')).toHaveLength(15);
  expect(app.lastFrame()!.split('\n').at(-1)).toContain('model · Effort: high');
  expect(app.lastFrame()!.match(/First message/g)).toHaveLength(1);
});
it('keeps the footer pinned when menus expand, close and the terminal height changes', async () => {
  const entries = [<Text key="history">{'History\n'.repeat(7).trimEnd()}</Text>];
  const prompt = <Box flexDirection="column"><Text>❯ Prompt</Text><Text>model · Effort: auto</Text></Box>;
  const app = render(<PinnedLayout entries={entries} rows={12} columns={50} minDockRows={2}>{prompt}</PinnedLayout>);
  await tick();
  app.rerender(<PinnedLayout entries={entries} rows={12} columns={50} minDockRows={9}>
    <Box flexDirection="column"><Text>{'Menu option\n'.repeat(7).trimEnd()}</Text>{prompt}</Box>
  </PinnedLayout>); await tick();
  const expandedLines = app.lastFrame()!.split('\n').length;
  app.rerender(<PinnedLayout entries={entries} rows={12} columns={50} minDockRows={2}>{prompt}</PinnedLayout>); await tick();
  expect(app.lastFrame()!.split('\n')).toHaveLength(expandedLines);
  expect(app.lastFrame()!.split('\n').at(-1)).toContain('model · Effort: auto');
  app.rerender(<PinnedLayout entries={entries} rows={18} columns={50} minDockRows={2}>{prompt}</PinnedLayout>); await tick();
  expect(app.lastFrame()!.split('\n').length).toBe(expandedLines + 6);
  expect(app.lastFrame()!.split('\n').at(-1)).toContain('model · Effort: auto');
});

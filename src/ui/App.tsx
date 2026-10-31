import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import type { UiController } from './controller.js';
import { DiffBlock } from './DiffBlock.js';
import { ToolCallBadge } from './ToolCallBadge.js';
import { StatusBar } from './StatusBar.js';
import { InputBox } from './InputBox.js';

export function App({ controller }: { controller: UiController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { exit } = useApp(); const { stdout } = useStdout();
  const [expanded, setExpanded] = useState(false);
  const [columns, setColumns] = useState(stdout.columns || 80);
  const [rows, setRows] = useState(stdout.rows || 24);
  useEffect(() => { const resize = () => { setColumns(stdout.columns || 80); setRows(stdout.rows || 24); }; stdout.on('resize', resize); return () => { stdout.off('resize', resize); }; }, [stdout]);
  useEffect(() => {
    const stop = () => exit(); controller.on('exit', stop); void controller.start();
    return () => { controller.off('exit', stop); controller.dispose(); };
  }, [controller, exit]);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') controller.cancelOrExit();
    if (key.escape) controller.cancel();
  });
  return <Box flexDirection="column" width={columns}>
    <Static items={state.history}>{entry => <Box key={entry.id} flexDirection="column" marginBottom={1}>
      {entry.kind === 'diff' ? <DiffBlock diff={entry.text} /> : entry.kind === 'tool' && entry.tool ? <ToolCallBadge tool={entry.tool} /> :
        <Text color={entry.kind === 'error' ? 'red' : entry.kind === 'user' ? 'cyan' : undefined} dimColor={entry.kind === 'info'}>{entry.kind === 'user' ? '› ' : entry.kind === 'assistant' ? 'nim › ' : ''}{entry.text}</Text>}
    </Box>}</Static>
    <Box flexDirection="column" height={Math.max(1, Math.min(rows - 2, 9 + (state.streaming ? 3 : 0) + (state.lastTool ? expanded ? 6 : 1 : 0)))} overflow="hidden">
    {state.streaming && <Box height={3} overflow="hidden"><Text>{state.streaming.slice(-Math.max(30, columns * 2)).split('\n').slice(-3).join('\n')}</Text></Box>}
    {state.lastTool && <ToolCallBadge tool={state.lastTool} expanded={expanded} />}
    <StatusBar state={state} />
    <InputBox controller={controller} busy={state.busy} onToggleDetails={() => setExpanded(value => !value)} />
    </Box>
  </Box>;
}

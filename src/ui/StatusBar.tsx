import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { UiState } from './controller.js';
export function StatusBar({ state }: { state: UiState }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (state.cooldownUntil <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [state.cooldownUntil]);
  const remaining = Math.max(0, state.cooldownUntil - now);
  return <Box flexDirection="column">
    <Text dimColor wrap="truncate">{state.model} · {state.graph ? `Graph: ${state.graph.files} files | ${state.graph.symbols} symbols${state.graph.diagnostics ? ` | ${state.graph.diagnostics} warnings` : ''}` : 'Graph: indexing'}</Text>
    <Text color={state.mode === 'plan' ? 'yellow' : 'gray'} wrap="truncate">{state.mode ?? 'build'} · {state.sessionId ? `Session: ${state.sessionId.slice(0, 8)}` : 'Session: memory'} · Queue: {state.queued ?? 0}</Text>
    <Box gap={1}><Text color={state.busy ? 'cyan' : 'green'}>{state.busy ? state.activity : 'Ready'}</Text><Text color={remaining ? 'yellow' : 'gray'}>{remaining ? `${state.cooldownReason === 'retry' ? 'Retry' : 'Cooling down'}: ${(remaining / 1000).toFixed(1)}s` : 'NIM Ready'}</Text></Box>
  </Box>;
}

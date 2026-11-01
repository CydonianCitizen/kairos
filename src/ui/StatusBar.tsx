import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { UiState } from './controller.js';
import { theme } from './theme.js';
import { modelName } from './text.js';
import { RoamingMascot, type KaironMood } from './RoamingMascot.js';
import stringWidth from 'string-width';
export function ActivityBar({ state, showMascot = false, columns = 80 }: { state: UiState; showMascot?: boolean; columns?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (state.cooldownUntil <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [state.cooldownUntil]);
  const remaining = Math.max(0, state.cooldownUntil - now);
  const waitText = `${state.cooldownReason === 'retry' ? 'Retry' : 'Cooling down'}: ${(remaining / 1000).toFixed(1)}s`;
  const mood: KaironMood = remaining ? state.cooldownReason === 'retry' ? 'error' : 'pacing'
    : state.busy ? 'thinking' : state.history.at(-1)?.kind === 'error' ? 'error' : 'idle';
  return <Box flexDirection="column">
    {showMascot && <RoamingMascot mood={mood} columns={columns} statusText={remaining ? waitText : state.busy ? state.activity : mood === 'error' ? 'Check the error above' : undefined} />}
  </Box>;
}

export function StatusBar({ state, columns = 80 }: { state: UiState; columns?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now()); if (state.cooldownUntil <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(timer);
  }, [state.cooldownUntil]);
  const remaining = Math.max(0, state.cooldownUntil - now);
  const status = remaining ? `${state.cooldownReason === 'retry' ? 'Retry' : 'Wait'} ${(remaining / 1000).toFixed(1)}s` : state.busy ? state.activity : state.queuePaused ? 'Queue paused' : 'Ready';
  const model = modelName(state.model); const effort = ` · Effort: ${state.effort ?? 'auto'}`;
  const hint = columns >= 80 ? '/help for commands' : '';
  const contentColumns = columns - (hint ? stringWidth(hint) + 2 : 0);
  const parts = [status, state.mode ?? 'build'];
  if (state.scope && state.scope !== 'workspace') parts.push(`scope:${state.scope}`);
  if (state.graph) parts.push(`AST ${state.graph.files}/${state.graph.symbols}${state.graph.diagnostics ? ` !${state.graph.diagnostics}` : ''}`);
  else parts.push('AST …');
  if (state.queued) parts.push(`Q${state.queued}${state.queuePaused ? ' paused' : ''}`);
  if (state.context?.references) parts.push(`Refs ${state.context.references}:${state.context.chars}/${state.context.maxChars}`);
  if (state.sideBusy) parts.push('btw…');
  if(state.backgroundRunning)parts.push(`Tasks ${state.backgroundRunning}`);
  const session = state.sessionId ? `#${state.sessionId.slice(0, 8)}` : 'memory';
  if (stringWidth(model + effort + ' · ' + [...parts, `Q${state.queued ?? 0}`, session].join(' · ')) <= contentColumns - 2) {
    if (!state.queued) parts.push('Q0'); parts.push(session);
  }
  return <Box width={columns} paddingX={1} height={1} overflow="hidden">
    <Box width={Math.max(1, Math.min(stringWidth(model), Math.floor(columns * 0.32)))} flexShrink={0}><Text color={theme.nvidia} wrap="truncate">{model}</Text></Box>
    <Box flexShrink={0}><Text color={theme.brand}>{effort}</Text></Box>
    <Box flexGrow={1} flexShrink={1} minWidth={0}><Text wrap="truncate" color={remaining ? state.cooldownReason === 'retry' ? theme.nimError : theme.brandAccent : theme.borderMuted}> · {parts.join(' · ')}</Text></Box>
    {!!hint && <Box marginLeft={2} flexShrink={0}><Text color={theme.borderMuted}>{hint}</Text></Box>}
  </Box>;
}

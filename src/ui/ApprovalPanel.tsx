import { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalRequest } from '../core/permissions.js';
import { layoutPrompt } from './prompt-editor.js';
import { safeText } from './text.js';
import { theme } from './theme.js';

export function ApprovalPanel({ request, columns, maxRows, onDecision, onCancel }: {
  request: ApprovalRequest; columns: number; maxRows: number;
  onDecision: (allowed: boolean) => void; onCancel: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const compact = maxRows < 7;
  const bodyRows = Math.max(1, maxRows - (compact ? 2 : 6));
  const lines = useMemo(() => layoutPrompt(safeText(request.preview || request.summary), -1, Math.max(1, columns - 4)).rows.map(row => row.cells.map(cell => cell.text).join('')), [request, columns]);
  const end = Math.max(0, lines.length - bodyRows);
  const start = Math.min(offset, end);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) { onCancel(); return; }
    if (key.ctrl && input === 'e') { setOffset(end); return; }
    if (key.ctrl && input === 'a') { setOffset(0); return; }
    if (key.upArrow || key.pageUp) setOffset(Math.max(0, start - (key.pageUp ? bodyRows : 1)));
    if (key.downArrow || key.pageDown) setOffset(Math.min(end, start + (key.pageDown ? bodyRows : 1)));
    if (!key.ctrl && !key.meta && input.toLowerCase() === 'y') onDecision(true);
    if (!key.ctrl && !key.meta && input.toLowerCase() === 'n') onDecision(false);
  });
  return <Box flexDirection="column" borderStyle={compact ? undefined : 'round'} borderColor={theme.brand} paddingX={1}>
    <Text bold color={theme.brand} wrap="truncate">Approval required · {safeText(request.tool)}</Text>
    {!compact && <Text color={theme.textPrimary} wrap="truncate">{safeText(request.summary)}</Text>}
    <Box flexDirection="column" height={bodyRows} overflow="hidden">
      {lines.slice(start, start + bodyRows).map((line, index) => <Text key={start + index} wrap="truncate" color={line.startsWith('+') ? theme.nimReady : line.startsWith('-') ? theme.nimError : theme.textPrimary}>{line || ' '}</Text>)}
    </Box>
    {!compact && <Text color={theme.borderMuted} wrap="truncate">Lines {start + 1}–{Math.min(lines.length, start + bodyRows)}/{lines.length} · ↑↓/PgUp/PgDn · Ctrl+E end</Text>}
    <Text color={theme.brand} wrap="truncate">y allow once · n deny · Esc cancel</Text>
  </Box>;
}

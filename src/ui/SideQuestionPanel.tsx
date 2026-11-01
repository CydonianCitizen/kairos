import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SideQuestionDisplay } from './controller.js';
import { layoutPrompt } from './prompt-editor.js';
import { modelName, safeText } from './text.js';
import { theme } from './theme.js';

interface Props {
  question: SideQuestionDisplay; pending: boolean; mainBusy: boolean; columns: number; maxRows: number;
  onHide: () => void; onCancel: () => void; onClear: () => void;
}
export function SideQuestionPanel({ question, pending, mainBusy, columns, maxRows, onHide, onCancel, onClear }: Props) {
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (question.cooldownUntil <= Date.now()) return;
    setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [question.cooldownUntil]);
  const compact = maxRows < 7;
  const bodyRows = Math.max(1, maxRows - (compact ? 2 : 6));
  const error = question.result && question.result.status !== 'completed';
  const text = safeText(error ? `${question.result!.status}: ${question.result!.error ?? ''}` : question.result?.text ?? question.streaming);
  const lines = useMemo(() => layoutPrompt(text || (pending ? 'Waiting for NIM…' : ''), -1, Math.max(1, columns - (compact ? 2 : 4))).rows.map(row => row.cells.map(cell => cell.text).join('')), [text, pending, columns, compact]);
  const start = Math.min(offset, Math.max(0, lines.length - bodyRows));
  useInput((input, key) => {
    if (key.escape) { onHide(); return; }
    if (key.ctrl && input === 'c') { onCancel(); return; }
    if (!pending && (key.return || input === ' ')) { onHide(); return; }
    if (!pending && input === 'x') { onClear(); return; }
    if (key.upArrow) setOffset(Math.max(0, start - 1));
    if (key.downArrow) setOffset(Math.min(Math.max(0, lines.length - bodyRows), start + 1));
  });
  const remaining = Math.max(0, question.cooldownUntil - now);
  return <Box flexDirection="column" borderStyle={compact ? undefined : 'round'} borderColor={theme.graph} paddingX={1}>
    <Text bold color={theme.graph} wrap="truncate">Side question · {modelName(question.model)}</Text>
    {!compact && <Text color={theme.brand} wrap="truncate">{safeText(question.question)}</Text>}
    <Box flexDirection="column" height={bodyRows} overflow="hidden">
      {lines.slice(start, start + bodyRows).map((line, index) => <Text key={start + index} color={error ? theme.nimError : theme.textPrimary} wrap="truncate">{line || ' '}</Text>)}
    </Box>
    <Text color={theme.borderMuted} wrap="truncate">{remaining ? `${question.cooldownReason === 'retry' ? 'Retry' : 'Cooling down'}: ${(remaining / 1000).toFixed(1)}s` : pending ? 'Thinking…' : `${start + 1}–${Math.min(lines.length, start + bodyRows)}/${lines.length}`}{mainBusy ? ' · Main agent running' : ''}</Text>
    {!compact && <Text color={theme.borderMuted} wrap="truncate">↑↓ scroll · Esc back · {pending ? 'Ctrl+C stop side question' : 'Enter close · x clear side history'}</Text>}
  </Box>;
}

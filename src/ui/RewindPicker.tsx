import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { RewindSummary } from '../core/rewind-store.js';
import { safeText } from './text.js';
import { theme } from './theme.js';

interface RewindPickerProps {
  points: readonly RewindSummary[];
  maxRows?: number;
  onSelect: (id: string, scope: 'conversation' | 'files' | 'both') => void;
  onCancel: () => void;
}
const scopes = ['both', 'conversation', 'files'] as const;
const scopeLabels = ['Conversation + files', 'Conversation only', 'Files only'];
const oneLine = (text: string) => safeText(text).replace(/\s+/g, ' ').trim();

export function RewindPicker({ points, maxRows = 10, onSelect, onCancel }: RewindPickerProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [scope, setScope] = useState(0);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = [...points].reverse().filter(point => {
    const text = oneLine(`${point.prompt} ${point.id} ${point.createdAt}`).toLowerCase();
    return terms.every(term => text.includes(term));
  });
  const rows = Math.max(4, Number.isFinite(maxRows) ? Math.floor(maxRows) : 10);
  const compact = rows < 8;
  const explain = rows >= 9;
  const chrome = (compact ? 3 : 5) + (explain ? 1 : 0);
  const itemRows = compact ? 1 : 2;
  const visible = Math.max(1, Math.min(matches.length, Math.floor((rows - chrome) / itemRows)));
  const index = matches.length ? selected % matches.length : 0;
  const start = Math.max(0, Math.min(index - Math.floor(visible / 2), matches.length - visible));
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) { onCancel(); return; }
    if (matches.length && key.upArrow) setSelected(n => (n + matches.length - 1) % matches.length);
    if (matches.length && key.downArrow) setSelected(n => (n + 1) % matches.length);
    if (key.leftArrow) setScope(n => (n + scopes.length - 1) % scopes.length);
    if (key.rightArrow) setScope(n => (n + 1) % scopes.length);
  });
  return <Box flexDirection="column" borderStyle={compact ? undefined : 'round'} borderColor={theme.brand} paddingX={1}>
    <Text color={theme.brand} bold wrap="truncate">Rewind prompt{matches.length ? ` · ${index + 1}/${matches.length}` : ''} · {scopeLabels[scope]}</Text>
    <Box height={1} overflow="hidden">
      <Box flexShrink={0}><Text color={theme.borderMuted}>Search: </Text></Box>
      <TextInput value={query} placeholder="Prompt, ID or date" onChange={next => {
        const clean = safeText(next).replace(/[\r\n\t]/g, ' ').slice(0, 128);
        if (clean !== query) { setQuery(clean); setSelected(0); }
      }} onSubmit={() => { if (matches[index]) onSelect(matches[index]!.id, scopes[scope]!); }} />
    </Box>
    {!matches.length && <Text color={theme.borderMuted} wrap="truncate">{points.length ? 'No matching prompts' : 'No rewind points yet'}</Text>}
    {matches.slice(start, start + visible).map((point, offset) => {
      const active = start + offset === index;
      const date = new Date(point.createdAt);
      const created = Number.isNaN(date.valueOf()) ? oneLine(point.createdAt) : date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
      return <Box key={point.id} flexDirection="column">
        <Text color={active ? theme.brand : theme.textPrimary} bold={active} wrap="truncate">{active ? '› ' : '  '}{oneLine(point.prompt) || 'Empty prompt'}</Text>
        {!compact && <Text color={theme.borderMuted} wrap="truncate">  {created} · {oneLine(point.id).slice(0, 8)}</Text>}
      </Box>;
    })}
    {explain && <Text color={theme.borderMuted} wrap="truncate">Shell/plugin changes are not restored</Text>}
    <Text color={theme.borderMuted} wrap="truncate">↑↓ prompt · ←→ scope · Enter restore · Esc cancel</Text>
  </Box>;
}

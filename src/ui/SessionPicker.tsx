import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { SessionInfo } from '../core/session-store.js';
import { safeText, modelName } from './text.js';
import { theme } from './theme.js';

interface SessionPickerProps {
  sessions: readonly SessionInfo[];
  currentId?: string;
  maxRows: number;
  pending?: boolean;
  error?: string;
  onSelect: (id: string) => void;
  onCancel: () => void;
}
const titleOf = (session: SessionInfo) => safeText(session.name ?? session.title ?? '').replace(/\s+/g, ' ').trim() || 'Empty session';

export function SessionPicker({ sessions, currentId, maxRows, pending = false, error, onSelect, onCancel }: SessionPickerProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => Math.max(0, sessions.findIndex(session => session.id !== currentId)));
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = sessions.filter(session => {
    const text = `${titleOf(session)} ${safeText(session.title ?? '')} ${session.id} ${session.updatedAt} ${session.model} ${session.mode}`.toLowerCase();
    return terms.every(term => text.includes(term));
  });
  const compact = maxRows < 7;
  const chrome = (compact ? 3 : 5) + (error ? 1 : 0);
  const itemRows = compact ? 1 : 2;
  const visible = Math.max(1, Math.min(matches.length, Math.floor((maxRows - chrome) / itemRows)));
  const index = matches.length ? selected % matches.length : 0;
  const start = Math.max(0, Math.min(index - Math.floor(visible / 2), matches.length - visible));
  useInput((input, key) => {
    if (pending) return;
    if (key.escape || (key.ctrl && input === 'c')) { onCancel(); return; }
    if (matches.length && key.upArrow) setSelected(n => (n + matches.length - 1) % matches.length);
    if (matches.length && key.downArrow) setSelected(n => (n + 1) % matches.length);
  });
  return <Box flexDirection="column" borderStyle={compact ? undefined : 'round'} borderColor={theme.brand} paddingX={1}>
    <Text color={theme.brand} bold wrap="truncate">Resume session{matches.length ? ` · ${index + 1}/${matches.length}` : ''}</Text>
    <Box height={1} overflow="hidden">
      <Box flexShrink={0}><Text color={theme.borderMuted}>Search: </Text></Box>
      <TextInput value={query} focus={!pending} placeholder="Prompt, ID, model or date" onChange={next => {
        const clean = safeText(next).replace(/[\r\n\t]/g, ' ').slice(0, 128);
        if (clean !== query) { setQuery(clean); setSelected(0); }
      }} onSubmit={() => { if (!pending && matches[index]) onSelect(matches[index]!.id); }} />
    </Box>
    {!!error && <Text color={theme.nimError} wrap="truncate">{safeText(error)}</Text>}
    {!matches.length && <Text color={theme.borderMuted} wrap="truncate">{sessions.length ? 'No sessions found' : 'No saved sessions for this project'}</Text>}
    {matches.slice(start, start + visible).map((session, offset) => {
      const active = start + offset === index;
      const date = new Date(session.updatedAt);
      const updated = Number.isNaN(date.valueOf()) ? safeText(session.updatedAt) : date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
      return <Box key={session.id} flexDirection="column">
        <Text color={active ? theme.brand : theme.textPrimary} bold={active} wrap="truncate">{active ? '› ' : '  '}{session.id === currentId ? '(current) ' : ''}{titleOf(session)}</Text>
        {!compact && <Text color={theme.borderMuted} wrap="truncate">  {updated} · {modelName(session.model)} · {session.mode} · {session.id.slice(0, 8)}</Text>}
      </Box>;
    })}
    <Text color={theme.borderMuted} wrap="truncate">{pending ? 'Opening session…' : 'Type to filter · ↑↓ · Enter resume · Esc back'}</Text>
  </Box>;
}

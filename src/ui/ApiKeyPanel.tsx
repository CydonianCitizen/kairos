import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { safeText } from './text.js';
import { theme } from './theme.js';

interface ApiKeyPanelProps {
  path: string;
  required?: boolean;
  saving?: boolean;
  error?: string;
  maxRows?: number;
  onSave: (key: string) => void;
  onCancel: () => void;
}

export function ApiKeyPanel({ path, required = false, saving = false, error, maxRows = 6, onSave, onCancel }: ApiKeyPanelProps) {
  const [value, setValue] = useState('');
  const [tooLong, setTooLong] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const compact = maxRows < 4;
  const bordered = maxRows >= 6;
  useInput((input, key) => {
    if (!saving && (key.escape || key.ctrl && input === 'c')) onCancel();
  });
  const change = (next: string) => {
    if (saving) return;
    const clean = next.trim();
    const malformed = !!clean && !/^[A-Za-z0-9._/-]+$/.test(clean);
    setInvalid(malformed);
    setTooLong(clean.length > 4096);
    if (!malformed && clean.length <= 4096) setValue(clean);
  };
  const submit = () => {
    if (!saving && !tooLong && !invalid && value.trim()) onSave(value.trim());
  };
  const status = saving ? 'Saving API key…'
    : tooLong ? 'Key limit: 4096 characters'
    : invalid ? 'Invalid key · paste again or Esc cancel'
    : error ? 'Save failed · Enter retry · Esc cancel'
    : 'Enter save · Esc cancel';
  return <Box flexDirection="column" borderStyle={bordered ? 'round' : undefined} borderColor={theme.brand} paddingX={bordered ? 1 : 0}>
    <Text color={theme.brand} bold wrap="truncate">NVIDIA API key{required ? ' · required' : ''}{compact ? ` · ${safeText(path)}` : ''}</Text>
    {!compact && <Text color={theme.borderMuted} wrap="truncate">Save to {safeText(path)}</Text>}
    <Box height={1} overflow="hidden">
      <Text color={theme.brand}>❯ </Text>
      <Box flexGrow={1} minWidth={0}>
        <Text wrap="truncate"><TextInput value={value} onChange={change} onSubmit={submit} mask="*" focus={!saving} highlightPastedText={false} placeholder="Paste API key" /></Text>
      </Box>
    </Box>
    <Text color={error || tooLong || invalid ? theme.nimError : theme.borderMuted} wrap="truncate">{status}</Text>
  </Box>;
}

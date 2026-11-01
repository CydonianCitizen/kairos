import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { effortLevels, type Effort } from '../config/effort.js';
import { modelName } from './text.js';
import { theme } from './theme.js';

export function EffortPicker({ model, effort, maxRows, onSelect, onCancel }: {
  model: string; effort: Effort; maxRows: number; onSelect: (effort: Effort) => void; onCancel: () => void;
}) {
  const levels = effortLevels(model);
  const [selected, setSelected] = useState(() => Math.max(0, levels.indexOf(effort)));
  const spacing = maxRows >= 10 ? 1 : 0;
  const visible = Math.max(1, Math.min(levels.length, maxRows - 4 - spacing * 2 - (levels.length === 1 ? 1 : 0)));
  const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), levels.length - visible));
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) { onCancel(); return; }
    if (key.upArrow) setSelected(index => (index + levels.length - 1) % levels.length);
    if (key.downArrow) setSelected(index => (index + 1) % levels.length);
    if (key.return) onSelect(levels[selected]!);
  });
  return <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
    <Text color={theme.brand} bold wrap="truncate">Reasoning effort · {modelName(model)}</Text>
    {levels.length === 1 && <Text color={theme.borderMuted} wrap="truncate">Only auto: effort support unverified.</Text>}
    <Box flexDirection="column" marginY={spacing}>
      {levels.slice(start, start + visible).map((level, offset) => <Text key={level} color={selected === start + offset ? theme.brand : theme.textPrimary} bold={selected === start + offset} wrap="truncate">
        {selected === start + offset ? '›' : ' '} {level}{level === 'auto' ? ' · model default' : ''}{level === effort ? ' (current)' : ''}
      </Text>)}
    </Box>
    <Text color={theme.borderMuted} wrap="truncate">↑↓ move · Enter select · Esc back</Text>
  </Box>;
}

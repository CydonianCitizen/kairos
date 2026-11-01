import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { MODELS } from '../config/models.js';
import { theme } from './theme.js';
import { modelName } from './text.js';
import TextInput from 'ink-text-input';

interface ModelPickerProps {
  model: string;
  models?: readonly string[];
  maxRows: number;
  onSelect: (model: string) => void;
  onCancel: () => void;
}

export function ModelPicker({ model, models: availableModels = MODELS.map(entry => entry.id), maxRows, onSelect, onCancel }: ModelPickerProps) {
  const allModels = [...availableModels];
  if (!allModels.includes(model)) allModels.push(model);
  const [query, setQuery] = useState('');
  const models = allModels.filter(id => modelName(id).toLowerCase().includes(query.trim().toLowerCase()));
  const [selected, setSelected] = useState(() => allModels.indexOf(model));
  const spacing = maxRows >= 10 ? 1 : 0;
  const visible = Math.max(1, Math.min(models.length, maxRows - 5 - spacing * 2));
  const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), models.length - visible));
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) { onCancel(); return; }
    if (models.length && key.upArrow) setSelected(index => (index + models.length - 1) % models.length);
    if (models.length && key.downArrow) setSelected(index => (index + 1) % models.length);
  });
  return <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
    <Text color={theme.brand} bold wrap="truncate">Select model</Text>
    <Box><Box flexShrink={0}><Text color={theme.borderMuted}>Search: </Text></Box><TextInput value={query} placeholder="Type a model name" onChange={next => {
      const clean = next.replace(/[\u0000-\u001f\u007f]/g, '');
      if (clean !== query) { setQuery(clean); setSelected(0); }
    }} onSubmit={() => { if (models[selected]) onSelect(models[selected]!); }} /></Box>
    <Box flexDirection="column" marginY={spacing}>
      {!models.length && <Text color={theme.borderMuted}>No models found</Text>}
      {models.slice(start, start + visible).map((id, offset) => {
        const index = start + offset;
        return <Text key={id} color={index === selected ? theme.brand : id === model ? theme.graph : theme.textPrimary} bold={index === selected} wrap="truncate">
          {index === selected ? '›' : ' '} {index + 1}. {modelName(id)}{id === model ? ' (current)' : ''}
        </Text>;
      })}
    </Box>
    <Text color={theme.borderMuted} wrap="truncate">Type to filter · ↑↓ · Enter · Esc</Text>
  </Box>;
}

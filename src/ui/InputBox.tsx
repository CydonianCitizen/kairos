import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { UiController } from './controller.js';
export function InputBox({ controller, busy, onToggleDetails }: { controller: UiController; busy: boolean; onToggleDetails: () => void }) {
  const [value, setValue] = useState(''); const [selected, setSelected] = useState(0); const [revision, setRevision] = useState(0);
  const suggestions = controller.suggestions(value);
  useInput((_input, key) => {
    if (key.tab && suggestions.length) {
      const choice = suggestions[selected % suggestions.length]!;
      setValue(value.startsWith('/') ? choice + ' ' : value.replace(/@[^\s]*$/, `@${choice} `));
      setSelected(0); setRevision(n => n + 1);
    }
    if (key.tab && !suggestions.length) onToggleDetails();
    if (key.downArrow && suggestions.length) setSelected(n => (n + 1) % suggestions.length);
    if (key.upArrow && suggestions.length) setSelected(n => (n + suggestions.length - 1) % suggestions.length);
  });
  return <Box flexDirection="column">
    <Box borderStyle="round" borderColor={busy ? 'gray' : 'cyan'} paddingX={1}>
      <TextInput key={revision} value={value} onChange={next => { setValue(next.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')); setSelected(0); }} onSubmit={input => { setValue(''); setRevision(n => n + 1); void controller.submit(input); }} placeholder={busy ? 'Queue a follow-up · /steer to guide · Esc to cancel' : 'Ask a question · /help · @file or @symbol'} />
    </Box>
    {!!suggestions.length && <Text dimColor wrap="truncate">Tab → {suggestions.map((item, i) => i === selected % suggestions.length ? `[${item}]` : item).join('  ')}</Text>}
    <Text dimColor>Tab complete / tool details · Ctrl+C {busy ? 'cancel' : 'exit'}</Text>
  </Box>;
}

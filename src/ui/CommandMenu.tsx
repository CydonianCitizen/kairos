import { Box, Text } from 'ink';
import type { CommandSuggestion } from './commands.js';
import { safeText } from './text.js';
import { theme } from './theme.js';

export function CommandMenu({ commands, selected, maxVisible }: { commands: CommandSuggestion[]; selected: number; maxVisible: number }) {
  const visible = Math.max(1, Math.min(commands.length, maxVisible));
  const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), commands.length - visible));
  return <Box flexDirection="column">
    <Text color={theme.borderMuted} wrap="truncate">Commands · {start + 1}–{start + visible} / {commands.length}</Text>
    {commands.slice(start, start + visible).map((command, offset) => <Text key={command.name} wrap="truncate">
      <Text color={selected === start + offset ? theme.brand : theme.textPrimary} bold={selected === start + offset}>
        {selected === start + offset ? '›' : ' '} {safeText(command.name).padEnd(13)}
      </Text>
      <Text color={theme.borderMuted}>{safeText(command.description)}</Text>
    </Text>)}
  </Box>;
}

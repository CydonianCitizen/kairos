import { Box, Text } from 'ink';
import { safeText } from './text.js';
import { theme } from './theme.js';
export function DiffBlock({ diff, maxLines = 24 }: { diff: string; maxLines?: number }) {
  const lines = safeText(diff).trimEnd().split('\n');
  const visible = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  return (
    <Box flexDirection="column">
      {visible.map((line, index) => (
        <Text key={index} color={line.startsWith('+') ? theme.nimReady : line.startsWith('-') ? theme.nimError : line.startsWith('@@') ? theme.graph : theme.textPrimary}>
          {line || ' '}
        </Text>
      ))}
      {remaining > 0 && (
        <Text color={theme.borderMuted}>  … ({remaining} more diff lines, use /diff to view full)</Text>
      )}
    </Box>
  );
}

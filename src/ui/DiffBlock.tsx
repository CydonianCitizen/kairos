import { Box, Text } from 'ink';
import { safeText } from './text.js';
import { theme } from './theme.js';
export function DiffBlock({ diff }: { diff: string }) {
  return <Box flexDirection="column">{safeText(diff).trimEnd().split('\n').map((line, index) =>
    <Text key={index} color={line.startsWith('+') ? theme.nimReady : line.startsWith('-') ? theme.nimError : line.startsWith('@@') ? theme.graph : theme.textPrimary}>{line || ' '}</Text>)}</Box>;
}

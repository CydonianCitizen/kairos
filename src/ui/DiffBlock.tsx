import { Box, Text } from 'ink';
import { safeText } from './text.js';
export function DiffBlock({ diff }: { diff: string }) {
  return <Box flexDirection="column">{safeText(diff).trimEnd().split('\n').map((line, index) =>
    <Text key={index} color={line.startsWith('+') ? 'green' : line.startsWith('-') ? 'red' : line.startsWith('@@') ? 'cyan' : undefined}>{line || ' '}</Text>)}</Box>;
}

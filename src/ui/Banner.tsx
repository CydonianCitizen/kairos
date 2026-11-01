import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { safeText, modelName } from './text.js';

export { theme } from './theme.js';

interface BannerProps {
  version: string;
  model: string;
  graphStats?: { files: number; symbols: number };
  columns?: number;
}

export function Banner({ version, model, graphStats, columns = 80 }: BannerProps) {
  const wide = columns >= 80;
  const width = Math.max(1, columns - (wide ? 17 : 0));
  return <Box marginBottom={1} width={Math.max(1, columns)}>
    {wide && <Box flexDirection="column" width={14} flexShrink={0} marginRight={3}>
      <Text color={theme.brand} bold wrap="truncate">{'   ▄▄██▀    '}</Text>
      <Text wrap="truncate">
        <Text color={theme.brand}>{' ▄██ '}</Text>
        <Text color={theme.graph} bold>{'● ●'}</Text>
        <Text color={theme.brand}>{' █▄ '}</Text>
      </Text>
      <Text color={theme.brandAccent} bold wrap="truncate">{'  ▄█████▄   '}</Text>
      <Text wrap="truncate">
        <Text color={theme.brand} bold>{' ▀▄ '}</Text>
        <Text color={theme.brandAccent}>{'▀ ▀'}</Text>
        <Text color={theme.brand} bold>{' ▄▀ '}</Text>
      </Text>
      <Text color={theme.brandAccent} wrap="truncate">{'   ▀   ▀    '}</Text>
    </Box>}
    <Box flexDirection="column" width={width}>
      <Text wrap="truncate">
        <Text color={theme.brand} bold>K A I R O S</Text>
        <Text color={theme.brandAccent} bold>  (κ)</Text>
        <Text color={theme.borderMuted}>  v{safeText(version).replace(/^v/, '')}</Text>
      </Text>
      <Text color={theme.textPrimary} wrap="truncate">Right-Time Coding Agent · <Text color={theme.nimReady}>NVIDIA NIM</Text></Text>
      <Text color={theme.borderMuted}>{'─'.repeat(Math.min(46, width))}</Text>
      <Text wrap="truncate">
        <Text color={theme.graph}>● AST: {graphStats ? `${graphStats.files} files (${graphStats.symbols} symbols)` : 'indexing'}</Text>
        <Text color={theme.borderMuted}> │ </Text>
        <Text color={theme.brandAccent}>37.5 RPM</Text>
      </Text>
      <Text color={theme.nvidia} wrap="truncate">{modelName(model)}</Text>
    </Box>
  </Box>;
}

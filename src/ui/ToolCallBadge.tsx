import { Box, Text } from 'ink';
import type { ToolDisplay } from './controller.js';
import { safeText } from './text.js';
import { theme } from './theme.js';
export function ToolCallBadge({ tool, expanded = false }: { tool: ToolDisplay; expanded?: boolean }) {
  const status = !tool.result ? 'running' : tool.result.ok ? 'done' : 'failed';
  const details = expanded ? safeText(JSON.stringify(tool.result ?? { arguments: tool.arguments }, null, 2)).split('\n') : [];
  return <Box flexDirection="column"><Text color={status === 'failed' ? theme.nimError : status === 'running' ? theme.brandAccent : theme.borderMuted}>{expanded ? '▾' : '▸'} {safeText(tool.name)} · {status}{tool.result?.error ? ` · ${safeText(tool.result.error)}` : ''}</Text>
    {details.slice(0, 4).map((line, index) => <Text key={index} color={theme.textPrimary} wrap="truncate">{line}</Text>)}
    {details.length > 4 && <Text color={theme.borderMuted}>[details truncated]</Text>}</Box>;
}

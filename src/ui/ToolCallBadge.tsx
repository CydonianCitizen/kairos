import { Box, Text } from 'ink';
import type { ToolDisplay } from './controller.js';
import { safeText } from './text.js';
export function ToolCallBadge({ tool, expanded = false }: { tool: ToolDisplay; expanded?: boolean }) {
  const status = !tool.result ? 'running' : tool.result.ok ? 'done' : 'failed';
  const details = expanded ? safeText(JSON.stringify(tool.result ?? { arguments: tool.arguments }, null, 2)).split('\n') : [];
  return <Box flexDirection="column"><Text color={status === 'failed' ? 'red' : 'gray'}>{expanded ? '▾' : '▸'} {safeText(tool.name)} · {status}{tool.result?.error ? ` · ${safeText(tool.result.error)}` : ''}</Text>
    {details.slice(0, 4).map((line, index) => <Text key={index} dimColor wrap="truncate">{line}</Text>)}
    {details.length > 4 && <Text dimColor>[details truncated]</Text>}</Box>;
}

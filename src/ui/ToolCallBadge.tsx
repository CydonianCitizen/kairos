import { Box, Text } from 'ink';
import type { ToolDisplay } from './controller.js';
import { safeText } from './text.js';
import { theme } from './theme.js';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export function parseToolInfo(tool: ToolDisplay): {
  icon: string;
  action: string;
  target: string;
  detail: string;
  color: string;
} {
  const isFailed = tool.result && !tool.result.ok;
  const isRunning = !tool.result;
  const icon = isFailed ? '✖' : isRunning ? '●' : '✔';

  let action = tool.name;
  let target = '';
  let detail = tool.detail ?? '';

  let argsObj: Record<string, unknown> = {};
  if (typeof tool.arguments === 'string') {
    try { argsObj = object(JSON.parse(tool.arguments)); } catch {}
  }

  if (tool.name === 'read_files_batch') {
    action = 'Read';
    const paths = strings(argsObj.paths);
    if (paths.length === 1) target = paths[0]!;
    else if (paths.length > 1) target = `${paths.length} files (${paths.slice(0, 2).join(', ')}${paths.length > 2 ? '…' : ''})`;
  } else if (tool.name === 'apply_edits_batch') {
    action = 'Edited';
    const paths = Array.isArray(argsObj.edits) ? argsObj.edits.flatMap(edit => strings([object(edit).path])) : [];
    if (paths.length === 1) target = paths[0]!;
    else if (paths.length > 1) target = `${paths.length} files`;
  } else if (tool.name === 'run_bash') {
    action = 'Bash';
    const command = typeof argsObj.command === 'string' ? argsObj.command : '';
    target = command.length > 35 ? command.slice(0, 32) + '…' : command;
    if (tool.result?.result && typeof tool.result.result === 'object') {
      const exitCode = object(tool.result.result).exitCode;
      if (exitCode === null || typeof exitCode === 'number') detail = `(exit ${exitCode})`;
    }
  } else if (tool.name === 'load_skills_batch') {
    action = 'Skill';
    const names = strings(argsObj.names);
    target = names.map((n: string) => '$' + n).join(', ');
  } else if (tool.name === 'inspect_symbol_graph') {
    action = 'Inspect';
    const names = strings(argsObj.symbol_names);
    target = names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '');
  } else if (tool.name === 'get_repo_map') {
    action = 'Graph';
    target = typeof argsObj.directory === 'string' ? argsObj.directory : 'repo map';
  }

  if (tool.result?.error) {
    detail = `(${tool.result.error.slice(0, 30)})`;
  }

  const color = isFailed ? theme.nimError : isRunning ? theme.brandAccent : theme.nimReady;
  return { icon, action: safeText(action), target: safeText(target), detail: safeText(detail), color };
}

export function ToolCallBadge({ tool, expanded = false }: { tool: ToolDisplay; expanded?: boolean }) {
  const { icon, action, target, detail, color } = parseToolInfo(tool);
  const status = !tool.result ? 'running' : tool.result.ok ? 'done' : 'failed';
  const details = expanded ? safeText(JSON.stringify(tool.result ?? { arguments: tool.arguments }, null, 2)).split('\n') : [];

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={color}>{expanded ? '▾' : icon} </Text>
        <Text color={theme.textPrimary} bold>{action} </Text>
        {!!target && <Text color={theme.brand}>{target} </Text>}
        {!!detail && <Text color={theme.borderMuted}>{detail} </Text>}
        <Text color={theme.borderMuted}>· {status}</Text>
      </Box>
      {details.slice(0, 4).map((line, index) => (
        <Text key={index} color={theme.borderMuted} wrap="truncate">  {line}</Text>
      ))}
      {details.length > 4 && <Text color={theme.borderMuted}>  [details truncated]</Text>}
    </Box>
  );
}

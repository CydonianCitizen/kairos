import { Box, Text } from 'ink';
import type { ToolDisplay } from './controller.js';
import { safeText } from './text.js';
import { theme } from './theme.js';

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
  let detail = '';

  let argsObj: any = undefined;
  if (typeof tool.arguments === 'string') {
    try { argsObj = JSON.parse(tool.arguments); } catch {}
  } else if (tool.arguments && typeof tool.arguments === 'object') {
    argsObj = tool.arguments;
  }

  if (tool.name === 'read_files_batch') {
    action = 'Read';
    const paths = argsObj?.paths ?? [];
    if (paths.length === 1) target = paths[0];
    else if (paths.length > 1) target = `${paths.length} files (${paths.slice(0, 2).join(', ')}${paths.length > 2 ? '…' : ''})`;
  } else if (tool.name === 'apply_edits_batch') {
    action = 'Edited';
    const edits = argsObj?.edits ?? [];
    if (edits.length === 1) target = edits[0].path;
    else if (edits.length > 1) target = `${edits.length} files`;
    if (Array.isArray(tool.result?.result)) {
      let added = 0; let removed = 0;
      for (const res of tool.result.result) {
        if (res && typeof res.diff === 'string') {
          for (const line of res.diff.split('\n')) {
            if (line.startsWith('+') && !line.startsWith('+++')) added++;
            else if (line.startsWith('-') && !line.startsWith('---')) removed++;
          }
        }
      }
      if (added || removed) detail = `(+${added} -${removed})`;
    }
  } else if (tool.name === 'run_bash') {
    action = 'Bash';
    target = argsObj?.command ? (argsObj.command.length > 35 ? argsObj.command.slice(0, 32) + '…' : argsObj.command) : '';
    if (tool.result?.result && typeof tool.result.result === 'object') {
      const exitCode = (tool.result.result as any).exitCode;
      if (exitCode !== undefined) detail = exitCode === 0 ? '(exit 0)' : `(exit ${exitCode})`;
    }
  } else if (tool.name === 'load_skills_batch') {
    action = 'Skill';
    const names = argsObj?.names ?? [];
    target = names.map((n: string) => '$' + n).join(', ');
  } else if (tool.name === 'inspect_symbol_graph') {
    action = 'Inspect';
    const names = argsObj?.symbol_names ?? [];
    target = names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '');
  } else if (tool.name === 'get_repo_map') {
    action = 'Graph';
    target = argsObj?.directory ?? 'repo map';
  }

  if (tool.result?.error) {
    detail = `(${tool.result.error.slice(0, 30)})`;
  }

  const color = isFailed ? theme.nimError : isRunning ? theme.brandAccent : theme.nimReady;
  return { icon, action, target, detail, color };
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

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
export function parseCliArgs(args: string[]) {
  const { values } = parseArgs({ args, allowPositionals: false, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    cwd: { type: 'string' }, model: { type: 'string', short: 'm' }, prompt: { type: 'string', short: 'p' },
    'max-iterations': { type: 'string' }, 'max-context-chars': { type: 'string' },
    mode: { type: 'string' }, session: { type: 'string' }, 'session-dir': { type: 'string' }, continue: { type: 'boolean' },
    'no-session': { type: 'boolean' }, json: { type: 'boolean' }, rpc: { type: 'boolean' }, 'trust-workspace': { type: 'boolean' },
    'list-sessions': { type: 'boolean' }, compaction: { type: 'string' },
  } });
  const number = (value: string | undefined, fallback: number, min: number, max: number) => {
    if (value !== undefined && !/^\d+$/.test(value)) throw new Error(`Expected an integer, received: ${value}`);
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`Expected a value from ${min} to ${max}`);
    return result;
  };
  if (values.model && !/^[\w.-]+\/[\w.-]+$/.test(values.model)) throw new Error('Model must be provider/model');
  if (values.prompt !== undefined && !values.prompt.trim()) throw new Error('Prompt must not be empty');
  if (values.mode && !['plan','build'].includes(values.mode)) throw new Error('Mode must be plan or build');
  if (values.compaction && !['local','model'].includes(values.compaction)) throw new Error('Compaction must be local or model');
  if ((values.rpc && (values.json || values.prompt !== undefined)) || (values.json && values.prompt === undefined)) throw new Error('Use --rpc alone or --json with --prompt');
  if ((values['no-session'] && (values.session || values.continue)) || (values.session && values.continue)) throw new Error('Choose only one of --session, --continue, --no-session');
  return { help: values.help ?? false, version: values.version ?? false, cwd: resolve(values.cwd ?? process.cwd()), model: values.model, prompt: values.prompt,
    mode: values.mode as 'build' | 'plan' | undefined, session: values.session, sessionDir: values['session-dir'] ? resolve(values['session-dir']) : undefined,
    continue: values.continue ?? false, noSession: values['no-session'] ?? false, json: values.json ?? false, rpc: values.rpc ?? false,
    trustWorkspace: values['trust-workspace'] ?? false, listSessions: values['list-sessions'] ?? false, compaction: (values.compaction ?? 'model') as 'model' | 'local',
    maxIterations: number(values['max-iterations'], 12, 1, 100), maxContextChars: number(values['max-context-chars'], 64000, 16000, 1000000) };
}
export const CLI_HELP = `nim-codex — inline NVIDIA NIM coding agent

Usage: nim-codex [options]
  -h, --help                   Show help without an API key
  -v, --version                Show version
  --cwd <directory>            Workspace (default: current directory)
  -m, --model <provider/model> NVIDIA NIM model
  -p, --prompt <text>          Run one turn in plain output mode (also for pipes)
  --max-iterations <1..100>    Maximum model iterations (default: 12)
  --max-context-chars <count>  Request context budget (default: 64000)
  --mode <plan|build>          Plan blocks edits, shell and external calls
  --session <id> | --continue Resume a session or the latest workspace session
  --session-dir <directory>   Journal directory (default: ~/.nim-codex/sessions)
  --no-session                Disable persistence for this invocation
  --list-sessions             List workspace sessions without an API key
  --compaction <model|local>  Summary strategy (default: model, local fallback)
  --trust-workspace           Load AGENTS.md, .nim skills/plugins/MCP config
  --json --prompt <text>      JSONL events and final result
  --rpc                      JSON-RPC over stdin/stdout

Interactive commands: /model /plan /build /sessions /resume /new /compact
                      /skills /skill /extensions /mcp /steer /queue /help /exit
Requires NVIDIA_API_KEY in the environment or workspace .env.
`;

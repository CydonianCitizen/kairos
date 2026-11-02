import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { EFFORTS, type Effort } from './config/effort.js';
import type { WorkspaceScope } from './tools/fs-tools.js';
export function parseCliArgs(args: string[]) {
  const { values } = parseArgs({ args, allowPositionals: false, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    cwd: { type: 'string' }, model: { type: 'string', short: 'm' }, prompt: { type: 'string', short: 'p' },
    'max-iterations': { type: 'string' }, 'max-context-chars': { type: 'string' },
    mode: { type: 'string' }, session: { type: 'string' }, 'session-dir': { type: 'string' }, continue: { type: 'boolean' },
    'no-session': { type: 'boolean' }, json: { type: 'boolean' }, rpc: { type: 'boolean' }, 'trust-workspace': { type: 'boolean' },
    'list-sessions': { type: 'boolean' }, compaction: { type: 'string' },
    effort: { type: 'string' }, 'system-prompt': { type: 'string' }, 'timeout-ms': { type: 'string' }, 'check-models': { type: 'boolean' },
    permissions: { type: 'string' },
    'no-memory':{type:'boolean'},sandbox:{type:'string'},scope:{type:'string'},thinking:{type:'boolean'},
  } });
  const number = (value: string | undefined, fallback: number, min: number, max: number) => {
    if (value !== undefined && !/^\d+$/.test(value)) throw new Error(`Expected an integer, received: ${value}`);
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`Expected a value from ${min} to ${max}`);
    return result;
  };
  if (values.model && !/^[\w.-]+\/[\w.-]+$/.test(values.model)) throw new Error('Model must be provider/model');
  if (values.effort !== undefined && !EFFORTS.some(effort => effort === values.effort)) throw new Error(`Effort must be one of ${EFFORTS.join(', ')}`);
  if (values.permissions !== undefined && !['allow','ask','deny'].includes(values.permissions)) throw new Error('Permissions must be allow, ask or deny');
  if(values.sandbox!==undefined&&!['off','required'].includes(values.sandbox))throw new Error('Sandbox must be off or required');
  if (values.scope !== undefined && !['none', 'read-only', 'workspace', 'full'].includes(values.scope)) throw new Error('Scope must be none, read-only, workspace or full');
  if (values['system-prompt'] !== undefined && !values['system-prompt'].trim()) throw new Error('System prompt file must not be empty');
  if (values.prompt !== undefined && !values.prompt.trim()) throw new Error('Prompt must not be empty');
  if (values.mode && !['plan','build'].includes(values.mode)) throw new Error('Mode must be plan or build');
  if (values.compaction && !['local','model'].includes(values.compaction)) throw new Error('Compaction must be local or model');
  if ((values.rpc && (values.json || values.prompt !== undefined)) || (values.json && values.prompt === undefined && !values['check-models'])) throw new Error('Use --rpc alone or --json with --prompt / --check-models');
  if (values['check-models'] && (values.rpc || values.prompt !== undefined || values.session || values.continue || values['list-sessions'])) throw new Error('Use --check-models separately from prompts, RPC and sessions');
  if (values['check-models'] && (values.effort !== undefined || values['system-prompt'] !== undefined)) throw new Error('Model checks use synthetic instructions and all configured effort profiles; omit --effort and --system-prompt');
  if ((values['no-session'] && (values.session || values.continue)) || (values.session && values.continue)) throw new Error('Choose only one of --session, --continue, --no-session');
  return { help: values.help ?? false, version: values.version ?? false, cwd: resolve(values.cwd ?? process.cwd()), model: values.model, prompt: values.prompt,
    mode: values.mode as 'build' | 'plan' | undefined, session: values.session, sessionDir: values['session-dir'] ? resolve(values['session-dir']) : undefined,
    continue: values.continue ?? false, noSession: values['no-session'] ?? false, json: values.json ?? false, rpc: values.rpc ?? false,
    trustWorkspace: values['trust-workspace'] ?? false, listSessions: values['list-sessions'] ?? false, compaction: (values.compaction ?? 'model') as 'model' | 'local',
    effort: values.effort as Effort | undefined, systemPromptFile: values['system-prompt'],
    permissions: values.permissions as 'allow' | 'ask' | 'deny' | undefined,
    noMemory:values['no-memory']??false,sandbox:values.sandbox as 'off'|'required'|undefined,
    scope: values.scope as WorkspaceScope | undefined,
    thinking: values.thinking ?? false,
    timeoutMs: values['timeout-ms'] === undefined ? undefined : number(values['timeout-ms'], 300000, 1, 2147483647), checkModels: values['check-models'] ?? false,
    maxIterations: number(values['max-iterations'], 12, 1, 100), maxContextChars: number(values['max-context-chars'], 64000, 16000, 1000000) };
}
export const CLI_HELP = `KAIROS (κ) — Right-Time Coding Agent · NVIDIA NIM

Usage: kairos [options]
  -h, --help                   Show help without an API key
  -v, --version                Show version
  --cwd <directory>            Workspace (default: current directory)
  -m, --model <provider/model> NVIDIA NIM model
  --effort <level>            Reasoning effort supported by the selected model
  --thinking                  Show model Chain of Thought (CoT) reasoning live
  --system-prompt <file>      Additional instructions (relative to workspace)
  --timeout-ms <count>        HTTP timeout; per-probe deadline for model checks
  --check-models              Probe bundled models, or only --model; saves a report
  --permissions <ask|allow|deny> Override edit/shell/external policies (CLI default: ask)
  --no-memory                 Disable durable project notes
  --sandbox <off|required>    Require Linux/WSL2 bubblewrap shell isolation; no fallback
  --scope <none|read-only|workspace|full> Workspace access scope (default: workspace)
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

Interactive commands: /key /model /effort /plan /build /undo /rewind /tasks /memory /context /sessions /resume /rename /branch /btw /new /compact
                      /skills /skill /extensions /mcp /steer /thinking /scope /queue /help /exit
Use /key for masked global key setup; opens automatically when no key is configured.
NVIDIA_API_KEY lookup: environment > workspace .env > ~/.kairos/.env.
Defaults: ~/.kairos/config.json; trusted project overrides: .kairos/config.json.
Optional personal instructions: ~/.kairos/system-prompt.md.
New sessions remember the last manually selected model (~/.kairos/last-model.json).
`;

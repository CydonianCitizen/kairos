export interface CommandSuggestion { name: string; description: string; argument?: string }

export const COMMANDS: CommandSuggestion[] = [
  { name: '/model', description: 'Choose a model' },
  { name: '/effort', description: 'Choose reasoning effort' },
  { name: '/key', description: 'Save your NVIDIA API key globally' },
  { name: '/mode', description: 'Set plan or build mode', argument: 'plan|build' },
  { name: '/plan', description: 'Switch to read-only planning' },
  { name: '/build', description: 'Enable coding and tools' },
  { name: '/graph', description: 'Rebuild and inspect the code graph' },
  { name: '/context', description: 'Inspect attached references and their budget' },
  { name: '/undo', description: 'Undo the latest KAIROS file-edit batch' },
  { name: '/diff', description: 'Inspect the full diff of the latest file edits' },
  { name: '/rewind', description: 'Restore conversation or files to a previous prompt' },
  { name: '/tasks', description: 'Manage supervised background shell tasks' },
  { name: '/memory', description: 'Inspect or manage durable project notes' },
  { name: '/clear', description: 'Clear conversation context' },
  { name: '/compact', description: 'Summarize the conversation' },
  { name: '/sessions', description: 'List saved sessions' },
  { name: '/resume', description: 'Search and resume a saved session' },
  { name: '/rename', description: 'Rename the current session', argument: 'SESSION_NAME' },
  { name: '/branch', description: 'Copy this conversation and switch to the new session' },
  { name: '/btw', description: 'Ask a side question (optional --model provider/model)' },
  { name: '/new', description: 'Start a new session' },
  { name: '/skills', description: 'List available skills' },
  { name: '/skill', description: 'Activate a skill', argument: 'NAME' },
  { name: '/extensions', description: 'List plugin commands' },
  { name: '/mcp', description: 'List connected MCP servers' },
  { name: '/steer', description: 'Guide the active turn', argument: 'TEXT' },
  { name: '/thinking', description: 'Toggle or set CoT reasoning visibility', argument: 'on|off' },
  { name: '/scope', description: 'Set workspace permission scope', argument: 'none|read-only|workspace|full' },
  { name: '/queue', description: 'List, add, edit or remove waiting messages' },
  { name: '/help', description: 'Show command help' },
  { name: '/exit', description: 'Exit KAIROS' },
];

/** Only a leading model option is interpreted; the rest is the name or question. */
export function conversationArgs(args: string): { model?: string; text: string } {
  const match = args.match(/^--model(?:=|\s+)(\S+)(?:\s+([\s\S]*))?$/);
  if (match) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(match[1]!)) throw new Error('Expected --model provider/model');
    return { model: match[1], text: match[2] ?? '' };
  }
  if (args === '--model' || args.startsWith('--model=')) throw new Error('Expected --model provider/model');
  return { text: args };
}

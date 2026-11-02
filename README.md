# KAIROS (κ)

**Right-Time Coding Agent · NVIDIA NIM**

KAIROS is a terminal coding agent with an inline React Ink interface, a local AST Code Graph, and NVIDIA NIM integration. Requests share a paced queue with at least **1,600 ms between HTTP dispatches**, keeping a single coordinated workload below NVIDIA NIM's 40 RPM limit.

The interface preserves native terminal scrollback and copy/paste. A gold/bronze banner introduces the session; the bottom dock shows input, model, reasoning effort, graph statistics, activity, queue, and cooldown. The banner becomes compact below 80 columns and reduces to a title in terminals shorter than 16 rows. Kairon's artwork appears in the wide banner; there is no roaming animation above the input.

Features include:

- **Local discovery:** AST indexing, symbol inspection, dependency candidates, and automatic repository context without exploratory model calls.
- **Batch tools:** file reads, exact edits, and supervised shell commands with bounded output.
- **Host-controlled permissions:** approval previews, granular allow/ask/deny rules, workspace scopes, and optional Linux shell isolation.
- **Persistent workflows:** sessions, semantic/local compaction, edit undo, prompt rewind, and project memory.
- **Interactive input:** multiline editing, file/symbol/skill completion, prompt search, steering, and an editable follow-up queue.
- **Extensions and integrations:** skills, ESM plugins, MCP, plain output, JSONL, JSON-RPC, and a JavaScript SDK.

Detailed guides cover [agent workflows](docs/WORKFLOWS.md), [approvals, references, and queues](docs/HOST-WORKFLOWS.md), and [permissions, background tasks, memory, and rewind](docs/ADVANCED-WORKFLOWS.md). These linked guides are currently written in Italian.

## Installation and verification

Requires **Node.js 20.19.x or later within Node 20, or Node.js 22.12+**, and npm. Node 24 is supported. `run_bash` requires Bash; Windows looks for Git Bash. Set `BASH_PATH` for a nonstandard installation. Windows process supervision also uses the .NET compiler available through Windows PowerShell.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

On machines where filesystem-heavy tests contend for resources, run the same complete suite with bounded parallelism:

```sh
npm test -- --maxWorkers=4
```

To use NIM across repositories, create a personal `~/.kairos/.env` once. On Windows, use `%USERPROFILE%\.kairos\.env`:

```dotenv
NVIDIA_API_KEY=your_nvidia_api_key
```

The CLI resolves the key in this order: **existing environment variable → selected workspace's `.env` → `~/.kairos/.env`**. For project-specific credentials, copy `.env.example` to `.env` and set the key. `.env` is excluded from Git. Tests use simulated HTTP responses and need no NVIDIA credentials.

Startup preferences live in `~/.kairos/config.json`; personal instructions go in `~/.kairos/system-prompt.md`, without rebuilding. The [configuration guide](docs/CONFIGURATION.md) explains precedence and `kairos --check-models` for explicit live endpoint checks. Historical results are in [NIM verification](docs/NIM-VERIFICATION.md).

### The `kairos` command

After building, link the command from the repository root for development:

```sh
npm link
```

Then run it from any project directory:

```sh
kairos
kairos --mode plan
kairos --version
```

On Windows, use `npm.cmd link` if PowerShell interferes with npm invocation. The global npm command directory must be on `PATH`; `npm prefix -g` shows its prefix. On macOS/Linux, commands live in the prefix's `bin` subdirectory.

To install a packaged copy instead of linking the checkout:

```sh
npm pack
npm install --global ./kairos-0.0.1-alpha.tgz
```

`npm pack` builds automatically and includes compiled modules, documentation, and `.env.example`. The command remains `kairos`, with `nim-codex` as a compatibility alias. This installs a local package without publishing it to npm. Node.js and a configured NVIDIA key are still required.

## Configuration and workspace access

Example personal `~/.kairos/config.json`:

```json
{
  "model": "mistralai/mistral-large-4-1t-a52b",
  "effort": "auto",
  "timeoutMs": 300000,
  "permissions": { "edits": "ask", "shell": "ask", "external": "ask" },
  "scope": "workspace",
  "memory": true,
  "sandbox": "off",
  "plugins": [],
  "mcpServers": {}
}
```

Personal `plugins` and `mcpServers` sections coexist with ordinary settings. Relative personal plugin paths resolve from `~/.kairos`; MCP credentials reference environment variables. Trusted project preferences use `.kairos/config.json`; project extensions use `.nim/config.json`. Project settings and extensions require `--trust-workspace`.

New-session settings resolve as **CLI overrides → trusted project settings → personal settings → bundled defaults**. Model selection also checks the last manually selected model between project and personal defaults. Resumed sessions retain their saved model/effort unless explicitly overridden. The SDK does not automatically load `.env` or preferences: call `loadSettings()` and supply the options when needed.

`--scope` and the idle-only `/scope` command select native filesystem tool access:

| Scope | Behavior |
| --- | --- |
| `none` | Disables native tools and new graph, reference, workspace-instruction, and project-memory context injection. Existing conversation history remains. |
| `read-only` | Allows workspace reads and local graph/skill inspection; blocks edits, shell startup, file restores, and external effects. |
| `workspace` | Default. Restricts native file reads and edits to the workspace. |
| `full` | Allows native file access outside the workspace, while preserving edit permissions and undo journaling. |

`AgentLoop.setScope()` also requires an idle agent. Prepared file operations recheck scope before applying changes; shell/external execution checks it before starting effects. Stopping already running background tasks remains available.

Scopes and `allow/ask/deny` rules control tool invocation, not OS-level containment. Permitted shell commands and trusted plugins run with the process's privileges. `--sandbox required` adds Linux/WSL2 bubblewrap isolation with a read-only host root, writable workspace, private temporary directory, and isolated network/process namespaces. It fails rather than falling back to an unsandboxed command when unavailable. Native Windows and macOS have no bundled sandbox backend. See [advanced workflows](docs/ADVANCED-WORKFLOWS.md) for limits.

## NIM client and rate limiting

After building, run this example from a JavaScript module in the project root:

```js
import 'dotenv/config';
import { NimClient } from './dist/core/nim-client.js';
import { FS_TOOL_SCHEMAS } from './dist/tools/fs-tools.js';

const client = new NimClient();
client.on('onRateLimitWait', ({ remainingMs, reason }) => {
  console.log(reason, remainingMs);
});
const result = await client.complete({
  messages: [{ role: 'user', content: 'Describe the files you need to explore this project.' }],
  tools: FS_TOOL_SCHEMAS,
});
if (result.ok) console.log(result.value.choices);
else console.error(result.error);
```

`complete()` returns `NimResult<ChatCompletion>`. `stream()` returns all chunks, including tool-call deltas, and emits `onTokenStream` for text and refusals. Reasoning uses a separate `onReasoningStream` event. Both methods accept an `AbortSignal` as their second argument. HTTP errors and exhausted retries return `{ ok: false, error, status }`; a missing key throws a constructor configuration error.

The library leaves environment loading to its caller. Here, `dotenv/config` loads the current directory's `.env`, not the CLI's workspace/personal lookup. The CLI loads those files explicitly while preserving existing environment variables.

All client instances share one FIFO queue per process, with one active request and at least 1,600 ms between actual HTTP dispatches. KAIROS processes on the same computer coordinate the same key through local files in `~/.kairos/rate-limits`, without storing the key. The slot stays occupied during streaming and backoff.

HTTP 429 responses allow three retries after 5, 10, and 20 seconds, honoring a longer `Retry-After`. Streams that have already received data are not replayed. SDK retries are disabled with `maxRetries: 0`, keeping dispatches inside the limiter.

FIFO order is guaranteed within a process; cross-process ordering follows lock contention. Other applications, computers, or coordination directories do not share this limit. Coordination requires a local filesystem with hard-link support; an unavailable or corrupt coordinator blocks dispatch instead of bypassing pacing.

### Models and reasoning effort

The [model catalog](docs/MODELS.md) checks NVIDIA metadata on TUI startup at most once every **24 hours**, with a local cache and offline fallback. Bundled profiles were checked against NVIDIA's public pages on **October 31, 2026**:

- `mistralai/mistral-large-4-1t-a52b` — default.
- `deepseek-ai/deepseek-v4.1-flash`.
- `minimaxai/minimax-m3.1-flash`.
- `z-ai/glm-5.3-flash`.
- `nvidia/nemotron-3.5-bolt-e4b`.

Downloaded models are candidates, not certified tool-capable endpoints. Custom `provider/model` IDs work through `/model provider/model` and `--model`. `parallel_tool_calls` is sent only with tools and documented profile support, currently Nemotron Bolt, or an explicit client-constructor support override.

`/model` opens a searchable picker: type to filter names, ↑/↓ selects, Enter confirms, and Esc cancels. The active custom model stays available. `/effort` exposes configured levels only: Mistral Large 4 has `auto`, `none`, and `high`; MiniMax M3.1 Flash has `auto`, `low`, `medium`, `high`, `xhigh`, and `max`. Other bundled models use `auto` without unverified effort parameters. Switching models resets unsupported effort to `auto`. See [reasoning effort](docs/MODELS.md#reasoning-effort).

New sessions remember the last manually selected model across repositories. Resumed sessions preserve their previous model unless explicitly overridden. To probe hosted capabilities:

```sh
kairos --check-models
kairos --check-models --model mistralai/mistral-large-4-1t-a52b --json
```

These checks make real, paced requests and save a report. They never run as part of the test suite.

## Batch tools

```js
import { FsTools } from './dist/tools/fs-tools.js';

const tools = new FsTools(process.cwd());
try {
  const files = await tools.read_files_batch(['package.json', 'tsconfig.json']);
  const edits = await tools.apply_edits_batch([
    { path: 'example.txt', old_text: '', new_text: 'New file\n' },
  ]);
  const command = await tools.run_bash('git status --short');
  console.log({ files, edits, command });
} finally {
  await tools.close();
}
```

- Batches contain 1–100 items with independent per-item results.
- Default paths are workspace-relative. Traversal and external symlinks are rejected. Reads accept regular files up to 1 MiB; `full` explicitly broadens path access.
- Replacements must match exactly once and execute in order. `old_text: ''` creates a new file only; its parent directory must exist. Edits are serialized per instance, without batch-wide rollback.
- Writes stage an adjacent temporary file and publish by rename. New files use an exclusive hard link, preserving a target created by another writer. Failures before publication preserve the original. Creation requires hard-link support; power-loss durability and global rollback are not guaranteed.
- `AgentLoop` emits `onToolStart` and `onToolEnd`; direct tools return results without agent events.
- `run_bash` starts in the workspace, defaults to 30 seconds, accepts timeouts from 1 ms to 300 seconds, and stops the supervised process tree on timeout. Each of stdout/stderr is capped at 15,000 characters. Results include exit code, timeout, cancellation, and truncation information.

The dispatcher validates arguments. The CLI requests approval before edits, shell commands, and external calls; noninteractive `ask` returns an explicit approval-required error. The SDK defaults to `allow` unless the host supplies a policy. Path protection assumes a trusted local workspace without hostile concurrent symlink changes.

For longer work, `run_bash` accepts `background: true` and returns a supervised task ID. `background_tasks_batch` or `/tasks` inspects status/logs or stops tasks. Up to eight tasks can run concurrently, with the 50 most recent completed results retained. Turn cancellation after startup does not stop a task already handed to the supervisor; use explicit stop, timeout, or process closure. Session switching and file rewind require running tasks to stop first.

## Local Code Graph

```js
import { indexWorkspace } from './dist/graph/indexer.js';
import { GraphTools, GRAPH_TOOL_SCHEMAS } from './dist/tools/graph-tools.js';

const graph = await indexWorkspace(process.cwd(), {
  onProgress: ({ files, symbols }) => console.log({ files, symbols }),
});
const tools = new GraphTools(graph);
console.log(graph.stats);
console.log(graph.diagnostics);
console.log(tools.get_repo_map('src'));
console.log(tools.inspect_symbol_graph(['NimClient', 'NimClient.complete']));
console.log(graph.search('rate limit client', 10));
```

Indexing uses no NIM client or API key. `web-tree-sitter` loads local WASM grammars without a native C++ build. Supported languages are TS/TSX, JS/JSX, Python, Rust, and Go, including ESM/CJS extensions.

The directed Graphology graph stores files, symbols, and `contains`, `imports`, and `calls` edges. Symbols retain exact AST source, signatures, qualified names, and one-based line numbers. `GRAPH_TOOL_SCHEMAS` connects graph tools to the agent dispatcher.

`inspect_symbol_graph(symbol_names)` accepts 1–100 names. It returns every matching duplicate; narrow a query with `path:Qualified.name`. Calls include candidate local targets; `targets: []` means unresolved. `dependents` lists files importing the symbol's file, not proof that they use that individual symbol.

`get_repo_map(directory?)` returns a map capped at 12,000 characters and marks truncation. Its directory filter is workspace-relative. `graph.search(query, limit)` ranks matching symbol locations for automatic turn context.

Resolution covers relative JS/TS imports, including NodeNext `.js` → `.ts`, local Python imports, simple Rust `crate`/`self`/`super` paths, and internal Go packages under the module declared in `go.mod`. It is not a type checker: `tsconfig` aliases, chained re-exports, dynamic imports, CommonJS `require`, grouped/glob Rust `use`, and dynamic dispatch remain unresolved. Candidates are not a compiler-certified call graph.

Root and nested `.gitignore` files are respected, including Git-compatible negation rules. Symlinks, `.git`, `node_modules`, build directories, virtual environments, and common caches are excluded. The default 1 MiB file limit is configurable through `maxFileBytes`. Read failures, oversized files, and incomplete syntax appear in `diagnostics`; grammar-loading failures stop indexing.

Each run produces an independent snapshot. After edits, call `indexWorkspace` again and replace previous graph/tools; there is no watcher. Parsers and AST trees are released after use. `AbortSignal` stops indexing between files. Tests use real parsers across supported languages and cover imports, aliases, Unicode, nested ignore rules, cancellation, symlinks, and reindexing.

## Agent loop

After configuring `NVIDIA_API_KEY` and building, save this as an `.mjs` module in the project root:

```js
import 'dotenv/config';
import { AgentLoop } from './dist/core/agent-loop.js';

const agent = new AgentLoop({
  workspace: process.cwd(),
  model: 'mistralai/mistral-large-4-1t-a52b',
  maxIterations: 12,
  maxContextChars: 64000,
});
agent.on('onTokenStream', token => process.stdout.write(token));
agent.on('onToolStart', ({ id, name }) => console.log('\nTool:', id, name));
agent.on('onToolEnd', ({ name, result }) => console.log('\nResult:', name, result.ok));
agent.on('onGraphUpdate', stats => console.log('\nGraph:', stats));
agent.on('onRateLimitWait', ({ reason, remainingMs }) => console.log('\nWait:', reason, remainingMs));
agent.on('onCompaction', ({ removedMessages }) => console.log('\nCompacted:', removedMessages));

const controller = new AbortController();
try {
  // Call controller.abort() to interrupt the turn.
  const result = await agent.run('Explain how NimClient works', {
    signal: controller.signal,
  });
  console.log('\n', result.status, result.error ?? '');
} finally {
  await agent.close();
}
```

The prompt in `src/core/system-prompt.ts` guides graph use, batching, and verification. Every model iteration receives it as a `system` message. Add personal instructions through `~/.kairos/system-prompt.md`, `systemPromptFile`, or `--system-prompt FILE`. Trusted `AGENTS.md` files supply subordinate project instructions when workspace scope permits. `--trust-workspace` also enables project skills, extension configuration, and `.kairos/config.json` preferences. Repository source, tool output, and compacted history are untrusted data.

When scope permits, `AgentLoop.run()` indexes before each turn, finds relevant symbols, and injects signatures, paths, and lines. The map is regenerated per request instead of accumulating in history. A successful or partially successful edit batch, or a shell command, triggers reindexing before the next tool. Discovery and local compaction make no API calls; semantic compaction uses NIM through the same limiter.

Streaming uses `NimClient` exclusively. Tool arguments are assembled by index from SSE chunks. Incomplete/truncated streams and duplicate IDs are rejected before model-proposed effects. The dispatcher validates JSON, names, types, batch bounds, and unexpected fields; errors return with the matching `tool_call_id`. The UI tolerates malformed previews instead of assuming model JSON already matches its schema.

Multiple tool calls execute in order, preserving dependencies such as edit followed by inspection. `onToolStart` includes ID, name, and JSON arguments; `onToolEnd` includes ID, name, and the full result, including `mutated`. Model-facing results are capped at 12,000 characters or one-third of the configured budget, whichever is smaller, inside a valid JSON truncation wrapper.

One instance retains conversation across `run()` calls. `agent.messages` returns a copy; `agent.clear()` resets context while idle. Concurrent main turns on one instance return `busy`. Independent agent instances must own separate clients so their events do not mix; the limiter remains process-wide.

Compaction preserves the current prompt and complete assistant/tool groups. Local compaction keeps up to 2,400 characters of excerpts; semantic compaction generates a NIM summary and falls back locally on failure. The CLI defaults to semantic compaction; `--compaction local` avoids that extra request. The default 64,000-character budget includes messages and tool schemas, not an exact token count. Requests that cannot fit return `context_limit`.

Results include `status`, `text`, `iterations`, and optional `error`. Statuses are `completed`, `cancelled`, `iteration_limit`, `context_limit`, `error`, and `busy`. The default maximum is 12 logical iterations; HTTP retries do not count toward it. NIM errors, including exhausted 429 retries, end the turn without an unhandled exception.

Cancellation interrupts NIM requests, indexing between files, and foreground shell work, and prevents subsequent tools/edits from starting. Completed effects are not rolled back; an in-flight filesystem write may finish before cancellation is observed. History keeps a result for each tool call, marking interrupted or unexecuted work. The next turn rebuilds the graph.

Tests cover SDK SSE → tool → SDK flows, pacing, fragmented arguments, graph refreshes, validation failures, limits, compaction, and cancellation without real NVIDIA calls.

<a id="tui-inline-e-cli-fase-4"></a>

## Inline TUI and CLI

```sh
npm ci
npm run build
npm start
```

Configure `NVIDIA_API_KEY` in the environment, workspace `.env`, or personal `~/.kairos/.env`. To select another project:

```sh
node dist/cli.js --cwd /path/to/project --model mistralai/mistral-large-4-1t-a52b
```

`--help`, `--version`, and `--list-sessions` need no API key. Existing session storage remains at `~/.nim-codex/sessions`; project extension configuration stays in `.nim/` for compatibility. Without a TTY, use `node dist/cli.js --prompt "Explain NimClient"` for one plain-output turn. `--max-iterations` and `--max-context-chars` set loop limits.

The TUI uses React 18, Ink 5, and `ink-text-input` in searchable pickers. The main prompt has a multiline editor. Completed turns and tool logs flush through `<Static>` into native scrollback. Compact action logs and folded reasoning keep the transcript readable; `/diff` prints retained edit diffs in full. The live dock shows model in NVIDIA green, effort in gold, activity/cooldown, mode, `AST files/symbols !warnings`, queue count, and a short session ID. Narrow terminals abbreviate trailing details. No alternate screen buffer is used.

| Command | Behavior |
| --- | --- |
| `/model` | Searchable model picker; ↑/↓ selects, Enter confirms, Esc cancels |
| `/model provider/model` | Switch models while preserving conversation |
| `/effort [level]` | Open the effort picker or set a supported level |
| `/mode plan`, `/plan`, `/build` | Switch planning/building while idle |
| `/graph [directory]` | Rebuild and display the graph map when scope permits |
| `/context` | Show explicit references, line ranges, and their budget |
| `/undo` | Preview and undo the last journaled edit batch |
| `/diff` | Print retained diffs without the compact preview's line limit |
| `/rewind [ID scope]` | Restore conversation, files, or both from a prompt checkpoint |
| `/tasks [start/logs/stop]` | Manage supervised background shell tasks |
| `/memory [add/update/remove/clear]` | Manage durable project notes |
| `/clear` | Clear conversation context, preserving scrollback |
| `/compact` | Summarize history through NIM with local fallback |
| `/compact local` | Compact without a model request |
| `/resume [ID]` | Search project sessions or resume an ID |
| `/rename NAME` | Persist a name for the current session |
| `/branch [--model ID] [NAME]` | Copy the conversation and switch to the new session |
| `/btw [--model ID] QUESTION` | Ask a separate side question; no text reopens the last panel |
| `/sessions`, `/new` | List sessions or start a new one |
| `/skills`, `/skill NAME`, `/extensions`, `/mcp` | Inspect and use extensions |
| `/steer TEXT`, `/queue TEXT` | Guide the active turn or queue a follow-up |
| `/thinking [on\|off]` | Toggle or set streamed reasoning visibility |
| `/scope [level]` | Select `none`, `read-only`, `workspace`, or `full` while idle |
| `/queue`, `/queue remove ID`, `/queue clear` | List/remove waiting prompts without stopping current work |
| `/queue edit ID TEXT` | Replace a waiting prompt, preserving its ID and position |
| `/help` | Show commands and shortcuts |
| `/exit` | Exit when the main turn is idle |

Typing `/` opens a scrollable menu, including loaded plugin commands. Continue typing to filter; ↑/↓ selects and Enter runs the selection. Commands requiring arguments, such as `/mode` and `/steer`, prepare a draft. Tab completes without running. Esc/Ctrl+C closes the menu and returns to the prompt.

To edit a queued message, press **↑ on the first input line**, choose with **↑/↓**, and open with **Enter/Tab**. **Enter saves**; **Esc cancels and restores the previous draft**. The queue pauses while editing; the active turn continues. Skills in ordinary queued prompts activate when their turn starts. `/skill NAME` and a standalone `$skill` remain explicit activation commands.

### Sessions and side questions

`/resume` opens a searchable project session picker, newest first. Entries show the chosen name or locally derived first-prompt title, date, model, mode, and short ID. The current session is marked; initial selection favors another session. Search matches name, original title, full ID, model, mode, and date. Enter resumes; Esc/Ctrl+C returns. An unreadable or busy session keeps the current session intact and displays the error. `--no-session` disables resuming. Original checkpoints preserve automatic titles after clearing/compaction, without NIM calls.

`/rename Graph plan` persists a name visible in `/resume` and `/sessions`. Names support spaces/Unicode, contain 1–120 characters on one line, and reject control characters. Renaming is local, requires an idle persistent session, and survives restart, resume, clearing, and compaction. `/new` starts unnamed; older unnamed journals remain readable.

`/branch Alternative strategy` creates a new session ID and persistent copy of messages, summary, mode, and settings, then switches to it. The original remains available through `/resume`; the confirmation includes its ID. `/branch --model minimaxai/minimax-m3.1-flash Alternative strategy` selects a model for the copy without changing the original. Unsupported effort resets to `auto`. Branching requires persistence and an idle agent, makes no NIM call, and shares project files: it creates neither a Git branch nor a worktree.

`/btw --model z-ai/glm-5.3-flash Why did we choose this parser?` uses a conversation snapshot and an isolated client in a separate panel. It has no tools, does not modify files or the main session, and does not journal its answer. Main work continues; all inference shares the paced queue. Without `--model`, it uses the current model without changing selection. The option precedes the question or branch name; `--model=provider/model` also works.

In the side panel, ↑/↓ scrolls, Esc returns without stopping work, and Ctrl+C cancels only the side question. After completion, Enter/Space closes and `x` clears side history. `/btw` without text reopens the panel without inference. At most 20 exchanges stay in memory within the context budget; clearing, switching sessions, or closing discards them. Only one side question can run at once.

### Input, history, and references

Input is **multiline**. Enter submits the full prompt; Ctrl+J, backslash followed by Enter, and recognized Shift+Enter sequences insert a newline. If the terminal sends identical Enter/Shift+Enter sequences, use another newline shortcut. Arrow keys, Home/End, Ctrl+A/Ctrl+E, Backspace, and Delete edit without splitting emoji or combining characters. Pasted blocks preserve lines/tabs; multiline input starting with `/` is treated as a prompt. The editor scrolls around the cursor with up to six visible lines while preserving the footer.

Ctrl+R searches project prompts, including previous sessions. Search ignores case; ↑/↓ or another Ctrl+R navigates results. Enter/Tab loads a draft; another Enter submits it. Esc/Ctrl+C restores the previous draft without interrupting work. Search reuses journals without creating files; `--no-session` uses in-memory prompts only. It returns up to 200 distinct prompts from at most 100 recent journal tails, reading at most 1 MiB per file and 16 MiB total. Older prompts may fall outside these bounds. Editing/search require no NIM requests.

Most slash commands are local. `/compact` and `/btw` use NIM; plugin commands can perform external operations. During a turn, input remains available for follow-ups and `/steer`. Outside menus, Esc cancels active main work and clears the queue; Ctrl+C does the same or exits while idle.

Type `@` followed by part of a file or symbol for index suggestions. ↑/↓ selects; Tab completes the trailing reference. Completion also supports slash commands and local skill names through `$`. Without active completion, Tab toggles the latest tool's bounded detail preview.

`@src/file.ts`, `@SymbolName`, `@file:path`, and `@symbol:SymbolName` attach source and line ranges when scope permits, within a 12,000-character budget. `/context` shows usage. Missing, ambiguous, or unsafe references are reported before inference. See [host workflows](docs/HOST-WORKFLOWS.md) for selection rules and limits.

Unified diffs use actual contents before and after successful writes: additions green, deletions red, and hunk headers cyan. Failed edits produce no successful diff. Shell commands report outcomes without automatic diffs for their filesystem effects. Terminal control sequences from source/model output are stripped before display.

## Project memory, undo, and rewind

The CLI enables durable notes per canonical workspace at `~/.kairos/memory/<hash>/notes.json`. Notes survive new sessions in that project and remain separate from conversation summaries and the global last-model preference. Use `/memory` to inspect/manage notes, `--no-memory` to disable them, or opt in through SDK `memory: { directory? }`.

The model proposes notes with `memory_update_batch`, subject to validation and edit permissions. Limits are 50 notes, 2,000 characters per note, a 32 KiB store, and up to 4,000 injected characters. Notes have stable IDs/timestamps, never grant permissions, and reject recognizable credentials, private keys, and raw source. Stale approval previews cannot overwrite newer notes.

Memory writes are atomic and backed up in `.bak`. Processes serialize updates through complete owner records published with hard links. Release and dead-owner recovery rename the public lock to a private generation before deletion, avoiding the Windows race between opening and deleting the shared name. Persistent permission errors and corrupt owners still fail closed; failed memory writes are not retried automatically.

`/undo` previews the latest journaled edit batch and restores it only if paths, contents, and identities still match the approved state. `/rewind` selects a checkpoint from before a prompt, with scope `conversation`, `files`, or `both`. File restoration requires edit permission/journals and refuses conflicting user or other-session changes. Shell, plugin, and MCP effects are not restored. Rewind leaves project notes, global model preferences, and terminal scrollback intact.

Rewind retains at most 100 points and 32 MiB per archive. Persistent CLI sessions use `~/.kairos/rewind`; `--no-session` keeps points in memory. Session journals above 64 MiB are rejected on resume: preserve/export the journal and start a new session. Journals contain local project data and should remain private. See [advanced workflows](docs/ADVANCED-WORKFLOWS.md) for recovery and SDK options.

## JSON, RPC, and SDK

```sh
kairos --prompt "Explain NimClient" --json
kairos --rpc
kairos --list-sessions
kairos --continue
```

Plain prompts use `--prompt`. `--json --prompt` streams JSONL events and a final result; `--rpc` serves JSON-RPC over stdin/stdout and is mutually exclusive with prompt/JSON output. Noninteractive operations requiring approval return an error unless the host has explicitly configured permissions.

The package exports `createAgent`, `AgentLoop`, `NimClient`, `Interaction`, session/memory/rewind stores, settings helpers, permissions, and RPC utilities. SDK callers own environment/configuration loading and must close their agent. `AgentLoop.initialize()`, `setModel()`, `compact()`, and `graphSnapshot` let hosts manage graph/model/context without recreating sessions. Scopes and policies also apply to SDK tool execution.

See [agent workflows](docs/WORKFLOWS.md), [host workflows](docs/HOST-WORKFLOWS.md), and [advanced workflows](docs/ADVANCED-WORKFLOWS.md) for RPC methods, event formats, extension configuration, and SDK examples.

## Verification and development history

Verification covers real parsers, simulated NIM HTTP/SSE, pacing and cross-process coordination, editing, approval/undo/rewind safeguards, memory concurrency, Ink rendering, keyboard completion, queues, session pickers, countdowns, and CLI workflows. The memory deletion race has a deterministic regression; a separate test keeps persistent `EPERM` failures visible. Windows terminal smoke coverage is included. Local test results do not certify live NIM endpoints or every host platform.

The original phases cover the NIM client/batch tools, Code Graph, agent loop, and inline CLI. The [Phase 5 audit](docs/PHASE-5-AUDIT.md) records earlier simplifications, including removal of `@inkjs/ui` and its spinner-only dependency chain. The [November 2 audit-fix plan](docs/superpowers/plans/2026-11-02-audit-fixes.md) records later scope, configuration, and UI corrections. The [Pi/OpenCode comparison](docs/PI-OPENCODE-COMPARISON.md) and [Claude Code research](docs/CLAUDE-CODE-RESEARCH.md) provide historical context. Check dependency security separately; an earlier audit is not a current guarantee.

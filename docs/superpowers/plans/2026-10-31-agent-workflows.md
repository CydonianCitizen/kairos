# Persistent agent workflows — Implementation plan and design

**Goal:** Implement persistent sessions, semantic compaction, enforced plan mode, MCP, skills/plugins, queued interaction, JSON/RPC and an importable SDK in the existing NIM-only agent.

**Architecture:** Keep AgentLoop as the single execution engine. Add file-backed sessions, a bounded extension host and a shared serialized interaction layer. CLI/TUI/RPC use the same engine, tool validation and NIM limiter.

**Scope approved:** The user requested implementation of all six areas and selected CLI/TUI + JSON/RPC/SDK. No web UI or editor-specific extension. Implementation proceeds under that authorization.

## Constraints and decisions

- Preserve TypeScript strict ESM, explicit .js imports, Windows/macOS/Linux compatibility and inline Ink Static history.
- Every model request, including summaries, uses the existing shared Bottleneck limiter: maxConcurrent 1, minTime 1600 ms. Do not add another provider.
- Model-facing filesystem and extension operations remain batched. Validate JSON inputs before effects.
- Plan mode advertises and executes only native read/graph tools and local skill loading. Block shell, edits and arbitrary plugin/MCP calls regardless of their read-only annotations. Plugins are trusted native code, not an OS sandbox.
- Sessions are append-only JSONL checkpoints in a user data directory, not in the repo. Keep original checkpoints after compaction, repair only an incomplete trailing record, validate restored protocol pairings, reject concurrent writers. Never serialize configuration/credentials. Tool/file content can still be sensitive.
- Compaction uses a bounded NIM summary without tools, with a deterministic local fallback on provider failure; preserve current user input and assistant/tool pairing. Cancellation must not replace context with a partial summary.
- Configured stdio and Streamable HTTP MCP connections use the official SDK. No sampling or automatic OAuth browser flow. Authentication refers to environment-variable names. Tool/resource calls are batched, bounded and cancellable.
- Skills are local SKILL.md documents discovered from .nim/skills. Plugins are explicit local ESM modules with registerTool/registerCommand/onTurnEnd and disposal. Loading workspace instructions, skills, plugins or MCP configuration requires --trust-workspace. No package installation at runtime.
- Queue follow-ups FIFO; steering joins the current turn only at a boundary after all results for the current tool-call group are recorded. Cancel clears queued prompts. JSON/RPC never mix UI text with protocol output.
- Retain existing uncommitted work. Work on codex/sessions-extensions; no automatic commits, deletion or shutdown for this new task (the earlier shutdown applied to the completed audit).

## Tasks and interfaces

### 1. Session journal
Files: src/core/session-store.ts, tests/sessions.test.ts.
Interface: SessionStore.create(directory, workspace, state), open(directory, id, workspace), list(directory, workspace), append(state), close(); public id and state. SessionState contains messages, memory, model, mode ('build'|'plan').
- [x] Write and run failing tests for persistence, interrupted tail, invalid IDs/pairing and simultaneous writers.
- [x] Implement restricted local journal files and checkpoint recovery; run tests.

### 2. Agent persistence, compaction and plan mode
Files: src/core/agent-loop.ts, src/tools/registry.ts, tests/workflows.test.ts.
Interfaces: session option, sessionId, resumeSession/newSession/listSessions/close; setMode; compactContext({strategy,signal}); steer(prompt). Keep compact() local compatibility. Registry blocks write/shell/external calls in plan mode.
- [x] Test actual resumed requests, blocked side effects, summary/fallback and tool-boundary steering before implementation.
- [x] Persist before effects and after results; integrate context compaction and dynamic tool schemas; run full suite.

### 3. MCP and extensions
Files: src/extensions/{host,mcp}.ts, tests/extensions.test.ts, tests/mcp.test.ts, package.json/lock.
Interfaces: ExtensionHost loads trusted config, provides tool schemas/catalog, executes batched tools/skills/resources, commands and turn-end hooks; closes plugin/MCP resources. MCP client tools via official SDK stdio/HTTP, environment references only.
- [x] Test real local plugin and SKILL.md, argument validation, no untrusted execution, MCP fixture transport and errors/cancellation.
- [x] Implement modules and connect to AgentLoop/Registry; install only required SDK/schema dependencies; run tests/typecheck.

### 4. Shared interaction and CLI/TUI/RPC/SDK
Files: src/core/interaction.ts, src/integrations/rpc.ts, src/index.ts, src/cli-options.ts, src/cli.tsx, src/ui/*, tests/interaction.test.ts.
Interfaces: Interaction queues runs, supports steer/cancel and emits results. RPC JSONL methods prompt/steer/cancel/state/sessions/resume/newSession/compact/mode/model/commands/command with id-correlated responses and event notifications. SDK exports createAgent and core types; createAgent configures trusted integrations and optional persistent session.
- [x] Test FIFO/cancel, RPC in-flight cancellation, machine output and CLI options before implementation.
- [x] Wire CLI flags --session/--continue/--session-dir/--no-session/--mode/--json/--rpc/--trust-workspace and TUI slash commands; keep input available while busy.

### 5. Documentation and final validation
- [x] Document config examples, plugin API, session privacy/locking, RPC protocol, SDK usage and limits.
- [x] Run all tests, typecheck, build, npm audit and CLI smoke checks.
- [x] Fresh review of integration boundaries and fix meaningful findings with regression tests.

## Review focus

Restoring interrupted tool calls; cross-workspace/concurrent resume; compaction failure/cancellation; untrusted config executing code; read-only mode bypass through plugins/MCP/shell; protocol output contamination and EOF during queued work.

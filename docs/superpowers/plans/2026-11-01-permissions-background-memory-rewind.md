# Permissions, background tasks, memory and rewind implementation plan

> **For agentic workers:** Use test-driven development and focused verification. Preserve all existing dirty work; do not commit or create a separate worktree because the installed development command uses this checkout.

**Goal:** Deliver usable granular permission rules, supervised background shell tasks, project memory/nested instructions and prompt-based conversation/file rewind in CLI, TUI, RPC and SDK.

**Architecture:** Extend the existing PermissionGate, FsTools journal and session snapshots. Keep process supervision, memory storage and rewind state in small modules. All inference remains behind the existing shared NIM limiter; none of these workflows requires separate automatic inference calls.

**Tech stack:** Node ESM, strict TypeScript, Ink/React and existing filesystem/path guards.

## Decisions and acceptance

- Preserve category permissions and their defaults. Add validated ordered granular rules for paths, shell command patterns and external tool names; deny has precedence over ask over allow across matching targets. Shell patterns match the complete normalized command; do not treat shell allowlisting as an OS sandbox.
- Background tasks start only after shell authorization, return IDs immediately, retain bounded logs/status, support list/log/stop locally and through batch tools, and terminate owned process trees on close. Starting tasks remains blocked in plan mode. No automatic relaunch after restart.
- Project memory is separate from compacted conversation history, bounded, editable and disabled on request. CLI enables it; SDK opts in. Model proposals use a batch memory tool with host authorization; manual add/remove/list/clear are local. Nested AGENTS.md loads only from trusted workspace paths relevant to the current turn and tool reads.
- Rewind records turn-start conversation/model/summary and edit-journal position. Users choose a prior turn and conversation/files/both. File rewind preflights all affected paths, restores only verified recorded changes and preserves unrelated human changes; no Git reset and no claim to revert shell/plugin effects. Approval uses the concrete bound restore preview. Rewind does not revert global model preference or project memory.
- Optional OS shell isolation must report supported backends honestly and fail closed if explicitly required but unavailable; Windows native must never be advertised as sandboxed. Integration choice follows capability research.
- Old settings/journals remain readable; personal files get backups before replacement. No secrets in tracked files or memory. Keep input/cancellation/queue behavior from previous work.

## Task ownership and checks

- [ ] Permission worker: src/core/permissions.ts, src/config/settings.ts and focused tests. Root integrates target metadata in registry/loop/CLI.
- [ ] Background worker: new process supervisor + shell execution section of src/tools/fs-tools.ts and process tests. Root owns schemas/dispatcher, UI/RPC wiring. Coordinate optional sandbox execution seam.
- [ ] Memory worker: new project-memory store + nested instructions resolver and focused tests. Root owns loop/tool and command integration.
- [ ] Root: rewind store/range restore and session integration; all cross-feature wiring, docs and verification.
- [ ] Fresh reviews of feature modules and integrated behavior, fixes with regression tests.
- [ ] Full native suite, typecheck/build, compiled CLI synthetic HTTP smoke; report actual backend/platform limits.

## Review focus

- Mixed-target permission batches must authorize every target before the first effect, and a trusted project must not silently erase personal deny rules.
- Cancelled spawn/timeout/stop/close must not leave a process tree or a stale running task; logs remain bounded.
- Memory and nested instructions must not leak across workspaces or traverse symlinks, and untrusted source text must not become host policy.
- Rewind through repeated paths, partial edit batches, earlier undos, restarted sessions and human changes must preflight before mutation and remain recoverable on failure.
- Active background tasks and queued prompts must not race a rewind or session switch into a different workspace state.

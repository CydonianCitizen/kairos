# Approvals, undo, explicit context and model memory

**Approved scope:** user requested roadmap items 4–6 plus remembering the last selected model. Continue in the existing checkout, preserving all earlier work. No extra provider/API calls are needed for these host-side features.

## Acceptance and boundaries

- CLI defaults to asking before model-proposed edits, shell and external tool calls. `allow/ask/deny` rules are enforced in ToolRegistry after schema validation. Plan mode still blocks effects. SDK callers retain existing behavior unless opting into rules/approval callbacks. A noninteractive `ask` fails explicitly instead of waiting forever.
- The edit approval presents the exact proposed unified diff; changes since the preview invalidate the approved edit plan.
- `/undo` restores only the latest journaled apply_edits_batch changes for this workspace, across restart; it rejects changed content and never uses Git reset. Arbitrary shell/plugin side effects are not claimed as undoable.
- `@file` and `@symbol` insert bounded, explicit untrusted context, with paths/lines and observable budget usage. Missing, ambiguous or unsafe references must be reported before model inference. Email addresses and ordinary prose should not become references accidentally.
- Measure indexing before implementing an incremental cache. Keep grammar parsing/local discovery at zero NIM calls; add caching only if measurements justify it.
- New sessions prefer explicit CLI model > trusted project model > last manually selected model > personal configured model > bundled default. Resumed sessions keep saved choices except explicit overrides. Remember CLI/model picker/RPC selections; do not rewrite user config.json or persist credentials.
- Additional user request: make the waiting prompt queue visible and manageable. Reuse Interaction FIFO; expose stable IDs/copied snapshots, list/remove/clear without cancelling active work, bound TUI previews and RPC queue events. Preserve existing cancel semantics, 20 waiting messages and 64K prompt cap. Queue is process memory; no new persistence format.

## Ownership and interfaces

1. **Filesystem/undo worker:** src/tools/fs-tools.ts, new src/core/undo-store.ts, new focused tests. Add `prepare_edits_batch(edits,signal?)` -> read-only preview plus bound `apply(signal?)` closure; retain existing apply_edits_batch API. Journal successful batches and expose preview/restore latest changes through FsTools, with safe path/hash checks and restrictive persistent storage.
2. **References/graph worker:** new src/core/references.ts, src/graph/indexer.ts only if benchmark warrants, new reference/benchmark tests. Export a bounded reference resolver; parent integrates AgentLoop and UI events. Record benchmark evidence.
3. **Model memory/settings worker:** src/config/settings.ts, new src/config/model-preferences.ts, tests/settings.test.ts and new memory tests. Add remembered selection and permissions schema/merging. Parent owns actual selection event hooks and CLI integration.
4. **Parent:** new src/core/permissions.ts, ToolRegistry enforcement, AgentLoop integration, approval UI, CLI/RPC/SDK command wiring, docs and integrated verification.

## Verification

- [x] Prove policy denial/approval, no premature effects, stale preview rejection, cancellation and noninteractive failure.
- [x] Prove durable undo for edits/creation/repeated paths, refuse human changes and escaping paths, preserve original on failed restore. Immutable restore intent covers interrupted/all-before recovery.
- [x] Prove reference contents/budgets, missing/ambiguous/symlink/traversal handling and no repeated accumulation.
- [x] Prove remembered model across processes/workspaces, unchanged personal config, configured precedence and session restoration.
- [x] Benchmark graph, implement only warranted improvement, and record result in GRAPH-BENCHMARK.md. Full rebuild retained.
- [x] Full suite, typecheck/build, CLI smoke with synthetic HTTP, interactive approval rendering/keyboard checks and independent review.
- [x] Queue FIFO, maximum length, visible previews, startup handoff, literal/multiline input, removal/clearing without cancelling active work and RPC queue events.

Evidence: final native Windows full suite 322 passed, one platform file-symlink skip; focused undo/edit-preview/atomic 35/35; focused queue/controller/interaction 21/21. `npm run typecheck` and `npm run build` pass. `node tests/fixtures/cli-host-smoke.mjs` after build verifies compiled CLI with an isolated home, simulated HTTP, two workspaces and reopened sessions/journal. No real NIM requests are required for these checks. Independent review findings (mutation reporting after publication, wrapped steering references, interrupted undo and queued-turn UI handoff) have regression coverage and fixes.

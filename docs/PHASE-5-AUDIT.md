# Phase 5 — Ponytail audit

What this repo does: nim-codex is a local terminal coding agent that sends model requests only to NVIDIA NIM. It indexes source locally, executes batch tools and shows an inline terminal conversation. The assumed load is one developer in a trusted local repository, using one active agent turn per process.

Audit date: 2026-10-31. Scope: every source file, all tests, README, package manifest and lockfile, TypeScript config, CLI and WASM loading. Findings below describe the audited baseline; their status records the fixes made under the user's explicit cleanup request. The audit skill itself was used for inspection; code changes were separately authorized by that request.

## Must fix

1. **A failed write can destroy the original file** (`src/tools/fs-tools.ts`, `write` and `apply_edits_batch`). **Fixed.**
   - **What this is:** The batch editor changes text in files.
   - **Problem:** It wrote directly over the original. A simulated full disk left the file containing only `partial`. Failed creation also left a partial new file.
   - **Fix:** Write a sibling temporary file first, then replace an existing file by rename. Create new files with a link that refuses to overwrite an existing target, then remove the temporary name. Keep the edit queue, path checks and cancellation.
   - **If we skip it:** A reported failed edit can still lose source code. Regression tests now cover partial writes and failed renames.

2. **`--cwd` can use the wrong project's environment file** (`src/core/nim-client.ts`, module imports; `src/cli.tsx`, startup). **Fixed.**
   - **What this is:** The CLI loads the selected workspace's `.env`.
   - **Problem:** Importing the client first loaded `dotenv/config` from the launch directory. Its values could win over the selected workspace because dotenv does not overwrite existing environment variables.
   - **Fix:** Remove the client import side effect. Only the CLI chooses and loads a workspace `.env`; library callers supply environment variables or an explicit API key.
   - **If we skip it:** Launching from project A with `--cwd B` can charge or authenticate with A's configuration.

3. **Collapsed tool logs retain entire file contents** (`src/ui/controller.ts`, tool-end handler; `src/ui/ToolCallBadge.tsx`). **Fixed.**
   - **What this is:** Completed tool calls remain in the terminal transcript.
   - **Problem:** Each collapsed read retained its entire result. A single 1 MB test read left over 1 MB in one history entry. Rendering also serialized the result when the details were closed.
   - **Fix:** Store only the outcome in history and a bounded 2,000-character JSON preview for the latest tool. Generate detail text only when expanded. Preserve actual edit diffs separately.
   - **If we skip it:** Repeated reads keep growing memory even after model-context compaction. The regression checks a history entry below 500 characters and a latest-tool entry below 3,000.

4. **A method call can point at the wrong symbol** (`src/graph/repo-graph.ts`, `link`). **Fixed.**
   - **What this is:** The local graph reports possible destinations of calls.
   - **Problem:** `import { Service } ...; Service.run()` was linked to the `Service` class itself. The code treated a member call as a direct named import call.
   - **Fix:** Resolve member prefixes only for namespace imports. Leave unsupported named-import member calls unresolved. Build import bindings once per file rather than once per call.
   - **If we skip it:** The agent can inspect the wrong symbol and make a change on false dependency evidence.

5. **Plain-output mode can hide a model refusal** (`src/core/nim-client.ts`, `stream`). **Fixed.**
   - **What this is:** The CLI prints text received from streamed model events.
   - **Problem:** The response assembler accepted `delta.refusal`, but the token event forwarded only `delta.content`. A valid refusal response produced no visible text in plain mode.
   - **Fix:** Forward content or refusal from choice zero through the same token event.
   - **If we skip it:** A command may finish without showing why the model declined. A simulated SSE response now covers this case.

## Should fix

6. **Event systems and waits duplicate work** (`src/tools/fs-tools.ts`, `src/tools/graph-tools.ts`, `src/core/nim-client.ts`, `src/ui/controller.ts`). **Fixed.**
   - **What this is:** Events connect model and tool execution to the UI.
   - **Problem:** Filesystem and graph tools emitted a second set of events with no listeners in source or tests. `onChunk` also had no consumer. Pacing was checked both before SDK preparation and at actual HTTP dispatch. A cleanup array always held one callback.
   - **Fix:** Keep typed execution events in `AgentLoop`; remove unused lower-level emitters, `onChunk`, the earlier duplicate pacing wait and the one-element callback array. Keep validation, the shared limiter, backoff events and the HTTP-dispatch pacing check.
   - **If we skip it:** Every event-related change has extra code paths to maintain without adding behavior. The client still returns full stream chunks, including tool deltas.

7. **A widget package adds five installed packages for one spinner** (`src/ui/StatusBar.tsx`, `package.json`, `package-lock.json`). **Fixed.**
   - **What this is:** The status bar displays whether work is active.
   - **Problem:** `@inkjs/ui` was used only for `Spinner`. Its `deepmerge` dependency produced two low-severity npm audit entries, with no fix offered by the registry at audit time.
   - **Fix:** Use the existing Ink `Text` component for the activity label and remove `@inkjs/ui`. The live countdown, status, terminal layout and input remain.
   - **If we skip it:** The project keeps a dependency tree and advisory exposure for an optional animation. npm removed five packages and now reports zero vulnerabilities. This intentionally narrows the original stack under the user's cleanup instruction.

8. **A common directory spelling returns an empty map** (`src/graph/repo-graph.ts`, `getRepoMap`). **Fixed.**
   - **What this is:** `/graph` accepts a workspace-relative directory.
   - **Problem:** `./src/` was compared literally with paths beginning `src/`, so it hid matching files.
   - **Fix:** Validate the path first, then normalize it with Node's POSIX path helper.
   - **If we skip it:** `/graph ./src` appears to find no source even though `/graph src` works. Both forms now have the same tested output.

## Additional small cleanup

The tool badge now sanitizes the tool name as well as its details before displaying model-controlled text. Cancellation reuses its existing method. TypeScript now checks unused local variables and parameters during the normal build. Public methods used by tests or README examples, the batch validation boundary, the graph snapshot and the client test interface were retained: they have actual callers and are not dead code.

## Verification and limits

- 46 tests pass, including seven new regressions for write failures, implicit configuration loading, graph resolution, retained UI output and streamed refusals.
- Typecheck and production build pass with unused-local and unused-parameter checks enabled.
- `npm audit` and production-only audit report zero vulnerabilities.
- Source changes: 76 lines removed and 74 added, net **2 source lines fewer**, using normalized line endings and excluding trailing blank lines. This is a small codebase, so safety fixes consume most of the removed scaffolding.
- Direct runtime dependencies: **14 → 13**. npm removed **5 installed packages**. Tests and this report are additional to the source-line counts.
- Snapshot of the pre-audit source/config was saved outside Git in `C:/Users/thoma/AppData/Local/Temp/nim-phase5-EbD7FZ/baseline.json`. It does not include `.env` or credentials.

Atomic file replacement protects against the tested partial-write failures. It is not a crash-durable database transaction, a cross-process lock or a batch-wide rollback. Creating new files requires filesystem hard-link support; unsupported filesystems fail safely. Original custom ACLs and hard-link relationships are not promised to survive replacement. Hostile concurrent filesystem changes remain outside the trusted-workspace assumption.

The shell still has the user's OS permissions. Persistent sessions, approval policies and automatic project-instruction loading are not implemented; they are proposals in the companion comparison. The graph is still rebuilt after mutations, and long transcripts/diffs still grow with the session. No speculative cache or plugin framework was introduced without load evidence.

Verdict: the reproduced failures are fixed, and the unnecessary event/widget scaffolding is removed. The next useful milestone is recoverable sessions and explicit project context, not more abstraction.

Lean: -2 net source lines, -1 direct dependency applied (-5 installed packages).

Not checked: live NVIDIA credentials/model availability, Linux/macOS execution, FAT/network filesystem behavior, power-loss durability, and very large repository benchmarks. No claim of complete sandboxing or universal static call resolution is made.

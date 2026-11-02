# Audit fixes implementation plan

Goal: fix all nine findings from the 2026-11-02 audit without changing unrelated behavior or adding dependencies.

Approved scope: the user's request to fix findings 1–9, remove confirmed duplication, and run tests, typecheck and build. Implementation stays in this checkout; no personal configuration changes or commits are needed.

1. Add failing regression tests for context disclosure in scope none; background/undo/rewind and stale edit previews under restricted scopes; external dispatch in read-only; personal settings with extensions; full-scope external edits with approval and undo.
2. Fix scope checks in AgentLoop, FsTools/BackgroundTasks, ToolRegistry and PermissionGate. Keep relative path rules strict unless the host explicitly supplies full-scope metadata. Preserve ask/deny policies.
3. Accept extension keys in the shared personal config and validate extension shapes in ExtensionHost. Keep project settings and CLI overrides strict.
4. Add failing UI regressions for malformed arguments, queued skill cancellation, full diff rendering and retained diffstats. Harden ToolCallBadge, activate prompt skills only when AgentLoop starts the turn, and mark explicitly requested full diffs.
5. Remove duplicate diff counting and the impossible object-arguments branch. Keep the single controller computation and pass its summary to both live and completed badges.
6. Run focused regressions, affected suites, full tests, typecheck, build and the Impeccable detector. Review the final diff for scope leaks, permission bypass, out-of-workspace undo, stale previews and UI input failures.

Acceptance: all nine original reproductions are covered by regression tests; no dependency changes; NIM pacing and inline terminal behavior preserved.

## Completion evidence

All six implementation steps completed. Regression coverage lives in `tests/audit-regressions.test.tsx` (23 cases).

| Audit finding | Delivered correction |
|---|---|
| 1 | No new graph/reference/workspace-instruction/project-note context in scope none; idle-only AgentLoop scope changes. |
| 2 | Shared writable checks for background, edits, undo and rewind; revalidation before publication/spawn. |
| 3 | Read-only filters external schemas and dispatch; current scope checked before every external effect. |
| 4 | Personal config accepts extension sections alongside settings; ExtensionHost validates their shapes. |
| 5 | Badge parsing validates unknown JSON values and removes the impossible object-arguments branch. |
| 6 | Ordinary prompt skills activate only when the queued turn starts; explicit skill toggles preserved. |
| 7 | Host-authorized full-scope paths retain ask/deny checks and undo journaling. |
| 8 | Explicit /diff history entries render all diff lines. |
| 9 | Controller computes diffstats once; live and completed badges consume the retained summary. |

Final checks on 2026-11-02: `npm.cmd test -- --reporter=dot` reports 52 test files passed, 526 tests passed and 2 skipped. `npm.cmd run typecheck`, `npm.cmd run build` and `git diff --check` pass. Impeccable detector on the changed UI files reports `[]`. Independent review reproduced and verified closure of the asynchronous scope cases.

One earlier full run failed the existing project-memory multiprocess test with an unreadable lock-owner error. Its isolated suite then passed 33/33 and the final full run passed. No project-memory source or test was changed to hide that intermittent failure. Live NIM endpoints, physical terminal accessibility and Linux/macOS execution were not tested.

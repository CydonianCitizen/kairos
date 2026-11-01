# Personal configuration and shared NIM verification implementation plan

> **For agentic workers:** Implement the approved three-point scope in this checkout, preserving all pre-existing changes. Use test-driven development and focused ownership; do not commit unrelated work.

**Goal:** Configure Kairos once, coordinate NIM requests across repositories/processes, and explicitly verify hosted model capabilities.

**Architecture:** Load personal JSON defaults and prompt instructions at CLI startup, with trusted project settings and explicit CLI overrides. Keep Bottleneck's single-process FIFO and add a per-key filesystem lease around requests, streaming and retries. An explicit CLI model check uses the same client and records observed results without promoting unverified capabilities.

**Tech Stack:** Existing TypeScript/Node ESM, OpenAI SDK, Bottleneck, Vitest; no additional runtime dependencies.

**Spec:** User-approved items 1–3 in this chat, 2026-11-01.

## Global constraints

- All NIM calls retain `maxConcurrent: 1` and `minTime: 1600`, including metadata and diagnostics.
- Keep credentials out of settings, reports and logs; preserve existing personal files.
- CLI > trusted project settings > personal settings; resumed sessions retain saved model/effort unless CLI overrides them.
- Personal instructions extend the base system prompt; project prompt settings require `--trust-workspace`.
- Work in the current checkout to retain the already modified implementation used by the installed command; no resets, automatic deletion or unrelated commits.

## Review focus

- Invalid JSON, unsupported effort, oversized/escaping prompt files must fail with useful messages.
- Cancellation and crashed owners must release/recover the shared queue without overlapping requests.
- Live owners must never lose a lease solely because a request takes a long time.
- Preserve cooldown after failure, retry or interrupted streams; never persist raw API keys.
- Checks must distinguish request acceptance, complete responses, tool arguments and untested capabilities.

### Task 1: Personal settings and instructions

Files: new `src/config/settings.ts`, settings tests; modify `src/core/agent-loop.ts` for optional `effort` and `systemPrompt` instructions. Parent integrates `src/cli-options.ts` and `src/cli.tsx`.

- [x] Test global/project/CLI precedence, trusted project boundary, missing/invalid files, model/effort validation and instruction injection on every turn/resume.
- [x] Implement loading from `~/.kairos/config.json`, optional `~/.kairos/system-prompt.md`, trusted `.kairos/config.json`, and explicit `--system-prompt`.
- [x] Run focused tests and typecheck; document actual interfaces for integration.

### Task 2: Cross-process NIM coordination

Files: new `src/core/nim-pacing.ts`, pacing tests; modify `src/core/nim-client.ts` and its isolated tests.

- [x] Prove exclusive requests and at least 1600ms between dispatches across independent processes using real local fixtures.
- [x] Add per-key filesystem coordination and cancellation/dead-owner recovery; hold the lease through streaming and 429 backoff.
- [x] Verify no raw credentials in coordinator files and that existing retry/countdown behavior survives.

### Task 3: Explicit model verification and integration

Files: new `src/core/model-checks.ts`, verification tests; modify CLI, SDK exports and documentation.

- [x] Test full/truncated streamed responses, system instructions, batch tool calls, valid arguments, and supported effort request profiles with simulated transport.
- [x] Add `kairos --check-models`, optionally filtered by `--model`, with bounded probe duration and local JSON report.
- [x] Integrate settings and shared pacing, run full tests/typecheck/build and external-workspace CLI smoke tests.
- [x] Execute live checks with the configured key; record the observed timestamp/status and endpoint failures without claiming unsupported capabilities.

### Completion

- [x] Review the integrated change, run required regression checks, and report exact live outcomes and any remaining limits.

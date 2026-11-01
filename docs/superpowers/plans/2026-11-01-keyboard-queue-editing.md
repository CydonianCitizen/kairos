# Keyboard editing of queued messages

User request: select queued messages with arrows and edit their existing text directly in the prompt. Also report remaining Claude Code differences using current official sources and the local working tree.

Agreed behavior: pause dispatch of the waiting queue during editing; allow the current turn to finish. Preserve ID/FIFO position. Up at the first input row enters queue selection, arrows browse, Enter/Tab loads the selected message, Enter saves, Esc cancels and restores the prior draft. Ordinary multiline cursor navigation, completion and history keep precedence. Literal slash-prefixed queued text must never execute as a command.

Implementation reuses Interaction's FIFO and editQueued API, the existing InputBox editor and theme. Controller owns an editing draft so approval/picker remounts cannot discard it. Editing starts only for an existing waiting ID. Removed/stale IDs and invalid text keep the draft and report an error without enqueueing. Cancelling or saving resumes dispatch. Selection alone does not pause. No persistent queue format or new dependency.

Verification: prove pause/handoff/cancel/close; keyboard selection, multiline editing, ID/order, draft restoration, active-turn completion while paused, stale target, literal commands, approval remount, no extra NIM request. Run focused suites, typecheck/build and review. Compare Claude Code in a separate read-only research task.

Completed: keyboard selection previews and highlights the exact queued ID, InputBox edits the existing text with the full editor, save/cancel resume the queue and restore the previous draft. Controller preserves the editing draft across approval remounts. A stale selection retains its identity until dismissed or a failed load, preventing Enter from accidentally submitting an unrelated draft. Short terminals compact optional content so editor controls and the footer stay visible.

Evidence: full native Windows suite **337 passed, one platform symlink skip**; typecheck/build and compiled-CLI offline smoke pass. Independent review found stale-selection submission and footer clipping at 10/16 rows; both have failing-then-passing regression tests and a successful bounded review confirmation. The UI mechanical detector returned no findings. No real NIM inference was used. Current Claude Code comparison is recorded in docs/KAIROS-VS-CLAUDE-CODE.md using official documentation and current local modules.

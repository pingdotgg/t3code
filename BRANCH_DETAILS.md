# File Change And Command Activity Boxes

## Current Status

Branch maintenance snapshot for the latest upstream merge resolution:

- Generated from `upstream/main` `1735e27d9e5106bbb35d5b1dd10363604a54b69e` with starting branch HEAD `69fc584b1daa62f93ee33ecccba05f16c52a1622`. The merge commit is `a1b98b863ed7b4e0f565cbb02f881f04c3f8cce0`; the previous upstream merge is `8423816645165c559c5baebc25d4f29d62b10e2f`, whose upstream parent is `fdca15471d92e95e4ec5501f45dbf3ce81f8d991`.
- Shared refs at merge time: `origin/main` `2fe83d19ea2548dfaa7770aea29e5047d0b17b6e`, local `main` `cfbd1261caa08707987d2dfc2edc93caa0790d54`, and branch tracking ref `origin/split/file-command-activity-boxes` `8423816645165c559c5baebc25d4f29d62b10e2f`.
- After the merge, activity normalization refactor, and this documentation refresh, the resulting branch is `63 ahead / 0 behind upstream/main`, `113 ahead / 505 behind origin/main`, `113 ahead / 517 behind local main`, and `55 ahead / 0 behind origin/split/file-command-activity-boxes`. The fork diff is `12 files changed, 4127 insertions(+), 683 deletions(-)` against the `upstream/main` tree.
- Merge note: the 50 incoming commits from `8a02c71869b4a075c0d5503a428c99d9c3ab6346` through `1735e27d9e5106bbb35d5b1dd10363604a54b69e` add terminal selection copying, the draft landing hero, file-explorer mention actions, desktop updater release notes, mobile screenshot automation and refreshed branding; improve message sending, initial thread snapshots, active-thread cache writes, timestamps, remote-environment cleanup, diff navigation/defaults, terminal spawning, source-control path handling, and provider reliability; and fix desktop, mobile, server, composer, preview, context-menu, and settings edge cases. Git merged all files automatically with no conflicts.
- Activity-box impact note: `apps/web/src/components/chat/MessagesTimeline.tsx` was the only branch-primary file touched by both histories. Its automatic additive merge preserves the customized expandable file-change and command rows while adding upstream's optional `hideEmptyPlaceholder` prop and empty-timeline suppression for the draft hero. Upstream still does not provide equivalent activity detail boxes, so no customization is retired. The incoming timestamp, message-delivery, initial-snapshot, and active-thread-cache fixes complement rather than replace the branch's work-log event normalization.
- Refactor note: commit `1c21453bc32b743838e6e3e25cb826000f2569ff` moves provider-specific command/file payload parsing, bounded patch extraction, changed-file discovery, and cumulative output/patch merging into the directly tested `apps/web/src/lib/workLogActivity.ts` module. `apps/web/src/session-logic.ts` retains timeline ordering, lifecycle collapse, and public work-log composition, reducing its scope without changing the exported activity-box API or behavior.
- Validation note: 169 focused unit tests passed across the work-log parser/merger, session logic, and both timeline suites; `pnpm exec vp check`, `pnpm exec vp run typecheck`, and `git diff --check` passed. The formatting/lint gate retained 10 unrelated warnings, typecheck retained existing informational Effect suggestions, and no native mobile files changed. A fixed-port Playwright startup smoke was attempted on web `5737` and server `13777`, but navigation did not reach `domcontentloaded` within 60 seconds while the server independently logged remote Git-status timeouts, so browser automation was recorded as environment-blocked rather than a product failure.

Tool activity remains readable in long-running Codex threads without changing agent execution semantics. File-change and command activities are rendered as clickable, expandable rows in the conversation work log.

Expected behavior:

- A file-change row keeps the compact `Changed files - path/to/file` style preview while collapsed.
- File-change-style tool rows that also carry command metadata or patch payloads still prefer the changed-file path preview while collapsed, so rows such as `apply_patch` stay oriented around the file being edited instead of the command label.
- Clicking a file-change row expands it inline and renders any available patch with the same `FileDiff` diff viewer used by other conversation diff surfaces.
- If a file-change event only has paths and no patch, the expanded row still lists the changed paths instead of opening the full turn diff panel.
- Tool rows that merely mention changed files, such as file-read detail rows, stay in the generic detail panel unless they include a patch or are explicitly marked as a file-change request, so read-only tool output is not mislabeled as an editable file-change row.
- A command row keeps the compact `Ran command - command` style preview while collapsed.
- Clicking a command row expands it inline and shows the command, raw command when it differs, stdout, stderr, exit code, and duration.
- Differing raw command text is rendered inline as a normal detail block in the expanded row, not hidden behind a second nested disclosure.
- Stdout and stderr show only the last 40 lines by default when longer than 40 lines; clicking either output block toggles the full stream.
- Structured non-zero command exit codes produce the failure affordance, and an exact zero duration is rendered as `0ms`.
- Cumulative file-change patch snapshots replace their shorter prefix instead of duplicating already-rendered hunks, and an oversized patch is skipped without preventing valid sibling diffs from rendering.
- Command output extraction ignores blank-only completed stdout/stderr fallbacks so aggregated command output is still shown, but preserves whitespace-only incremental `tool.updated` chunks, including raw output `content`, so streamed output is not collapsed away.
- Incremental command output chunks concatenate without injected separators, while shorter completed snapshots, newline-terminated shorter updated snapshots, and shorter single-line repeated-prefix snapshots do not overwrite a previously merged longer output snapshot.
- MCP tool-data serialization preserves repeated references to the same argument object when they are not cyclic, while still redacting real ancestor-chain cycles as `[Circular]`, so expanded generic details stay informative without risking recursive rendering.
- Row-level keyboard expansion only handles Enter and Space when the event target is the row itself, so nested action controls do not also toggle the parent activity row.

Primary files:

- `apps/web/src/session-logic.ts`
- `apps/web/src/lib/workLogActivity.ts`
- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/lib/workLogEntryDetails.ts`

Relevant tests live in:

- `apps/web/src/lib/workLogActivity.test.ts`
- `apps/web/src/components/chat/MessagesTimeline.test.tsx`
- `apps/web/src/components/chat/MessagesTimeline.logic.test.ts`
- `apps/web/src/session-logic.test.ts`

Useful focused commands:

```sh
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/lib/workLogActivity.test.ts src/session-logic.test.ts src/components/chat/MessagesTimeline.logic.test.ts src/components/chat/MessagesTimeline.test.tsx)
```

## Development Ports

- Web: `5737`
- Server/WebSocket: `13777`

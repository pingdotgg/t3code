# File Change And Command Activity Boxes

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
- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/lib/workLogEntryDetails.ts`

Relevant tests live in:

- `apps/web/src/components/chat/MessagesTimeline.test.tsx`
- `apps/web/src/components/chat/MessagesTimeline.logic.test.ts`
- `apps/web/src/session-logic.test.ts`

Useful focused commands:

```sh
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/session-logic.test.ts)
(cd apps/web && pnpm exec vp test run --passWithNoTests --project unit src/components/chat/MessagesTimeline.test.tsx)
```

## Development Ports

- Web: `5737`
- Server/WebSocket: `13777`

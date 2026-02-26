# PR #89 Post-Rewrite Validity Audit

Architecture baseline used for this audit:
- Provider runtime activity is projected into orchestration domain events.
- Web client consumes `orchestration.domainEvent`; no separate `providers.event` channel is expected.

## Summary

- Canonical items reviewed: 58
- Valid: 34
- Partially valid: 19
- Invalid (stale/no longer applicable): 5

## Invalid Items To Close

- C021 [Medium] Shared mutable default metadata object causes stale eventId (apps/server/src/orchestration/decider.ts:27)
  - Reason: Stale-eventId claim no longer applies; eventId is regenerated per event.
  - Threads: PRRT_kwDORLtfbc5wkPaA
- C025 [Medium] Duplicated checkpoint ref computation across two files (apps/server/src/wsServer.ts:128)
  - Reason: No longer duplicated; checkpoint ref helper now centralized.
  - Threads: PRRT_kwDORLtfbc5wvwag
- C031 [Medium] Revert uses wrong turn count from positional inference (apps/web/src/session-logic.ts:127)
  - Reason: Revert now uses explicit checkpointTurnCount first; positional fallback is non-primary.
  - Threads: PRRT_kwDORLtfbc5v9SCp
- C036 [Low] Duplicate `checkpointRefForThreadTurn` function in two production files (apps/server/src/checkpointing/Layers/CheckpointStore.ts:284)
  - Reason: No longer duplicated; single production source via Refs.ts.
  - Threads: PRRT_kwDORLtfbc5wiqFX
- C055 [Low] Duplicate `checkpointRefForThreadTurn` function across files (apps/server/src/wsServer.ts:128)
  - Reason: No longer duplicated; helper is centralized.
  - Threads: PRRT_kwDORLtfbc5wkPaG

## Partially Valid Items (de-scope or lower priority)

- C006 [Medium] Build script runs TypeScript file with bare node (apps/server/package.json:14)
  - Note: Node 24 makes this work, but script still relies on runtime-specific TS execution.
- C007 [Medium] Build script uses `node` to run `.ts` file directly (apps/server/package.json:14)
  - Note: Same as C006 (duplicate concern).
- C008 [Medium] Inconsistent input normalization across CheckpointStore methods (apps/server/src/checkpointing/Layers/CheckpointStore.ts:94)
  - Note: Normalization inconsistency remains, but upstream callsites now mostly canonicalize inputs.
- C014 [Medium] Engine error handler catches all errors including non-invariant ones (apps/server/src/orchestration/Layers/OrchestrationEngine.ts:144)
  - Note: Broad catch may be intentional for liveness; correctness concern is contextual.
- C015 [Medium] The gap-filling fallback logic can retain messages from turns that are about to be deleted, causing foreign key violations. Consider removing the fallback logic entirely, or filtering `fallbackUserMessages` and `fallbackAssistantMessages` to only include messages whose `turnId` is in `retainedTurnIds`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/orchestration/Layers/ProjectionPipeline.ts:99)
  - Note: Message fallback retention issue is real, but prior FK-violation claim is overstated.
- C017 [Medium] `REQUIRED_SNAPSHOT_PROJECTORS` includes `pending-approvals` and `thread-turns`, but `getSnapshot` doesn't query their data. If these projectors lag behind, the returned `snapshotSequence` will be lower than what the included data actually reflects, causing clients to replay already-applied events. Consider filtering `REQUIRED_SNAPSHOT_PROJECTORS` to only include projectors whose data is actually fetched in the snapshot. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:71)
  - Note: Snapshot sequence can under-report due to extra projectors, but replay impact is lower now.
- C019 [Medium] ProviderRuntimeIngestion processes events for wrong thread on race (apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:178)
  - Note: SessionId-only routing can misassociate events under races/rebinds.
- C020 [Medium] On `message.completed`, the message ID is added to the set and `thread.message.assistant.complete` is dispatched. On `turn.completed`, the same set is iterated and `thread.message.assistant.complete` is dispatched again for each ID—including already-completed ones. Consider removing message IDs from the set after dispatching on `message.completed`, or filtering out already-completed IDs before the `turn.completed` loop. (apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:266)
  - Note: Duplicate complete dispatch exists; downstream impact often idempotent.
- C024 [Medium] In `executeUnprepared`, preparing outside an effect and not closing the statement can cause uncaught errors and leaks. Suggest wrapping with `Effect.acquireUseRelease`: prepare in acquire (error-safe) and `finalize` in release. (apps/server/src/persistence/NodeSqliteClient.ts:145)
  - Note: prepare() still outside managed effect boundary; failure handling risk remains.
- C028 [Medium] Branch sync dispatches both server and stale local update (apps/web/src/components/BranchToolbar.tsx:102)
  - Note: Optimistic local+server dual update is intentional but can temporarily diverge.
- C033 [Low] Three error classes defined but never instantiated anywhere (apps/server/src/checkpointing/Errors.ts:51)
  - Note: Original claim overstated; some errors used, others appear unused.
- C037 [Low] `Effect.callback` should return a cleanup function to close the server(s) on fiber interruption. Without it, the `Net.Server` handles keep the process alive and leak the port if the effect is cancelled. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/config.ts:41)
  - Note: Callback cleanup missing, but practical exposure is low in one-shot startup path.
- C039 [Low] The `+` key can be parsed (via trailing `+` handling) but cannot be encoded because `shortcut.key.includes("+")` returns true for the literal `+` key. Consider checking `shortcut.key === "+"` separately and encoding it as `"space"` style (e.g., a special token), or adjusting the condition to allow the single `+` character. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/keybindings.ts:352)
  - Note: Parser/encoder mismatch remains, but encoder path currently low-use.
- C042 [Low] Duplicated `resolveThreadWorkspaceCwd` across three files (apps/server/src/orchestration/Layers/CheckpointReactor.ts:62)
  - Note: Duplication exists but one instance is variant logic, so impact is moderate.
- C044 [Low] Checkpoint reactor swallows diff errors silently for `turn.completed` (apps/server/src/orchestration/Layers/CheckpointReactor.ts:274)
  - Note: Errors are swallowed to empty diff with warning; not fully silent but still lossy.
- C048 [Low] `statement.run()` returns a `RunResult` object, not an array. Casting it to `ReadonlyArray<any>` will cause runtime errors when consumers call array methods. Consider wrapping the result (e.g., `[result]`) or returning a properly typed object. (apps/server/src/persistence/NodeSqliteClient.ts:99)
  - Note: Unsafe run() result cast remains; runtime risk depends on raw-result consumers.
- C051 [Low] Using `??` for `providerThreadId` and `adapterKey` makes it impossible to clear these fields by passing `null`, since `null ?? existing` evaluates to `existing`. Consider using explicit `undefined` checks (like `resumeCursor` does) if clearing should be supported. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/provider/Layers/ProviderSessionDirectory.ts:119)
  - Note: Null-clearing issue is real for providerThreadId; adapterKey part overstated.
- C056 [Low] When `onOpenChange` is provided without `open`, the internal `_open` state never updates because `setOpenProp` takes precedence. Consider calling `_setOpen` when `openProp === undefined`, regardless of whether `setOpenProp` exists. (apps/web/src/components/ui/sidebar.tsx:114)
  - Note: Bug pattern exists, but current callsites mostly avoid triggering it.
- C059 [Low] Suggestion: don’t spread `params` into `body`; it can override `_tag` and mishandle non-object values. Keep `_tag` separate and nest `params` under a single key (e.g., `data`), or validate `params` is a plain object. (apps/web/src/wsTransport.ts:59)
  - Note: Transport _tag override risk exists but current callsites are constrained.

## Valid Items (actionable unless marked completed)

- C001 [High] Non-atomic event appending can corrupt state on retry. If an error occurs mid-loop (lines 96-102) after some events are persisted but before the receipt is written, the command appears to fail. A retry generates new UUIDs via `crypto.randomUUID()` in the decider, appending duplicate events. Consider wrapping the loop in a transaction or using deterministic event IDs derived from `commandId`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/orchestration/Layers/OrchestrationEngine.ts:96)
- C002 [High] A dispatch error in `processEvent` will terminate the `Effect.forever` loop, permanently halting event ingestion. Consider adding error recovery (e.g., `Effect.catchAll` with logging) around `processEvent` so failures don't kill the fiber. (apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:333)
  - Status: Completed in Phase 1.
- C003 [High] Consider attaching a no-op error listener before `socket.write` (e.g., `socket.on('error', () => {})`) to prevent an unhandled `EPIPE`/`ECONNRESET` from crashing the process if the client disconnects mid-handshake. (apps/server/src/wsServer.ts:75)
- C009 [Medium] Git's braced rename syntax (e.g., `src/{old => new}/file.ts`) isn't handled correctly. The current slice after ` => ` produces invalid paths like `new}/file.ts`. Consider expanding the braces to construct the full destination path. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/git/Layers/GitCore.ts:41)
- C010 [Medium] `loadCustomKeybindingsConfig` fails when the config file doesn't exist, which is expected for new users. Consider catching `ENOENT` and returning an empty array instead. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/keybindings.ts:418)
- C011 [Medium] Template literal `${cause}` throws if `cause` is a `Symbol`. Consider using `String(cause)` instead. (apps/server/src/orchestration/Errors.ts:117)
- C012 [Medium] Forked revert dispatch risks read model inconsistency (apps/server/src/orchestration/Layers/CheckpointReactor.ts:542)
  - Status: Completed in Phase 1.
- C013 [Medium] If `projectionPipeline.projectEvent` fails after `eventStore.append` succeeds, the event is persisted but `readModel` isn't updated, causing desync. Consider updating the in-memory `readModel` immediately after append (before the external projection), so local state stays consistent regardless of downstream failures. (apps/server/src/orchestration/Layers/OrchestrationEngine.ts:99)
- C016 [Medium] The in-memory `pendingTurnStartByThreadId` map isn't restored during bootstrap. If the service restarts after processing `thread.turn-start-requested` but before `thread.session-set`, the `userMessageId` and `startedAt` will be lost since bootstrap resumes *after* the committed sequence. Consider persisting this pending state or processing these two events atomically. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/orchestration/Layers/ProjectionPipeline.ts:490)
- C018 [Medium] Unbounded memory growth in turn start deduplication set (apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:84)
- C022 [Medium] Fish shell outputs `$PATH` as space-separated, not colon-separated. Consider checking if the shell is fish and using `string join : $PATH` instead, or validating the result contains colons before assigning. (apps/server/src/os-jank.ts:10)
- C023 [Medium] Using `-il` flags causes the shell to source profile scripts that may print banners or other text, polluting the captured `PATH`. Consider using `-lc` (login only, non-interactive) to reduce unwanted output. (apps/server/src/os-jank.ts:10)
- C026 [Medium] Consider adding `.catch(() => {})` after `Effect.runPromise(handleMessage(ws, raw))` to prevent unhandled rejections from crashing the server if `encodeResponse` or setup logic fails. (apps/server/src/wsServer.ts:545)
  - Status: Completed in Phase 1.
- C027 [Medium] WS message handler can cause unhandled promise rejection (apps/server/src/wsServer.ts:545)
  - Status: Completed in Phase 1.
- C029 [Medium] `parseFileUrlHref` already decodes the path (line 46), but `safeDecode` is called again here, corrupting filenames containing `%` sequences. Consider skipping the decode when `fileUrlTarget` is non-null. (apps/web/src/markdown-links.ts:105)
- C030 [Medium] `EXTERNAL_SCHEME_PATTERN` matches `script.ts:10` as a scheme because `.ts:` looks like `scheme:`. Consider requiring `://` after the colon, or checking that what follows the colon is not just digits. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/web/src/markdown-links.ts:111)
- C032 [Low] Dummy workflow marker accidentally committed to docs (AGENTS.md:45)
- C034 [Low] Redundant `CheckpointInvariantError` in `CheckpointServiceError` union type (apps/server/src/checkpointing/Errors.ts:79)
- C035 [Low] Redundant error type in CheckpointServiceError union definition (apps/server/src/checkpointing/Errors.ts:79)
- C038 [Low] Multi-byte UTF-8 characters split across chunks will be corrupted when decoding each chunk separately. Consider accumulating all chunks first, then decoding once, or use `TextDecoder` with `stream: true`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/git/Layers/CodexTextGeneration.ts:136)
- C040 [Low] `upsertKeybindingRule` has a race condition: concurrent calls read the same file state, then the last write overwrites earlier changes. Consider wrapping the read-modify-write sequence with `Effect.Semaphore` to serialize access. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/keybindings.ts:488)
- C041 [Low] Template literal interpolation throws `TypeError` if `cause` is a `Symbol`. Consider using `String(cause)` for safe coercion. (apps/server/src/orchestration/Errors.ts:126)
- C043 [Low] Duplicated workspace CWD resolution logic across reactor modules (apps/server/src/orchestration/Layers/CheckpointReactor.ts:62)
- C045 [Low] `truncateDetail` slices to `limit - 1` then appends `"..."` (3 chars), producing strings of length `limit + 2`. Consider slicing to `limit - 3` instead. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:29)
- C046 [Low] `latestMessageIdByTurnKey` is written to but never read, and `clearAssistantMessageIdsForTurn` doesn't clear its entries—only `clearTurnStateForSession` does. Consider removing this map entirely if unused, or clearing it alongside `turnMessageIdsByTurnKey` in `clearAssistantMessageIdsForTurn`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:133)
- C047 [Low] `SqlSchema.findOneOption` can produce both SQL errors and decode errors, but `mapError` wraps all as `PersistenceSqlError`. Consider distinguishing `ParseError` from SQL errors and mapping decode failures to `PersistenceDecodeError` instead. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts:75)
- C049 [Low] `JSON.stringify(cause)` returns `undefined` for `undefined`, functions, or symbols, violating the `string` return type. Consider coercing the result to a string (e.g., `String(JSON.stringify(cause))`) or adding a fallback. (apps/server/src/provider/Layers/ProviderService.ts:59)
- C050 [Low] The read-modify-write pattern (`getBySessionId` → merge → `upsert`) is susceptible to lost updates under concurrent writes. Consider wrapping in a transaction or adding optimistic concurrency control (e.g., version field) if concurrent session updates are expected. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/provider/Layers/ProviderSessionDirectory.ts:94)
- C052 [Low] Race condition: `processHandle` may be `null` when `data` callback fires, since it's assigned after `Bun.spawn` returns. Consider initializing `BunPtyProcess` first, then passing it to the callback to avoid losing initial output. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/terminal/Layers/BunPTY.ts:97)
- C053 [Low] Consider using `socket.end(response)` instead of `socket.write(response)` + `socket.destroy()` to ensure the HTTP error response is fully flushed before closing the connection. (apps/server/src/wsServer.ts:83)
- C054 [Low] When array chunks contain a multi-byte UTF-8 character split across boundaries, decoding each chunk separately produces replacement characters. Consider using `Buffer.concat()` on all chunks before calling `.toString("utf8")`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/wsServer.ts:104)
- C057 [Low] The `resizable` object is recreated on every render, causing `SidebarRail`'s `useEffect` to repeatedly read localStorage and update the DOM. Consider memoizing the object with `useMemo`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/web/src/routes/_chat.$threadId.tsx:105)
- C058 [Low] When `localStorage.getItem()` returns `null`, `Number(null)` evaluates to `0`, which passes `Number.isFinite(0)`. This causes the sidebar to clamp to `minWidth` on first load, overriding the `DIFF_INLINE_DEFAULT_WIDTH` CSS clamp. Consider checking for `null` or empty string before parsing, e.g. guard with `storedWidth === null || storedWidth === ''`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/web/src/routes/_chat.$threadId.tsx:122)
- C060 [Low] `defaultModel` should be `Schema.optional(Schema.NullOr(Schema.String))` to allow clearing the value. Currently there's no way to reset it to `null` since omitting means "no change" in patch semantics. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (packages/contracts/src/orchestration.ts:253)

## By Area

- Build/runtime portability: valid=0, partially-valid=2, invalid=0
- Checkpointing correctness: valid=2, partially-valid=3, invalid=3
- Edge-case parsing/platform behavior: valid=8, partially-valid=1, invalid=0
- Event ordering and state consistency: valid=3, partially-valid=2, invalid=1
- Memory/resource growth: valid=1, partially-valid=0, invalid=0
- Other: valid=10, partially-valid=6, invalid=1
- Runtime resilience and failure handling: valid=6, partially-valid=4, invalid=0
- WebSocket robustness: valid=4, partially-valid=1, invalid=0

Machine-readable mapping: `.plans/16b-pr89-architecture-validity-audit.json`.

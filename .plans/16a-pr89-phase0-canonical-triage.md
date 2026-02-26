# Phase 0: PR #89 Canonical Triage Lock

- PR: https://github.com/pingdotgg/t3-code/pull/89
- Title: Add server-side orchestration engine with event sourcing
- Generated from latest GitHub data and deduplicated into canonical fix items.

## Summary

- Total threads: 185
- Actionable canonical: 58
- Actionable duplicates: 24
- Filtered outdated: 94
- Filtered resolved: 6
- Filtered invalid: 3

## Canonical Actionable Checklist

### Other (17)

- [ ] C011 [Medium] Template literal `${cause}` throws if `cause` is a `Symbol`. Consider using `String(cause)` instead. (apps/server/src/orchestration/Errors.ts:117)
  - Threads: PRRT_kwDORLtfbc5wBFv4
- [ ] C021 [Medium] Shared mutable default metadata object causes stale eventId (apps/server/src/orchestration/decider.ts:27)
  - Threads: PRRT_kwDORLtfbc5wkPaA
- [ ] C024 [Medium] In `executeUnprepared`, preparing outside an effect and not closing the statement can cause uncaught errors and leaks. Suggest wrapping with `Effect.acquireUseRelease`: prepare in acquire (error-safe) and `finalize` in release. (apps/server/src/persistence/NodeSqliteClient.ts:145)
  - Threads: PRRT_kwDORLtfbc5whxX9
- [ ] C028 [Medium] Branch sync dispatches both server and stale local update (apps/web/src/components/BranchToolbar.tsx:102)
  - Threads: PRRT_kwDORLtfbc5v-XCu
- [ ] C032 [Low] Dummy workflow marker accidentally committed to docs (AGENTS.md:45) (+1 dup)
  - Threads: PRRT_kwDORLtfbc5wlYgj, PRRT_kwDORLtfbc5w1C4H
- [ ] C037 [Low] `Effect.callback` should return a cleanup function to close the server(s) on fiber interruption. Without it, the `Net.Server` handles keep the process alive and leak the port if the effect is cancelled. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/config.ts:41)
  - Threads: PRRT_kwDORLtfbc5wj4cO
- [ ] C041 [Low] Template literal interpolation throws `TypeError` if `cause` is a `Symbol`. Consider using `String(cause)` for safe coercion. (apps/server/src/orchestration/Errors.ts:126)
  - Threads: PRRT_kwDORLtfbc5wBFWs
- [ ] C047 [Low] `SqlSchema.findOneOption` can produce both SQL errors and decode errors, but `mapError` wraps all as `PersistenceSqlError`. Consider distinguishing `ParseError` from SQL errors and mapping decode failures to `PersistenceDecodeError` instead. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts:75)
  - Threads: PRRT_kwDORLtfbc5wiaR-
- [ ] C048 [Low] `statement.run()` returns a `RunResult` object, not an array. Casting it to `ReadonlyArray<any>` will cause runtime errors when consumers call array methods. Consider wrapping the result (e.g., `[result]`) or returning a properly typed object. (apps/server/src/persistence/NodeSqliteClient.ts:99)
  - Threads: PRRT_kwDORLtfbc5wio-r
- [ ] C049 [Low] `JSON.stringify(cause)` returns `undefined` for `undefined`, functions, or symbols, violating the `string` return type. Consider coercing the result to a string (e.g., `String(JSON.stringify(cause))`) or adding a fallback. (apps/server/src/provider/Layers/ProviderService.ts:59)
  - Threads: PRRT_kwDORLtfbc5wnVsI
- [ ] C050 [Low] The read-modify-write pattern (`getBySessionId` → merge → `upsert`) is susceptible to lost updates under concurrent writes. Consider wrapping in a transaction or adding optimistic concurrency control (e.g., version field) if concurrent session updates are expected. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/provider/Layers/ProviderSessionDirectory.ts:94)
  - Threads: PRRT_kwDORLtfbc5wiLhY
- [ ] C051 [Low] Using `??` for `providerThreadId` and `adapterKey` makes it impossible to clear these fields by passing `null`, since `null ?? existing` evaluates to `existing`. Consider using explicit `undefined` checks (like `resumeCursor` does) if clearing should be supported. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/provider/Layers/ProviderSessionDirectory.ts:119)
  - Threads: PRRT_kwDORLtfbc5wxvH9
- [ ] C052 [Low] Race condition: `processHandle` may be `null` when `data` callback fires, since it's assigned after `Bun.spawn` returns. Consider initializing `BunPtyProcess` first, then passing it to the callback to avoid losing initial output. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/terminal/Layers/BunPTY.ts:97)
  - Threads: PRRT_kwDORLtfbc5w1CxE
- [ ] C056 [Low] When `onOpenChange` is provided without `open`, the internal `_open` state never updates because `setOpenProp` takes precedence. Consider calling `_setOpen` when `openProp === undefined`, regardless of whether `setOpenProp` exists. (apps/web/src/components/ui/sidebar.tsx:114)
  - Threads: PRRT_kwDORLtfbc5wxvIq
- [ ] C057 [Low] The `resizable` object is recreated on every render, causing `SidebarRail`'s `useEffect` to repeatedly read localStorage and update the DOM. Consider memoizing the object with `useMemo`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/web/src/routes/_chat.$threadId.tsx:105)
  - Threads: PRRT_kwDORLtfbc5wyWz4
- [ ] C058 [Low] When `localStorage.getItem()` returns `null`, `Number(null)` evaluates to `0`, which passes `Number.isFinite(0)`. This causes the sidebar to clamp to `minWidth` on first load, overriding the `DIFF_INLINE_DEFAULT_WIDTH` CSS clamp. Consider checking for `null` or empty string before parsing, e.g. guard with `storedWidth === null || storedWidth === ''`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/web/src/routes/_chat.$threadId.tsx:122)
  - Threads: PRRT_kwDORLtfbc5wnVsX
- [ ] C060 [Low] `defaultModel` should be `Schema.optional(Schema.NullOr(Schema.String))` to allow clearing the value. Currently there's no way to reset it to `null` since omitting means "no change" in patch semantics. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (packages/contracts/src/orchestration.ts:253)
  - Threads: PRRT_kwDORLtfbc5whxJC

### Runtime resilience and failure handling (10)

- [ ] C002 [High] A dispatch error in `processEvent` will terminate the `Effect.forever` loop, permanently halting event ingestion. Consider adding error recovery (e.g., `Effect.catchAll` with logging) around `processEvent` so failures don't kill the fiber. (apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:333) (+5 dup)
  - Threads: PRRT_kwDORLtfbc5wj4cH, PRRT_kwDORLtfbc5wnWwF, PRRT_kwDORLtfbc5wyTaP, PRRT_kwDORLtfbc5wzliw, PRRT_kwDORLtfbc5w0_g3, PRRT_kwDORLtfbc5w1HGT
- [ ] C012 [Medium] Forked revert dispatch risks read model inconsistency (apps/server/src/orchestration/Layers/CheckpointReactor.ts:542) (+4 dup)
  - Threads: PRRT_kwDORLtfbc5whszW, PRRT_kwDORLtfbc5wyTaS, PRRT_kwDORLtfbc5wzli0, PRRT_kwDORLtfbc5w0_g4, PRRT_kwDORLtfbc5w1HGX
- [ ] C019 [Medium] ProviderRuntimeIngestion processes events for wrong thread on race (apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:178)
  - Threads: PRRT_kwDORLtfbc5wkPaL
- [ ] C020 [Medium] On `message.completed`, the message ID is added to the set and `thread.message.assistant.complete` is dispatched. On `turn.completed`, the same set is iterated and `thread.message.assistant.complete` is dispatched again for each ID—including already-completed ones. Consider removing message IDs from the set after dispatching on `message.completed`, or filtering out already-completed IDs before the `turn.completed` loop. (apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:266)
  - Threads: PRRT_kwDORLtfbc5w1GPr
- [ ] C027 [Medium] WS message handler can cause unhandled promise rejection (apps/server/src/wsServer.ts:545) (+1 dup)
  - Threads: PRRT_kwDORLtfbc5wyTaW, PRRT_kwDORLtfbc5wzli3
- [ ] C042 [Low] Duplicated `resolveThreadWorkspaceCwd` across three files (apps/server/src/orchestration/Layers/CheckpointReactor.ts:62)
  - Threads: PRRT_kwDORLtfbc5wzli2
- [ ] C043 [Low] Duplicated workspace CWD resolution logic across reactor modules (apps/server/src/orchestration/Layers/CheckpointReactor.ts:62) (+2 dup)
  - Threads: PRRT_kwDORLtfbc5wnWwM, PRRT_kwDORLtfbc5w1C3-, PRRT_kwDORLtfbc5w1HGZ
- [ ] C044 [Low] Checkpoint reactor swallows diff errors silently for `turn.completed` (apps/server/src/orchestration/Layers/CheckpointReactor.ts:274)
  - Threads: PRRT_kwDORLtfbc5wkPaO
- [ ] C045 [Low] `truncateDetail` slices to `limit - 1` then appends `"..."` (3 chars), producing strings of length `limit + 2`. Consider slicing to `limit - 3` instead. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:29)
  - Threads: PRRT_kwDORLtfbc5wzp4R
- [ ] C046 [Low] `latestMessageIdByTurnKey` is written to but never read, and `clearAssistantMessageIdsForTurn` doesn't clear its entries—only `clearTurnStateForSession` does. Consider removing this map entirely if unused, or clearing it alongside `turnMessageIdsByTurnKey` in `clearAssistantMessageIdsForTurn`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:133)
  - Threads: PRRT_kwDORLtfbc5wxvIQ

### Edge-case parsing/platform behavior (9)

- [ ] C009 [Medium] Git's braced rename syntax (e.g., `src/{old => new}/file.ts`) isn't handled correctly. The current slice after ` => ` produces invalid paths like `new}/file.ts`. Consider expanding the braces to construct the full destination path. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/git/Layers/GitCore.ts:41)
  - Threads: PRRT_kwDORLtfbc5w1CxT
- [ ] C010 [Medium] `loadCustomKeybindingsConfig` fails when the config file doesn't exist, which is expected for new users. Consider catching `ENOENT` and returning an empty array instead. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/keybindings.ts:418)
  - Threads: PRRT_kwDORLtfbc5wxvIJ
- [ ] C022 [Medium] Fish shell outputs `$PATH` as space-separated, not colon-separated. Consider checking if the shell is fish and using `string join : $PATH` instead, or validating the result contains colons before assigning. (apps/server/src/os-jank.ts:10)
  - Threads: PRRT_kwDORLtfbc5wkRZM
- [ ] C023 [Medium] Using `-il` flags causes the shell to source profile scripts that may print banners or other text, polluting the captured `PATH`. Consider using `-lc` (login only, non-interactive) to reduce unwanted output. (apps/server/src/os-jank.ts:10)
  - Threads: PRRT_kwDORLtfbc5wj4cM
- [ ] C029 [Medium] `parseFileUrlHref` already decodes the path (line 46), but `safeDecode` is called again here, corrupting filenames containing `%` sequences. Consider skipping the decode when `fileUrlTarget` is non-null. (apps/web/src/markdown-links.ts:105)
  - Threads: PRRT_kwDORLtfbc5wnVsU
- [ ] C030 [Medium] `EXTERNAL_SCHEME_PATTERN` matches `script.ts:10` as a scheme because `.ts:` looks like `scheme:`. Consider requiring `://` after the colon, or checking that what follows the colon is not just digits. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/web/src/markdown-links.ts:111)
  - Threads: PRRT_kwDORLtfbc5wnVsK
- [ ] C038 [Low] Multi-byte UTF-8 characters split across chunks will be corrupted when decoding each chunk separately. Consider accumulating all chunks first, then decoding once, or use `TextDecoder` with `stream: true`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/git/Layers/CodexTextGeneration.ts:136)
  - Threads: PRRT_kwDORLtfbc5w1GPo
- [ ] C039 [Low] The `+` key can be parsed (via trailing `+` handling) but cannot be encoded because `shortcut.key.includes("+")` returns true for the literal `+` key. Consider checking `shortcut.key === "+"` separately and encoding it as `"space"` style (e.g., a special token), or adjusting the condition to allow the single `+` character. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/keybindings.ts:352)
  - Threads: PRRT_kwDORLtfbc5wxvIB
- [ ] C040 [Low] `upsertKeybindingRule` has a race condition: concurrent calls read the same file state, then the last write overwrites earlier changes. Consider wrapping the read-modify-write sequence with `Effect.Semaphore` to serialize access. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/keybindings.ts:488)
  - Threads: PRRT_kwDORLtfbc5wxvIA

### Checkpointing correctness (8)

- [ ] C008 [Medium] Inconsistent input normalization across CheckpointStore methods (apps/server/src/checkpointing/Layers/CheckpointStore.ts:94) (+3 dup)
  - Threads: PRRT_kwDORLtfbc5widJw, PRRT_kwDORLtfbc5wnWv_, PRRT_kwDORLtfbc5w0_g7, PRRT_kwDORLtfbc5w1C36
- [ ] C017 [Medium] `REQUIRED_SNAPSHOT_PROJECTORS` includes `pending-approvals` and `thread-turns`, but `getSnapshot` doesn't query their data. If these projectors lag behind, the returned `snapshotSequence` will be lower than what the included data actually reflects, causing clients to replay already-applied events. Consider filtering `REQUIRED_SNAPSHOT_PROJECTORS` to only include projectors whose data is actually fetched in the snapshot. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:71)
  - Threads: PRRT_kwDORLtfbc5wiLhQ
- [ ] C025 [Medium] Duplicated checkpoint ref computation across two files (apps/server/src/wsServer.ts:128)
  - Threads: PRRT_kwDORLtfbc5wvwag
- [ ] C033 [Low] Three error classes defined but never instantiated anywhere (apps/server/src/checkpointing/Errors.ts:51)
  - Threads: PRRT_kwDORLtfbc5wlYgo
- [ ] C034 [Low] Redundant `CheckpointInvariantError` in `CheckpointServiceError` union type (apps/server/src/checkpointing/Errors.ts:79)
  - Threads: PRRT_kwDORLtfbc5wj5fn
- [ ] C035 [Low] Redundant error type in CheckpointServiceError union definition (apps/server/src/checkpointing/Errors.ts:79) (+2 dup)
  - Threads: PRRT_kwDORLtfbc5wlYgs, PRRT_kwDORLtfbc5wxsO6, PRRT_kwDORLtfbc5w1C4B
- [ ] C036 [Low] Duplicate `checkpointRefForThreadTurn` function in two production files (apps/server/src/checkpointing/Layers/CheckpointStore.ts:284)
  - Threads: PRRT_kwDORLtfbc5wiqFX
- [ ] C055 [Low] Duplicate `checkpointRefForThreadTurn` function across files (apps/server/src/wsServer.ts:128)
  - Threads: PRRT_kwDORLtfbc5wkPaG

### Event ordering and state consistency (6)

- [ ] C001 [High] Non-atomic event appending can corrupt state on retry. If an error occurs mid-loop (lines 96-102) after some events are persisted but before the receipt is written, the command appears to fail. A retry generates new UUIDs via `crypto.randomUUID()` in the decider, appending duplicate events. Consider wrapping the loop in a transaction or using deterministic event IDs derived from `commandId`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/orchestration/Layers/OrchestrationEngine.ts:96)
  - Threads: PRRT_kwDORLtfbc5wzp4T
- [ ] C013 [Medium] If `projectionPipeline.projectEvent` fails after `eventStore.append` succeeds, the event is persisted but `readModel` isn't updated, causing desync. Consider updating the in-memory `readModel` immediately after append (before the external projection), so local state stays consistent regardless of downstream failures. (apps/server/src/orchestration/Layers/OrchestrationEngine.ts:99)
  - Threads: PRRT_kwDORLtfbc5whtrM
- [ ] C014 [Medium] Engine error handler catches all errors including non-invariant ones (apps/server/src/orchestration/Layers/OrchestrationEngine.ts:144)
  - Threads: PRRT_kwDORLtfbc5wkPaJ
- [ ] C015 [Medium] The gap-filling fallback logic can retain messages from turns that are about to be deleted, causing foreign key violations. Consider removing the fallback logic entirely, or filtering `fallbackUserMessages` and `fallbackAssistantMessages` to only include messages whose `turnId` is in `retainedTurnIds`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/orchestration/Layers/ProjectionPipeline.ts:99)
  - Threads: PRRT_kwDORLtfbc5whxJO
- [ ] C016 [Medium] The in-memory `pendingTurnStartByThreadId` map isn't restored during bootstrap. If the service restarts after processing `thread.turn-start-requested` but before `thread.session-set`, the `userMessageId` and `startedAt` will be lost since bootstrap resumes *after* the committed sequence. Consider persisting this pending state or processing these two events atomically. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/orchestration/Layers/ProjectionPipeline.ts:490)
  - Threads: PRRT_kwDORLtfbc5wxvH8
- [ ] C031 [Medium] Revert uses wrong turn count from positional inference (apps/web/src/session-logic.ts:127)
  - Threads: PRRT_kwDORLtfbc5v9SCp

### WebSocket robustness (5)

- [ ] C003 [High] Consider attaching a no-op error listener before `socket.write` (e.g., `socket.on('error', () => {})`) to prevent an unhandled `EPIPE`/`ECONNRESET` from crashing the process if the client disconnects mid-handshake. (apps/server/src/wsServer.ts:75)
  - Threads: PRRT_kwDORLtfbc5v-cf4
- [ ] C026 [Medium] Consider adding `.catch(() => {})` after `Effect.runPromise(handleMessage(ws, raw))` to prevent unhandled rejections from crashing the server if `encodeResponse` or setup logic fails. (apps/server/src/wsServer.ts:545)
  - Threads: PRRT_kwDORLtfbc5wj4cE
- [ ] C053 [Low] Consider using `socket.end(response)` instead of `socket.write(response)` + `socket.destroy()` to ensure the HTTP error response is fully flushed before closing the connection. (apps/server/src/wsServer.ts:83)
  - Threads: PRRT_kwDORLtfbc5v-WPD
- [ ] C054 [Low] When array chunks contain a multi-byte UTF-8 character split across boundaries, decoding each chunk separately produces replacement characters. Consider using `Buffer.concat()` on all chunks before calling `.toString("utf8")`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary> (apps/server/src/wsServer.ts:104)
  - Threads: PRRT_kwDORLtfbc5whtrR
- [ ] C059 [Low] Suggestion: don’t spread `params` into `body`; it can override `_tag` and mishandle non-object values. Keep `_tag` separate and nest `params` under a single key (e.g., `data`), or validate `params` is a plain object. (apps/web/src/wsTransport.ts:59)
  - Threads: PRRT_kwDORLtfbc5whtrN

### Build/runtime portability (2)

- [ ] C006 [Medium] Build script runs TypeScript file with bare node (apps/server/package.json:14)
  - Threads: PRRT_kwDORLtfbc5wxsO-
- [ ] C007 [Medium] Build script uses `node` to run `.ts` file directly (apps/server/package.json:14) (+1 dup)
  - Threads: PRRT_kwDORLtfbc5wiLNS, PRRT_kwDORLtfbc5wj5fl

### Memory/resource growth (1)

- [ ] C018 [Medium] Unbounded memory growth in turn start deduplication set (apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:84) (+5 dup)
  - Threads: PRRT_kwDORLtfbc5whszQ, PRRT_kwDORLtfbc5wl2A8, PRRT_kwDORLtfbc5wyTaT, PRRT_kwDORLtfbc5wzliz, PRRT_kwDORLtfbc5w0_g-, PRRT_kwDORLtfbc5w1HGW

## Invalid / False-Positive Threads

- PRRT_kwDORLtfbc5v9An7 | apps/web/src/routes/__root.tsx:140 | channel.** The web app currently does not consume provider event streams via the `providers.event` channel. While the orchestration API has `onReadModel()` and `onDomainEvent()` subscriptions, the providers event stream subscription is missing. Add a subscription to `ORCHESTRATION_WS_CHANNELS.event` (or the appropriate providers event channel from contracts) in `wsNativeApi.ts` and expose it via the `api.providers` object to comply with the guideline requirement. <details> <summary>🤖 Prompt for AI Agents</summary>
  - Rationale: Invalid by design: provider runtime events are intentionally surfaced through orchestration domain events (`orchestration.domainEvent`), not a separate `providers.event` WebSocket channel in the current architecture.
- PRRT_kwDORLtfbc5v9An- | apps/web/src/wsNativeApi.ts:165 | push stream, and the callbacks rely on unchecked casts. Please reintroduce a `providers.onEvent` (or equivalent) that subscribes to the `providers.event` channel and decode read-model/domain-event payloads using the shared contracts schemas before invoking callbacks. As per coding guidelines: "Web app must consume provider event streams via WebSocket push on channel `providers.event`" and "Use Zod schemas from `packages/contracts` for shared type contracts covering provider events, WebSocket protocol, and model/session types". <details> <summary>🤖 Prompt for AI Agents</summary>
  - Rationale: Invalid by design: provider runtime events are intentionally surfaced through orchestration domain events (`orchestration.domainEvent`), not a separate `providers.event` WebSocket channel in the current architecture.
- PRRT_kwDORLtfbc5widJx | apps/server/package.json:14 | Build script requires implicit Node.js TypeScript support
  - Rationale: Thread contains explicit false-positive determination in replies.

## Duplicate Mapping

- Each duplicate thread is mapped to one canonical fix item.

- PRRT_kwDORLtfbc5wj5fl | apps/server/package.json:14 -> C007
- PRRT_kwDORLtfbc5wl2A8 | apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:84 -> C018
- PRRT_kwDORLtfbc5wnWv_ | apps/server/src/checkpointing/Layers/CheckpointStore.ts:94 -> C008
- PRRT_kwDORLtfbc5wnWwF | apps/server/src/orchestration/Layers/CheckpointReactor.ts:584 -> C002
- PRRT_kwDORLtfbc5wxsO6 | apps/server/src/checkpointing/Errors.ts:79 -> C035
- PRRT_kwDORLtfbc5wyTaP | apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:334 -> C002
- PRRT_kwDORLtfbc5wyTaS | apps/server/src/orchestration/Layers/CheckpointReactor.ts:542 -> C012
- PRRT_kwDORLtfbc5wyTaT | apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:84 -> C018
- PRRT_kwDORLtfbc5wzliw | apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:334 -> C002
- PRRT_kwDORLtfbc5wzliz | apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:84 -> C018
- PRRT_kwDORLtfbc5wzli0 | apps/server/src/orchestration/Layers/CheckpointReactor.ts:542 -> C012
- PRRT_kwDORLtfbc5wzli3 | apps/server/src/wsServer.ts:545 -> C027
- PRRT_kwDORLtfbc5w0_g3 | apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:334 -> C002
- PRRT_kwDORLtfbc5w0_g4 | apps/server/src/orchestration/Layers/CheckpointReactor.ts:542 -> C012
- PRRT_kwDORLtfbc5w0_g7 | apps/server/src/checkpointing/Layers/CheckpointStore.ts:95 -> C008
- PRRT_kwDORLtfbc5w0_g- | apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:84 -> C018
- PRRT_kwDORLtfbc5w1C36 | apps/server/src/checkpointing/Layers/CheckpointStore.ts:94 -> C008
- PRRT_kwDORLtfbc5w1C3- | apps/server/src/checkpointing/Layers/CheckpointDiffQuery.ts:40 -> C043
- PRRT_kwDORLtfbc5w1C4B | apps/server/src/checkpointing/Errors.ts:79 -> C035
- PRRT_kwDORLtfbc5w1C4H | AGENTS.md:45 -> C032
- PRRT_kwDORLtfbc5w1HGT | apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:334 -> C002
- PRRT_kwDORLtfbc5w1HGW | apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:84 -> C018
- PRRT_kwDORLtfbc5w1HGX | apps/server/src/orchestration/Layers/CheckpointReactor.ts:542 -> C012
- PRRT_kwDORLtfbc5w1HGZ | apps/server/src/checkpointing/Layers/CheckpointDiffQuery.ts:40 -> C043

## Outdated / Resolved Buckets

- Outdated threads: 94
- Resolved threads: 6

Per-thread mapping source of truth: `.plans/16a-pr89-phase0-canonical-triage.json`.

# PR #89 Remediation Checklist (Consolidated)

_Last updated: 2026-02-26_

This is the working checklist for remediation execution.

Status values:
- `TODO`: Not started
- `IN_PROGRESS`: Currently being worked
- `BLOCKED`: Waiting on decision/dependency
- `DONE`: Implemented and verified
- `CLOSED_INVALID`: Stale/invalid review finding

Counts: active `51` (`valid=33`, `partially-valid=18`), closed-invalid `6`

## Active Checklist

### Phase 1

- [x] `C002` A dispatch error in `processEvent` will terminate the `Effect.forever` loop, permanently halting event ingestion. Consider adding error recovery (e.g., `Effect.catchAll` with logging) around `processEvent` so failures don't kill the fiber.
  - Status: `DONE`
  - Verdict: `valid`
  - Severity: `High`
  - Area: `Runtime resilience and failure handling`
  - File: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:333`
  - Threads: PRRT_kwDORLtfbc5wj4cH, PRRT_kwDORLtfbc5wnWwF, PRRT_kwDORLtfbc5wyTaP, PRRT_kwDORLtfbc5wzliw, PRRT_kwDORLtfbc5w0_g3, PRRT_kwDORLtfbc5w1HGT (+5 duplicate thread(s))
  - Audit note: Ingestion worker loop can terminate on unhandled processEvent failure.

- [x] `C003` Consider attaching a no-op error listener before `socket.write` (e.g., `socket.on('error', () => {})`) to prevent an unhandled `EPIPE`/`ECONNRESET` from crashing the process if the client disconnects mid-handshake.
  - Status: `DONE`
  - Verdict: `valid`
  - Severity: `High`
  - Area: `WebSocket robustness`
  - File: `apps/server/src/wsServer.ts:75`
  - Threads: PRRT_kwDORLtfbc5v-cf4
  - Audit note: Upgrade reject writes then destroys socket without defensive error listener.

- [x] `C012` Forked revert dispatch risks read model inconsistency
  - Status: `DONE`
  - Verdict: `valid`
  - Severity: `Medium`
  - Area: `Runtime resilience and failure handling`
  - File: `apps/server/src/orchestration/Layers/CheckpointReactor.ts:542`
  - Threads: PRRT_kwDORLtfbc5whszW, PRRT_kwDORLtfbc5wyTaS, PRRT_kwDORLtfbc5wzli0, PRRT_kwDORLtfbc5w0_g4, PRRT_kwDORLtfbc5w1HGX (+4 duplicate thread(s))
  - Audit note: Revert completion dispatch remains forked; state consistency window remains.

- [ ] `C019` ProviderRuntimeIngestion processes events for wrong thread on race
  - Status: `TODO`
  - Verdict: `partially-valid`
  - Severity: `Medium`
  - Area: `Runtime resilience and failure handling`
  - File: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:178`
  - Threads: PRRT_kwDORLtfbc5wkPaL
  - Audit note: SessionId-only routing can misassociate events under races/rebinds.

- [x] `C020` On `message.completed`, the message ID is added to the set and `thread.message.assistant.complete` is dispatched. On `turn.completed`, the same set is iterated and `thread.message.assistant.complete` is dispatched again for each ID—including already-completed ones. Consider removing message IDs from the set after dispatching on `message.completed`, or filtering out already-completed IDs before the `turn.completed` loop.
  - Status: `DONE`
  - Verdict: `partially-valid`
  - Severity: `Medium`
  - Area: `Runtime resilience and failure handling`
  - File: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:266`
  - Threads: PRRT_kwDORLtfbc5w1GPr
  - Audit note: Duplicate complete dispatch exists; downstream impact often idempotent.

- [x] `C026` Consider adding `.catch(() => {})` after `Effect.runPromise(handleMessage(ws, raw))` to prevent unhandled rejections from crashing the server if `encodeResponse` or setup logic fails.
  - Status: `DONE`
  - Verdict: `valid`
  - Severity: `Medium`
  - Area: `WebSocket robustness`
  - File: `apps/server/src/wsServer.ts:545`
  - Threads: PRRT_kwDORLtfbc5wj4cE
  - Audit note: runPromise result still not caught; rejection can surface unhandled.

- [x] `C027` WS message handler can cause unhandled promise rejection
  - Status: `DONE`
  - Verdict: `valid`
  - Severity: `Medium`
  - Area: `Runtime resilience and failure handling`
  - File: `apps/server/src/wsServer.ts:545`
  - Threads: PRRT_kwDORLtfbc5wyTaW, PRRT_kwDORLtfbc5wzli3 (+1 duplicate thread(s))
  - Audit note: Same unhandled rejection path remains in WS message handler.

- [x] `C042` Duplicated `resolveThreadWorkspaceCwd` across three files
  - Status: `DONE`
  - Verdict: `partially-valid`
  - Severity: `Low`
  - Area: `Runtime resilience and failure handling`
  - File: `apps/server/src/orchestration/Layers/CheckpointReactor.ts:62`
  - Threads: PRRT_kwDORLtfbc5wzli2
  - Audit note: Duplication exists but one instance is variant logic, so impact is moderate.

- [x] `C043` Duplicated workspace CWD resolution logic across reactor modules
  - Status: `DONE`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `Runtime resilience and failure handling`
  - File: `apps/server/src/orchestration/Layers/CheckpointReactor.ts:62`
  - Threads: PRRT_kwDORLtfbc5wnWwM, PRRT_kwDORLtfbc5w1C3-, PRRT_kwDORLtfbc5w1HGZ (+2 duplicate thread(s))
  - Audit note: Workspace CWD resolution duplication still present across modules.

- [x] `C044` Checkpoint reactor swallows diff errors silently for `turn.completed`
  - Status: `DONE`
  - Verdict: `partially-valid`
  - Severity: `Low`
  - Area: `Runtime resilience and failure handling`
  - File: `apps/server/src/orchestration/Layers/CheckpointReactor.ts:274`
  - Threads: PRRT_kwDORLtfbc5wkPaO
  - Audit note: Errors are swallowed to empty diff with warning; not fully silent but still lossy.

- [x] `C045` `truncateDetail` slices to `limit - 1` then appends `"..."` (3 chars), producing strings of length `limit + 2`. Consider slicing to `limit - 3` instead. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `DONE`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `Runtime resilience and failure handling`
  - File: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:29`
  - Threads: PRRT_kwDORLtfbc5wzp4R
  - Audit note: truncateDetail still overshoots limit.

- [x] `C046` `latestMessageIdByTurnKey` is written to but never read, and `clearAssistantMessageIdsForTurn` doesn't clear its entries—only `clearTurnStateForSession` does. Consider removing this map entirely if unused, or clearing it alongside `turnMessageIdsByTurnKey` in `clearAssistantMessageIdsForTurn`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `DONE`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `Runtime resilience and failure handling`
  - File: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:133`
  - Threads: PRRT_kwDORLtfbc5wxvIQ
  - Audit note: latestMessageIdByTurnKey still unused/unpruned in per-turn clear path.

- [x] `C053` Consider using `socket.end(response)` instead of `socket.write(response)` + `socket.destroy()` to ensure the HTTP error response is fully flushed before closing the connection.
  - Status: `DONE`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `WebSocket robustness`
  - File: `apps/server/src/wsServer.ts:83`
  - Threads: PRRT_kwDORLtfbc5v-WPD
  - Audit note: Still uses write+destroy rather than end() for rejection response.

- [ ] `C054` When array chunks contain a multi-byte UTF-8 character split across boundaries, decoding each chunk separately produces replacement characters. Consider using `Buffer.concat()` on all chunks before calling `.toString("utf8")`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `WebSocket robustness`
  - File: `apps/server/src/wsServer.ts:104`
  - Threads: PRRT_kwDORLtfbc5whtrR
  - Audit note: Array chunk UTF-8 decode remains vulnerable to split multibyte corruption.

- [x] `C059` Suggestion: don’t spread `params` into `body`; it can override `_tag` and mishandle non-object values. Keep `_tag` separate and nest `params` under a single key (e.g., `data`), or validate `params` is a plain object.
  - Status: `DONE`
  - Verdict: `partially-valid`
  - Severity: `Low`
  - Area: `WebSocket robustness`
  - File: `apps/web/src/wsTransport.ts:59`
  - Threads: PRRT_kwDORLtfbc5whtrN
  - Audit note: Transport _tag override risk exists but current callsites are constrained.

### Phase 2

- [x] `C001` Non-atomic event appending can corrupt state on retry. If an error occurs mid-loop (lines 96-102) after some events are persisted but before the receipt is written, the command appears to fail. A retry generates new UUIDs via `crypto.randomUUID()` in the decider, appending duplicate events. Consider wrapping the loop in a transaction or using deterministic event IDs derived from `commandId`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `DONE`
  - Verdict: `valid`
  - Severity: `High`
  - Area: `Event ordering and state consistency`
  - File: `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:96`
  - Threads: PRRT_kwDORLtfbc5wzp4T
  - Audit note: Append/project/receipt are non-atomic; retry can duplicate events.

- [x] `C013` If `projectionPipeline.projectEvent` fails after `eventStore.append` succeeds, the event is persisted but `readModel` isn't updated, causing desync. Consider updating the in-memory `readModel` immediately after append (before the external projection), so local state stays consistent regardless of downstream failures.
  - Status: `DONE`
  - Verdict: `valid`
  - Severity: `Medium`
  - Area: `Event ordering and state consistency`
  - File: `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:99`
  - Threads: PRRT_kwDORLtfbc5whtrM
  - Audit note: Persisted event can outpace in-memory projection on mid-flight failure.

- [x] `C015` The gap-filling fallback logic can retain messages from turns that are about to be deleted, causing foreign key violations. Consider removing the fallback logic entirely, or filtering `fallbackUserMessages` and `fallbackAssistantMessages` to only include messages whose `turnId` is in `retainedTurnIds`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `DONE`
  - Verdict: `partially-valid`
  - Severity: `Medium`
  - Area: `Event ordering and state consistency`
  - File: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:99`
  - Threads: PRRT_kwDORLtfbc5whxJO
  - Audit note: Message fallback retention issue is real, but prior FK-violation claim is overstated.

- [x] `C016` The in-memory `pendingTurnStartByThreadId` map isn't restored during bootstrap. If the service restarts after processing `thread.turn-start-requested` but before `thread.session-set`, the `userMessageId` and `startedAt` will be lost since bootstrap resumes *after* the committed sequence. Consider persisting this pending state or processing these two events atomically. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `DONE`
  - Verdict: `valid`
  - Severity: `Medium`
  - Area: `Event ordering and state consistency`
  - File: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:490`
  - Threads: PRRT_kwDORLtfbc5wxvH8
  - Audit note: Pending turn-start map is in-memory only and not rebuilt on bootstrap.

### Phase 3

- [ ] `C008` Inconsistent input normalization across CheckpointStore methods
  - Status: `TODO`
  - Verdict: `partially-valid`
  - Severity: `Medium`
  - Area: `Checkpointing correctness`
  - File: `apps/server/src/checkpointing/Layers/CheckpointStore.ts:94`
  - Threads: PRRT_kwDORLtfbc5widJw, PRRT_kwDORLtfbc5wnWv_, PRRT_kwDORLtfbc5w0_g7, PRRT_kwDORLtfbc5w1C36 (+3 duplicate thread(s))
  - Audit note: Normalization inconsistency remains, but upstream callsites now mostly canonicalize inputs.

- [ ] `C017` `REQUIRED_SNAPSHOT_PROJECTORS` includes `pending-approvals` and `thread-turns`, but `getSnapshot` doesn't query their data. If these projectors lag behind, the returned `snapshotSequence` will be lower than what the included data actually reflects, causing clients to replay already-applied events. Consider filtering `REQUIRED_SNAPSHOT_PROJECTORS` to only include projectors whose data is actually fetched in the snapshot. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `TODO`
  - Verdict: `partially-valid`
  - Severity: `Medium`
  - Area: `Checkpointing correctness`
  - File: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:71`
  - Threads: PRRT_kwDORLtfbc5wiLhQ
  - Audit note: Snapshot sequence can under-report due to extra projectors, but replay impact is lower now.

- [ ] `C033` Three error classes defined but never instantiated anywhere
  - Status: `TODO`
  - Verdict: `partially-valid`
  - Severity: `Low`
  - Area: `Checkpointing correctness`
  - File: `apps/server/src/checkpointing/Errors.ts:51`
  - Threads: PRRT_kwDORLtfbc5wlYgo
  - Audit note: Original claim overstated; some errors used, others appear unused.

- [ ] `C034` Redundant `CheckpointInvariantError` in `CheckpointServiceError` union type
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `Checkpointing correctness`
  - File: `apps/server/src/checkpointing/Errors.ts:79`
  - Threads: PRRT_kwDORLtfbc5wj5fn
  - Audit note: CheckpointInvariantError remains redundantly included in service union.

- [ ] `C035` Redundant error type in CheckpointServiceError union definition
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `Checkpointing correctness`
  - File: `apps/server/src/checkpointing/Errors.ts:79`
  - Threads: PRRT_kwDORLtfbc5wlYgs, PRRT_kwDORLtfbc5wxsO6, PRRT_kwDORLtfbc5w1C4B (+2 duplicate thread(s))
  - Audit note: Same as C034.

### Phase 4

- [ ] `C018` Unbounded memory growth in turn start deduplication set
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Medium`
  - Area: `Memory/resource growth`
  - File: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:84`
  - Threads: PRRT_kwDORLtfbc5whszQ, PRRT_kwDORLtfbc5wl2A8, PRRT_kwDORLtfbc5wyTaT, PRRT_kwDORLtfbc5wzliz, PRRT_kwDORLtfbc5w0_g-, PRRT_kwDORLtfbc5w1HGW (+5 duplicate thread(s))
  - Audit note: handledTurnStartKeys still grows without pruning.

### Phase 5

- [ ] `C009` Git's braced rename syntax (e.g., `src/{old => new}/file.ts`) isn't handled correctly. The current slice after ` => ` produces invalid paths like `new}/file.ts`. Consider expanding the braces to construct the full destination path. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Medium`
  - Area: `Edge-case parsing/platform behavior`
  - File: `apps/server/src/git/Layers/GitCore.ts:41`
  - Threads: PRRT_kwDORLtfbc5w1CxT
  - Audit note: Braced rename parsing still breaks paths like src/{old => new}/file.ts.

- [ ] `C010` `loadCustomKeybindingsConfig` fails when the config file doesn't exist, which is expected for new users. Consider catching `ENOENT` and returning an empty array instead. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Medium`
  - Area: `Edge-case parsing/platform behavior`
  - File: `apps/server/src/keybindings.ts:418`
  - Threads: PRRT_kwDORLtfbc5wxvIJ
  - Audit note: ENOENT for missing keybindings config still not handled as empty/default.

- [ ] `C022` Fish shell outputs `$PATH` as space-separated, not colon-separated. Consider checking if the shell is fish and using `string join : $PATH` instead, or validating the result contains colons before assigning.
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Medium`
  - Area: `Edge-case parsing/platform behavior`
  - File: `apps/server/src/os-jank.ts:10`
  - Threads: PRRT_kwDORLtfbc5wkRZM
  - Audit note: fish PATH formatting risk still exists in os-jank path recovery.

- [ ] `C023` Using `-il` flags causes the shell to source profile scripts that may print banners or other text, polluting the captured `PATH`. Consider using `-lc` (login only, non-interactive) to reduce unwanted output.
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Medium`
  - Area: `Edge-case parsing/platform behavior`
  - File: `apps/server/src/os-jank.ts:10`
  - Threads: PRRT_kwDORLtfbc5wj4cM
  - Audit note: -ilc shell invocation can pollute captured PATH output.

- [ ] `C029` `parseFileUrlHref` already decodes the path (line 46), but `safeDecode` is called again here, corrupting filenames containing `%` sequences. Consider skipping the decode when `fileUrlTarget` is non-null.
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Medium`
  - Area: `Edge-case parsing/platform behavior`
  - File: `apps/web/src/markdown-links.ts:105`
  - Threads: PRRT_kwDORLtfbc5wnVsU
  - Audit note: file URL decoding still double-decodes in one path.

- [ ] `C030` `EXTERNAL_SCHEME_PATTERN` matches `script.ts:10` as a scheme because `.ts:` looks like `scheme:`. Consider requiring `://` after the colon, or checking that what follows the colon is not just digits. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Medium`
  - Area: `Edge-case parsing/platform behavior`
  - File: `apps/web/src/markdown-links.ts:111`
  - Threads: PRRT_kwDORLtfbc5wnVsK
  - Audit note: Scheme regex still misclassifies script.ts:10 as external scheme.

- [ ] `C038` Multi-byte UTF-8 characters split across chunks will be corrupted when decoding each chunk separately. Consider accumulating all chunks first, then decoding once, or use `TextDecoder` with `stream: true`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `Edge-case parsing/platform behavior`
  - File: `apps/server/src/git/Layers/CodexTextGeneration.ts:136`
  - Threads: PRRT_kwDORLtfbc5w1GPo
  - Audit note: Chunk-by-chunk UTF-8 decode can still corrupt split multibyte characters.

- [ ] `C039` The `+` key can be parsed (via trailing `+` handling) but cannot be encoded because `shortcut.key.includes("+")` returns true for the literal `+` key. Consider checking `shortcut.key === "+"` separately and encoding it as `"space"` style (e.g., a special token), or adjusting the condition to allow the single `+` character. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `TODO`
  - Verdict: `partially-valid`
  - Severity: `Low`
  - Area: `Edge-case parsing/platform behavior`
  - File: `apps/server/src/keybindings.ts:352`
  - Threads: PRRT_kwDORLtfbc5wxvIB
  - Audit note: Parser/encoder mismatch remains, but encoder path currently low-use.

- [ ] `C040` `upsertKeybindingRule` has a race condition: concurrent calls read the same file state, then the last write overwrites earlier changes. Consider wrapping the read-modify-write sequence with `Effect.Semaphore` to serialize access. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `Edge-case parsing/platform behavior`
  - File: `apps/server/src/keybindings.ts:488`
  - Threads: PRRT_kwDORLtfbc5wxvIA
  - Audit note: upsertKeybindingRule read-modify-write remains race-prone.

### Phase 6

- [ ] `C006` Build script runs TypeScript file with bare node
  - Status: `TODO`
  - Verdict: `partially-valid`
  - Severity: `Medium`
  - Area: `Build/runtime portability`
  - File: `apps/server/package.json:14`
  - Threads: PRRT_kwDORLtfbc5wxsO-
  - Audit note: Node 24 makes this work, but script still relies on runtime-specific TS execution.

- [ ] `C007` Build script uses `node` to run `.ts` file directly
  - Status: `TODO`
  - Verdict: `partially-valid`
  - Severity: `Medium`
  - Area: `Build/runtime portability`
  - File: `apps/server/package.json:14`
  - Threads: PRRT_kwDORLtfbc5wiLNS, PRRT_kwDORLtfbc5wj5fl (+1 duplicate thread(s))
  - Audit note: Same as C006 (duplicate concern).

- [ ] `C011` Template literal `${cause}` throws if `cause` is a `Symbol`. Consider using `String(cause)` instead.
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Medium`
  - Area: `Other`
  - File: `apps/server/src/orchestration/Errors.ts:117`
  - Threads: PRRT_kwDORLtfbc5wBFv4
  - Audit note: Template-literal interpolation of Symbol still throws.

- [ ] `C024` In `executeUnprepared`, preparing outside an effect and not closing the statement can cause uncaught errors and leaks. Suggest wrapping with `Effect.acquireUseRelease`: prepare in acquire (error-safe) and `finalize` in release.
  - Status: `TODO`
  - Verdict: `partially-valid`
  - Severity: `Medium`
  - Area: `Other`
  - File: `apps/server/src/persistence/NodeSqliteClient.ts:145`
  - Threads: PRRT_kwDORLtfbc5whxX9
  - Audit note: prepare() still outside managed effect boundary; failure handling risk remains.

- [ ] `C028` Branch sync dispatches both server and stale local update
  - Status: `TODO`
  - Verdict: `partially-valid`
  - Severity: `Medium`
  - Area: `Other`
  - File: `apps/web/src/components/BranchToolbar.tsx:102`
  - Threads: PRRT_kwDORLtfbc5v-XCu
  - Audit note: Optimistic local+server dual update is intentional but can temporarily diverge.

- [ ] `C032` Dummy workflow marker accidentally committed to docs
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `Other`
  - File: `AGENTS.md:45`
  - Threads: PRRT_kwDORLtfbc5wlYgj, PRRT_kwDORLtfbc5w1C4H (+1 duplicate thread(s))
  - Audit note: Dummy workflow marker comment is still present in docs.

- [ ] `C037` `Effect.callback` should return a cleanup function to close the server(s) on fiber interruption. Without it, the `Net.Server` handles keep the process alive and leak the port if the effect is cancelled. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `TODO`
  - Verdict: `partially-valid`
  - Severity: `Low`
  - Area: `Other`
  - File: `apps/server/src/config.ts:41`
  - Threads: PRRT_kwDORLtfbc5wj4cO
  - Audit note: Callback cleanup missing, but practical exposure is low in one-shot startup path.

- [ ] `C041` Template literal interpolation throws `TypeError` if `cause` is a `Symbol`. Consider using `String(cause)` for safe coercion.
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `Other`
  - File: `apps/server/src/orchestration/Errors.ts:126`
  - Threads: PRRT_kwDORLtfbc5wBFWs
  - Audit note: Same Symbol interpolation hazard as C011 remains.

- [ ] `C047` `SqlSchema.findOneOption` can produce both SQL errors and decode errors, but `mapError` wraps all as `PersistenceSqlError`. Consider distinguishing `ParseError` from SQL errors and mapping decode failures to `PersistenceDecodeError` instead. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `Other`
  - File: `apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts:75`
  - Threads: PRRT_kwDORLtfbc5wiaR-
  - Audit note: Decode and SQL errors still collapsed into one persistence error kind.

- [ ] `C048` `statement.run()` returns a `RunResult` object, not an array. Casting it to `ReadonlyArray<any>` will cause runtime errors when consumers call array methods. Consider wrapping the result (e.g., `[result]`) or returning a properly typed object.
  - Status: `TODO`
  - Verdict: `partially-valid`
  - Severity: `Low`
  - Area: `Other`
  - File: `apps/server/src/persistence/NodeSqliteClient.ts:99`
  - Threads: PRRT_kwDORLtfbc5wio-r
  - Audit note: Unsafe run() result cast remains; runtime risk depends on raw-result consumers.

- [ ] `C049` `JSON.stringify(cause)` returns `undefined` for `undefined`, functions, or symbols, violating the `string` return type. Consider coercing the result to a string (e.g., `String(JSON.stringify(cause))`) or adding a fallback.
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `Other`
  - File: `apps/server/src/provider/Layers/ProviderService.ts:59`
  - Threads: PRRT_kwDORLtfbc5wnVsI
  - Audit note: JSON.stringify(cause) may return undefined despite string expectations.

- [ ] `C050` The read-modify-write pattern (`getBySessionId` → merge → `upsert`) is susceptible to lost updates under concurrent writes. Consider wrapping in a transaction or adding optimistic concurrency control (e.g., version field) if concurrent session updates are expected. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `Other`
  - File: `apps/server/src/provider/Layers/ProviderSessionDirectory.ts:94`
  - Threads: PRRT_kwDORLtfbc5wiLhY
  - Audit note: ProviderSessionDirectory upsert remains read-merge-write without concurrency control.

- [ ] `C051` Using `??` for `providerThreadId` and `adapterKey` makes it impossible to clear these fields by passing `null`, since `null ?? existing` evaluates to `existing`. Consider using explicit `undefined` checks (like `resumeCursor` does) if clearing should be supported. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `TODO`
  - Verdict: `partially-valid`
  - Severity: `Low`
  - Area: `Other`
  - File: `apps/server/src/provider/Layers/ProviderSessionDirectory.ts:119`
  - Threads: PRRT_kwDORLtfbc5wxvH9
  - Audit note: Null-clearing issue is real for providerThreadId; adapterKey part overstated.

- [ ] `C052` Race condition: `processHandle` may be `null` when `data` callback fires, since it's assigned after `Bun.spawn` returns. Consider initializing `BunPtyProcess` first, then passing it to the callback to avoid losing initial output. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `Other`
  - File: `apps/server/src/terminal/Layers/BunPTY.ts:97`
  - Threads: PRRT_kwDORLtfbc5w1CxE
  - Audit note: Data callback may race before processHandle assignment.

- [ ] `C056` When `onOpenChange` is provided without `open`, the internal `_open` state never updates because `setOpenProp` takes precedence. Consider calling `_setOpen` when `openProp === undefined`, regardless of whether `setOpenProp` exists.
  - Status: `TODO`
  - Verdict: `partially-valid`
  - Severity: `Low`
  - Area: `Other`
  - File: `apps/web/src/components/ui/sidebar.tsx:114`
  - Threads: PRRT_kwDORLtfbc5wxvIq
  - Audit note: Bug pattern exists, but current callsites mostly avoid triggering it.

- [ ] `C057` The `resizable` object is recreated on every render, causing `SidebarRail`'s `useEffect` to repeatedly read localStorage and update the DOM. Consider memoizing the object with `useMemo`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `Other`
  - File: `apps/web/src/routes/_chat.$threadId.tsx:105`
  - Threads: PRRT_kwDORLtfbc5wyWz4
  - Audit note: Resizable object recreation still retriggers effect/storage reads.

- [ ] `C058` When `localStorage.getItem()` returns `null`, `Number(null)` evaluates to `0`, which passes `Number.isFinite(0)`. This causes the sidebar to clamp to `minWidth` on first load, overriding the `DIFF_INLINE_DEFAULT_WIDTH` CSS clamp. Consider checking for `null` or empty string before parsing, e.g. guard with `storedWidth === null || storedWidth === ''`. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `Other`
  - File: `apps/web/src/routes/_chat.$threadId.tsx:122`
  - Threads: PRRT_kwDORLtfbc5wnVsX
  - Audit note: Number(null) -> 0 path still forces min width on initial load.

- [ ] `C060` `defaultModel` should be `Schema.optional(Schema.NullOr(Schema.String))` to allow clearing the value. Currently there's no way to reset it to `null` since omitting means "no change" in patch semantics. <details> <summary>🚀 Reply "<strong>fix it for me</strong>" or copy this <strong>AI Prompt</strong> for your agent:</summary>
  - Status: `TODO`
  - Verdict: `valid`
  - Severity: `Low`
  - Area: `Other`
  - File: `packages/contracts/src/orchestration.ts:253`
  - Threads: PRRT_kwDORLtfbc5whxJC
  - Audit note: Schema still cannot express null clear for defaultModel patch.

## Closed Invalid Items

- [x] `C014` Engine error handler catches all errors including non-invariant ones
  - Status: `CLOSED_INVALID`
  - Severity: `Medium`
  - File: `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:144`
  - Threads: PRRT_kwDORLtfbc5wkPaJ
  - Rationale: Broad catch is intentional for worker liveness; transactional dispatch path prevents the claimed non-invariant idempotency break in current design.

- [x] `C021` Shared mutable default metadata object causes stale eventId
  - Status: `CLOSED_INVALID`
  - Severity: `Medium`
  - File: `apps/server/src/orchestration/decider.ts:27`
  - Threads: PRRT_kwDORLtfbc5wkPaA
  - Rationale: Stale-eventId claim no longer applies; eventId is regenerated per event.

- [x] `C025` Duplicated checkpoint ref computation across two files
  - Status: `CLOSED_INVALID`
  - Severity: `Medium`
  - File: `apps/server/src/wsServer.ts:128`
  - Threads: PRRT_kwDORLtfbc5wvwag
  - Rationale: No longer duplicated; checkpoint ref helper now centralized.

- [x] `C031` Revert uses wrong turn count from positional inference
  - Status: `CLOSED_INVALID`
  - Severity: `Medium`
  - File: `apps/web/src/session-logic.ts:127`
  - Threads: PRRT_kwDORLtfbc5v9SCp
  - Rationale: Revert now uses explicit checkpointTurnCount first; positional fallback is non-primary.

- [x] `C036` Duplicate `checkpointRefForThreadTurn` function in two production files
  - Status: `CLOSED_INVALID`
  - Severity: `Low`
  - File: `apps/server/src/checkpointing/Layers/CheckpointStore.ts:284`
  - Threads: PRRT_kwDORLtfbc5wiqFX
  - Rationale: No longer duplicated; single production source via Refs.ts.

- [x] `C055` Duplicate `checkpointRefForThreadTurn` function across files
  - Status: `CLOSED_INVALID`
  - Severity: `Low`
  - File: `apps/server/src/wsServer.ts:128`
  - Threads: PRRT_kwDORLtfbc5wkPaG
  - Rationale: No longer duplicated; helper is centralized.

# Plan: Orchestration V2 Session Audit Remediation

## Summary

A full audit of every v2 orchestrator session in `~/.t3/userdata-v2` (2026-07-02, 18 session
groups, ~43k events, ~6.3k projected turn items, all 5 providers) compared native provider logs
against ingested events and item projections. Core mechanics are healthy — zero stream_version
gaps, zero ordinal collisions, positions table 100% consistent, no duplicate `nativeItemRef`s,
no stuck non-terminal state — but 23 verified discrepancies cluster into the workstreams below.

Every finding was adversarially re-verified against the raw DB/logs and the adapter source.
Repro commands are inline. File/line references are as of branch `t3code/codex-turn-mapping`
on the audit date; expect drift.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

## Tracking checklist

> **Restructure note (2026-07-04):** the PR stack was reorganized to combine with
> mwolson's parallel work. Shared continuation plumbing (C0, ea57e97d58) now lives
> directly on `t3code/codex-turn-mapping`; Claude session-continuity fixes including
> our #1/#15 (+ fixtures `claude_result_is_error`, `claude_idle_resume`,
> `advance_clock` step) live in PR #3860; grok/ACP lifecycle (superset of plan #7)
> lives in PR #3578; this branch (PR #3677) keeps the remaining audit fixes:
> #2 #3 #4 #5 #9 #10 #11 #12. Our turn.wakeup implementation was dropped in favor
> of the C0 continuation design.


- [x] 1. Honor `is_error` on Claude SDK results — MOVED to PR #3860 (with fixture claude_result_is_error)
- [x] 2. Preserve real failure causes in projected errors (Claude adapter + ProviderFailure)
- [x] 3. Preserve cursor failure detail (requestId, durationMs; SDK exposes no error text yet)
- [x] 4. Log failure/lifecycle frames in native provider logs (claude + cursor runners)
- [x] 5. Surface provider-process crashes / reconcile cancellations to the user
- [x] 6. Ingest codex-native collab subagents — already implemented upstream (verified 2026-07-04 on #3908's branch: registerSubagentActivity/registerSubagentThreads handle subAgentActivity + collabAgentToolCall, and the subagent_v2 fixtures replay the exact a5a643b2 loss scenario incl. post-settle child completion, asserting the child's "Hello." result)
- [ ] 7. Fix grok/ACP background subagent lifecycle + transcript projection
- [x] 8. Invisible post-turn wakeup turns — SUPERSEDED by C0/#3860's provider-continuation design (our turn.wakeup implementation dropped in the restructure)
- [x] 9. Route shared-codex-session native logs to the correct thread's file
- [x] 10. Coalesce streaming-delta event persistence (~2800x amplification)
- [x] 11. Assistant text segments merged without separator (fixed in worktree — add regression fixture)
- [x] 12. OpenCode `file_search` items drop error/output
- [ ] 13. Low-severity backlog (see section)
- [ ] 14. Cursor SDK unhandled `write EPIPE` crashes the backend child (recurring, post-SDK-bump)

---

## 1. `is_error: true` on Claude SDK results ignored — failed runs recorded as completed

**Severity: high.** The Claude Agent SDK emits terminal `result` messages with
`subtype: "success"` but `is_error: true` for API-level failures. The adapter only branches on
subtype, so the run, run_attempt, provider_turn, and (for delegated tasks) the subagent row and
the parent's `delegate_task` item all read `completed`.

Observed in four independent places:

- Delegated task `hello-opus-48` (thread `1156181e`): 401 auth failure, zero token usage,
  everything projected `completed`.
- Same 401 in a5a643b2's run-4 delegated child — parent `delegate_task` item output.status
  `completed`.
- Thread `47763f5e` run 1: 401 result projected as a completed run; error text survives only as
  a plain completed `assistant_message` (the SDK's synthetic `<synthetic>`-model message) — no
  error item, so the run reads as a success.
- Thread `ea84f015` runs 11–13: `API Error: 529 Overloaded` (29 `api_retry` events preceding),
  all three runs `completed`.

**Root cause:** `ClaudeAdapterV2.ts` — `terminalStatusFromResult` (~line 1652) returns
`"completed"` whenever `message.subtype === "success"`; the failure branch (~line 3254) only
fires for non-success subtypes. `is_error` / `api_error_status` are never consulted.

**Proposed fix:**

1. In `terminalStatusFromResult` (and the result handler), treat `subtype === "success" &&
   is_error === true` as a failure.
2. Build a `ProviderFailure` from the result: `message` = the `result` text (e.g. `Failed to
   authenticate. API Error: 401 ...`), `code` = `api_error_status` when present, plausibly
   `retryable: true` for 429/529.
3. Ensure a terminal-failure error item is emitted (not just the synthetic assistant message)
   and delegated-task subagent rows go to `failed`.
4. Testkit: extend `ClaudeAdapterV2.testkit.ts` + replay fixtures with an
   `is_error`-on-success-subtype result.

**Repro:**

```sh
sqlite3 -readonly ~/.t3/userdata-v2/state.sqlite \
  "SELECT status FROM orchestration_v2_projection_runs WHERE thread_id LIKE '%1156181e%';"  # completed
grep 'api_error_status' ~/.t3/userdata-v2/logs/provider/thread-delegated-task-command-3amcp-3a1156181e-*.log
```

- [ ] Status: not started

## 2. Terminal failures persist only generic strings — root cause unrecoverable from DB

**Severity: high (systemic).** Every claudeAgent failed run in the DB persists exactly
`{class: "transport_error", message: "Claude Agent SDK query failed.", code: null,
retryable: null}` (threads 47763f5e run 10, 7f1dfff1 run 10, 71e29ba5 runs 89/119). The native
log at those failure sites shows only the outgoing `query.open`/`prompt.offer` with nothing
incoming — so after the fact, **no record of the actual failure exists anywhere**. The same
pattern hit cursor (issue 3) — while codex proves it can be done right: codex failures keep the
full upstream error body.

**Root causes:**

- `ClaudeAdapterV2.ts:279-281` — `ClaudeAgentSdkQueryRunnerError.message` getter hardcodes the
  string; the wrapped `cause` defect is discarded.
- `ProviderFailure.ts:90-113` — `makeProviderFailure` reads only `.message`/`.code` off the
  squashed cause and never unwraps nested causes of tagged wrapper errors.
- `RunExecutionService.ts:~830` — feeds `Cause.squash(cause)` into `makeProviderFailure`, so a
  tagged error's inner cause never reaches the projection. The server log printed the cause
  depth-elided (`failures: [ [Object] ]`), destroying the last copy.

**Proposed fix:**

1. Give wrapper errors (`ClaudeAgentSdkQueryRunnerError`, `ProviderAdapterTurnStartError` at
   `ProviderAdapter.ts:~291`) a message that includes `String(cause)` (or a `detail` field).
2. In `makeProviderFailure`, walk the cause chain (`Cause.prettyErrors` / unwrap `.cause`) and
   persist a structured `detail` (message chain + code) on the failure payload; contracts change
   in `packages/contracts/src/orchestrationV2.ts` if the failure schema needs a `detail` field.
3. Fix the server-log print to use full-depth inspection for causes.
4. Side note from 47763f5e run 10: the failed `query.open` reused a **create-style `sessionId`
   param after the session had been closed** (retry with `resume:` succeeded) — check
   `ProviderSessionManager`/adapter open-vs-resume selection for closed sessions while fixing.

**Repro:**

```sh
sqlite3 -readonly ~/.t3/userdata-v2/state.sqlite \
  "SELECT thread_id, json_extract(payload_json,'$.failure.message') \
   FROM orchestration_v2_projection_turn_items WHERE type='error';"
```

- [ ] Status: not started

## 3. Cursor failure detail dropped (requestId, durationMs, SDK error_code)

**Severity: high.** Thread `c9e72a05` (the "why are cursor turns failing" session): run 2 failed
after a 440s silent turn; native `run.completed` carried `status:"error"`,
`requestId:"beca30c7-..."`, `durationMs:440732`. Projection kept only
`{message: "Provider turn failed.", code: null}` — requestId and duration dropped. The real
cause ("Authentication error. If you are logged in, try logging out and back in.") lives only in
the Cursor SDK's local store (`runs.error_code`), which T3 never reads.

**Root cause:** `CursorAdapterV2.ts:2165-2168` maps `cause: (result as {error?: unknown}).error`
— that field does not exist on the SDK `RunResult`, so it always falls back to
`DEFAULT_PROVIDER_FAILURE_MESSAGE`.

**Proposed fix:**

1. Map what the result actually carries: persist `requestId` and `durationMs` on the failure
   payload (code field is a natural home for requestId).
2. On `status === "error"`, query the Cursor SDK store for `runs.error_code` /
   error message for that run id and attach it.
3. Note: verify against current SDK shape — the audit also found (refuted-as-intentional) cases
   where cursor's `run.completed` genuinely carries no detail; the fix is "persist everything
   present", not "invent detail".

**Repro:**

```sh
sqlite3 -readonly ~/.t3/userdata-v2/state.sqlite \
  "SELECT json_extract(payload_json,'$.failure') FROM orchestration_v2_projection_turn_items \
   WHERE thread_id='c9e72a05-4c87-4dd5-b1b6-83834cc73afe' AND type='error';"
grep 'run.completed' ~/.t3/userdata-v2/logs/provider/c9e72a05-*.log | tail -1
```

- [ ] Status: not started

## 4. Native provider logs never record failure/lifecycle frames

**Severity: medium.** The "ground truth" logs cannot explain failed turns. In `721fc23c` the
log ends with an outgoing `run.start` and no trace of the `agent.send` rejection 4ms later, nor
of the provider child process fatally crashing (twice, `@cursor/sdk` Node error — visible only
in `server-child.log`). No adapter has an error/lifecycle log kind at all.

**Root cause:** e.g. `CursorAgentSdk.ts` `send()` — log writes cover outgoing `run.start` and
incoming frames only; `runnerError(cause, "run.start")` paths (lines ~408/440) write nothing.
Process exit is not logged to the per-thread native log either.

**Proposed fix:**

1. Add an `error`/`lifecycle` kind to the native event logger contract and write a frame on:
   adapter send/open rejections, runner errors, provider process spawn/exit (with exit code),
   and turn-abort paths — across all adapters (cursor, claude, codex, ACP, opencode).
2. Keep payloads small (message + code + native run/turn id), no secrets.

- [ ] Status: not started

## 5. Provider crashes / reconcile cancellations are silent to the user

**Severity: high.** In `721fc23c` the cursor backend crashed mid-turn; startup reconcile
cancelled run 1. In `48663fb7` a server restart orphaned the run; reconcile cancelled it. In
both cases the user asked something, got **no response, no error item, and no explanation** —
a reconcile-cancelled run is projected indistinguishably from a user cancellation.

**Root cause:** the startup runtime-reconcile (`command:runtime-reconcile:startup...`)
terminalizes runs/attempts/turns to `cancelled` but emits no user-visible item and no reason.

**Proposed fix:**

1. When reconcile terminalizes a run it did not start, emit an error (or `interrupted`) turn
   item with a reason: e.g. "Provider process exited unexpectedly" / "Run was interrupted by an
   app restart".
2. Record the cancellation reason on the run payload (`cancelReason: "runtime_reconcile" |
   "user" | ...`) so UI and debugging can distinguish.
3. Optional: auto-offer retry in UI for reconcile-cancelled runs.

**Repro:**

```sh
sqlite3 -readonly ~/.t3/userdata-v2/state.sqlite \
  "SELECT event_type, occurred_at FROM orchestration_events \
   WHERE stream_id='721fc23c-2cf3-42bf-9d84-edd94359dca9' AND event_id LIKE '%runtime-reconcile%';"
grep -n 'cursor/sdk\|terminalizedRuns' ~/.t3/userdata-v2/logs/server-child.log
```

- [ ] Status: not started

## 6. Codex-native collab subagents entirely missing from events and projections

**Severity: high (lost data).** In `a5a643b2` run 3 ("spawn a subagent"), codex spawned a
native collab subagent: `subAgentActivity` item, `collabAgentToolCall` (`wait`), and a child
native thread (`019f0c93-d260`) with webSearch, reasoning, and a final `agentMessage`
("Hello."). **Zero** of it was ingested — no events, no items, no subagent row, no child
thread. The child also completed *after* the parent turn finalized, so late-arriving child
items need routing even post-turn.

**Root cause:** `CodexAdapterV2.ts` has no handlers for `subAgentActivity` /
`collabAgentToolCall` item types, and events on non-primary native threads of the shared
app-server session are not attributed to any T3 thread.

**Proposed fix:**

1. Handle `subAgentActivity`: create a subagent projection row + child provider thread (mirror
   of what `a61e9269`'s newer session shape already does — that session projected
   `subAgentActivity` fine, so check what differs: likely experimental collab API vs newer
   subagent API).
2. Handle `collabAgentToolCall` as a tool item on the parent.
3. Route child-native-thread items to the child T3 thread, including after the parent turn
   completed (same routing-loosening pattern used for owned-provider-thread updates in the
   wakeup work).

**Repro:**

```sh
sqlite3 -readonly ~/.t3/userdata-v2/state.sqlite \
  "SELECT COUNT(*) FROM orchestration_events WHERE payload_json LIKE '%019f0c93-d260%';"  # 0
grep -c 'subAgentActivity\|collabAgentToolCall' ~/.t3/userdata-v2/logs/provider/a5a643b2-*.log  # >0
```

- [ ] Status: not started

## 7. Grok/ACP background subagent: wrong lifecycle + transcript never projected

**Severity: high (lost data) + medium (lifecycle).** Thread `5dcea72d` ("spawn a subagent"):

- The subagent row and parent `subagent` item were marked `completed` at spawn time
  (01:52:10) with the placeholder result "Subagent started in background..." — the task
  actually ran 75s (116 tool calls, per the later `TaskOutput` payload).
- The child thread got only its 2 spawn-time items; the live transcript (811 decoded incoming
  ACP messages between runs) produced **zero** ingested events. The subagent's real final
  output never reached the child thread.

**Root cause:** `AcpAdapterV2.ts` `emitSubagent` (~lines 1047-1060) adopts the spawn tool's
bootstrap text as the result and a non-running taskStatus as terminal; session notifications
arriving **between runs** (no active turn) are dropped rather than buffered/routed to the
subagent's child thread.

**Proposed fix:**

1. Keep the subagent `running` until a terminal task status; update result/completedAt from
   `TaskOutput` (or task-completion notification) when it arrives.
2. Route/buffer ACP session notifications for background tasks outside active turns to the
   child thread (reuse the wakeup-buffer pattern from ClaudeAdapterV2 if applicable to ACP).
3. Related low finding: child-thread items carry null `run_id`/`provider_thread_id`/
   `provider_turn_id` — populate lineage when projecting child items.

**Repro:**

```sh
sqlite3 -readonly ~/.t3/userdata-v2/state.sqlite \
  "SELECT status, completed_at, substr(json_extract(payload_json,'$.result'),1,60) \
   FROM orchestration_v2_projection_subagents WHERE thread_id='5dcea72d-15e1-4ded-922b-0b00c587de6c';"
```

- [ ] Status: not started

## 8. Invisible post-turn wakeup turns (known — fix on this branch)

**Severity: high (lost data), known issue.** The audit quantified the pre-fix damage:

- `47763f5e`: 10 whole wakeup turns unpersisted — 16 assistant messages + 84 tool calls,
  including 5 real git pushes and the final "Converged. PR #3638 is fully green".
- `ea84f015`: 42 tool calls + final assistant messages across 3 windows — including a GitHub
  comment posted with no user-visible record (`pull/2829#issuecomment-4861082710`).
- `71e29ba5`: 76 completed tool calls (60 Bash, 7 Edit, 5 Read, 4 ScheduleWakeup), all falling
  in gaps between run windows, zero inside any run.

The fix (`turn.wakeup` / `ProviderWakeupService` / `attach_wakeup` / backgrounded-bash
adoption) is implemented on `t3code/codex-turn-mapping`; these sessions ran on pre-fix builds.
First `provider_wakeup` events in the DB appear 2026-07-01T22:47:41 — post-fix threads persist
wakeups.

**Remaining work:**

- [x] Core fix implemented (this branch, replay fixture `claude_provider_wakeup`)
- [ ] Sanity-check the three audit scenarios against the fixture set (task-notification wakeup,
      ScheduleWakeup sleep-loop, backgrounded Bash completion) — the audit evidence makes good
      additional fixture material
- [ ] Known follow-ups (from memory): idle session reaper vs long sleeps; superseded-wakeup
      buffer only replays task bookkeeping; provider_turn has no `waiting` status literal

## 9. Shared codex session logs written to opener thread's file

**Severity: medium.** Four codex threads (`c878541b`, `de5f191a`, `68f7595b`, `af66fc2c`) have
**no native log file at all** — their app-server traffic was written into
`71e29ba5-...log.*` because that thread opened the shared codex app-server session.
Consequence: rotation of the busy opener's log (10 files × 10MB) **destroyed the native ground
truth** for most of those threads' runs; it also produced a false "ingestion gap" signal during
the audit (another thread's traffic interleaved in 71e29ba5's log).

**Root cause:** `CodexAdapterV2.ts:~1136` — `codexAppServerClientFactoryFromSettingsLayer.open`
builds `makeCodexAppServerProtocolLogger({ threadId: input.threadId })` once per app-server
process; `EventNdjsonLogger.write` routes to `${threadSegment}.log` from that frozen threadId.

**Proposed fix:**

1. Resolve the log target per message, not per process: maintain a native-thread-id → T3
   thread-id map (the adapter already tracks owned native threads) and route each protocol
   frame to the owning thread's log; fall back to a shared
   `codex-shared-session.log` for unattributable frames (initialize, thread/start, etc.).
2. Consider retention bump for provider logs, since they are the only ground truth
   (`.plans/06-provider-logstream-lifecycle.md` is the related prior art).

**Repro:**

```sh
grep -l '019f1b62-f532' ~/.t3/userdata-v2/logs/provider/*.log*  # only 71e29ba5-*.log.{6,9,10}
ls ~/.t3/userdata-v2/logs/provider/ | grep -c 'c878541b\|de5f191a\|68f7595b\|af66fc2c'  # 0
```

- [ ] Status: not started

## 10. Streaming deltas persisted as full-row event pairs (~2800x amplification)

**Severity: medium (cost/scale, not correctness).** Grok/ACP streams a child task's result
per-token; each chunk is persisted as a **full-row** `turn-item.updated` + `message.updated`
event pair. One 6,274-char result accumulated 2,704 events; a 2-minute session wrote 6,017
rows (14% of the whole 43k-row table). Replay and projection costs scale with this.

**Root cause:** `AcpAdapterV2.emitSubagentAssistant` emits a full event pair per
`agent_message_chunk`, and `ProviderEventIngestor` persists every emission.

**Proposed fix:**

1. Split live streaming from persistence: broadcast deltas to subscribers in-memory, persist
   coalesced snapshots (e.g. on item completion + every N seconds/K bytes while running).
2. Alternatively debounce persistence per item id in the ingestor so any adapter gets the
   benefit.
3. Check other adapters for the same pattern (claude/codex emit per-block, which is fine;
   ACP per-token is the outlier).

**Repro:**

```sh
sqlite3 -readonly ~/.t3/userdata-v2/state.sqlite \
  "SELECT event_type, COUNT(*) FROM orchestration_events \
   WHERE stream_id LIKE 'thread:provider:grok:native-thread:019f1558%' GROUP BY 1;"
```

- [ ] Status: not started

## 11. Claude assistant text segments merged without separator (fixed — needs regression fixture)

**Severity: medium, already fixed in worktree.** In the `6d618dc4` MCP group (build
`fc23be8184`), 5 interleaved assistant text blocks were accumulated
(`context.assistant.text += ...`) and emitted as ONE item at end of turn — 10,642 chars joined
with no separator, ordered after all 19 tool calls, losing interleaving. Current worktree code
(`emitAssistantTextArtifacts` per `message.uuid`) already emits per-segment items.

**Remaining work:**

- [x] Fix (already in worktree)
- [ ] Add a replay fixture asserting multi-segment assistant text produces one item per SDK
      uuid, interleaved with tool items at correct ordinals

## 12. OpenCode `file_search` items drop error/output

**Severity: medium.** Child session `ses_0ea978228`: a failed `file_search` item projects only
`{status: 'failed', type: 'file_search', pattern: '...'}` — the provider's error message is
unrecoverable. Same shape drops successful read/grep/glob outputs (low finding).

**Root cause:** `OpenCodeAdapterV2.ts` — `toolOutput()` (line ~659) extracts
`part.state.error`, but the `file_search` mapping branch (~line 1376) only maps `pattern`;
output/error only attach for `dynamic_tool`. The contract type
(`packages/contracts/src/orchestrationV2.ts` ~line 841) has no output/error field on
`file_search` either.

**Proposed fix:**

1. Add optional `output`/`error` to the `file_search` item contract.
2. Map `part.state.error` (and output where present) in the opencode/ACP `file_search` branch.
3. Grok has the same gap (`file_search`/`read` persist only pattern/fileName echo — low
   finding); fix at the shared mapping level if possible.

**Repro:**

```sh
sqlite3 -readonly ~/.t3/userdata-v2/state.sqlite \
  "SELECT payload_json FROM orchestration_v2_projection_turn_items \
   WHERE turn_item_id='turn-item:provider:opencode:native-item:prt_f15692f30001qL66As1xsUCQXc';"
```

- [ ] Status: not started

## 13. Low-severity backlog

Unverified (single-auditor) findings, grouped. Tick when triaged/fixed:

**Lineage**
- [ ] `run_attempts.provider_turn_id` is null on ALL 207 attempts DB-wide (reverse link only) —
      populate the forward link or drop the column
- [ ] Opencode/claude "pending"-keyed provider-thread placeholder row persists alongside the
      real `ses_`-keyed row; runs/attempts reference one, items/active_provider_thread_id the
      other (3029dc85, 9f8d616d)
- [ ] Subagent child-thread items carry null run/provider_thread/provider_turn ids (grok,
      ea84f015)
- [ ] Interrupt-result turn item references an interrupt-request parent item that was never
      emitted (GLOBAL)
- [ ] Synthesized terminal-failure error item references a provider_turn_id that was never
      projected (GLOBAL)

**Stuck state / lifecycle**
- [ ] Projection ignores `provider-session.detached` — sessions stay `ready`/`running` for
      ~20-25h until shutdown sweep (GLOBAL, 1156181e, 6d618dc4, 47763f5e, ea84f015); also
      claudeAgent sessions are never idle-reaped
- [ ] Provider-thread row stayed `active` ~20h after its session stopped (9f8d616d)
- [ ] Run 119 (71e29ba5) marked failed while its native query kept running; retry run 120
      adopted the result leaving a duplicated user message — dedupe/adopt semantics on retry

**Dropped provider data (no user-visible loss observed yet)**
- [ ] Codex `reasoning` items silently dropped (no adapter handler; all observed summaries were
      empty — would lose data once codex emits populated summaries)
- [ ] Codex `thread/tokenUsage/updated` + `account/rateLimits/updated` never ingested — runs
      have no usage data; cursor `run.completed` usage also dropped (8ee00dcc)
- [ ] Codex `contextCompaction` item has no projection representation
- [ ] Cursor tool calls that never returned natively are auto-marked `completed` with no
      results at turn end (c9e72a05) — should be `failed`/`interrupted`
- [ ] 4 native `error_during_execution` results silently recovered in-adapter with no
      projection trace (71e29ba5); one absorbed during a steering message (ea84f015)

**Cosmetic / observability**
- [ ] Grok + opencode native logs redact payloads to shape summaries — no content-level ground
      truth for audits; consider a debug setting to log content
- [ ] Grok logs every successful `session/prompt` as `failed` with `errorTag: Interrupt`
- [ ] Cursor native `read` tool calls projected as type `file_search` (semantic mismatch)
- [ ] Cursor `file_change` diffStr has malformed headers (`a//abs/path`, `b//abs/path`)
- [ ] 13 old backgrounded `local_bash` tasks projected as subagents with empty prompts and
      synthetic child threads (GLOBAL); backgrounded-bash child threads have empty-text prompt
      user_message items (7f1dfff1)
- [ ] Cursor 7.3-minute silent hang before failing (c9e72a05) — no progress/heartbeat signal
      exists to distinguish a hung turn from a thinking one

## 14. Cursor SDK unhandled `write EPIPE` crashes the backend child (recurring)

**Severity: high.** Added 2026-07-02 after new cursor sessions reproduced backend crashes.
Distinct from the June-29 crash that the `@cursor/sdk` version bump addressed.

Three occurrences in `server-child.log`, identical signature — `Unhandled 'error' event /
Error: write EPIPE` on a `net.Socket`, followed by the `Node.js v24.15.0` footer (process
death):

- **2026-07-02T19:04:57.558Z** — stack definitively inside `@cursor/sdk/dist/esm/357.js`
  (`et.execute` → `We.execute` → `Is.execute`): a connect-RPC execute writing to a
  cursor-agent socket whose far end had closed. Context: TWO cursor sessions streaming
  concurrently (d1bfdd3d run-0294b303, 4f3381e5 run-c7e93ba0, each with its own provider
  session, plus a native subagent task thread); both streamed token-deltas until 19:04:55.5.
- **2026-07-01T20:47:34.573Z** and **2026-07-02T04:46:20.557Z** — same signature, but stack is
  only the async write-completion frame (`WriteWrap.onWriteComplete`), so origin unproven. No
  cursor turns were active; consistent with a lingering cursor-agent connection dying idle and
  a later write hitting EPIPE.

**Collateral (ties into issues 2/4/5):**

- d1bfdd3d run 1 + 4f3381e5 run 1 silently `cancelled` by startup reconcile at 19:05:01;
  4f3381e5 has NO error item at all (issue 5).
- d1bfdd3d run 2 (retry) failed with the generic `Failed to start run ... on cursor provider
  thread ...pending...` wrapper, cause depth-elided in the log (issue 2), and targeted the
  stale `pending`-keyed provider thread (issue 13 lineage note).
- The two earlier EPIPE crashes explain two previously "undebuggable" audit failures: the
  restarted child killed the live claude CLI processes, so 7f1dfff1 run 10 (requested
  20:47:56, `claude-query-stream-failed` 20:47:58) and 71e29ba5 run 89 (requested 04:47:03)
  failed ~20-40s after each crash with the generic "Claude Agent SDK query failed."
- The June-29 crash's actual error text is unknowable: the stderr dump was truncated at
  51,674 chars (log line cap) BEFORE the error message — only minified bundle source survived.

**Proposed fix:**

1. Containment: attach `error` handlers to (or wrap) the cursor SDK's sockets, and add a
   `process.on('uncaughtException'/'unhandledRejection')` policy in the backend child that
   fails the owning provider session instead of dying. Longer-term: isolate provider SDKs in
   their own child process so an SDK crash cannot kill the orchestrator.
2. Report upstream to Cursor: SDK leaves its agent socket without an `error` listener;
   `write EPIPE` after agent-process exit is fatal to the host.
3. Fix stderr log truncation: when capping captured child output, keep the TAIL (where Node
   prints the error + stack), not just the head.
4. Issues 2/4/5 remain the reason this was hard to diagnose — they get us error items with
   real causes, native-log failure frames, and user-visible reconcile cancellations.

**Repro:**

```sh
grep -n "Unhandled 'error' event" ~/.t3/userdata-v2/logs/server-child.log   # 3 hits
sqlite3 -readonly ~/.t3/userdata-v2/state.sqlite \
  "SELECT run_id,status,completed_at FROM orchestration_v2_projection_runs \
   WHERE thread_id IN ('d1bfdd3d-38cc-4ff3-ab75-8be6dc592b00','4f3381e5-89e2-45a8-bca1-bbe5d520bbba');"
```

- [ ] Status: not started

## Refuted during verification (do NOT act on)

- 71e29ba5 "ingestion gap, 119 items lost" — traffic belonged to c878541b via the shared codex
  session (see issue 9).
- 47763f5e "122 thinking blocks dropped" — all native thinking blocks were empty
  (`{"thinking":""}`); nothing to lose. (Reasoning ingestion is still absent, tracked as low.)
- ea84f015 failed cursor runs 15-17 "generic error" — native results genuinely carried no
  detail; nothing to persist (but see issues 3/4 for making cursor carry detail).

## Validation

- Re-run the audit repro queries above after each fix; each issue's repro should flip.
- Extend replay fixtures (`testkit/fixtures/`) per issue where marked; the audit evidence
  (thread ids + native log excerpts) is fixture source material.
- Full audit data with per-finding evidence, verifier verdicts, and repro commands:
  `.plans/22-orchestration-v2-audit-findings.json`.

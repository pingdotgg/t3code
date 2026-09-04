# Orchestrator V2 provider parity and regression audit

## Result

The frozen committed branch still has four provider findings from the 2026-09-02 audit and has four additional concrete provider-parity defects exposed by changes that landed on main since that audit. I found no current-main-only provider change among the final eight unmerged commits and no committed registration, discovery, or auth regression across the seven built-in drivers.

The dropped range-diff patch for Codex availability was absorbed by the refactor. It is not a regression: `CodexProvider.ts:489-525` still produces the unchecked pending snapshot with `installed: false`, and `CodexDriver.ts:192-204` still uses that builder as the managed driver's `initialSnapshot`.

Audit basis:

- Frozen branch: `8af5734365f7c45bc08b57066dbae42f9f7d4235`
- Frozen main: `d7cf8aaa8d4fbcbdd523b4f4bc86fda5c47b4a70`
- Merge base: `c8f77e0d441264efb0acfac312e852c81ae3da83`
- Prior audit branch/main: `d2f1f511f4cc833bc930d6c355cd0f9b61e835a0` / `57a66608b918d673eeec7e6c94ea5906b756fcd0`

All committed evidence below came from `git show` at those frozen revisions. Dirty-worktree observations came from the `.snapshot` files in `worktree-overlay`.

## Prior finding status

| ID  | Severity | Status                     | Current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------: | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F06 |       P1 | Persists in committed HEAD | OpenCode V2 treats descendant enumeration, descendant abort, and the whole 15-second descendant traversal as best effort (`OpenCodeAdapterV2.ts:3121-3150`). Only the root abort can reach `ProviderAdapterInterruptError`. An explicit Stop can therefore acknowledge success while a child session continues. Current main preserves the first relevant descendant error instead of discarding it (`OpenCodeAdapter.ts:756-823`).                                             |
| F07 |       P1 | Persists in committed HEAD | An external OpenCode server is accepted at `OpenCodeAdapterV2.ts:893-905`, but session teardown only aborts the local SSE controller at `2542-2548`. The now-bounded and logged manager scope close (`ProviderSessionManager.ts:651-705`) prevents release itself from hanging; it does not abort the root or child OpenCode sessions. Current main calls bounded root and descendant aborts during teardown (`OpenCodeAdapter.ts:825-837`).                                    |
| F08 |       P1 | Persists in committed HEAD | Cursor metadata generation still launches the SDK in unrestricted `agent` mode at the real project cwd with its sandbox disabled (`CursorTextGeneration.ts:75-124`). The timeout bounds duration, not filesystem effects. Current main uses Cursor ACP and requests `ask` mode before prompting (`CursorTextGeneration.ts:85-105`).                                                                                                                                             |
| F11 |       P2 | Persists in committed HEAD | Claude `Read` remains a generic `dynamic_tool`: the classifier only accepts the tool name and maps `read` without inspecting the path (`ClaudeAdapterV2.ts:1401-1449, 3614-3626`). Web and mobile then reduce dynamic tool data to input/output (`apps/web/src/session-logic.ts:631-637`; `apps/mobile/src/lib/threadActivity.ts:534-539`), so the shared image-preview path never receives `viewedImagePath`. Coordinate the client presentation portion with the root review. |

F12 and F16 are owned by the root audit and are not duplicated here.

## New concrete findings

### PROV-OPENCODE-01: P1, a clean SSE EOF silently disables all later provider events

`OpenCodeAdapterV2.ts:2542-2575` creates one `event.subscribe` stream. Its terminal handler returns without changing session state when `Exit.isSuccess(exit)` at line 2562. The public provider runtime continues exposing a separate never-ending queue stream at `2710-2716`, so the session manager does not observe that the native subscription fiber ended.

Trigger: the SDK async iterable ends cleanly without the local abort signal being set. This includes a transport that reports disconnect as EOF instead of throwing.

Consequence: the provider session remains apparently ready, but subsequent status, text, tool, approval, and completion events are no longer ingested. An active turn or request can remain stuck, and later activity on the same session is invisible.

Current main addressed this in [#9653](https://github.com/pingdotgg/t3code/pull/9653): `OpenCodeAdapter.ts:2713-2757` records SSE errors and emits an unexpected-exit failure even when the iterable ends successfully, enabling the stopped/reconnect path. This is a missing port, not an intentional V2 difference.

I left this finding source-backed. The existing mocked adapter lifecycle does not expose a receipt when the private subscription fiber completes. A passing absence assertion after closing the iterable would depend on scheduler timing, so it would not be a meaningful regression probe.

### PROV-OPENCODE-02: P1, approval and question replies can hang the durable effect worker indefinitely

`OpenCodeAdapterV2.ts:3162-3212` calls `question.reply` and `permission.reply` without passing an SDK abort signal and without a timeout. The orchestrator has already persisted the request as resolved before enqueueing this external effect (`Orchestrator.ts:5068-5075, 5222-5237`), and `RuntimeRequestService.ts:91-125` then waits directly on the adapter call.

Trigger: an OpenCode server accepts the reply connection but never resolves it.

Consequence: the user cannot submit another answer because the durable request is already resolved, while the provider may never receive the response. The call also pins one effect worker and leaves its outbox row running. `EffectWorker.ts:216-238` and `RuntimeRequestService.ts:112-138` only translate errors; neither adds cancellation or a deadline. The worker races execution only against the outbox's explicit cancellation signal (`EffectWorker.ts:485-502`). `EffectOutbox.ts:278-303` claims pending rows only and blocks later non-title effects in the same thread while this row remains running. Lease expiry does not start an automatic duplicate attempt. One hung reply therefore blocks that thread's effect lane until explicit cancellation or process restart; four distinct hung replies can occupy the default four-worker pool.

Current main addressed both reply types in [#9653](https://github.com/pingdotgg/t3code/pull/9653): it passes the SDK signal, applies a 10-second timeout, and only then resolves the local pending request and emits its terminal event (`OpenCodeAdapter.ts:3611-3715`). This is a missing port.

### PROV-CLAUDE-01: P1, new Claude dead-turn terminal reasons are reported as successful completion

The branch already depends on Claude Agent SDK `0.3.260`, but V2's result classifier predates that SDK's structured dead-turn results. `ClaudeAdapterV2.ts:1991-2025` returns `completed` for every `subtype: "success"`, `is_error: false` result, regardless of `terminal_reason`; `providerFailureFromResult` likewise returns no failure at `2045-2065`. The result handler commits those values at `4769-4788`.

Trigger: Claude exhausts retries or otherwise ends with a structured failure such as `terminal_reason: "api_error"`, `"blocking_limit"`, `"rapid_refill_breaker"`, `"prompt_too_long"`, `"image_error"`, `"model_error"`, `"malformed_tool_use_exhausted"`, `"budget_exhausted"`, `"structured_output_retry_exhausted"`, `"tool_deferred_unavailable"`, or `"turn_setup_failed"`, while the SDK reports a success subtype and no ordinary error.

Consequence: a turn that produced no successful answer is projected as completed and has no provider failure for the UI to explain.

Current main added the structured classification and user-facing messages in [#9135](https://github.com/pingdotgg/t3code/pull/9135) (`ClaudeAdapter.ts:438-478, 1510-1548`), including a regression test for the observed `success` / `is_error: false` / `terminal_reason: "api_error"` shape and exhaustive tests for the dead-turn set. This is a missing port.

`provider-adapter-regression-probes.test.ts` confirms the behavior through the actual V2 adapter. It starts a mocked Claude query session, sends the observed `api_error` result shape through the adapter's message stream, and receives `turn.terminal` with `status: "completed"` and `failure: null`. The probe passed as a reproduction in 25 ms.

### PROV-OPENCODE-03: P2, OpenCode per-turn token telemetry is always unavailable

`OpenCodeAdapterV2.ts:1029-1051` emits terminal provider-turn updates without `turnTokenUsage`. Its part switch at `2310-2340` handles text, reasoning, and tools, but ignores `step-finish`, the OpenCode event carrying token counts. `ProviderEventIngestor.ts:88-114` therefore emits `usageStatus: "unavailable"` for every OpenCode turn.

Consequence: V2 OpenCode terminal provider-turn telemetry and its analytics properties cannot report per-turn input, cache, output, or reasoning token counts. This does not prove increased spend and does not establish that a separate transcript-backed usage dashboard is missing data.

Current main added ownership-aware `step-finish` accumulation and complete/partial/unavailable terminal usage in [#9132](https://github.com/pingdotgg/t3code/pull/9132) (`OpenCodeAdapter.ts:403-439, 2409-2429`). Codex and Claude V2 already populate the same provider-turn field. This is a missing port.

## Feature parity matrix

| Provider     | Registry, discovery, auth                                                                      | Native session/history                                                                                                        | Approvals and questions                                                                         | Stop and release                                                                   | Per-turn usage                                      | Metadata generation boundary                                 | Assessment                                                             |
| ------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Codex        | Registered; unchecked state remains unavailable until probed; auth/settings hydration retained | Strong resume, fork/from-turn, rollback, subagent fork                                                                        | Command/read/change/patch approvals and structured questions                                    | Interrupt and scoped cleanup covered by focused tests                              | Complete/partial telemetry implemented              | Existing constrained helper behavior retained                | No committed regression found; dirty capability change described below |
| Claude       | Registered with managed health/auth                                                            | Resume, fork/from-turn, rollback; no subagent fork advertised                                                                 | Command/read/change approvals and structured questions                                          | Interrupt/query teardown covered                                                   | Complete/partial telemetry implemented              | Existing behavior unchanged from main                        | F11 and PROV-CLAUDE-01                                                 |
| Cursor       | Registered; API-key auth path retained                                                         | Resume by native session id; fork and rollback explicitly unsupported                                                         | No approvals or structured questions are advertised; runtime access modes are applied at launch | Interrupt-restart behavior advertised and covered                                  | Unavailable by protocol/design                      | Unrestricted SDK agent at project cwd                        | F08; unsupported capabilities are explicit, not hidden parity claims   |
| OpenCode     | Registered; local/external settings and password path retained                                 | Resume, fork/from-turn, rollback, child-session projection                                                                    | All approval kinds and structured questions                                                     | Root abort is bounded; descendant Stop failures and external release are defective | Missing despite native `step-finish` data           | Text helper denies tools; no new boundary issue found        | F06, F07, PROV-OPENCODE-01/02/03                                       |
| Grok         | Registered ACP specialization; auth/settings retained                                          | ACP load snapshot supported; native fork explicitly unavailable                                                               | ACP permission/questions supported, including Grok question extension                           | ACP interrupt and hard teardown paths covered                                      | Unavailable by protocol/design                      | Existing Grok helper behavior matches main                   | No concrete regression found                                           |
| Antigravity  | Registered; Google-profile auth coordination retained                                          | ACP capabilities are negotiated; resume is preferred, base fork/rollback remain unavailable unless runtime advertises support | ACP permissions/questions supported                                                             | ACP interrupt and scoped process teardown covered                                  | Unavailable by protocol/design                      | Isolated temporary cwd, no injected tools, rejects tool work | No concrete regression found                                           |
| ACP Registry | Registered as a built-in; instance-specific command/auth discovery retained                    | Load/fork/model/MCP capabilities are negotiated from the agent; no rollback                                                   | ACP permissions/questions supported; request IDs are weak/live-only                             | Explicit interrupt and hard teardown propagate relevant failures                   | Unavailable unless a future protocol field is added | Text generation is intentionally unsupported                 | No concrete regression found                                           |

The built-in list at `provider/builtInDrivers.ts:52-60` contains Codex, Claude, Cursor, Grok, OpenCode, Antigravity, and ACP Registry. The seemingly incomplete older adapter-driver helper is not used by production registration and is not a finding.

## Main-since-prior and final-eight review

The main changes that materially affect this domain since the prior audit are the OpenCode transport/request fixes in [#9653](https://github.com/pingdotgg/t3code/pull/9653), OpenCode token accumulation in [#9132](https://github.com/pingdotgg/t3code/pull/9132), Claude terminal classification in [#9135](https://github.com/pingdotgg/t3code/pull/9135), Claude attachment ordering in [#9122](https://github.com/pingdotgg/t3code/pull/9122), provider image-embedding instructions in [#9597](https://github.com/pingdotgg/t3code/pull/9597), OpenCode access rules in [#9282](https://github.com/pingdotgg/t3code/pull/9282), OpenCode workspace skills in [#9585](https://github.com/pingdotgg/t3code/pull/9585), and Codex async questions in [#9512](https://github.com/pingdotgg/t3code/pull/9512). Except for the four new findings above, the inspected V2 equivalents of those provider fixes are present.

Mobile's cwd-specific provider catalog refresh from [#9180](https://github.com/pingdotgg/t3code/pull/9180) is present at `use-composer-command-menu.ts:188-244`; the prior broad V02 “outside web” validation gap should not be carried forward. I did not establish a narrower execution-only stale-catalog failure. Project auto-pull is also retained through `VcsStatusBroadcaster` policy and startup `autoPullProjects`; no missing provider launch hook was found.

The final eight commits between branch HEAD and frozen main are [#9740](https://github.com/pingdotgg/t3code/pull/9740), [#9744](https://github.com/pingdotgg/t3code/pull/9744), [#9627](https://github.com/pingdotgg/t3code/pull/9627), [#9748](https://github.com/pingdotgg/t3code/pull/9748), [#9747](https://github.com/pingdotgg/t3code/pull/9747), [#9749](https://github.com/pingdotgg/t3code/pull/9749), [#9743](https://github.com/pingdotgg/t3code/pull/9743), and [#9739](https://github.com/pingdotgg/t3code/pull/9739). None changes a provider registry, adapter, provider text-generation helper, or provider contract in this bounded scope. The branch's lag behind those commits is not itself a provider regression.

## Dirty overlay

The only provider-material frozen overlay change is local-only: `CodexAdapterV2` adds `optOutNotificationMethods: ["turn/diff/updated"]`, with the matching fixture/test update. It asks Codex app-server not to send a notification that T3 already presents through its own diff flow. I found no new regression in that local change. The focused Codex test passed against the live overlay.

The frozen `Orchestrator.ts.snapshot` has no content difference from committed HEAD for this domain. Other recorded session-turn-control/fixture changes are interface or settlement work outside a concrete provider regression. No product source or existing test was modified by this audit.

## Tests and limitations

Focused live-worktree run: 9 files, 215 tests passed in 2.17 seconds. The exact target and result are in `providers-tests.log`. The selection covered all seven V2 adapter suites plus provider auth and instance-registry live tests.

Audit-only behavior probe: 1 file, 1 test passed in 632 ms total, with 25 ms spent in the test. The exact command and result are in `provider-adapter-regression-probes.log`. It imported and exercised the real `makeClaudeAdapterV2` implementation with an in-process query runner. The probe stays in this audit directory and does not alter product tests.

These are mock/in-process suites. The new probe covers the observed Claude `api_error` result shape but not every new terminal reason. No test here exercises graceful OpenCode SSE EOF, a never-resolving OpenCode reply promise, OpenCode `step-finish` token accumulation, real Cursor metadata filesystem behavior, or Claude Read image presentation. Their passing result therefore does not contradict the remaining source-path findings.

No provider or server was launched, no browser/simulator was used, no live T3 userdata was touched, no network was used, and no repo-wide check ran. The copied audit tests now use `.snapshot` suffixes; the earlier Vitest substring import failure caused by an unsuffixed frozen copy was an audit-artifact issue, not a product regression.

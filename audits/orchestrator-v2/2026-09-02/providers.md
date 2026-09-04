# Orchestrator V2 provider behavior audit

Date: 2026-09-02  
Audited HEAD: `d2f1f511f4cc833bc930d6c355cd0f9b61e835a0`  
Comparison main: `57a66608b918d673eeec7e6c94ea5906b756fcd0`  
Prior reviewed object: `47f5b100440591d2f49aa30cf3bb69eacae07f52`  
Rebased prior-equivalent tip: `c1791ab2637`

## Verdict

The supplied main is an ancestor of the frozen HEAD, and the branch is 332 commits ahead. The previously reported provider fixes survive the rebase. I found five confirmed behavior regressions against current main V1:

1. Cursor background text generation runs a full agent with its sandbox and approval boundary disabled.
2. Claude workspace image reads do not become image previews in either current V2 client projection.
3. OpenCode Stop reports descendant cleanup as successful even when child discovery or abort fails or times out.
4. Releasing an OpenCode V2 session connected to an external server never asks that server to abort root or child work.
5. V2 reconnect and HTTP-failure fallbacks bypass the bounded thread-snapshot path and can send the full lifetime projection over WebSocket.

The Cursor SDK migration itself is intentional, but I found no evidence that removing the metadata-generation write guard was an accepted part of it. The Claude result is a missing user-visible main feature. The OpenCode findings partially port main's `#9005` fix but leave reachable stop/teardown behavior weaker than V1. The snapshot issue is not the ordinary healthy cold-open path—the bounded HTTP request protects that case—but it is an active fallback used by both current clients.

## Confirmed regressions

### P1 — Cursor metadata generation runs with unrestricted write/tool access

**Current V2 evidence:** `apps/server/src/textGeneration/CursorTextGeneration.ts:75-157`.

- Every Cursor commit message, change-request description, branch name, and thread title calls `Agent.prompt` with `mode: "agent"`, `local.autoReview: false`, and `local.sandboxOptions.enabled: false` (`90-104`; callers at `159-251`). The focused test explicitly pins those options but mocks the SDK, so it does not exercise their permission behavior (`CursorTextGeneration.test.ts:38-85`).
- The installed dependency is `@cursor/sdk@1.0.22`. Its public types expose only `"agent" | "plan"` modes and a boolean sandbox switch (`node_modules/.pnpm/@cursor+sdk@1.0.22/node_modules/@cursor/sdk/dist/esm/options.d.ts:3-4, 63-65, 108-145, 218-240`). Inspection of the installed runtime bundle shows that `enabled: false` immediately selects `defaultSandboxPolicy: { type: "insecure_none" }`, before considering the loaded per-user sandbox policy; because that policy is insecure and `autoReview` is false, it supplies neither `approvalMode` nor a `pendingDecisionProvider` (`dist/esm/357.js:1`). The same bundle maps `mode: "agent"` to the native `AGENT` mode and implements `Agent.prompt` as create/send/wait/dispose, so this is the normal tool-capable local agent path rather than a text-only inference call.

**Main evidence:** supplied main's `apps/server/src/textGeneration/CursorTextGeneration.ts:85-105` starts Cursor ACP and deliberately calls `runtime.setMode("ask")` before prompting. The accompanying Cursor ACP capability names Ask as “Request permission before making any changes,” contrasted with Code's full tool access (`apps/server/scripts/acp-mock-agent.ts` at supplied main: `271-287`). The SDK migration commit `6c78a01831d` documents the intentional boundary/auth/model-discovery change, but neither its message nor its implementation records an intentional relaxation for background metadata generation.

**Reachable trigger:** Select Cursor as the text-generation/source-control writer. Initial and regenerated titles invoke the service against the real worktree (`ThreadTitleRegenerationService.ts:184-245`), commit generation passes the real source-control cwd (`GitManager.ts:1618-1657`), and automatic worktree naming does likewise (`ThreadLaunchService.ts:178-213`). The title prompt explicitly tells the model to use available tools for linked-only context (`TextGenerationPrompts.ts:219-243`). Any resulting shell, edit, or delete tool call executes without main's ask boundary; the user message and diff content supplied to these prompts can also request or induce such a call.

**User impact:** A background title/branch generation or a commit/PR-copy request can modify or delete workspace files, run commands, or perform other agent actions even though the operation is presented as metadata generation. Explicitly disabling the SDK sandbox also overrides a user's configured Cursor sandbox for these calls.

**Minimal recommendation:** Restore an enforced non-writing boundary for Cursor text generation before using `Agent.prompt`. The installed SDK does not expose an Ask mode, and `sandboxOptions.enabled: true` maps to workspace read-write, so neither that flag nor an unverified switch to Plan should be treated as equivalent. Use a documented SDK text-only/read-only policy if one is added; otherwise retain a guarded metadata path or do not offer Cursor for these background generators. Add a behavioral integration test with a fake/local SDK runtime that attempts shell and file-write tools and proves they are denied; do not merely assert option shape.

### P1 — OpenCode Stop swallows descendant cleanup failures

**Current V2 evidence:** `apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.ts:2986-3069`.

- V2 first waits for `session.abort` on the root (`3013-3029`). It then describes descendant cleanup as best-effort (`3030-3033`).
- A failed `session.children` call is converted to `Option.none` (`3038-3043`), each child `session.abort` failure is ignored (`3049-3055`), and the whole traversal's 15-second timeout or failure is ignored (`3058-3059`). The outer `ProviderAdapterInterruptError` mapping therefore never sees any descendant cleanup failure.
- V2 also waits up to ten seconds for the root HTTP abort even when native session events have already acknowledged or completed cancellation (`3013-3029`).

**Main evidence:** commit `62d39bf00d` (`fix(server): stop OpenCode child sessions (#9005)`). At main, `apps/server/src/provider/Layers/OpenCodeAdapter.ts:707-774` walks all descendants and returns the first non-not-found list/abort failure. Its interrupt state machine at `2987-3122` races the HTTP request with native acknowledgment/completion and propagates a descendant failure or timeout unless the turn has independently completed.

**Reachable trigger:** An OpenCode turn has spawned a task child or grandchild and the user presses Stop while `session.children` or a child `session.abort` errors or hangs. A slow root abort request with a prompt native acknowledgment also reaches the avoidable delay.

**User impact:** T3 can acknowledge Stop while one or more OpenCode child sessions continue executing commands or modifying files. Failures leave no caller-visible indication. The root abort can also keep the Stop command pending for up to ten seconds after native cancellation is already known.

**Minimal recommendation:** Port main's cancellation state machine into V2: keep prompt-admission cancellation, race root abort against native acknowledgment/terminal completion, traverse descendants with the cycle guard and bounded concurrency, ignore only explicit not-found responses, and propagate the first other failure or timeout while the cancellation is still live. Add adapter tests for nested children, list failure, child-abort failure, timeout, and acknowledgment winning a pending HTTP request.

### P1 — External OpenCode work survives V2 session release

**Current V2 evidence:**

- An OpenCode session may connect to an external configured server at `apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.ts:882-902`.
- Its only explicit scope finalizer aborts the local SSE subscription controller at `apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.ts:2488-2496`. The only root/descendant `session.abort` calls in this adapter are inside `interruptTurn` at `3013-3059`; session release has no corresponding path.
- The V2 runtime interface has no close/teardown callback (`apps/server/src/orchestration-v2/ProviderAdapter.ts:470-535`). The manager releases sessions by closing the adapter scope (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:611-706`) for idle timeout, runtime error, manual shutdown, and server shutdown (`ProviderSessionManager.ts:47-52, 761-839, 1361-1389, 1555-1565`).
- Normal server shutdown calls `providerSessions.shutdown` before terminalizing durable work (`apps/server/src/serverRuntimeStartup.ts:386-402`). For an external OpenCode server, closing T3's scope only disconnects its event stream; there is no owned local child process whose teardown could stop the remote sessions.

**Main evidence:** the same main commit, `62d39bf00d`. Main implements `abortOpenCodeSessionForTeardown` at `apps/server/src/provider/Layers/OpenCodeAdapter.ts:776-787` and calls it from normal context stop at `828-860`. It explicitly aborts the parent, snapshots the child tree, and aborts descendants before closing local handles.

**Reachable trigger:** Use an OpenCode provider configured with `serverUrl`, start work, then shut down T3, manually close/detach the single-thread session, hit the idle-release path, or lose the V2 event stream without first completing a successful explicit interrupt.

**User impact:** T3 marks/releases the session and loses its event stream while the external OpenCode server can continue root or child work unseen. On shutdown this can leave commands and file writes running after the local UI/server has stopped.

**Minimal recommendation:** Add a provider-runtime teardown effect (or an OpenCode-specific scope finalizer) that best-effort aborts the root and the complete descendant tree before the SSE subscription is closed. Preserve strict failure reporting for explicit Stop, but time-box and log teardown failures. Cover external connections and all four manager release reasons in focused tests.

### P1 — V2 WebSocket snapshot fallbacks bypass the bounded history path

**Current V2 evidence:**

- The server advertises `threadSnapshotPagination`, but the V2 subscription input has no window/limit field (`apps/server/src/ws.ts:770-792`; `packages/contracts/src/orchestrationV2.ts:2430-2443`). Both a subscription without `afterSequence` and a resume rejected by the 128-event or 1 MiB replay limits call `snapshotThenLive` (`apps/server/src/ws.ts:829-922`; limits at `apps/server/src/orchestration-v2/ThreadStream.ts:1-50`). That function calls the unwindowed `getThreadSnapshot`, projects it, and emits it as one socket item (`ws.ts:860-884`).
- The call remains unwindowed through `ThreadManagementService` (`apps/server/src/orchestration-v2/ThreadManagementService.ts:413-423`). `ProjectionStore` consequently reads every turn item and all rows in each projection collection without a `LIMIT` when `window` is absent, and recursively does the same for inherited source-thread history (`apps/server/src/orchestration-v2/ProjectionStore.ts:2023-2030, 2146-2399, 2467-2589, 2601-2626`). The bounded SQL read is a separate API at `2628-2677`.
- Wire projection caps individual detail/dynamic values at 32 KiB/16 KiB, but maps every `turnItems` and `visibleTurnItems` entry; it does not cap collection cardinality (`apps/server/src/orchestration-v2/WireProjection.ts:7-99`). The bounded HTTP implementation instead budgets at most 75 timeline items and about 1 MiB, including the duplicate local-item cost across those two arrays (`apps/server/src/orchestration-v2/threadHistoryPaging.ts:9-16, 61-79, 420-496`).
- The current web and mobile runtimes both install the shared bounded HTTP loader. A healthy cold open therefore gets the intended bounded snapshot first. The loader has a six-second budget and deliberately returns `unavailable` on transient failure so the socket is used (`packages/client-runtime/src/state/boundedThreadSnapshotHttp.ts:23-65, 109-156`). When no projection was installed, the client subscribes without `afterSequence`; a warm cached projection skips HTTP and subscribes with its sequence (`packages/client-runtime/src/state/threads.ts:580-647`; the latter behavior is pinned at `threads-sync.test.ts:289-308, 472-507`). A received socket snapshot is installed as a full replacement and clears progressive-history metadata (`threads.ts:288-307`), so this is neither a dead nor control-plane-only fallback.

**Main evidence:** Main `#8992` (`7e460f429b`) bounds replay and falls back to a snapshot; `#9000` (`a9ffb827961`) adds bounded snapshot activity reads/projection. Crucially, current main's subscription contract accepts `turnLimit` and defines it as the fallback-snapshot window (`packages/contracts/src/orchestration.ts` at supplied main: `630-653`). The client always sends its ten-user-turn initial limit to pagination-capable servers specifically so a missing cursor or failed resume does not redownload the full thread (`packages/client-runtime/src/state/threads.ts` at supplied main: `43-50, 560-637`), and the server passes that limit into `getThreadDetailSnapshot` on the fallback path (`apps/server/src/ws.ts` at supplied main: `1525-1654`). Main `#9032` (`e86604d337`) avoids repeated full-message reads while streaming; it does not close or establish this snapshot bound and is not used as proof for the finding.

**Reachable trigger:** Either (1) open a thread with an empty client cache while the bounded HTTP request times out or fails transiently, or (2) reconnect/foreground a warm cached thread after more than 128 thread events or more than 1 MiB of encoded replay events accumulated. The first subscribes without a cursor; the second makes `decideThreadResume` choose snapshot. Both reach the same unwindowed snapshot call.

**User impact:** On a long-lived thread, the server queries and decodes every historical row across the projection tables (and inherited parent history), serializes the full projection, and sends it as one WebSocket snapshot. Work and payload size therefore grow with lifetime thread cardinality despite the advertised paginated path; remote clients are especially exposed when the bounded HTTP request is the part that failed. The client then loses its load-earlier cursor because it treats the socket result as complete. This audit proves the unbounded cardinality and reachable paths from source; it did not measure a percentage, frame size, or memory peak.

**Minimal recommendation:** Extend the V2 subscription with a pagination-capable fallback request, then build its socket snapshot through `getThreadSnapshotWindow` plus the existing bounded projection/budget logic and carry progressive-history metadata in the stream item. Preserve an explicit full fallback for legacy clients if needed. Add focused cases for a warm bounded cache whose gap exceeds 128 events and a cold loader-unavailable path; assert a bounded timeline, retained live control state, a usable history cursor, and the payload-budget signal rather than a timing percentage.

### P2 — Claude workspace image reads lose image-preview projection

**Current V2 evidence:**

- Claude's V2 tool classifier only permits `command_execution`, `file_change`, `dynamic_tool`, and `web_search`; `Read` is always `dynamic_tool` (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:1392-1447`).
- The actual tool-start caller has the parsed `toolInput` but calls `classifyClaudeNativeTool(input.toolName)` without it (`ClaudeAdapterV2.ts:3601-3630`). Artifact construction can consequently emit only those four item types (`ClaudeAdapterV2.ts:3001-3039`).
- V2 does retain the native Read input in the generic `dynamic_tool.input` field (`ClaudeAdapterV2.ts:3001-3039`; contract at `packages/contracts/src/orchestrationV2.ts:1069-1075`), so contract shape alone does not prove the preview is lost. The actual client projections do: web puts the input only in `toolData` and supplies neither `detail` nor `viewedImagePath` (`apps/web/src/session-logic.ts:591-597`), and mobile does the same (`apps/mobile/src/lib/threadActivity.ts:467-472`).
- The shared preview detector reads only an explicit `viewedImagePath` or a single-line `detail` on a Read entry; it never inspects `dynamic_tool.input` (`packages/client-runtime/src/work-log/presentation.ts:354-385`). Consequently the web renderer receives `null` at `MessagesTimeline.tsx:3275-3282` and cannot enter its image branch at `3378-3389`; mobile likewise receives `null` at `apps/mobile/src/features/threads/thread-work-log.tsx:651-665` and skips its image branch at `759-770`. The expanded inspector renders structured input/output JSON only (`apps/web/src/components/chat/V2ItemInspector.tsx:227-244`).

**Main evidence:** commit `d0b19b32e0` (`fix(claude): preview images read from the workspace (#9119)`). Main's `apps/server/src/provider/Layers/ClaudeAdapter.ts:717-727` recognizes only `Read`/`Read file` calls whose `file_path` or `path` passes `isWorkspaceImagePreviewPath`; `730-777` classifies them as `image_view`; `1188-1192` retains the path as display detail. Main's regression test at `apps/server/src/provider/Layers/ClaudeAdapter.test.ts:1438-1574` verifies the streamed Read input transitions from a generic start to `image_view` updates/completion carrying the image path.

**Reachable trigger:** Claude invokes its `Read` or `Read file` tool for a supported workspace image such as PNG, JPEG, GIF, or WebP.

**User impact:** V2 renders a generic Read tool row (and structured JSON when expanded) instead of main's inline workspace image preview on both web/desktop and mobile.

**Minimal recommendation:** A new turn-item variant is not required. On both client projections, recognize `dynamic_tool` names `Read` / `Read file`, extract `file_path` or `path` from `input`, validate it with the shared workspace-image predicate, and populate `viewedImagePath`; alternatively project the same explicit path server-side if maintainers want a provider-neutral contract field. Preserve the generic-start-to-image transition when streamed partial JSON reveals the path only later. Add the main streamed-input regression case plus web and mobile projection/render coverage.

## Prior-fix status

| Prior concern                                                        | Status at frozen HEAD | Evidence                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generic attachments for all providers                                | Preserved             | Shared path text is built by `AttachmentPrompt.ts:11-25`; Claude, Codex, Cursor, ACP/Grok, and OpenCode all call it on their actual prompt paths. Native image blocks remain additive where the provider supports them. The focused attachment/adapter tests passed. |
| Claude session-scoped permission suggestions                         | Preserved             | `ClaudeAdapterV2.ts:1894-1945` rewrites every suggested permission destination to `session` and synthesizes a whole-tool session rule if none was supplied.                                                                                                          |
| Claude pre-aborted approval/user-input signals                       | Preserved             | `ClaudeAdapterV2.ts:1948-1973` installs the listener and immediately observes `signal.aborted`; cancellation listeners are removed by the callback finalizer.                                                                                                        |
| Claude structured and multi-select questions in all permission modes | Preserved             | `AskUserQuestion` is handled before the permission-callback policy gate at `ClaudeAdapterV2.ts:4714-4807`; `canUseTool` is installed unconditionally at `5029-5031`. The full-access structured-question test passed.                                                |
| Claude plan/todo identity and lifecycle                              | Preserved             | Stable per-native-item IDs and latest-per-kind supersession live at `ClaudeAdapterV2.ts:2417-2420, 3468-3598`; the generic completion regression test passed.                                                                                                        |
| Claude compaction controls/resume                                    | Preserved             | `autoCompactWindow` and `resumeSessionAt` are compiled at `ClaudeAdapterV2.ts:730-753`; the resume dialog is projected through structured user input at `4882-4955`; resumed queries pass the native head at `4972-5031`.                                            |
| Claude/Codex token usage                                             | Preserved             | Claude emits root-assistant usage at `ClaudeAdapterV2.ts:4359-4387`; Codex retains its usage conversion and provider-turn updates. `ProviderTurnTokenUsage.test.ts` passed.                                                                                          |
| Claude subagent model propagation                                    | Preserved             | Pending assistant-snapshot models are retained until task registration and used by the subagent lifecycle; the ordering regression test (`keeps a subagent snapshot model that arrives before task_started`) passed.                                                 |
| OpenCode native message correlation                                  | Preserved             | Each initial/steer prompt receives a generated `admissionMessageId` (`OpenCodeAdapterV2.ts:2787-2845, 2929-2955`), and only the matching native user message advances admission (`2256-2266`).                                                                       |
| OpenCode pending initial/steer prompt cancellation                   | Preserved             | Initial and steer requests combine the SDK signal with a turn-owned abort controller; interrupt invalidates the generation and aborts it (`OpenCodeAdapterV2.ts:2787-2850, 2929-2965, 3000-3011`).                                                                   |
| OpenCode generation-owned status retry                               | Preserved             | Admission reconciliation checks turn identity and generation before every status request and adoption (`OpenCodeAdapterV2.ts:2017-2091`). Transient-retry, stale-generation, delayed-reply, and abort-winning-status tests passed.                                   |

## Current-main feature coverage

| Main provider change since the prior reviewed base            | V2 status                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude project/per-cwd skills (`bc918e74ac`, later `#9210`)   | Driver-side `snapshotForCwd` is present, and Claude's actual query path also resolves cwd skills. Covered, with the refresh caveat below.                                                                                                                             |
| Codex/OpenCode per-cwd skills (`80a14b6588`)                  | Driver `snapshotForCwd` implementations are present for both. Web requests cwd snapshots. Covered for the web entry path; execution-trigger refresh parity remains unverified.                                                                                        |
| Remote Claude model manifest (`0354283683`)                   | Shared driver/catalog path is used by V2. Covered.                                                                                                                                                                                                                    |
| OpenCode bounded version probes (`4116db9807`)                | Shared OpenCode runtime/driver path is used by V2. Covered.                                                                                                                                                                                                           |
| Removed custom models disappear (`941acb4f91`)                | Shared provider registry and client selection normalization apply to V2. Covered.                                                                                                                                                                                     |
| Grok health/model selection/Stop (`a434677eca`, `7880a6e583`) | V2 ACP flavor carries live model switching and Grok-specific interrupt/runtime-restart controls. Covered in the shared runtime path.                                                                                                                                  |
| Claude workspace image preview (`d0b19b32e0`)                 | **Missing; confirmed regression above.**                                                                                                                                                                                                                              |
| OpenCode child-session stop (`62d39bf00d`)                    | **Partial; explicit interrupt traversal exists, but failure semantics and release teardown are missing.**                                                                                                                                                             |
| Bounded V1 persisted-session lookup (`9a7b1e21e5`)            | Not directly applicable: V2 uses `ProviderSessionManagerV2`'s keyed live-session map and projection APIs rather than V1's ProviderService scan.                                                                                                                       |
| Provider-event leak/idle CPU fixes (`0bfb6df34b`)             | The OpenCode assistant merge change is present; other changes target V1 ingestion/logging or shared runtimes. No V2-specific regression found in this provider audit.                                                                                                 |
| Active tool-update frame coalescing (`7e4ce3bbb1`, `#8368`)   | No equivalent V2 thread-detail coalescer was found. This is a performance validation gap, detailed below; the audit did not reproduce or quantify the main PR's 90% reduction against V2.                                                                             |
| Bounded replay/snapshot work (`#8992`, `#9000`, `#9032`)      | **Partial.** V2 bounds replay and has a bounded HTTP snapshot, but its no-cursor and over-budget WebSocket fallbacks use the full-cardinality projection; confirmed regression above. `#9032` concerns streaming-message reads and was not treated as snapshot proof. |
| Cursor text-generation Ask guard (present at supplied main)   | **Missing after the intentional Cursor SDK migration; confirmed regression above.**                                                                                                                                                                                   |

Provider execution paths inspected: Claude Agent SDK; Codex app-server; Cursor Agent SDK; OpenCode SDK/SSE; Grok through the flavored ACP adapter; ACP Registry through the generic ACP adapter; provider driver creation, model/skill snapshot plumbing, session lifecycle, and the relevant orchestration V2 contracts.

## Intentional differences

- **Restart continuation is deliberately withheld in V2.** Main's `5b7d72aad1` / `#9167` keeps active V1 threads resumable across server restarts. The frozen HEAD's commit message explicitly says the server-side continuation markers were not ported because they live in the V1 session directory and V2 recovery terminalizes running runs. That matches `ProviderRuntimeRecoveryService.ts:130-190, 450-526`. I do not classify this as a regression without a V2 durability design.
- **Cursor uses the Cursor Agent SDK rather than main V1's ACP boundary.** Its orchestration capabilities intentionally advertise no live approvals/structured questions and no native fork/rollback (`CursorAdapterV2.ts:101-158`). I found no evidence that the chosen SDK boundary exposes equivalent interactive callbacks that V2 is silently dropping. This intentional D01/API-boundary change does not make unrestricted background text generation intentional; that separate loss is the confirmed finding above.
- **V2 session residency differs from V1.** The V1 persisted-session lookup optimization does not map one-for-one to V2's keyed in-memory manager. This is an architectural difference, not missing parity.

## Suspected or unverified cases

- **Execution-triggered per-cwd skill refresh:** main V1 refreshes the workspace provider snapshot both after starting a provider session and when reusing one (`ProviderCommandReactor.ts` at supplied main: `660-681, 712-740`). V2 has the registry RPC (`apps/server/src/ws.ts:1574-1587`) and web proactively requests a missing cwd snapshot (`apps/web/src/components/chat/ChatComposer.tsx:1143-1194`), but I found no equivalent refresh in V2 launch/run execution. Claude independently scans skills while forming its query, so execution is safe there; Codex/OpenCode slash-command discovery appears UI-facing. I did not find a reachable current-client failure, so this remains a parity/test gap rather than a confirmed regression.
- **Active-detail WebSocket coalescing/performance:** main commit `7e4ce3bbb1` adds a semantic, stable-tool-call coalescer with a 50 ms/512-event bound before V1 live thread-detail delivery (`ThreadLiveEventCoalescer.ts` at that commit: `13-14, 20-89, 91-205`; V1 `ws.ts:1499-1513`). The V2 thread subscription maps every stored event directly to a wire event at `apps/server/src/ws.ts:807-827` and uses that same uncoalesced stream for live delivery at `883, 918`. The grouped/coalesced V2 streams at `ws.ts:1001-1026, 1181-1190` are shell/archive paths, not active thread detail. Static provider paths can generate repeated full-state events: Cursor sends a node plus turn-item update on every shell-output delta (`CursorAdapterV2.ts:1094-1102, 1838-1847`), ACP/Grok reprojects tool state for every native tool-call update (`AcpAdapterV2.ts:2604-2613, 3693-3701`), and OpenCode reprojects every tool `message.part.updated` (`OpenCodeAdapterV2.ts:2270-2295`). Codex assistant text has its own adapter coalescer, but each `item/plan/delta` emits full node, plan, and turn-item events (`CodexAdapterV2.ts:3171-3205`). This establishes exposure to chatty frames, not a measured regression: V2 event shapes, persistence, client reduction, and provider fixture rates differ from V1, and main's coalescer targeted `tool.updated`, not plan deltas. Add an integrated V2 stream test using a burst of stable tool updates plus an interleaved boundary, and record frame/byte counts on checked-in provider replays before assigning severity or claiming the main PR's 90% figure. Any fix should coalesce only wire delivery, retain persisted events, key by turn plus stable item identity, and preserve sequence/completion-marker semantics.

## Known-main bugs

None identified in the provider behaviors used as comparison evidence. The five findings above are branch omissions or weaker semantics, not defects inherited unchanged from main.

## Verification and gaps

- Read `AGENTS.md` and `.repos/effect-smol/LLMS.md` before assessing Effect scopes, finalizers, races, and error handling.
- Verified the exact frozen HEAD, supplied main ancestry, and 332-commit count before and after inspection.
- Ran:

  ```text
  vp test run \
    apps/server/src/orchestration-v2/AttachmentPrompt.test.ts \
    apps/server/src/orchestration-v2/ProviderTurnTokenUsage.test.ts \
    apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts \
    apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.test.ts
  ```

  Result: 4 files passed, 96 tests passed.

- Ran the bounded follow-up suite for the Cursor SDK wrapper and the web/mobile work-log projections:

  ```text
  vp test run \
    apps/server/src/textGeneration/CursorTextGeneration.test.ts \
    packages/client-runtime/src/work-log/presentation.test.ts \
    apps/web/src/session-logic.test.ts \
    apps/mobile/src/lib/threadActivity.test.ts
  ```

  Result: 4 files passed, 81 tests passed. These tests confirm the current option and projection shapes; they do not attempt a live provider call or prove tool denial/image rendering, which is why the missing behavioral cases remain gaps below.

- Per instructions, no live provider, server, browser, external OpenCode server, or production state was used. SDK behavior was validated from checked-in types, testkits, full callers, current-main adapter tests, and the exact installed `@cursor/sdk@1.0.22` type declarations/runtime bundle.
- The focused suite has no Cursor text-generation tool-denial test, no V2 Claude workspace-image projection test, no OpenCode child-list/child-abort failure test, no external-server session-release test, and no V2 large-gap or HTTP-unavailable test asserting a bounded socket snapshot with progressive-history metadata. Those are the direct verification gaps behind the five recommendations.
- The final WebSocket snapshot check was source-only; no additional test was run because the existing fixtures stop at client subscription inputs or the pure replay decision and do not exercise the server fallback through client history installation.
- No focused V2 test currently demonstrates semantic coalescing or establishes a frame/byte budget for active tool-update or plan-delta bursts. No performance percentage was inferred from main's benchmark claim.
- No product or test source was edited. This report is the only file written by this audit.

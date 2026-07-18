# Repeated Steering And Reliable Stop

## Current Status

Branch maintenance snapshot for the 2026-07-18 upstream merge:

- Generated from `upstream/main` `1735e27d9e5106bbb35d5b1dd10363604a54b69e` with starting branch HEAD `0ac74996288ca44b1d400012235fa406c0ec51d4`. The merge commit is `195fbca66e408e03fc6f6ac8220e5b5c7430277d`; the previous upstream merge is `dd4549645d8545e2c566560470f00be69bb98f42`, whose upstream parent is `fdca15471d92e95e4ec5501f45dbf3ce81f8d991`.
- Shared refs at merge time: `origin/main` `2fe83d19ea2548dfaa7770aea29e5047d0b17b6e`, local `main` `cfbd1261caa08707987d2dfc2edc93caa0790d54`, and branch tracking ref `origin/fix/repeated-steering-and-stop` `6c08e813d7f5b18e339c0494bcd1a035f6d1ff70`.
- After the merge, conflict-resolution hardening, and this documentation refresh, the resulting branch is `14 ahead / 0 behind upstream/main`, `64 ahead / 505 behind origin/main`, `64 ahead / 517 behind local main`, and `55 ahead / 0 behind origin/fix/repeated-steering-and-stop`. The fork diff is `7 files changed, 402 insertions(+), 53 deletions(-)` against the `upstream/main` tree.
- The 50 incoming commits from `8a02c718619a9d4c6588d3ab7a89204023cfab62` through `1735e27d9e5106bbb35d5b1dd10363604a54b69e` add the draft landing hero, terminal selection copying, file-explorer mention actions, desktop release-note UI, mobile screenshot automation, refreshed branding, and Codex runtime model/effort instructions. They also improve active-turn sending, initial thread snapshot replay, deferred active-thread cache writes, timestamp validation/canonicalization, remote-environment cleanup, diff and terminal behavior, provider reliability, and source-control path handling.
- Customized-behavior impact: upstream's active-turn send fix acknowledged any changed latest user message. This branch still requires the projected id to equal the exact outbound steering id, so an unrelated user projection cannot release local busy state. Upstream's initial-snapshot replay, deferred active-thread cache writes, and timestamp hardening can change when that exact message becomes visible but complement rather than replace the correlation rule. Upstream did not add equivalent root/subagent interrupt routing or live Codex active-turn resolution, so no branch customization is retired.
- Conflict note for `apps/web/src/components/ChatView.logic.ts`, `apps/web/src/components/ChatView.logic.test.ts`, and `apps/web/src/components/ChatView.tsx`: the upstream latest-message-change acknowledgement and its weaker regression assertion were replaced by the existing exact-id correlation and consecutive-steer coverage. The new draft-hero dock transition and early in-flight guard were preserved, while `beginLocalDispatch` now waits until `newMessageId()` provides the exact expected id.
- Conflict note for `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts`: upstream's runtime model/effort instruction tests and imports were initially combined with the branch's live-turn lookup, ordering, timeout, and fallback tests. The branch-owned suite now lives in `apps/server/src/provider/Layers/CodexInterruptResolution.test.ts`, removing the concrete collision with continued upstream growth in the general runtime test file. `apps/server/src/provider/Layers/CodexSessionRuntime.ts` merged additively, retaining both the incoming developer-instruction behavior and branch-owned interrupt resolution.
- Validation note: the 50 focused steering/Codex interruption tests, `vp check`, repository typecheck, and mobile native static check pass; the extracted server pair specifically passes 28 tests. Playwright reached the authenticated draft hero and composer on ports `5738`/`13778`. The full repository run passed 4,782 tests and failed six tests in three incoming upstream test files; an isolated rerun cleared `server.test.ts` but retained three GitHub-selector timeouts in `GitManager.test.ts` and the ACP replay-idle timeout in `AcpJsonRpcConnection.test.ts`. None exercises a branch-primary customization file.
- Follow-up maintenance note: `hasServerAcknowledgedLocalDispatch` is already the branch's small, tested dispatch-correlation helper, so another client helper layer would not reduce the send-site conflict introduced by the upstream draft hero. An explicit server receipt keyed by message id would broaden contracts and runtime behavior without closing a demonstrated correctness gap; defer that protocol change unless projected ids stop being authoritative.

Running conversations allow users to send any number of steering prompts and stop the active agent at any time, including after one or more steers.

Expected behavior:

- A steering send remains locally busy only until the server projects that exact user-message id. Unrelated projected user messages must not acknowledge the dispatch, and steering the existing running turn must not wait for a new turn or session transition before re-enabling the composer.
- Root interruption commands retain the projected active turn id in orchestration events, but the provider command reactor intentionally lets the root Codex adapter resolve the authoritative active provider turn. Subagent interruption continues to target the selected child turn explicitly and must not fall back to a root turn.
- Codex root interruption reads the live provider thread with `includeTurns: true`, selects the most recently started `inProgress` turn, and bounds that lookup with a timeout. When either candidate lacks `startedAt`, provider response order is authoritative and the later entry wins. A failed lookup is logged and may fall back to the cached session turn; a successful lookup with no active turn returns without reviving a stale cached id.

Primary files:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.logic.ts`
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`

Regression coverage lives in `apps/web/src/components/ChatView.logic.test.ts` and `apps/server/src/provider/Layers/CodexInterruptResolution.test.ts`. Keep coverage for consecutive in-turn steers, exact-message acknowledgement, timestamp-based live-turn selection, lookup timeout/failure fallback, and successful empty reads that suppress stale interrupts.

## Development Ports

- Web: `5738`
- Server/WebSocket: `13778`

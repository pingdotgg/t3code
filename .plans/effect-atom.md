# Replace React Query With AtomRpc + Atom State

## Summary
- Use `effect/unstable/reactivity/AtomRpc` over the existing `WsRpcGroup`; stop wrapping RPC in promises via [wsRpcClient.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/wsRpcClient.ts) and [wsNativeApi.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/wsNativeApi.ts).
- Keep Zustand for orchestration read model and UI state.
- Keep a narrow `desktopBridge` adapter for dialogs, menus, external links, theme, and updater APIs.
- Do not introduce Suspense in this migration. Atom-backed hooks should keep returning `data`, `error`, `isLoading|isPending`, `refresh`, and `mutateAsync`-style surfaces so component churn stays low.

## Target Architecture
- Extract the websocket `RpcClient.Protocol` layer from [wsTransport.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/wsTransport.ts) into `rpc/protocol.ts`.
- Define one `AtomRpc.Service` for `WsRpcGroup` in `rpc/client.ts`.
- Add `rpc/invalidation.ts` with explicit scoped invalidation keys: `git:${cwd}`, `project:${cwd}`, `checkpoint:${threadId}`, `server-config`.
- Add `platform/desktopBridge.ts` as the only browser/desktop facade.
- Remove from web by the end: [wsNativeApi.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/wsNativeApi.ts), [nativeApi.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/nativeApi.ts), [wsNativeApiState.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/wsNativeApiState.ts), [wsNativeApiAtoms.tsx](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/wsNativeApiAtoms.tsx), [wsRpcClient.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/wsRpcClient.ts), and all `*ReactQuery.ts` modules.

## Phase 1: Infrastructure First
1. Extract the shared websocket RPC protocol layer from [wsTransport.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/wsTransport.ts) without changing behavior.
2. Build the AtomRpc client on top of that layer.
3. Add one temporary `runRpc` helper for imperative handlers that still want `Promise` ergonomics; it must call the AtomRpc service directly and must not reintroduce a facade object.
4. Replace manual registry wiring with one app-level registry provider based on `@effect/atom-react`.
5. Land this as a no-behavior-change PR.

## Phase 2: Replace `wsNativeApi`-Owned Push State
1. Migrate welcome/config/provider/settings state first, because it is already atom-shaped and is the lowest-risk way to delete `wsNativeApi` responsibilities.
2. Replace [wsNativeApiState.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/wsNativeApiState.ts) with `rpc/serverState.ts`, updated directly from `subscribeServerLifecycle` and `subscribeServerConfig`.
3. Keep the current hook names for one PR: `useServerConfig`, `useServerSettings`, `useServerProviders`, `useServerKeybindings`, `useServerWelcomeSubscription`, `useServerConfigUpdatedSubscription`.
4. Move bootstrap side effects out of [wsNativeApiAtoms.tsx](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/wsNativeApiAtoms.tsx) into a new root bootstrap component mounted from [__root.tsx](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/routes/__root.tsx).
5. Delete the `server.getConfig()` fallback logic from [wsNativeApi.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/wsNativeApi.ts); snapshot fetch now lives beside the stream atoms.

## Phase 3: Replace React Query Domain By Domain
1. Replace [gitReactQuery.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/lib/gitReactQuery.ts) first.
2. Add `rpc/gitAtoms.ts` and `rpc/useGit.ts` with `useGitStatus`, `useGitBranches`, `useResolvePullRequest`, and `useGitMutation`.
3. Mutation settlement must invalidate scoped keys, not a global cache. `checkout`, `pull`, `init`, `createWorktree`, `removeWorktree`, `preparePullRequestThread`, and stacked actions invalidate `git:${cwd}`. Worktree create/remove also invalidates `project:${cwd}`.
4. Replace [projectReactQuery.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/lib/projectReactQuery.ts) second. `useProjectSearchEntries` must preserve current “keep previous results while loading” behavior.
5. Replace [providerReactQuery.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/lib/providerReactQuery.ts) third. Preserve current checkpoint error normalization and retry/backoff semantics inside the atom effect. Invalidate by `checkpoint:${threadId}`.
6. Defer the desktop updater until the last phase.

## Phase 4: Move Root Invalidation Off `queryClient`
1. In [__root.tsx](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/routes/__root.tsx), remove `QueryClient` usage and replace the throttled `invalidateQueries` block with throttled invalidation helpers.
2. Keep Zustand orchestration/event application unchanged.
3. Map current effects exactly:
- git or checkpoint-affecting orchestration events touch `checkpoint:${threadId}`
- file creation/deletion/restoration touches `project:${cwd}`
- config-affecting server events touch `server-config`

## Phase 5: Remove Imperative `NativeApi` Usage
1. Create narrow modules instead of a replacement mega-facade:
- `rpc/orchestrationActions.ts`
- `rpc/terminalActions.ts`
- `rpc/gitActions.ts`
- `rpc/projectActions.ts`
- `platform/desktopBridge.ts`
2. Migrate direct [nativeApi.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/nativeApi.ts) callers by domain, not file-by-file: git-heavy components first, then orchestration/thread actions, then shell/dialog helpers.
3. After the last caller is gone, delete [nativeApi.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/nativeApi.ts) and the `window.nativeApi` fallback entirely.
4. In the final cleanup PR, remove `NativeApi` from [ipc.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/packages/contracts/src/ipc.ts) if nothing outside web still needs it.

## Phase 6: Remove React Query Completely
1. Delete `@tanstack/react-query` from `apps/web/package.json`.
2. Remove `QueryClientProvider` and router context from [router.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/router.ts) and [__root.tsx](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/routes/__root.tsx).
3. Replace [desktopUpdateReactQuery.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/lib/desktopUpdateReactQuery.ts) with a writable atom plus `desktopBridge.onUpdateState`.
4. Delete the old query-option tests.

## Public Interfaces And Types
- Preserve the current server-state hook names during the transition.
- Add permanent domain hooks: `useGitStatus`, `useGitBranches`, `useResolvePullRequest`, `useProjectSearchEntries`, `useCheckpointDiff`, `useDesktopUpdateState`.
- Do not expose raw AtomRpc clients to components.
- Do not add Suspense as part of this migration.
- Final boundary is direct RPC for server features plus `desktopBridge` for local desktop features.

## Test Plan
- Add unit tests for `rpc/serverState.ts`: snapshot bootstrapping, stream replay, provider/settings updates.
- Add unit tests for git/project/checkpoint hooks: loading, error mapping, retry behavior, invalidation, keep-previous-result behavior.
- Update the browser harness in [wsRpcHarness.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/test/wsRpcHarness.ts) to assert direct RPC + atom behavior instead of `__resetNativeApiForTests`.
- Replace [wsNativeApi.test.ts](/Users/julius/.t3/worktrees/codething-mvp/effect-http-router/apps/web/src/wsNativeApi.test.ts), `gitReactQuery.test.ts`, `providerReactQuery.test.ts`, and `desktopUpdateReactQuery.test.ts` with equivalent atom-backed coverage.
- Acceptance scenarios:
- welcome still bootstraps snapshot and navigation
- keybindings toast still responds to config stream updates
- git status/branches refresh after checkout/pull/worktree actions
- PR resolve dialog keeps cached result while typing
- `@` path search refreshes after file mutations and orchestration events
- diff panel refreshes when checkpoints arrive
- desktop updater still reflects push events and button actions

## Assumptions And Defaults
- Zustand stays in scope; only `react-query` is being removed.
- `desktopBridge` remains the only non-RPC boundary.
- The migration lands as 5-6 small PRs, each green independently.
- Invalidations are explicit and scoped; do not recreate a global cache client abstraction.
- Orchestration recovery/order logic stays as-is; only the data-fetching and mutation layer changes.

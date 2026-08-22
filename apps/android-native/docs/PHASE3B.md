# Phase 3B — Git operations

## Goal

Let a user inspect and operate on a thread's effective Git workspace without leaving the native Android app, while keeping the server authoritative for repository and environment state.

## Capability matrix

| Journey                 | Server contract                   | Android behavior                                                                |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| Observe status          | `subscribeVcsStatus`              | Reduces split local/remote events for the thread worktree or project root       |
| Refresh status          | `vcs.refreshStatus`               | Reconciles the screen with a fresh server result                                |
| Commit selected files   | `git.runStackedAction`            | Selects changed files, accepts an optional message, and shows streamed progress |
| Pull                    | `vcs.pull`                        | Pulls only when the branch is safely behind and reports the result              |
| Push / create PR        | `git.runStackedAction`            | Uses the server workflow and exposes the resulting PR link                      |
| List branches/worktrees | `vcs.listRefs`                    | Shows local refs, the current/default branch, and attached worktree paths       |
| Create or switch branch | `vcs.createRef` / `vcs.switchRef` | Updates the thread Git context and immediately refreshes status and refs        |
| Create worktree         | `vcs.createWorktree`              | Creates a branch-backed worktree and moves the thread context to it             |

Status stream events use the current `_tag` discriminator. The decoder also accepts the older `kind` spelling so remote environments on either wire shape remain usable. Branch mutations already perform an immediate status and refs refresh; live stream updates keep both Git screens synchronized afterward.

## Entry points and safety

- Thread toolbar: current branch label or Git
- Git overview: primary contextual action, commit, pull/push/PR, branches and worktrees
- Commit screen: explicit Commit or New branch choice

Push and pull-request actions on the default branch require confirmation and offer a feature-branch path. Mutations are single-flight. A dropped stacked-action stream is not retried because the server may already have committed or pushed; the client refreshes status instead.

## Verification

Focused local gate:

```bash
./gradlew :protocol:test :app:testDebugUnitTest :app:compileDebugAndroidTestKotlin :app:assembleDebug
```

The opt-in Android protocol integration accepts `pairingUrl` and `gitCwd` instrumentation arguments and verifies status against a disposable Git repository.

Manual acceptance on a connected Android device covers clean and dirty status, refresh, commit, default-branch confirmation, push, pull from a remote-ahead fixture, branch creation/switching, and the shared branches/worktrees view. Pull-request creation requires an explicitly disposable hosted repository and is not performed against a contributor remote.

Environment replacement was also verified against a disposable server: an invalid old bearer requested re-pairing, successful pairing at the same endpoint removed the stale environment/cache, and the fresh server shell replaced cached threads.

## Boundaries

Phase 3B does not add Git initialization, worktree deletion, force push/reset, terminal sessions, review UI, file writes, or attachment picker/upload. T3 Connect remains externally blocked by production administrator approval and is not a Phase 3B gate. Performance measurement remains deferred until all Phase 3 slices are complete.

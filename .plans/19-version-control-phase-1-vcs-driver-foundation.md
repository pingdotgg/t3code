# Version Control Phase 1: VCS Driver Foundation

## Goal

Introduce a provider-neutral VCS layer and rewrite the local Git implementation as an Effect-native driver. This phase should preserve user-visible behavior while replacing the Git-first service boundary with an abstraction that can support Git, Jujutsu, and later Sapling or another viable VCS.

The existing `GitCore` implementation is a behavior reference and source of regression tests, not the target architecture. New code should follow the newer package style used by `effect-acp` and `effect-codex-app-server`: typed service tags, schema-backed tagged errors, scoped process usage, explicit decode boundaries, and no Promise-based process helper as the core execution primitive.

## Scope

- Add VCS-domain contracts in `packages/contracts/src/vcs.ts`.
- Add shared runtime parsing helpers in `packages/shared/src/vcs/*` only when they are useful to both server and web.
- Add server services under `apps/server/src/vcs`:
  - `Services/VcsDriver.ts`
  - `Services/VcsRepositoryResolver.ts`
  - `Services/VcsProcess.ts`
  - `Layers/GitVcsDriver.ts`
  - `errors.ts`
- Migrate server callers from Git-specific terms where the operation is actually VCS-generic.
- Update active consumers to the new VCS APIs in the same phase; do not add backwards-compatible export shims.
- Leave source-control hosting providers out of this phase except for remote metadata needed to describe repository status.

## Non-Goals

- No GitLab, Azure DevOps, or GitHub provider rewrite yet.
- No Jujutsu driver yet, but every interface must be designed so a Jujutsu driver does not have to pretend to be Git.
- No T3 Review implementation yet.
- No broad UI redesign.

## Driver Model

Use provider-neutral nouns in new APIs:

- `VcsDriver`: local repository mechanics.
- `RepositoryIdentity`: detected VCS kind, root path, common metadata path when available, remotes.
- `WorkingCopyStatus`: dirty state, changed files, aggregate insertions/deletions, current branch/bookmark/change name.
- `ChangeSet`: a committed or pending unit of change, not necessarily a Git commit.
- `RefName`: branch, bookmark, tag, or provider-specific ref.

The initial driver capabilities should be explicit:

```ts
export interface VcsDriverCapabilities {
  readonly kind: "git" | "jj" | "sapling" | "unknown";
  readonly supportsWorktrees: boolean;
  readonly supportsBookmarks: boolean;
  readonly supportsAtomicSnapshot: boolean;
  readonly supportsPushDefaultRemote: boolean;
}
```

Do not model Jujutsu as `GitCoreShape extends ...`. The Git driver can expose Git-specific implementation details internally, but the public VCS layer should describe operations by intent:

- `detectRepository(cwd)`
- `status(cwd, options)`
- `listRefs(cwd, query/pagination)`
- `checkoutRef(cwd, ref)`
- `createRef(cwd, ref, from?)`
- `createWorkspace(cwd, ref, path?)`
- `removeWorkspace(path)`
- `prepareChangeContext(cwd, filePaths?)`
- `createChange(cwd, message, options)`
- `push(cwd, target?)`
- `rangeContext(cwd, base, head)`
- `listWorkspaceFiles(cwd, options)`

## Effect Process Layer

Create a small reusable `VcsProcess` service instead of using `runProcess`.

Requirements:

- Implement with `ChildProcess` and `ChildProcessSpawner` from `effect/unstable/process`.
- Support scoped acquisition/release for long-running commands and interruption.
- Support bounded stdout/stderr collection with truncation markers.
  - DO not eagerly consume full stdout/stderr, return stream apis and expose helpers for consumers so we don't consume streams to memory unnecessarily...
- Support stdin.
- Support timeout through Effect scheduling/interruption, not ad-hoc timers.
- Stream output lines to progress callbacks as Effects.
- Return a typed `ProcessOutput` value for successful execution.
- Fail with typed errors, not generic thrown exceptions.

Errors should be schema-backed tagged classes, for example:

- `VcsProcessSpawnError`
- `VcsProcessExitError`
- `VcsProcessTimeoutError`
- `VcsOutputDecodeError`
- `VcsRepositoryDetectionError`
- `VcsUnsupportedOperationError`

Every error should carry operation name, command display string, cwd when applicable, exit code when applicable, stderr/stdout tails when useful, and original cause where available. Override `message` for user readable messages that provides meaning and hints where appropriate. Errors are schema backed so the full error details will be persisted and serialized properly when stored to DB/Logfiles.

## Git Driver Rewrite

Rewrite Git support against `VcsProcess`.

Carry forward current behavior from:

- `apps/server/src/git/Layers/GitCore.ts`
- `apps/server/src/git/Layers/GitCore.test.ts`
- current Git status/branch/worktree contracts

But split the implementation into smaller modules:

- command execution and hardening config
- repository detection
- status parsing
- branch/ref parsing
- worktree operations
- commit/range context generation
- push/pull operations

Keep parsing deterministic. Prefer Git porcelain formats, null-separated output, and schema decoding for JSON-like command output. Avoid regex parsing where Git gives a structured format.

## Freshness and Local Caching

Define freshness rules in the VCS layer before adding more providers. Local VCS status is cheap enough to refresh often; network-backed status is not.

Treat these as live/local:

- repository detection for the active cwd
- working copy dirty state
- staged/unstaged/untracked file summaries
- current branch/bookmark/change name
- local branch/bookmark lists
- local worktree/workspace lists

These may run on user-visible polling, but should still be debounced and coalesced per repository root. Prefer filesystem-triggered invalidation where available, with a short fallback poll interval. Concurrent requests for the same repository/status shape should share one in-flight Effect.

Treat these as cached or explicit-refresh only:

- remote tracking branch refreshes
- ahead/behind counts that require network fetches
- default branch discovery from a remote provider
- remote branch lists beyond locally known refs

The VCS driver should expose freshness metadata with status results:

```ts
export interface VcsFreshness {
  readonly source: "live-local" | "cached-local" | "cached-remote" | "explicit-remote";
  readonly observedAt: string;
  readonly expiresAt?: string;
}
```

Remote refreshes should be opt-in per operation, for example `refresh: "local-only" | "allow-cached-remote" | "force-remote"`. The default for background status should be `local-only`.

Use Effect `Cache` for repository identity and expensive local metadata:

- key by resolved repository root plus VCS kind
- invalidate on cwd/root changes and workspace mutation operations
- use short TTLs for local status caches when filesystem events are unavailable
- never hide command failures behind stale values unless the caller explicitly accepts stale data

## Cutover Policy

Prefer direct migration and deletion over compatibility wrappers.

Rules:

- Update consumers to call `VcsDriver`/`VcsRepositoryResolver` directly as soon as the new API exists.
- Delete migrated `GitCore` service methods and tests in the same PR that moves their consumers.
- Do not keep backwards-compatible export shims, barrel aliases, or old service names for convenience.
- Transitional modules are allowed only when a caller group is too complex or risky to migrate in the same PR.
- Every transitional module must have a narrow owner, a removal checklist, and a test proving it delegates to the new implementation.
- No new feature work may depend on transitional modules.

Expected transitional candidates:

- The highest-level `GitManager` orchestration can be migrated in slices if doing the full Commit + PR flow in one PR is too risky.
- WebSocket payload compatibility can remain only where changing it would require a coordinated UI/server protocol migration. Internal server code should still use the new VCS contracts.

## Tests

Add integration-style tests with real temporary Git repositories for the new Git driver:

- non-repository detection
- status for clean/dirty/untracked/staged states
- branch/ref list with pagination
- checkout/create branch
- worktree create/remove
- commit context generation with file filters
- commit creation with hook progress events
- push behavior against a local bare remote
- status polling does not perform remote network refresh by default
- concurrent duplicate status requests are coalesced
- bounded output/truncation
- timeout/interruption
- typed error shape for command failure and missing executable

Move or duplicate only the tests needed to prove behavior, then delete the old service tests in the same migration slice.

## Migration Steps

1. Add `vcs` contracts and tagged errors.
2. Add `VcsProcess` and unit tests around process execution semantics.
3. Add `VcsDriver` and `VcsRepositoryResolver` service contracts.
4. Implement `GitVcsDriver` with real Git command integration tests.
5. Move `GitStatusBroadcaster` and branch/worktree flows to the VCS service directly.
6. Move commit/range/push callers to the VCS service directly.
7. Delete migrated `GitCore` internals and tests as each caller group moves.
8. Add a transitional adapter only for any remaining `GitManager` path that is explicitly too complex to cut over safely in one PR.
9. Remove every transitional adapter before starting Phase 2 unless the adapter is documented as blocking on the provider cutover.

## Acceptance Criteria

- Current Git branch/status/worktree/commit behavior remains intact.
- New Git implementation does not depend on `processRunner.ts`.
- New errors are typed and inspectable by tests.
- VCS interfaces contain no GitHub/GitLab/Azure concepts.
- Active consumers use the new VCS APIs directly; any remaining transitional module has a written removal checklist and no compatibility export shim.
- Background status refresh is local-only by default and cannot hit provider rate limits.
- Jujutsu can be added by implementing a real driver instead of conforming to Git command semantics.
- `bun fmt`, `bun lint`, and `bun typecheck` pass.

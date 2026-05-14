# Version Control Phase 2: Source Control Provider Foundation

## Goal

Introduce a pluggable source-control provider layer and rewrite GitHub support as an Effect-native provider. This phase should preserve the existing GitHub Commit + PR flow while making GitLab and Azure DevOps additive drivers rather than branches inside GitHub-oriented code.

The existing `GitHubCli` service and GitHub-specific `GitManager` paths are behavior references. The new provider layer should use detailed tagged errors, schema decode boundaries, `effect/unstable/process`, capability flags, and provider-neutral change-request types.

## Scope

- Add provider-domain contracts in `packages/contracts/src/sourceControl.ts`.
- Add provider URL/reference parsing helpers in `packages/shared/src/sourceControl/*`.
- Add server services under `apps/server/src/sourceControl`:
  - `Services/SourceControlProvider.ts`
  - `Services/SourceControlProviderRegistry.ts`
  - `Services/SourceControlProcess.ts`
  - `Layers/GitHubSourceControlProvider.ts`
  - `errors.ts`
- Migrate PR creation, PR lookup, default-branch lookup, clone URL lookup, and PR checkout through the provider layer.
- Update active consumers to the provider APIs directly; do not add backwards-compatible `GitHubCli` export shims.
- Keep GitHub as the only production provider at the end of this phase, but make GitLab and Azure implementation paths obvious and bounded.

## Non-Goals

- No GitLab implementation in this phase, except fixtures/contracts that prove the abstraction can represent merge requests.
- No Azure DevOps implementation in this phase, except URL/reference parser test cases if cheap.
- No in-app review UI yet.
- No hard dependency on one CLI forever. The first GitHub driver may use `gh`, but the interface should support REST/GraphQL implementations later.

## Provider Model

Use provider-neutral names:

- `SourceControlProvider`: hosted repository and change-request mechanics.
- `ChangeRequest`: GitHub pull request, GitLab merge request, Azure pull request.
- `ChangeRequestThread`: review or discussion thread.
- `ChangeRequestComment`: top-level or inline comment.
- `ProviderRepository`: owner/project/repo identity plus clone URLs.

Core provider operations:

- `detectRemote(remoteUrl)`
- `checkAuth(cwd)`
- `getRepository(cwd | remoteUrl)`
- `getDefaultTargetRef(repository)`
- `listChangeRequests(repository, filters)`
- `getChangeRequest(repository, reference)`
- `createChangeRequest(repository, input)`
- `checkoutChangeRequest(cwd, changeRequest, options)`
- `getCloneUrls(repository)`

Review-facing operations should be designed now, even if unimplemented:

- `listReviewThreads(changeRequest)`
- `createReviewComment(changeRequest, input)`
- `replyToReviewThread(thread, input)`
- `resolveReviewThread(thread)`
- `submitReview(changeRequest, input)`

Each operation should be guarded by capabilities:

```ts
export interface SourceControlProviderCapabilities {
  readonly kind: "github" | "gitlab" | "azure-devops" | "unknown";
  readonly supportsCreateChangeRequest: boolean;
  readonly supportsCheckoutChangeRequest: boolean;
  readonly supportsReviewThreads: boolean;
  readonly supportsInlineComments: boolean;
  readonly supportsDraftChangeRequests: boolean;
}
```

## Provider Registry

Add a registry that resolves a provider from repository remotes and explicit user input.

Rules:

- Detection should be pure where possible and testable without spawning CLIs.
- Remote URL parsing belongs in `packages/shared`, not server-only provider layers.
- Unknown providers should return explicit unsupported-operation errors, not silently fall back to GitHub.
- Provider selection should be stable per operation and logged with enough context to debug bad remote detection.

The registry should support multiple provider implementations at runtime, not a single dispatcher file with inline provider branches.

## Rate Limits and Provider Caching

Design the provider layer around a strict freshness budget. Provider API and CLI calls must not be part of frequent background polling unless the operation is explicitly marked safe and cached.

Default behavior:

- Pure URL/remote parsing is always live because it is local.
- Provider detection from local remotes is live-local.
- Authentication checks are cached.
- Repository metadata is cached.
- Default branch metadata is cached.
- Change-request lists are cached and refreshed on explicit user actions or coarse intervals.
- Full review threads, comments, file diffs, and timeline data are fetched only when the user opens the relevant review surface or explicitly refreshes it.
- Create/update operations invalidate affected cache keys immediately after success.

The provider API should make freshness explicit:

```ts
export interface SourceControlFreshness {
  readonly source: "live-local" | "cached-provider" | "live-provider";
  readonly observedAt: string;
  readonly expiresAt?: string;
  readonly stale?: boolean;
}

export type ProviderRefreshPolicy =
  | "cache-first"
  | "stale-while-revalidate"
  | "force-refresh"
  | "local-only";
```

Every read operation that can touch a provider should accept a refresh policy. Background UI reads should default to `cache-first` or `stale-while-revalidate`; direct user actions like pressing refresh can use `force-refresh`.

Use Effect `Cache` for provider data:

- auth status: key by provider kind, hostname, workspace identity, and account if known; TTL around minutes, not seconds
- repository metadata/default branch: key by provider repository stable ID or normalized remote URL; TTL around tens of minutes
- change-request summary lists: key by provider repository, state/filter, source ref, target ref; short TTL with stale-while-revalidate
- individual change-request summaries: key by provider repository and provider CR ID; short TTL, invalidated after create/update/comment operations
- review threads/comments/diffs: key by provider CR ID and head SHA/version when available; fetch on demand for T3 Review

Provider drivers should surface rate-limit signals when available:

- remaining quota
- reset time
- retry-after duration
- whether the limit is primary, secondary/abuse, or unknown

Rate-limit errors should be typed, retryable when the provider gives a reset/retry time, and visible enough for the UI to avoid repeatedly retrying a blocked operation.

Avoid rate-limit footguns:

- no provider calls from render loops or fast status polling
- no listing all PRs/MRs across all repos to infer one branch state
- no silent GitHub fallback for unknown providers
- no unbounded cache cardinality for branch names or free-form search queries
- no per-thread duplicate provider refresh when multiple views observe the same repository

## GitHub Provider Rewrite

Rewrite GitHub support as `GitHubSourceControlProvider`.

Carry forward behavior from:

- `apps/server/src/git/Layers/GitHubCli.ts`
- `apps/server/src/git/Layers/GitHubCli.test.ts`
- `apps/server/src/git/githubPullRequests.ts`
- GitHub-specific `GitManager` PR paths

Implementation requirements:

- Use `SourceControlProcess` built on `effect/unstable/process`, not `runProcess`.
- Decode `gh api` and `gh pr --json` responses with Effect Schema.
- Use typed errors for auth failure, missing CLI, command failure, output decode failure, unsupported reference, and provider mismatch.
- Keep stdout/stderr bounded.
- Avoid global mutable auth caches unless they are Effect `Cache` values with explicit keys, TTLs, and invalidation behavior.
- Parse provider rate-limit headers or CLI/API error payloads when available and map them to typed rate-limit errors.
- Keep GitHub nouns inside the GitHub driver; convert to `ChangeRequest` at the provider boundary.

## GitManager Cutover

Refactor `GitManager` so it coordinates three independent services:

- `VcsDriver` for local repository mechanics.
- `SourceControlProviderRegistry` for hosted provider selection.
- `TextGeneration` for message/body generation.

`GitManager` should stop depending directly on GitHub services. User-visible step labels should be provider-neutral unless the selected provider is known and the label is intentionally provider-specific.

The Commit + PR flow should become:

1. Resolve VCS repository and local status.
2. Resolve source-control provider from remotes.
3. Generate commit content through the existing text generation service.
4. Create local change through `VcsDriver`.
5. Push through `VcsDriver` or a narrow provider push helper only if the VCS requires provider-specific target syntax.
6. Generate change-request title/body.
7. Create the change request through `SourceControlProvider`.

## Cutover Policy

This phase should aggressively remove old GitHub-specific internals.

Rules:

- Move each active consumer directly to `SourceControlProviderRegistry` or a concrete provider test layer.
- Delete migrated `GitHubCli` methods, tests, and GitHub-specific helper exports in the same PR that moves their final consumer.
- Do not add compatibility export shims from `apps/server/src/git` to `apps/server/src/sourceControl`.
- Transitional modules are allowed only for a bounded `GitManager` slice that cannot move safely with the rest of the provider cutover.
- Every transitional module must have an owner comment, a removal checklist, and no public exports consumed by new code.
- Provider-neutral web parsing should replace GitHub-only parsing directly; do not keep parallel parser stacks unless a route still requires both during a single PR.

## GitLab and Azure Readiness

Use the triaged references as implementation inputs, not merge targets:

- GitLab PR #592 is useful for `glab mr` command mapping and JSON normalization.
- Azure issue #1138 defines a good first Azure slice: remote/URL detection and change-request thread setup for same-repo URLs.

The abstraction should let Phase 3 add:

- `GitLabSourceControlProvider` using `glab`.
- `AzureDevOpsSourceControlProvider` using `az repos pr` or REST APIs.

No provider should need to edit GitHub code to join the registry.

## T3 Review Design Constraint

Do not optimize only for creation/checkout. The provider layer must be able to support a future in-app review surface.

That means contracts should include stable IDs and enough metadata for:

- file-level diffs
- inline review threads
- resolved/unresolved state
- top-level discussion comments
- pending review submission
- provider URL back-links

Provider-specific fields can live in a metadata bag, but core review behavior should not require the UI to know whether the backing service is GitHub, GitLab, or Azure DevOps.

## Tests

Add tests at three levels:

- Pure parser tests for GitHub, GitLab, and Azure remote URLs and change-request references.
- Provider unit tests with fake `SourceControlProcess` output and schema decode failures.
- Integration-style GitHub CLI tests only where they can run hermetically or be skipped without hiding unit coverage.

Required cases:

- GitHub PR URL, number, and branch-ish references.
- GitLab MR URL/reference parsing.
- Azure DevOps PR URL parsing for same-repo URLs.
- unknown provider returns unsupported-operation errors.
- missing CLI and auth failures produce distinct typed errors.
- invalid CLI JSON fails at decode boundary with useful context.

## Migration Steps

1. Add `sourceControl` contracts and provider-neutral schemas.
2. Add shared remote/reference parser helpers and tests.
3. Add `SourceControlProcess` and provider errors.
4. Add provider registry with GitHub-only registration.
5. Implement `GitHubSourceControlProvider` from scratch against the new process layer.
6. Cut GitHub PR operations in `GitManager` over to the provider registry.
7. Replace web PR-reference parsing with provider-neutral parser output while keeping current GitHub UX.
8. Add provider cache metrics and tests for cache hit, stale refresh, invalidation, and rate-limit error mapping.
9. Delete the migrated `GitHubCli` implementation, tests, and GitHub-specific helper exports unless an explicit transitional checklist remains.

## Acceptance Criteria

- Existing GitHub Commit + PR and PR checkout flows still work.
- `GitManager` no longer imports or depends on `GitHubCli`.
- Active consumers use source-control provider APIs directly; any remaining transitional module has a written removal checklist and no compatibility export shim.
- Source-control contracts can represent GitHub PRs, GitLab MRs, and Azure DevOps PRs.
- Unknown/unsupported providers fail explicitly and visibly.
- GitHub command execution does not depend on `processRunner.ts`.
- Background provider reads are cached/coalesced and do not consume provider API quota on every status refresh.
- Rate-limit responses become typed errors with retry/reset metadata where available.
- The provider API includes the review operations needed by future T3 Review work, even if they are capability-gated.
- `bun fmt`, `bun lint`, and `bun typecheck` pass.

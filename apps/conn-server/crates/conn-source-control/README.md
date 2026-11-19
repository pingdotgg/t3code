# conn-source-control

GitHub source control for the Conn Server. We use the same CLI calls, credentials and API
requests as the T3 server's GitHub driver. Conn supports only GitHub (`FORK.md`, "Upstream
scope", Nick's decision of 2026-11-16). Other hosts read as unknown git remotes: their host,
base URL and normal git repository key are kept; no host-specific discovery or API runs.

The specification is `packages/source-control-core`, `packages/source-control-github` and
`apps/server/src/{sourceControl,pullRequest,git}` in the Conn monorepo.

## What is served now

| Area | State |
| --- | --- |
| `server.discoverSourceControl` | Served: `git`, `jj` (from `conn-vcs`) and GitHub (see "Discovery") |
| `sourceControl.*` (9) | All 9 served: `signInStart`, `signInWait`, `signInCancel`, `appAccess` (as a T3 server without `T3CODE_GITHUB_APP_CLIENT_ID`), `starred`, `star` (GitHub REST, any other host `false`); `lookupRepository`, `cloneRepository`, `publishRepository` for GitHub (see "Repositories") |
| The host definition registry | Built (part 4): remotes, change request URLs, canonical keys, the project predicates, thread link keys (see "Registry") |
| Provider detection | Built (part 4), not yet called by a method (see "Provider detection") |
| GitHub's GraphQL operations | Generated from the monorepo; panel reads, viewed-file mutations and PR resolution send them. |
| `git.*` (3) | GitHub PR resolution and checkout; commit-only stacked actions in `conn-server` |
| `pr` in VCS status | Not served (always `null`) |
| `pullRequests.*` (35) | GitHub panel reads and writes, including stacks and stored guides. `runAction` and `generateReviewGuide` register typed refusals; those operations are unavailable. |
| Engine commands for linked pull requests (7) | `thread.pull-request.link` and `unlink` as T3's decider (part 4); the other 5 refused |
| `/mcp` pull request tools (9) | 8 served: the 5 link tools, `watch`/`unwatch_pull_request`, `read_pull_request_guide`; `write_pull_request_guides` not served (no guide generator) |

## Modules

| Module | Holds |
| --- | --- |
| `checkout.rs` | GitHub PR resolution, local checkout and worktree reuse |
| `secret.rs` | `Secret`: a token with a redacted `Debug` and `Display` |
| `http.rs` | One HTTPS request per connection (hyper + rustls), bounded answer, local fake server for tests |
| `settings.rs` | GitHub's saved fields (`hosts`, `tokens`, `signIns`), secret references |
| `discovery.rs` | The generic CLI probe (`probeSourceControlProvider`), the auth text helpers, a stub executable for tests |
| `cli.rs` | A host CLI call outside discovery, as `VcsProcess.run` runs it (30 s, 1,000,000 bytes) |
| `remote.rs` | Clone URL and remote text: `cloneUrl.ts`, `parseGitRemoteRepository`, `repositoryKeyFromRemote`, the redaction helpers |
| `repository.rs` | `SourceControlRepositoryService`: lookup, clone (its own `git clone` child), publish (`ensureRemote`, push, upstream) |
| `hosts/github.rs` | GitHub discovery, credentials and REST requests |
| `hosts/repositories.rs` | GitHub's `getRepositoryCloneUrls` and `createRepository` (`Hosts`) |
| `hosts/github_graphql/` | GitHub's GraphQL operations: `generated.rs` (by `tools/gen-graphql.mjs`) and the batch renderer |
| `registry/` | The host definition registry (`mod.rs`), its URL routes (`paths.rs`), thread link keys (`thread_keys.rs`) |
| `detect.rs` | Provider detection: the checkout's remotes, the recognised context, unknown hosts refined |
| `cache.rs` | `TtlCache`: bounded, one shared lookup per key, a time to live per answer (Effect's `Cache`) |
| `pull_requests/watch.rs` | A watch's evaluation and wake texts (`pullRequestWatch.ts`); `tools/pr-watch-diff.mjs` runs T3's functions and ours on the same cases |

## Sign-in and stars

The GitHub App sign-in is not built, so these answer as a T3 server started without
`T3CODE_GITHUB_APP_CLIENT_ID` answers (`SourceControlSignIn.ts`, `GitHubAppSignIn.ts`,
`GitHubAppAccess.ts`): `signInStart` refuses (`unsupported`), `signInWait` has nothing pending
(`not-started`), `signInCancel` succeeds for GitHub, every other host refuses all three, and
`appAccess` is `signed-out`. Discovery never offers `appSignIn`, so the client does not ask.

`starred` and `star` send GitHub's `GET`/`PUT user/starred/{owner}/{name}` (true only on 204)
with the credential `GitHubCredentials.get` picks: the token saved in Settings, else
`GH_TOKEN`/`GITHUB_TOKEN` (`GH_ENTERPRISE_TOKEN` for `GH_HOST`), else
`gh auth token --hostname <host> [--user <account>]` (env `GH_DEBUG=`, `GH_PROMPT_DISABLED=1`,
10 s; retried without `--user` when that account is signed out). A host turned off in
Settings, a host that is not a plain host name, or an invalid repository asks nothing. Tests:
`GitHubCredentials.test.ts` and `driver.test.ts`, with `gh` as a stub and the request on a
fake server. T3 keeps `gh`'s token 5 minutes; this server asks `gh` on each call.

## Discovery

`server.discoverSourceControl` answers `git`, `jj` and GitHub. The GitHub probe and its tests
follow the T3 server:

| Host | Probe | T3 cases ported |
| --- | --- | --- |
| GitHub | `gh --version`, `gh auth status --json hosts`; `GET /user` with a saved or `GH_TOKEN`/`GITHUB_TOKEN` token | `GitHubSourceControlProvider.test.ts` (parse cases), `gitHubDiscovery.test.ts` (saved token cases) |

How it is proven: every CLI runs as a stub executable that records its argv and the variables
that matter (`GIT_CONFIG_*`, `GH_DEBUG`, `GH_PROMPT_DISABLED`), and the tests compare them with the
T3 driver's argv. Every API request goes to a local fake server that records method, path and
headers; the tests check the `authorization` shape with a fake token. No test runs a real host
CLI or calls a real API: the stubs come first on the children's `PATH`, and the environment is
a fixed set (`hosts::Environment::fixed`). The checks that start a server (`effect-client.mjs`,
`replay.mjs`) start it with `tools/sealed-env.mjs`: no token variable and a fresh `HOME`, so no
CLI login of the machine is read.

Deviations from the T3 server:

- **The login-shell `PATH` lives beside the environment, not in it.** Before discovery the T3
  server re-reads `PATH`, `__MISE_DIFF` and `JAVA_HOME` from the login shell
  (`refreshPathFromLoginShell`, cached 10 s) and writes them into its own environment.
  `std::env::set_var` is unsafe once threads exist, so `conn_support::login_env` keeps them and
  every spawn site adds them. The same happens at start (`fixPath`). Not ported: the account's
  shell from the user database (only `$SHELL`, then `/bin/zsh` or `/bin/bash`), the macOS
  `launchctl getenv PATH` fallback, Nushell's capture, and the desktop's
  `shellEnvironmentPrepared` (the shell is read at start also when the desktop prepared it).
- **No secret providers.** A saved credential that is a secret reference reads as the T3
  server's `SettingsSecretUnresolvedError` (its message names the provider).
- **No GitHub App sign-in.** The server acts as a T3 server without
  `T3CODE_GITHUB_APP_CLIENT_ID`: no `appSignIn` offer, and a saved sign-in is not used.
- **No token caches.** The T3 server keeps a GitHub token (`gh auth token` 5 min)
  and GitHub's quota and pause state between calls. Discovery here reads them on every call; a
  GitHub rate-limit answer reads as "unknown" with T3's message. `cache.rs` now has the bounded
  cache these need; provider detection uses it.
- **The macOS wrong-CPU hint** (errno -86 in `failedProbeHint`) is not detected; such a CLI
  gets the generic "failed" hint.
- **No concurrency keys.** T3 runs at most 4 `gh` children and 4 non-`git` children at once;
  GitHub discovery here starts at most two CLI probes at once.

## Repositories

`sourceControl.lookupRepository`, `cloneRepository` and `publishRepository` follow
`SourceControlRepositoryService.ts` (`repository.rs`); the host half is in
`hosts/repositories.rs`:

| Host | Lookup | Create |
| --- | --- | --- |
| GitHub | `GET repos/{owner}/{name}` (a bare name: `GET user` for the owner); the host from `GH_REPO` or the checkout's GitHub remote (`git remote -v`, `git config --get-regexp ^remote\..*\.gh-resolved$`; github.com, its SSH aliases, `*.ghe.com`, or a host with a `github` label such as an Enterprise Server), else `GH_HOST`, else github.com | `POST user/repos` or `orgs/{owner}/repos` with `{"name","private"}` |

A host failure reaches the client as T3's fixed "The source control operation could not be
completed." A clone runs its own
`git clone --progress -- <url> <name>` with `GIT_PROGRESS_DELAY=0`, `GIT_TERMINAL_PROMPT=0` and
`LANGUAGE=C` (the locale is left alone, unlike other `git` children here), keeps the last four
non-progress stderr lines with URL credentials removed, stops after 2 minutes, and retries a
refused SSH clone over HTTPS. Publish adds the remote (`ensureRemote`), pushes
`HEAD:refs/heads/<branch>` with no deadline, records the upstream, and switches an
auto-selected SSH remote to HTTPS after an SSH refusal. Every failed push reads as T3's fixed
text.

Proofs: the cases of `SourceControlRepositoryService.test.ts` on local bare repositories, with
a stub `git` for the SSH refusals and the slow clone (`repository_tests.rs`); GitHub requests
against a loopback fake server (`hosts/repositories_tests.rs`); the real client decoding the
server's responses (`effect-client.mjs`). No model or external API is called.

Deviations:

- **No rate-limit slots or quota.** T3 runs at most 8 GitHub requests at once and keeps
  GitHub's quota and pause state. These methods do not yet have that queueing. Background
  pull request reads are not built.
- **Publish** reads the branch with `git symbolic-ref` (T3: `statusDetails`) and refreshes the VCS
  status afterwards, but has no repository identity cache to refresh.
- **The clone child** loses the repository selectors the server inherited (`GIT_DIR`,
  `GIT_WORK_TREE`, ...), as every `git` child does (`unsetInheritedRepositoryEnv`). T3 adds a
  trace2 variable only to a `git` call that reports hook progress, and a clone does not.
- The error's `cause` is not sent; clients read `detail`.
- **A clone needs `filesystem:write` too** (a deliberate difference, `STRICTER` in
  `crates/conn-server/src/scopes.rs`). A clone creates its folder and the missing parents at
  any path the caller names, which is a filesystem write. T3 asks only `source-control:write`
  (see `docs/status.md`, "Faults found in the T3 server"). A client paired with
  `source-control:write` but without `filesystem:write` can no longer clone; the owner's
  clients hold both.

## Registry

`registry/` follows T3's `makeSourceControlDefinitionRegistry` with only the GitHub
definition registered. It handles GitHub recognition, pull request URLs, canonical keys,
selectors, project predicates and thread link keys. URLs use the WHATWG parser (`url`).
Unclaimed remotes use T3's `unknownRemoteProvider` fallback. Local paths have no host.
GitHub's `/owner/repo/pull/number` URL parser still accepts any HTTP host, as T3 does.

`tools/registry-diff.mjs` constructs that registry from T3's own GitHub definition and core
code, then compares it with `examples/registry_cases.rs`. It harvests every GitHub definition
test literal and exercises a fixed grid, including removed hosts as unknown-host inputs.
Other host packages are neither imported nor harvested. GitHub and core drift still fail
`tools/check.sh`; changes confined to removed host definitions do not.

## Provider detection

`detect.rs` follows `SourceControlProviderRegistry.ts`: `git rev-parse --is-inside-work-tree
--show-toplevel --git-common-dir`, then `git remote -v` (5 s, 64 KiB); `selectProviderContext`
(origin, then a known host, then the first remote); GitHub refines an unknown host with a
credential for the host, `gh auth token --hostname <h>` when nothing is saved. A host turned
off in Settings claims it too. A check that could not answer is not kept. Caches as T3's:
a checkout's answer 5 s (2,048 checkouts, failures not kept), an unknown server's verdict
5 minutes (512 servers), cleared by `Detector::settings_changed`. Callers of one key share
one lookup.

Proof: T3's `SourceControlProviderRegistry.test.ts` cases on scratch repositories with stub
`gh`; the children's `PATH` holds only the stub folder and
`/usr/bin:/bin`, so no real host CLI runs.

Deviations: T3's VCS detection cache (5 minutes, stat-checked) and jj checkouts are not ported;
each detection here runs `git rev-parse` before `git remote -v`. The server does not create a
`Detector` yet: no served method needs one.

## GitHub GraphQL

`tools/gen-graphql.mjs` imports T3's generated `*.graphql.ts` modules
(`packages/source-control-github/src/server`) and prints each operation with
`effect/graphql`'s own joiner into `hosts/github_graphql/generated.rs`: 55 operations, with
their template parts. `--check` runs in `tools/check.sh`. `github_graphql` renders an operation
once or batched under `_<i>_` aliases, as `GraphQLResolver.aliased` does; tests hold every
joined template to T3's text and every two-slice batch to Effect's `renderSlices` output. The
request body is `{query, operationName, variables}` as JSON (Effect's `requestBody`); no request
sends one yet.

## Engine links and `/mcp` tools

`conn-engine/src/pull_requests.rs` decides `thread.pull-request.link` and `unlink` as T3's
`Orchestrator.ts` does, with the registry's keys (see that file). Both emit
`thread.pull-request-synced` with the thread, also when nothing changed. Proof: unit tests and
`client-check.mjs` (a GitHub link, a stack member, its unlink and a relink through the client's
own reducers).

`conn-mcp/src/tools/pull_requests.rs` serves the five link tools (`pullRequestTarget.ts`
`resolveTarget`, `resolveThreadPullRequestChains`, T3's paging). Proof: 26 `parity.mjs` steps
against the T3 server, values compared, no differences. It also serves the watch and guide
tools; the engine decides `thread.pull-request.watch` and `thread.pull-request-watch.sync`,
and `conn-server/src/methods/pull_requests/watches.rs` is the watch loop (`docs/status.md`,
"PR watching and review guides").

## PR panel differences

- Reads use a bounded memory cache rather than T3's persistent stale reads; entries do not survive restart.
- Listings read each repository separately. ETag revalidation, credential-token caching, quota reserve and Unix-socket transport remain absent.
- Withheld whole-diff single-file extraction and the automatic PR-link sync reactor remain unbuilt. The watch loop has no GitHub change feed or fingerprints.
- The 15 actions, stack and guide methods remain unregistered here; the actions branch supplies them.
- No live macOS/iPhone or signed-in Orbit proof has been run for the panel.

## What the next steps need

The registry, detection and the GraphQL texts are built. What every remaining step still needs:

1. **The project's `repositoryIdentity`** (T3's `project/RepositoryIdentityResolver.ts`, 358
   lines, cached). This engine's project rows carry none. T3's link tools fall back to it, and
   every `pullRequests.*` read, `pr` in VCS status and the link sweep start from it.
2. **GitHub's request policy** (`GitHubRequestPolicy.ts`, `GitHubQuota.ts`,
   `SourceControlRateLimit.ts`): 8 requests at once, a 10 % quota reserve for background reads,
   the pause after a rate limit, the credential source header. Then GitHub's GraphQL client
   (`gitHubGraphQlClient.ts`: the byte cap, `isNotFoundOnly`, the batch windows of 50 ms and
   500 ms) on the generated operations.
3. **GitHub change request reads** (`getChangeRequest`, `listChangeRequests` by head,
   `checkoutChangeRequest`), through GraphQL and REST (`GitHubSourceControlProvider.ts`).
   No other host implementation is needed.

`git.runStackedAction` and the review guides also call a text generator, and
`git.preparePullRequestThread` runs the project's setup script, which this server does not run
the T3 way yet.

## Dependencies

- **hyper, hyper-util, http-body-util, rustls, tokio-rustls, webpki-roots**: HTTPS to a host's
  API (parts 1 to 3). hyper is already linked through axum; the client side adds about 100 KB.
- **url 2.5** (part 4, servo's WHATWG URL parser, maintained, 2.5.8 on crates.io): the registry
  reads URLs as `new URL` does, IDNA through ICU as Node does. Measured on the macOS arm64
  release binary: 16,800,544 to 17,001,824 bytes (+201,280). No run-time heap of its own; the
  IDNA tables are static. `idna_adapter` 1.0 (ASCII only) would save most of that, but a host
  name in another script would then read differently from T3's (the diff has `bücher.example`).

## Costs

- Nothing runs while idle: no poll, no watch. The only caches are provider detection's
  (at most 2,048 checkouts for 5 s and 512 servers for 5 minutes), and nothing creates one yet.
- GitHub discovery starts at most two short CLI children and a saved-token API probe;
  output and request bounds are unchanged.
- Each HTTPS request opens its own TCP and TLS connection and closes it after the answer. The
  TLS configuration (Mozilla's roots) is built on first use and kept.

## The map

Scopes are from `RPC_REQUIRED_SCOPES`: R = `orchestration:read`, SCW = `source-control:write`,
OP = `orchestration:operate`, SW = `settings:write`. "Host" means the call goes through the
host's driver (`PullRequestProviderApi` or `SourceControlProvider`); how each host is reached
is under "How the T3 server reaches each host". PRS = `apps/server/src/pullRequest/PullRequestService.ts`.

Totals: 48 RPC methods (45 unary, 3 streams), 7 engine commands plus one
`thread.metadata.update` field, 9 `/mcp` tools, one host.

### `server.discoverSourceControl`, `sourceControl.*`, `git.*`

| Method | T3 source | What it does | Talks to | Scope |
| --- | --- | --- | --- | --- |
| `server.discoverSourceControl` | `sourceControl/SourceControlDiscovery.ts` | Lists VCS and host CLIs with version and sign-in state | `git`/`jj --version`; GitHub's probe (CLI and API) | R |
| `sourceControl.lookupRepository` | `SourceControlRepositoryService.ts:223` | A repository's clone URLs | host `getRepositoryCloneUrls` | R |
| `sourceControl.cloneRepository` | `SourceControlRepositoryService.ts:400` | Clones a repository to a path | host lookup, `git clone` | SCW |
| `sourceControl.publishRepository` | `SourceControlRepositoryService.ts:485` | Creates a remote repository and pushes | host `createRepository`; `git` remote, push | SCW |
| `sourceControl.signInStart` | `SourceControlSignIn.ts:53` | Starts the GitHub App device flow | GitHub HTTP `/login/device/code` | SW |
| `sourceControl.signInWait` | `SourceControlSignIn.ts:56` | Waits for the device flow | GitHub HTTP `/login/oauth/access_token`; settings write | SW |
| `sourceControl.signInCancel` | `SourceControlSignIn.ts:59` | Cancels a pending sign-in | in memory | SW |
| `sourceControl.appAccess` | `SourceControlSignIn.ts:62`, `GitHubAppAccess.ts` | Whether the App covers a repository | GitHub HTTP as the App | R |
| `sourceControl.starred` | `SourceControlSignIn.ts:69` | Whether the server's account starred it | GitHub `GET user/starred/{o}/{r}` | R |
| `sourceControl.star` | `SourceControlSignIn.ts:74` | Stars the repository | GitHub `PUT user/starred/{o}/{r}` | SCW |
| `git.resolvePullRequest` | `git/GitManager.ts:2902` | Resolves a PR reference for a checkout | host `getChangeRequest`; `git` remotes | R |
| `git.preparePullRequestThread` | `git/GitManager.ts:2945` | Checks a PR out locally or in a worktree | host `getChangeRequest`, `checkoutChangeRequest`; `git`; setup script | SCW |
| `git.runStackedAction` (stream) | `git/GitManager.ts:3394` | Commit, push, create PR with progress | `git`; AI model (commit message, PR text); host `createChangeRequest`, `listChangeRequests` | SCW |

### `pullRequests.*`

Every one reads the project shell to find the repository and host. "cache" names an in-memory
cache in PRS (capacities 32 to 128, TTL 15 s to 10 min) or the on-disk `PullRequestReadCache`.

| Method | T3 source | What it does | Talks to | Scope |
| --- | --- | --- | --- | --- |
| `list` | PRS `listUncached` 1330 | PRs across a project's repositories, paged, filtered | host `listChangeRequests`/`Across`, `getViewer`; cache 30 s | R |
| `listStats` | PRS 2758 | Additions and deletions for a batch | host `listChangeRequestStats`; cache 60 s | R |
| `filterOptions` | PRS 2620 | Labels, authors or references for filters | host `listRepositoryLabels`, `searchRepositoryAuthors`, `searchRepositoryReferences` | R |
| `summary` | PRS 1807 | One PR's summary | host `getChangeRequestSummary`/`getChangeRequest` | R |
| `routing` | PRS 1719 | Which account and host reads go to | host `getViewer`; viewer cache 10 min | R |
| `routingIdentity` | PRS 1669 | Account id and viewer for a host | host `getRoutingIdentity` | R |
| `stack` | PRS 1821 | The stacked PR chain | host `getChangeRequestStack` | R |
| `linkedThreads` | `pullRequest/linkedThreads.ts` | Threads linked to a PR | engine store | R |
| `detail` | PRS 3253 | Full PR detail | host `getChangeRequest`; cache 60 s | R |
| `preview` | PRS 1941 | Short preview | host `getChangeRequestPreview` | R |
| `checks` | PRS 3188 | Check runs | host `getChangeRequestChecks`; cache 15 s | R |
| `activity` | PRS 3409 | Comments, review threads, commits | host `getChangeRequestActivity` | R |
| `reviewGuide` | `PullRequestReviewGuideService.ts` | Stored review guide and run state | engine SQL; host `detail` | R |
| `generateReviewGuide` | `PullRequestReviewGuideService.ts` | Starts a guide run in a temp checkout | AI model (codex/claudeAgent); `git` fetch, worktree; host | OP |
| `threadComments` | PRS 1995 | More comments of a review thread | host `getReviewThreadComments` | R |
| `diffFileContents` | PRS 2042 | Old and new contents of a changed file | host `getDiffFilePaths`, `getDiffFileContents` | R |
| `filesViewed` | PRS 3551 | Files the viewer marked viewed | host `getFilesViewed`; cache 15 s | R |
| `changeBreakdown` | PRS 3420 | Per-file line counts | host `getFileStats` | R |
| `setFilesViewed` | ws.ts:2783 | Marks files viewed | host `setFilesViewed` | SCW |
| `runAction` | PRS 3718 | Merge, close, ready, ...; then a link sync | host `runAction`; engine sync | SCW |
| `update` | PRS 2312 | Edits title and body | host `updateChangeRequest` | SCW |
| `comment` | ws.ts:2797 | Adds a comment | host `comment` | SCW |
| `updateComment` | PRS 2369 | Edits a comment | host `updateComment` | SCW |
| `submitReview` | ws.ts:2801 | Submits a review | host `submitReview` | SCW |
| `replyToThread` | ws.ts:2803 | Replies in a thread | host `replyToThread` | SCW |
| `setThreadResolution` | ws.ts:2805 | Resolves a thread | host `setThreadResolution` | SCW |
| `setReaction` | ws.ts:2807 | Sets a reaction | host `setReaction` | SCW |
| `invalidate` | PRS 3637 | Drops cached reads, may sync | caches; engine sync | R |
| `reportState` | PRS 3348 | A client reports a PR state | in memory (5 min dedupe) | R |
| `subscribeRefreshes` (stream) | PRS 3910 | Counter that bumps on refresh | in memory | R |
| `subscribeLinkedThreadRefreshes` (stream) | PRS 3913 | Counter that bumps on a linked-thread change | in memory | R |
| `reviewerCandidates` | PRS | People who can review | host `listReviewerCandidates` | R |
| `requestReviewers` | ws.ts:2829 | Requests or removes reviewers | host `setReviewerRequest` | SCW |
| `labelCandidates` | PRS 2690 | Labels that can be applied | host `listLabelCandidates` | R |
| `setLabels` | PRS 2723 | Sets labels | host `setLabels` | SCW |

### Engine commands (`orchestration-v2/Orchestrator.ts`, OP through `dispatchCommand`)

| Command | Decided at | Issued by | What it does |
| --- | --- | --- | --- |
| `thread.pull-request.link` | 4757 | `/mcp`, `PullRequestSyncReactor`, `linkCreatedPullRequest`, client | Links a PR (no-op when linked) |
| `thread.pull-request.unlink` | 4813 | `/mcp`, client | Removes a link |
| `thread.pull-request-link.sync` | 4759 | `PullRequestSyncReactor` | Writes a link's snapshot and stack |
| `thread.pull-request.watch` | 4872 (checks 4056-4110) | `PullRequestWatchService`, client | Starts or stops a watch |
| `thread.pull-request-watch.sync` | 14828 | `PullRequestWatchReactor` | Writes watch results and wakes |
| `thread.pull-request-watch.checks-reopen` | 4860 | `PullRequestSyncReactor` | Clears "checks pending" after a push |
| `thread.pull-request.sync` | 4963 (stale check 4214) | `ThreadPullRequestService` | The thread's branch PR |
| `thread.metadata.update` `linkedPullRequest` | | client | Legacy single link |

Three loops feed them: the link sweep (every minute; each PR every 5 to 15 min), the watch
sweep (every 2 min, plus GitHub's event stream per watched PR) and the branch PR sweep (every
minute).

### `/mcp` tools (`apps/server/src/mcp/toolkits/pullRequests`, capability `pull-requests`)

| Tool | What it does | Talks to | Guard |
| --- | --- | --- | --- |
| `link_pull_request` | Links one PR (`source: "agent"`) | engine; local URL parse | writes thread |
| `link_pull_requests` | Links many, returns `invalidUrls` | engine | writes thread |
| `unlink_pull_request` | Unlinks one | engine | writes thread |
| `unlink_pull_requests` | Unlinks by last known state | engine | writes thread |
| `list_thread_pull_requests` | A thread's PRs with last state | engine | reads |
| `watch_pull_request` | Watches an open PR | host `summary`; engine | writes thread |
| `unwatch_pull_request` | Stops the watch | engine | writes thread |
| `write_pull_request_guides` | Starts guide runs (up to 20) | AI model; `git`; host | writes |
| `read_pull_request_guide` | Reads a stored guide | engine SQL; host `detail` | reads |

### `pr` in VCS status

`VcsStatusRemoteShape.pr` (`packages/contracts/src/git.ts:212,258`): the latest open change
request for the current branch. `GitManager.lookupStatusPr` (~1366) calls the host's
`listChangeRequests({headSelector, state: "open"})`, cached per branch (60 s with a PR, 5 min
without; failures back off from 20 s to 15 min) and refreshed with the remote status (about
30 s).

## How the T3 server reaches each host

Process rules for every host CLI (`VcsProcess.ts`): the server's environment plus
`safe.bareRepository=explicit` through `GIT_CONFIG_COUNT`/`KEY`/`VALUE`; 30 s and 1,000,000
bytes by default; at most 4 non-`git` children at once. Discovery probes: 8,000 bytes with the
marker `\n\n[truncated]`, 5 s.

| Host | Discovery | Credentials | Repository and PR operations |
| --- | --- | --- | --- |
| GitHub | `gh --version`, `gh auth status --json hosts`; then `GET /user` when a token is saved, signed in, or in `GH_TOKEN`/`GITHUB_TOKEN` | Settings `sourceControlHosts.github.tokens[host]`; App sign-in `signIns["github.com"]` (needs `T3CODE_GITHUB_APP_CLIENT_ID`); `GH_TOKEN`, `GITHUB_TOKEN` (`GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` for `GH_HOST`); `gh auth token --hostname <h> [--user <a>]` (env `GH_DEBUG=`, `GH_PROMPT_DISABLED=1`, 10 s), cached 5 min | REST `https://api.github.com` (`api.<h>` for `*.ghe.com`, `https://<h>/api/v3` for GHES) and GraphQL `/graphql`; headers `accept: application/vnd.github+json`, `x-github-api-version: 2022-11-28`, `user-agent: t3code`, `authorization: Bearer <token>`; 30 s, 8 MiB, 8 at once; quota reserve 10 %; `gh config get http_unix_socket` routes requests over a socket |

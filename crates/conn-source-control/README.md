# conn-source-control

Source control hosts for the Conn Server: GitHub, Cursor Origin, GitLab, GitCafe, Forgejo,
Bitbucket and Azure DevOps (the T3 server's order). We reach each host exactly as the T3
server's driver does: the same CLI calls with the same argv and environment, the same API
requests with the same method, path, headers and body. The T3 sources are
`packages/source-control-*` and `apps/server/src/{sourceControl,pullRequest,git}` in the Conn
monorepo at `conn.pin`.

## What is served now

| Area | State |
| --- | --- |
| `server.discoverSourceControl` | Served: `git`, `jj` (from `conn-vcs`) and all 7 hosts (see "Discovery") |
| `sourceControl.*` (9) | All 9 served: `signInStart`, `signInWait`, `signInCancel`, `appAccess` (as a T3 server without `T3CODE_GITHUB_APP_CLIENT_ID`), `starred`, `star` (GitHub REST, any other host `false`); `lookupRepository`, `cloneRepository`, `publishRepository` for all 7 hosts (see "Repositories") |
| The host definition registry | Built (part 4): remotes, change request URLs, canonical keys, the project predicates, thread link keys (see "Registry") |
| Provider detection | Built (part 4), not yet called by a method (see "Provider detection") |
| GitHub's GraphQL operations | Generated from the monorepo (part 4); no request sends one yet (see "GitHub GraphQL") |
| `git.*` (3) | Not served |
| `pr` in VCS status | Not served (always `null`) |
| `pullRequests.*` (35) | Not served |
| Engine commands for linked pull requests (7) | `thread.pull-request.link` and `unlink` as T3's decider (part 4); the other 5 refused |
| `/mcp` pull request tools (9) | 5 served (part 4): `link_pull_request(s)`, `unlink_pull_request(s)`, `list_thread_pull_requests`; `watch`/`unwatch` and the 2 guide tools not served |

## Modules

| Module | Holds |
| --- | --- |
| `secret.rs` | `Secret`: a token with a redacted `Debug` and `Display` |
| `http.rs` | One HTTPS request per connection (hyper + rustls), bounded answer, local fake server for tests |
| `settings.rs` | A host's saved fields (`hosts`, `tokens`, Bitbucket's and GitCafe's), secret references |
| `discovery.rs` | The generic CLI probe (`probeSourceControlProvider`), the auth text helpers, a stub executable for tests |
| `cli.rs` | A host CLI call outside discovery, as `VcsProcess.run` runs it (30 s, 1,000,000 bytes) |
| `remote.rs` | Clone URL and remote text: `cloneUrl.ts`, `parseGitRemoteRepository`, `repositoryKeyFromRemote`, the redaction helpers |
| `repository.rs` | `SourceControlRepositoryService`: lookup, clone (its own `git clone` child), publish (`ensureRemote`, push, upstream) |
| `hosts/<host>.rs` | One module per host: its discovery |
| `hosts/forgejo_cli.rs` | `ForgejoCli.resolveTarget` and `api`: the fj or tea login that serves a repository, fj's API with its token, `tea api` |
| `hosts/gitcafe_api.rs` | GitCafe's hosts and remotes, `GitCafeCredentials.get`, `GitCafeApi.request`, `resolveTarget` |
| `hosts/repositories.rs` | Each host's `getRepositoryCloneUrls` and `createRepository` (`Hosts`) |
| `hosts/github_graphql/` | GitHub's GraphQL operations: `generated.rs` (by `tools/gen-graphql.mjs`) and the batch renderer |
| `registry/` | The host definition registry (`mod.rs`), its URL routes (`paths.rs`), thread link keys (`thread_keys.rs`) |
| `detect.rs` | Provider detection: the checkout's remotes, the recognised context, unknown hosts refined |
| `cache.rs` | `TtlCache`: bounded, one shared lookup per key, a time to live per answer (Effect's `Cache`) |

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

`server.discoverSourceControl` answers `git` and `jj` and the seven hosts in the T3 server's
order, all probed at once. Each host module ports its driver's probe and its own test cases:

| Host | Probe | T3 cases ported |
| --- | --- | --- |
| GitHub | `gh --version`, `gh auth status --json hosts`; `GET /user` with a saved or `GH_TOKEN`/`GITHUB_TOKEN` token | `GitHubSourceControlProvider.test.ts` (parse cases), `gitHubDiscovery.test.ts` (saved token cases) |
| Cursor Origin | `origin --version`, `origin auth status --json`; `origin auth token`, `GET /v1/origin/namespaces` | none exist upstream; cases from the code |
| GitLab | `glab --version`, `glab auth status`, then `--all` | `gitLabDiscovery.test.ts` |
| GitCafe | `cafe --version`, `cafe ... auth status --json` with `CAFE_TOKEN` from Settings | `GitCafeSourceControlProvider.test.ts`, `GitCafeCredentials.test.ts` |
| Forgejo | `git remote get-url origin`, fj keys file, `fj version`, `fj --host <url> whoami`, `GET /api/v1/user`; else `tea` | `ForgejoSourceControlProvider.test.ts` (discovery cases) |
| Bitbucket | `GET /user` (3 s) with the Settings or `T3CODE_BITBUCKET_*` credential | `BitbucketApi.test.ts` |
| Azure DevOps | `az --version`, `az account show --query user.name -o tsv` (20 s) | `AzureDevOpsSourceControlProvider.test.ts` |

How it is proven: every CLI runs as a stub executable that records its argv and the variables
that matter (`GIT_CONFIG_*`, `CAFE_TOKEN`, `NO_COLOR`), and the tests compare them with the
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
- **No token caches.** The T3 server keeps a host's token (Origin 5 min, `gh auth token` 5 min)
  and GitHub's quota and pause state between calls. Discovery here reads them on every call; a
  GitHub rate-limit answer reads as "unknown" with T3's message. `cache.rs` now has the bounded
  cache these need; provider detection uses it.
- **The macOS wrong-CPU hint** (errno -86 in `failedProbeHint`) is not detected; such a CLI
  gets the generic "failed" hint.
- **No concurrency keys.** T3 runs at most 4 `gh` children and 4 non-`git` children at once;
  discovery here starts at most two per CLI host at once, 14 in all.

## Repositories

`sourceControl.lookupRepository`, `cloneRepository` and `publishRepository` follow
`SourceControlRepositoryService.ts` (`repository.rs`); the host half is in
`hosts/repositories.rs`:

| Host | Lookup | Create |
| --- | --- | --- |
| GitHub | `GET repos/{owner}/{name}` (a bare name: `GET user` for the owner); the host from `GH_REPO` or the checkout's GitHub remote (`git remote -v`, `git config --get-regexp ^remote\..*\.gh-resolved$`; github.com, its SSH aliases, `*.ghe.com`, or a host with a `github` label such as an Enterprise Server), else `GH_HOST`, else github.com | `POST user/repos` or `orgs/{owner}/repos` with `{"name","private"}` |
| Cursor Origin | `GET /v1/origin/repos/{owner}/{name}` with the `origin auth token` bearer (one retry after a 401) | private only: `POST /v1/origin/repos/{owner}` `{"name"}`, then `PATCH` `{"visibility":"private"}` (3 tries, 1 s apart); a bare name uses the personal namespace |
| GitLab | `glab api projects/<encoded path>` | `glab api namespaces/<encoded>` for the id, then `glab api --method POST projects --raw-field path= name= visibility= [namespace_id=]` |
| Bitbucket | `GET /repositories/{workspace}/{slug}`, redirects followed as fetch follows them | `POST` the same path with `{"scm":"git","is_private":...}` |
| Azure DevOps | `az repos show --detect true --repository <name> [--project <p>] --only-show-errors --output json` | `az repos create --detect true --name <name> [--project <p>] ...` |
| GitCafe | `GET /api/repos/{owner}/{name}` on git.cafe or staging.git.cafe (the host from the URL, else the checkout's GitCafe remote: `git remote get-url -- origin`, `git remote`, `git config --get remote.<r>.url`, else git.cafe) | `POST /api/orgs/{owner}/repos` `{"name","requestKey","visibility","defaultBranch":"main"}`, then `GET /api/orgs/{owner}/admissions/{id}` every 500 ms for up to 30 s until `complete` or `blocked` |
| Forgejo | `resolveTarget` (below), then `GET <base>/api/v1/repos/{owner}/{name}` | `GET user`, then `POST user/repos` or `orgs/{owner}/repos` with `{"name","private","auto_init":false}` |

A host failure reaches the client as T3's fixed "The source control operation could not be
completed.", except Bitbucket's "Bitbucket repositories must be specified as
workspace/repository." (the one host error with a `userFacingDetail`). A clone runs its own
`git clone --progress -- <url> <name>` with `GIT_PROGRESS_DELAY=0`, `GIT_TERMINAL_PROMPT=0` and
`LANGUAGE=C` (the locale is left alone, unlike other `git` children here), keeps the last four
non-progress stderr lines with URL credentials removed, stops after 2 minutes, and retries a
refused SSH clone over HTTPS. Publish adds the remote (`ensureRemote`), pushes
`HEAD:refs/heads/<branch>` with no deadline, records the upstream, and switches an
auto-selected SSH remote to HTTPS after an SSH refusal. Every failed push reads as T3's fixed
text.

Forgejo's `resolveTarget` picks the login: the remote in the request (a URL or SCP remote; with
no repository, `git remote get-url origin`), matched against fj's logins from `keys.json`. A
matching fj login is checked with `fj --host <url> whoami` in the home folder, and a bare name
takes the fj account's login (`GET user`). Several matching fj logins with `fj` installed fail;
without a usable fj login, `tea login list --output json` decides. With fj the server sends the
request (`Authorization: token <t>`, redirects followed five times inside `/api/v1/`); with tea
it runs `tea api --include --login <l> [--repo <r>] --method <m> [--data @-] <url>` and reads the
status from tea's stderr. GitCafe's credential is the Settings token (git.cafe only), else
`CAFE_TOKEN` for the host `CAFE_HOST` names, else `cafe auth http credential --host
https://<h>/api get` with `protocol=https\nhost=<h>\n\n` on stdin, in the server's folder,
with `CAFE_NO_UPDATE_CHECK=1`. Its requests carry `Authorization: Bearer`, `accept:
application/json` and `user-agent: t3code`, and follow at most three redirects inside `/api/`.

Proofs: the cases of `SourceControlRepositoryService.test.ts` on local bare repositories, with
a stub `git` for the SSH refusals and the slow clone (`repository_tests.rs`); each host's argv,
paths, headers and bodies against stub CLIs and a loopback fake server
(`hosts/repositories_tests.rs`); T3's own Forgejo `api` cases and GitCafe host, credential and
provider cases (`hosts/forgejo_cli_tests.rs`, `hosts/gitcafe_api_tests.rs`); the real client
decodes all three (`effect-client.mjs`).

Deviations:

- **The fj login check and GitCafe's `cafe` token last one operation.** T3 skips
  `fj --host <url> whoami` for 30 s after a check and keeps a token from `cafe` for 5 minutes (a
  missing one for 10 s). Here each operation checks once and asks `cafe` once, so a warm T3
  server can run fewer children than this one.

- **No rate-limit slots or quota.** T3 runs at most 8 GitHub and 4 Bitbucket requests at once
  and keeps GitHub's quota and Bitbucket's 429 pause. A lookup runs as interactive and a create
  is a write, and T3 refuses neither while paused, so the only effect on these three methods is
  T3's queueing under load. The pause matters for background reads (pull requests), which are
  not built.
- **The Origin token** is read on each call (T3 keeps it 5 minutes).
- **Publish** reads the branch with `git symbolic-ref` (T3: `statusDetails`) and refreshes the VCS
  status afterwards, but has no repository identity cache to refresh.
- **The clone child** loses the repository selectors the server inherited (`GIT_DIR`,
  `GIT_WORK_TREE`, ...), as every `git` child does (`unsetInheritedRepositoryEnv`). T3 adds a
  trace2 variable only to a `git` call that reports hook progress, and a clone does not.
- The error's `cause` is not sent; clients read `detail`.

## Registry

`registry/` is the server half of T3's definition registry
(`packages/source-control-core/src/shared/definition.ts`, the order in
`packages/source-control-definitions/src/registry.ts`, each host's `src/shared/definition.ts`):
`recognize_remote` in recognition order (GitCafe, Cursor Origin, Forgejo, GitHub, GitLab, Azure
DevOps, Bitbucket), `parse_change_request_url` in claim order (GitCafe, Cursor Origin, Azure
DevOps first), each host's `change_request_url`, `canonical_repository_key`,
`repository_key_from_remote`, `repository_selector`, `change_request_host`,
`find_by_public_host`, the project predicates (`is_change_request_in_repository`,
`can_read_change_request_on_host`, `checkout_change_request_host`), `change_request_head_ref`,
`is_same_change_request`, GitCafe's URL spelling, and the thread link keys
(`normalizeThreadPullRequestKey`, `legacyThreadPullRequestKey`). URLs go through the WHATWG
parser (`url`), as `new URL` reads them; the regular expressions are written out by hand
(`paths.rs`). What only clients use (icons, autolinks, media, checkout commands, settings forms)
is not ported.

Proof: `tools/registry-diff.mjs` runs T3's registry (loaded from the monorepo) and ours
(`examples/registry_cases.rs`) on every string literal of T3's seven `definition.test.ts`
files and a fixed grid of hosts, paths, schemes, remotes and identities: 24,085 cases, 0
differences. It runs in `tools/check.sh`, so an upstream change to a definition or a test
shows at once.

## Provider detection

`detect.rs` follows `SourceControlProviderRegistry.ts`: `git rev-parse --is-inside-work-tree
--show-toplevel --git-common-dir`, then `git remote -v` (5 s, 64 KiB); `selectProviderContext`
(origin, then a known host, then the first remote); a remote on an unknown host is refined one
integration after another, as `refineUnknownRemoteProvider` runs them: GitHub (a credential for
the host, `gh auth token --hostname <h>` when nothing is saved; a host turned off in Settings
claims it too), GitLab (`glab auth status --hostname <h>`, in the remote's own spelling) and
Forgejo (fj's logins, then `tea login list --output json`). A check that could not answer is not
kept. Caches as T3's: a checkout's answer 5 s (2,048 checkouts, failures not kept), an unknown
server's verdict 5 minutes (512 servers), cleared by `Detector::settings_changed`. Callers of
one key share one lookup.

Proof: T3's `SourceControlProviderRegistry.test.ts` cases on scratch repositories with stub
`gh`, `glab`, `fj` and `tea`; the children's `PATH` holds only the stub folder and
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
`client-check.mjs` (a GitCafe link, a stack member, its unlink and a relink through the client's
own reducers).

`conn-mcp/src/tools/pull_requests.rs` serves the five link tools (`pullRequestTarget.ts`
`resolveTarget`, `resolveThreadPullRequestChains`, T3's paging). Proof: 26 `parity.mjs` steps
against the T3 server, values compared, no differences.

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
3. **Each host's change request reads** (`getChangeRequest`, `listChangeRequests` by head,
   `checkoutChangeRequest`): GitHub through GraphQL and REST (`GitHubSourceControlProvider.ts`,
   1,186 lines), GitLab (`glab mr view/list/checkout`), Cursor Origin, GitCafe, Forgejo (fj/tea),
   Bitbucket, Azure DevOps (`az repos pr`). `git.resolvePullRequest` needs all seven, since a
   method is registered only when it serves every host.

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
- One discovery: at most 14 short CLI children and 3 HTTPS requests (GitHub, Bitbucket,
  Origin; Forgejo adds one per signed-in fj login it checks), each bounded: 8,000 bytes per
  CLI stream, 8 MiB per answer, 5 s per CLI (20 s for `az`), 30 s per request (3 s for the
  whole Bitbucket probe).
- Each HTTPS request opens its own TCP and TLS connection and closes it after the answer. The
  TLS configuration (Mozilla's roots) is built on first use and kept.

## The map

Scopes are from `RPC_REQUIRED_SCOPES`: R = `orchestration:read`, SCW = `source-control:write`,
OP = `orchestration:operate`, SW = `settings:write`. "Host" means the call goes through the
host's driver (`PullRequestProviderApi` or `SourceControlProvider`); how each host is reached
is under "How the T3 server reaches each host". PRS = `apps/server/src/pullRequest/PullRequestService.ts`.

Totals: 48 RPC methods (45 unary, 3 streams), 7 engine commands plus one
`thread.metadata.update` field, 9 `/mcp` tools, 7 hosts.

### `server.discoverSourceControl`, `sourceControl.*`, `git.*`

| Method | T3 source | What it does | Talks to | Scope |
| --- | --- | --- | --- | --- |
| `server.discoverSourceControl` | `sourceControl/SourceControlDiscovery.ts` | Lists VCS and host CLIs with version and sign-in state | `git`/`jj --version`; each host's probe (CLI; GitHub and Bitbucket API) | R |
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
| Cursor Origin | `origin --version`, `origin auth status --json`; `GET /v1/origin/namespaces` for the account | `origin auth token` (env `NO_COLOR=1`), cached 5 min | `https://api.cursor.com/v1/origin/...`, `Authorization: Bearer`, `Accept: application/json`; `origin pr checkout` |
| GitLab | `glab --version`, `glab auth status`, retry `glab auth status --all` | None in the server; `glab`'s own login | `glab mr list/view/checkout`, `glab api ...` with `GITLAB_HOST=<host>` |
| GitCafe | `cafe --version`, `cafe --host https://git.cafe/api --no-input --no-update-check auth status --json`, with `CAFE_TOKEN` from settings | Settings `sourceControlHosts.gitcafe.token` (git.cafe only); `CAFE_TOKEN` (when `CAFE_HOST` matches); `cafe auth http credential --host https://<h>/api get` over stdin | `https://<h>/api...`, `Authorization: Bearer`, `accept: application/json`, `user-agent: t3code`; only `git.cafe` and `staging.git.cafe` |
| Forgejo | `git remote get-url origin`; `fj version`, `fj --host <url> whoami` (cwd `$HOME`), `GET /api/v1/user`; else `tea --version`, `tea login status --output json` | The fj keys file (`keys.json`); `tea`'s own logins | fj: `<base>/api/v1/...`, `Authorization: token <t>`; tea: `tea api --include --login <l> ...`; `tea pulls checkout` |
| Bitbucket | API probe: `GET /user` (3 s) | Settings `sourceControlHosts.bitbucket.accessToken` or `email` + `apiToken`; `T3CODE_BITBUCKET_ACCESS_TOKEN`, `_EMAIL`, `_API_TOKEN` | `https://api.bitbucket.org/2.0` (or `T3CODE_BITBUCKET_API_BASE_URL`), `Authorization: Bearer` or Basic, `Accept: application/json`; 30 s, 8 MiB, 4 at once |
| Azure DevOps | `az --version`, `az account show --query user.name -o tsv` (20 s) | None in the server; `az login` | `az repos ...`, `az devops invoke ...` |

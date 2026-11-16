# GitHub PR panel

The panel serves GitHub through the existing credential resolver: official `gh auth token`,
then a private `Secret` in the HTTP header. One credential stays pinned through a routed read
or mutation. Nothing opens a GitHub settings file or forwards a token to a client. GraphQL
texts and aliased statistics batches come from `hosts/github_graphql`, generated from T3.

## Boundary map

| T3 entry | Rust entry |
| --- | --- |
| `PullRequestService.list`, GitHub list/search | `Client.list`; the panel handler selects and deduplicates projects |
| `listStats` | `Client.stats_batch`, at most 100 aliased lookups per request; failed slices omitted |
| `filterOptions` | `Client.filter_options`, then deduplication and ranking in the panel handler |
| `summary`, `preview` | `Client.summary`, `Client.preview` |
| `detail`, `checks` | `Client.detail`, with bounded check pages, permissions and workflow runs |
| `activity`, `threadComments` | `Client.activity`, `Client.thread_comments`; hidden comments omitted and thread ownership checked |
| `changeBreakdown` | `Client.change_breakdown`, `normalize::breakdown`; a partial file list gives null |
| `diffFileContents` | `Client.diff_file_contents`; changed-file membership checked before repository contents are read |
| `filesViewed`, `setFilesViewed` | `Client.files_viewed`, `Client.set_files_viewed`; paths keep whitespace and toggles execute in order |
| `routing`, `routingIdentity` | `Client.identity`; a mismatched expected account fails before reading the PR |
| `linkedThreads` | Panel handler over active and archived engine projections; canonical registry keys |
| `invalidate`, `reportState` | Scoped read invalidation, bounded five-minute state-report deduplication |
| Both refresh subscriptions | Bounded watch channels; one shared engine subscription observes linked-thread and completed-turn changes |
| `POST /api/pull-requests/diff` | `Client.diff`, under `orchestration:read`; raw patches and paged files/commit patches |

Only these 20 RPCs register. Capabilities withhold the action and guide features. The existing
five PR-link MCP tools keep using the engine; this step adds no MCP tool.

## Proof

`tests.rs` uses the crate's stub `gh` and loopback HTTP server. It checks credentials' CLI
arguments, generated documents and headers, aliased batches, missing slices, pagination ties,
hidden remarks, reactions, thread ownership, merge-base expansion, changed-file guards,
viewed-file pagination and ordered toggles. The server's panel tests check the typed RPC
results, routing, refreshes, bounded caches, state-report deduplication and permissions. The
HTTP test checks the read scope and typed error status.

`tools/gen-pr-cases.mjs` records 67 cases from T3's own summary, check, file-classification,
patch and credential-requirement code. Rust tests compare against them; `tools/check.sh`
checks their generator for drift. Every registered RPC has a call in `effect-client.mjs`,
which uses the real client's decoders. Tests never use a real login, model or GitHub API.

## Differences and remaining work

- This is the read-and-refresh slice. The 15 unregistered methods are `comment`,
  `replyToThread`, `updateComment`, `setReaction`, `setThreadResolution`, `submitReview`,
  `requestReviewers`, `reviewerCandidates`, `labelCandidates`, `setLabels`, `update`,
  `runAction`, `stack`, `generateReviewGuide` and `reviewGuide`. Their next step needs fresh
  host permissions, subject ownership, mutation invalidation and engine PR-link sync; guide
  generation also needs its service, store and model-backed checkout lifecycle.
- Reads use bounded memory caches, not T3's persistent stale-read cache. The shared cache
  holds at most 32 answers, retaining only answers up to 64 KiB encoded. Credentials have at
  most eight opaque scopes; reported states and observed thread views each cap at 2,048.
  Cached answers do not survive a restart. T3's ETag revalidation, token TTL, quota reserve
  and Unix-socket HTTP transport are not added here.
- Listings read repositories separately instead of using one cross-repository search. This
  costs more requests on a large project list. Requests still have bounded concurrency and
  pagination; statistics use T3's alias renderer.
- The code tab can read ordinary and paged patches. Single-file extraction from a withheld
  whole diff is not advertised. `diffFileContents` does serve ordinary unchanged-line
  expansion, including renamed, added and deleted files.
- Reports notify readers without trusting a client's state as a GitHub observation. The
  engine's automatic PR-link sync and watch reactors remain outside this panel step.
- No live macOS/iPhone client or signed-in Orbit container has been exercised in this step.

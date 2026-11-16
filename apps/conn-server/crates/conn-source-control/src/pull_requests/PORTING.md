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
| `comment`, `replyToThread`, `updateComment`, `setReaction`, `setThreadResolution`, `submitReview`, `update` | `Client.action`; fresh permissions where T3 checks them, generated mutations, subject ownership before edits and reactions |
| `requestReviewers`, `reviewerCandidates`, `labelCandidates`, `setLabels` | `Client.action`; fresh write/triage access, bounded candidate pages, ordered label removal |
| `stack` | `Client.stack`; detailed REST layers; only 404 means unsupported |
| `reviewGuide` | Panel handler plus `guides::load`; T3's stored guide and the current GitHub head |
| `invalidatedByMutation` | Panel call guard; scoped invalidation before and after writes, including failure and cancellation; successful writes notify the existing refresh stream |

These 33 RPCs register. Capabilities withhold `runAction`, stack actions and guide generation.
The existing five PR-link MCP tools keep using the engine; this step adds no MCP tool.

## Proof

`tests.rs` uses the crate's stub `gh` and loopback HTTP server. It checks credentials' CLI
arguments, generated documents and headers, aliased batches, missing slices, pagination ties,
hidden remarks, reactions, thread ownership, merge-base expansion, changed-file guards,
viewed-file pagination and ordered toggles. The server's panel tests check the typed RPC
results, routing, refreshes, bounded caches, state-report deduplication and permissions. The
HTTP test checks the read scope and typed error status.

`tools/gen-pr-cases.mjs` records 133 cases from T3's own normalization functions, including
review ranges, subject ownership, candidates, malformed stacks and credential requirements.
Its `pr-action-recordings.mjs` also runs T3's real GitHub API implementation on an in-memory
HTTP client: 33 traces cover write documents, variables, REST paths, methods, bodies and
GitHub refusals. Rust tests compare the requests and failure details exactly. This exposed
and fixed the shared helper's missing `operationName`, discarded API error messages and
overly broad GraphQL not-found classification. `tools/check.sh` checks both recordings for drift.
The reaction cases come from the contract's literals; a new one must be implemented too.
Panel capabilities are compared with T3's provider, with explicit omissions for unserved features.

`pr-guide-recordings.mjs` writes and reads a guide through T3's actual SQLite repository. It
records the table definition, stored JSON and decoded guide. The Rust RPC reads that row from
the supplied state directory's `statev2.sqlite` with a read-only connection on a blocking
thread, with a 256 KiB SQLite cache and an 8 MiB row limit. Missing databases, tables and rows
mean no stored guide; malformed rows fail with T3's read error. No guide data stays cached.
Tests cover every section, model options, restart, stale versus current head, absence and
corruption. Generation is unserved, so there is no running generation to report.

The Rust action tests also cover fresh permissions, self-review refusal, read-only labels,
wrong-PR subjects, signed-out credentials and failed writes. Panel tests cover typed success
and failure results, routing, notifications, and invalidation on success, failure and
cancellation. Every registered RPC has a call in `effect-client.mjs`, which uses the real
client's decoders. Tests never use a real login, model or GitHub API.

## Differences and remaining work

- `runAction` stays unregistered. Serving it completely needs GitHub's guarded stack action
  and rebase paths, branch deletion checks, workflow approval limits, merge confirmation and
  the engine's merge observation/link synchronization. This change does not offer a subset
  of those actions under a method that accepts them all.
- `generateReviewGuide` stays unregistered. The Rust text generator supports titles, not
  T3's review-guide generation interface. Generation still needs an owned background run,
  guarded scratch checkout/fetch lifecycle, normalization against the actual diff and a
  guide write path. `reviewGuide` reads existing stored guides without inventing one.
- Preserved T3 quirk: replies and resolution send the thread ID directly after the named PR's
  access check. T3 checks node ownership for reactions and comment edits, but not these two
  thread mutations. GitHub remains authoritative on the mutation itself.
- Reads use bounded memory caches, not T3's persistent stale-read cache. The shared cache
  holds at most 32 answers, retaining only answers up to 64 KiB encoded. Credentials have at
  most eight opaque scopes; reported states and observed thread views each cap at 2,048.
  Cached answers do not survive a restart. T3's ETag revalidation, token TTL, quota reserve
  and Unix-socket HTTP transport are not added here. Immutable PR node IDs are read on each write.
- Listings read repositories separately instead of using one cross-repository search. This
  costs more requests on a large project list. Requests still have bounded concurrency and
  pagination; statistics use T3's alias renderer.
- The code tab can read ordinary and paged patches. Single-file extraction from a withheld
  whole diff is not advertised. `diffFileContents` does serve ordinary unchanged-line
  expansion, including renamed, added and deleted files.
- Reports notify readers without trusting a client's state as a GitHub observation. The
  engine's automatic PR-link sync and watch reactors remain outside this panel step.
- No live macOS/iPhone client or signed-in Orbit container has been exercised in this step.

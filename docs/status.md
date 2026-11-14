# Status

**The work is active.** It was parked on 2026-11-13 and Nick resumed it on 2026-11-14. This file
says where the work stands, what is proven, and what is left, in order. Keep it true: update
it with every merged step.

Nothing in the Conn repository depends on this repository yet. No container, desktop or mobile
client uses the Conn Server.

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

`main` is in a working state. `tools/check.sh` passes 27 checks with `CONN_MONOREPO` set (Conn `b12470dcad`, 2026-11-14).

| Part | State |
| --- | --- |
| RPC methods | 89 of 236 served; 88 have a run that the real client's decoders accept |
| Engine commands | 43 of 56 |
| HTTP routes | 13 of 57 |
| `/mcp` tools | 20 of 87 |
| Providers | Claude and Codex, of the 10 the T3 server has without Pi |

Proven:

- **Claude** runs through Anthropic's official Claude Agent SDK in the SDK host
  (`helpers/sdk-host`). In 13 scenarios the `claude` CLI gets the same argv, environment and
  stdin as from the T3 server. 18 of the T3 server's 39 Claude transcripts pass (all that the
  driver runs). 11 live tests
  pass on Claude Haiku on macOS.
- **Codex** runs on `codex app-server`, as in the T3 server. 35 scenarios show no difference,
  20 of them the T3 server's own recordings. **No live Codex turn has run.**
- Orbit's container flow (start, add a project on the running server, a Swamp session, a
  thread through `/mcp`, wait, read, revoke, SIGTERM with no child left) passes on the fake
  provider and once with a live Haiku turn, on macOS.
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
  changes ran only as the same commands on Beast); Orbit in a real container; the cause of
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
- Orbit's flow in a real container.
- Codex on CLI 0.166 or 0.167 (the recordings are from 0.156).

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
`stop_task`, `await_background_tasks`, `background_work.updated` (Claude reports no roster).

## Checkpoints, rollback and fork (2026-11-14)

Each turn is captured as a git checkpoint the T3 way (`conn-vcs` `checkpoint.rs`, engine
`checkpoint.rs`): T3's refs in the workspace's own repository, a scratch index, a baseline
before the provider turn, the run `waiting` until the capture completes it, a `checkpoint`
turn item with the changed files. `getTurnDiff` and `getFullThreadDiff` are served.
`checkpoint.rollback` (provider rollback, file restore in an isolated worktree, stale refs,
`rolled_back` runs, `rollbackFailure`) and `thread.fork` (native fork only) are handled.
Proofs: engine tests on scratch repositories, `client-check.mjs` (changed files, a rewind, a
fork's lineage and graph through the client's own code), `effect-client.mjs` for both diff
methods. Not proven: T3's recorded `thread_rollback`, `thread_fork_native*` and
`thread_merge_back_siblings` scenarios through our engine (they need the replay driver of item
4); a live Claude or Codex rollback or fork. Measured (macOS, 50 fake turns, one file each, a
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
   server passes none); Claude's background roster
   (`background_work.updated`, `stopTask`, `awaitBackgroundTasks`: in the trait, not built in
   the provider).
3. **Other providers.** One ACP provider for Grok, Kiro, fx, Antigravity and the ACP registry:
   `crates/conn-provider-acp`, **Grok built (2026-11-14), not yet offered by the server.** The
   trial ruled out the official schema crate: it cannot express T3's negotiating `initialize`
   and costs 565 KiB on the release binary; the crate uses its own JSON-RPC with T3's key order.
   Proven: 10 of the 15 Grok transcripts replay with every frame and event equal to T3's (the 5
   others need background tasks, monitors and subagents, listed); a stub agent sees the same
   argv, environment, stdin bytes and shutdown from T3's Grok adapter and ours in all 10
   scenarios. Next, in order: Grok's server entry (T3 probes the CLI), its background work and
   subagents, ACP protocol 2 replies for Kiro, then fx, Antigravity, the registry and its 11
   `server.*` methods, and the file and terminal host (`ProviderHost`). See the crate README.
   Cursor, OpenCode and Muse go in the SDK host as driver modules.
4. **Replay of the T3 server's `testkit` fixtures** (172 transcripts) through our providers and
   engine, Codex first. Upstream's own assertions ran by hand on a projection from our engine
   and passed. It needs an event export without pruning and a clock seam in the engine.
5. **Engine.** Bounded thread snapshots and the `/history`, `/bounded` and `/transcript`
   routes (a full snapshot of a long thread peaks at about 13 bytes per byte of JSON);
   merge-back and the portable fork path (both need T3's `ContextHandoffService`); prepared
   runs and setup scripts in a `setup-<id>` terminal; a workspace strategy for delegated tasks; search details (no NFC normalization, the old snippet rule). Seen with
   the real client: a provider turn shows as running only after the CLI's first event (about
   3.5 s on a cold start; the T3 server marks it at once), so the client offers "Send now" on
   a queued message later; no title generation, so a thread
   keeps its first message as title.
6. **Features.** Pull requests and source control: `crates/conn-source-control/README.md` maps
   the area (48 methods, 7 engine commands, 9 `/mcp` tools, 7 hosts). Served (2026-11-14):
   `server.discoverSourceControl` for all 7 hosts, and 6 of 9 `sourceControl.*` (sign-in as a
   T3 server without an app client id; GitHub stars). Next: each host's repository operations
   (`lookupRepository`, `cloneRepository`, `publishRepository`), then `git.*`, `pr` in VCS
   status, `pullRequests.*` (35), the linked pull request commands and the `/mcp` tools.
   Also: the Conn-only methods
   (annotations, panels, scheduled tasks, peer links, test logins, credentials, secrets, guest
   share); 67 more `/mcp` tools (11 need nothing new: `crates/conn-mcp/README.md`, "All 87 tools"); Codex subagents and MCP elicitation; worktree setup scripts
   the T3 way (typed into a thread terminal, with a completion marker).
7. **Small leftovers.** Limits on terminal environment variables; string caps on
   `assets.createUrl`; finished `git` children stay unreaped while the server runs;
   T3's search ranking (`scoreThreadSearch`, `rankMessageMatches`) for `t3_thread_search` and
   `orchestration.searchThreads`; `@` file search ranks with nucleo, not T3's fff (`@hello`
   finds `hello.ts`, T3 also `helper.ts`); `server.listTextGeneratorModels`, without which the
   client's "Add text generator" wizard cannot save; the Claude model list is not filtered by
   the CLI's version; the Linux systemd scope for provider processes;
   a cap on the blocking pool or one store thread (measure first: each store call takes its
   own blocking thread).
8. **Proofs.** Live Codex; the Linux pass; Orbit in a scratch container on Beast; desktop and
   mobile in a VM; the recorder scenarios on Linux. The recorder with the real web client and
   a live model is done (2026-11-14, see "What exists").
9. **Upkeep.** Wire the bump into the nightly sync (its script is outside the Conn
   repository; `FORK.md` there says the Grok bot runs it). The first real bump
   (2026-11-14, `docs/upkeep.md` "Bumps") took about four hours. The provider gaps it left:
   reaping a recorded Claude CLI after a restart, Claude
   Monitor wakes, `workState: "waiting_for_children"` in `/mcp`.

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

- `main`: verified. All 24 checks pass on macOS, and all tests pass on Linux (20 runs on the
  gnu target and 5 on musl, on 2026-11-14).
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

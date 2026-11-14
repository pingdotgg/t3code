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

`main` is in a working state. `tools/check.sh` passes 24 checks with `CONN_MONOREPO` set (Conn `b12470dcad`, 2026-11-14).

| Part | State |
| --- | --- |
| RPC methods | 81 of 236 served; 80 have a run that the real client's decoders accept |
| Engine commands | 41 of 56 |
| HTTP routes | 13 of 57 |
| `/mcp` tools | 16 of 87 |
| Providers | Claude and Codex, of the 10 the T3 server has without Pi |

Proven:

- **Claude** runs through Anthropic's official Claude Agent SDK in the SDK host
  (`helpers/sdk-host`). In 10 scenarios the `claude` CLI gets the same argv, environment and
  stdin as from the T3 server. 15 of the T3 server's 39 Claude transcripts pass. 11 live tests
  pass on Claude Haiku on macOS.
- **Codex** runs on `codex app-server`, as in the T3 server. 35 scenarios show no difference,
  20 of them the T3 server's own recordings. **No live Codex turn has run.**
- Orbit's container flow (start, add a project on the running server, a Swamp session, a
  thread through `/mcp`, wait, read, revoke, SIGTERM with no child left) passes on the fake
  provider and once with a live Haiku turn, on macOS.
- The real web client paired, ran turns, approvals, stop and a restart against an early
  version (the spike). The recorder scenarios have not run against the current `main` with a
  live model.
- Memory on macOS arm64: the server about 3 to 5 MB private; the SDK host about 45 MB while a
  Claude session is open, and no Node process when none is open.

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

## What is left, in the planned order

1. **Rust hygiene, step 1.** The lint set of BeautifulRust (`lints/beautiful-rust/`), stage 1:
   `unwrap_used`, `panic_in_result_fn`, `allow_attributes`, `allow_attributes_without_reason`,
   `dbg_macro`, `todo`, `wildcard_imports`, `string_add`, `missing_assert_message`,
   `redundant_clone`, `rc_buffer`, `missing_debug_implementations`, `unreachable_pub`,
   `rust_2018_idioms`, plus `large_futures`. Measured with clippy 0.1.95: 533 warnings, most
   fixed by `cargo clippy --fix`, 162 by hand. Stage 2: the `bool` parameter lints (56 hits at
   BeautifulRust's limit of zero), `clone_on_ref_ptr` (110), the print lints with a `tracing`
   switch, `clippy::all` and `clippy::pedantic`. Stage 3: the cast lints (about 295 places).
   The `[lib]` lints stay off. Also in step 1: typed construction at the 7 places that build a
   contract error with `from_json(json!(..)).expect(..)`; `thiserror` on eight boundary error
   types; a `conn-support` crate for the time, hex, HMAC and base64 helpers that exist 2 to 6
   times; the `uuid` crate; the store's sequence counter that is not restored when a commit
   fails; a `Drop` on `CodexSession`; an unchecked offset in `reads.rs`; a pinned toolchain.
2. **Provider interface.** A sandbox and approval policy (closes Claude's read-only sandbox and
   `dontAsk`, and 3 failing transcripts); MCP servers at session open; a host handle for
   agents that ask the server for files and terminals; `background_work.updated`; a
   selection-transition hook; `stop_task` and `background_tasks`. Move the Rust side of the
   SDK host (`helper.rs`) into `conn-provider-support` before a second SDK driver.
3. **Other providers.** One ACP provider for Grok, Kiro, fx, Antigravity and the ACP registry.
   The T3 server offers ACP protocol version 2 with version 1 as fallback and uses a
   hand-written client. The official Rust crate (`agent-client-protocol` 5.2.0) runs on a
   current-thread runtime but defaults to version 1 and adds about 525 KiB: use its schema
   crate for types and our own JSON-RPC, and start with a trial that replays one of the T3
   server's Grok transcripts. Cursor, OpenCode and Muse go in the SDK host as driver modules.
4. **Replay of the T3 server's `testkit` fixtures** (172 transcripts) through our providers and
   engine, Codex first. Upstream's own assertions ran by hand on a projection from our engine
   and passed. It needs an event export without pruning and a clock seam in the engine.
5. **Engine.** Bounded thread snapshots and the `/history`, `/bounded` and `/transcript`
   routes (a full snapshot of a long thread peaks at about 13 bytes per byte of JSON);
   checkpoints and diffs per turn; rollback, fork and merge-back; a model change during a
   turn; a workspace strategy for delegated tasks; search details (no NFC normalization, the
   old snippet rule).
6. **Features.** `pullRequests.*` (34), `sourceControl.*` and `git.*`; the Conn-only methods
   (annotations, panels, scheduled tasks, peer links, test logins, credentials, secrets, guest
   share); 71 more `/mcp` tools; Codex subagents and MCP elicitation; worktree setup scripts
   the T3 way (typed into a thread terminal, with a completion marker).
7. **Small leftovers.** Limits on terminal environment variables; string caps on
   `assets.createUrl`; finished `git` children stay unreaped while the server runs;
   `t3_thread_search` on the engine's search; the Linux systemd scope for provider processes;
   a cap on the blocking pool or one store thread (measure first: each store call takes its
   own blocking thread).
8. **Proofs.** The recorder with the real web client and a live model; live Codex; the Linux
   pass; Orbit in a scratch container on Beast; desktop and mobile in a VM.
9. **Upkeep.** Wire the bump into the nightly sync (its script is outside the Conn
   repository; `FORK.md` there says the Grok bot runs it). The first real bump
   (2026-11-14, `docs/upkeep.md` "Bumps") took about four hours. The provider gaps it left:
   Codex Stop with "Force stop" (needs an interrupt-timeout error in the provider trait and
   an unresponsive Stop in the engine), reaping a recorded Claude CLI after a restart, Claude
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

- `main`: verified. All checks pass on macOS.
- `parked/rust-hygiene-step-1`: one finished commit (the generator writes one reasoned `allow`
  at the top of the generated file) and one commit marked `WIP (not proven)`.
- `parked/linux-pass`: the first Linux pass. Its four proven commits are merged into `main`.
  Its `memory-flow.mjs` commit was finished in the second pass, which made the
  `README.md` memory table with it.
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

CI: on 2026-11-13 the test step passed on Linux in one run and failed in the next on the
terminal byte-window test, which is fixed since. The rust job now installs the SDK host first
(Node 26.12.1, `npm ci`), so its provider tests run instead of skipping, and the recordings
decode step runs even after a test failure. These changes have not run in CI yet; the same
commands pass on Beast. `cargo-deny` and the musl release build pass. The nightly schedule
is switched off until the job with the Conn checkout can run: it needs the repository secret
`CONN_READ_TOKEN` (read access to `nckrtl/conn`).

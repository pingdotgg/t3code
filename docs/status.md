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

`main` is in a working state. `tools/check.sh` passes 31 checks with `CONN_MONOREPO` set (Conn `b12470dcad`, 2026-11-14; 31 since the text generation check). The source control part 4 branch adds two (`gen-graphql --check`, `registry-diff`): 33.

| Part | State |
| --- | --- |
| RPC methods | 99 of 236 served; 99 have a run that the real client's decoders accept |
| Engine commands | 43 of 56 |
| T3 testkit fixtures through this engine | 42 of 159 variants pass T3's own assertions (Claude 24 of 34, Codex 17 of 25, Grok 1 of 15; the other 85 are providers this server does not offer) |
| HTTP routes | 13 of 57 |
| `/mcp` tools | 33 of 87 |
| Providers | Claude, Codex and Grok, of the 10 the T3 server has without Pi |

Proven:

- **Claude** runs through Anthropic's official Claude Agent SDK in the SDK host
  (`helpers/sdk-host`). In 14 scenarios (and one more with `JAVA_HOME` set) the `claude` CLI
  gets the same argv, environment (with the login shell's `PATH`, `__MISE_DIFF` and
  `JAVA_HOME`) and stdin as from the T3 server. 18 of the T3 server's 39 Claude transcripts pass (all that the
  driver runs). 11 live tests
  pass on Claude Haiku on macOS.
- **Codex** runs on `codex app-server`, as in the T3 server. 37 scenarios show no difference,
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
`runNow` stops with its caller and records a failure, as T3 (2026-11-14). Not built: webhook
tasks (refused on save; `crates/conn-features/README.md` maps what is left). `fresh_session` tasks are served since part 2 of the engine work (below). Annotations
(`annotations.*` and the four `annotations_*` tools) on the T3 server's own files, also with
parity. `docs/conn-only-areas.md`
maps the Conn-only areas and what each needs.

## Text generators and thread titles (2026-11-14)

Nick decided to serve text generators as the T3 server does. `server.listTextGeneratorModels`
is served, so the client's "Add text generator" wizard can save; saving, changing and removing
a generator was already served by `server.updateSettings` (3 more `settings-diff` cases).
Thread titles are generated through a text generator: T3's prompt (generated from
`buildThreadTitlePrompt`), its reply rules, three tries for a first title. When the title model
is an agent provider (Codex by default, or Claude), the T3 server asks that provider; this
server does not call it, and the thread keeps its seed title. The key stays in `settings.json`
with the other settings secrets, or in the T3 server's secret store when a T3 server moved it.
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
  30 s); only the last failure sets `rollbackFailure` (T3's `EffectWorker`). As in T3, a
  failure after the provider rolled back (in the file restore) retries the provider rollback
  too. Proof: `a_rollback_that_fails_twice_then_works_is_retried`; the failing test now
  expects 5 tries.
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
   server passes none); the rest of Claude's background work: subagents in the roster,
   monitors' and tasks' wakes, `stopTask`, `awaitBackgroundTasks` (in the trait, not built in
   the provider), and a Stop with no running turn (T3's `requestRuntimeRestart`).
3. **Other providers.** One ACP provider for Grok, Kiro, fx, Antigravity and the ACP registry:
   `crates/conn-provider-acp`. **Grok is offered by the server (2026-11-14):** T3's default
   `grok` instance, off until `providerInstances.grok` enables it, probed as T3 probes the CLI
   (`--version`, `models`, `inspect --json`, an ACP `initialize`) at start, on a settings change,
   every 5 minutes and on `server.refreshProviders`, with `providerStatuses` on config streams.
   The trial ruled out the official schema crate: it cannot express T3's negotiating
   `initialize` and costs 565 KiB on the release binary; the crate uses its own JSON-RPC with
   T3's key order. Proven: 10 of the 15 Grok transcripts replay with every frame and event
   equal to T3's; a stub agent sees the same argv, environment, stdin bytes and shutdown from
   T3's Grok adapter and ours in all 10 scenarios; T3's status probe and ours give the same
   entry and the same CLI runs in 14 of 14 stub scenarios (missing, hanging, failing, old,
   logged out, ready, …); the real client decodes the probed entry. Not ported on purpose:
   T3's Grok account and usage read (credentials and xAI's API) and the version advisory (a
   registry lookup). `/compact` is served since part 3 (below). Next, in order: Grok's
   background work and subagents (the 5 failing
   transcripts; the crate README has a map of T3's mechanism), ACP protocol 2 replies for
   Kiro, then fx, Antigravity, the registry and its 11 `server.*` methods, and the file and
   terminal host (`ProviderHost`; in T3 only Antigravity's files and the registry's terminals
   use it). Cursor, OpenCode and Muse go in the SDK host as driver modules.
4. **Replay of the T3 server's `testkit` fixtures: done (2026-11-14), Claude, Codex and Grok.**
   See "Engine, part 2", "Codex: the turn start, …" and "ACP provider, part 3". Next: T3's
   buffered delivery in the engine (9 Grok variants), Codex subagents (6), a replay gate in the
   stand-ins (3 + 4 Grok variants), the `queued_turn` tie (2; a provider clock seam is not
   enough).
5. **Engine.** Merge-back and the portable fork path (both need T3's `ContextHandoffService`);
   prepared runs and setup scripts in a `setup-<id>` terminal; bounded thread snapshots and the `/history`, `/bounded` and
   `/transcript` routes (a full snapshot of a long thread peaks at about 13 bytes per byte of
   JSON); a workspace strategy for delegated tasks; search details (no NFC normalization, the
   old snippet rule); titles only through a text generator (an agent title model keeps the seed
   title; no fork source or linked pull request context in the prompt). `freshContext` is
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
   share); 67 more `/mcp` tools (11 need nothing new: `crates/conn-mcp/README.md`, "All 87 tools"); Codex subagents; worktree setup scripts
   the T3 way (typed into a thread terminal, with a completion marker).
7. **Small leftovers.** Done on 2026-11-14 (`docs/server-area.md`, end): the contract's
   limits on terminal environment variables and `assets.createUrl` strings (generated,
   `limits-diff` check); `git` children are reaped (a test). Left:
   T3's search ranking (`scoreThreadSearch`, `rankMessageMatches`) for `t3_thread_search` and
   `orchestration.searchThreads`; `@` file search ranks with nucleo, not T3's fff (`@hello`
   finds `hello.ts`, T3 also `helper.ts`); the Claude model list is not filtered by the CLI's version (needs a CLI version probe in
   the provider); the Linux systemd scope for provider processes;
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

- `t3/44de3066` (source control part 4, 2026-11-14, not merged): all 33 checks pass on macOS
  (`check exit: 0`, none skipped). See "Source control, part 4".

- `t3/32cd278b` (text generators, titles, `runNow`, the redacting `Debug`): all 31 checks pass
  on macOS (2026-11-14). No new dependency; the release binary grew by 93,648 bytes
  (16,558,944 to 16,652,592, macOS arm64).
- `main`: verified. All 31 checks pass on macOS (2026-11-14, with the ACP provider, scheduled
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

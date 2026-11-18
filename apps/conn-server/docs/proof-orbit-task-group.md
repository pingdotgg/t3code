# Proof: an Orbit task group on the Conn Server

**Result: pass.** On 2026-11-18 one real Orbit task group ran end to end in a task copy whose
agent server was `conn-server` 0.2.0. Orbit used the same RPCs it uses with the T3 server.
Every field Orbit reads has the same shape. No Conn Server defect was found. The work was
merged: nckrtl/website PR #26 (`ea79804`).

## Setup

- Project 20 (`nckrtl`, `container_server: conn`, ADR 0258). Live Gateway `126f2286adef`;
  its recipe pins `conn-server-v0.2.0`. Beast's agent folder `2d3759fd7ef7` holds it.
- Task group 5919, "Update dependencies", subtask 5920. Copy Instance 3729 (container
  `instance-3729`, Incus project `orbit-instances`), cloned from default Instance 53 in about
  20 s. Its `t3.service` runs `conn-server serve --host=0.0.0.0 --port=3773 --no-browser`;
  `intent.turn.t3` is `/opt/orbit-agent/current/agent/bin/conn-server`.
- Implementer: Claude Opus 5.5, effort medium (provider instance `claudeMedium`). Reviewer:
  Codex `gpt-6.2-astra`, effort high (`codexHigh`). Startup log: 163 of 237 methods, 14
  provider instances (Claude and Codex at every effort, plus `grok`).

## Steps

| # | Step | Orbit Operation | Result |
| --- | --- | --- | --- |
| 1 | Copy create from the default | `instance.create` 29012 | pass |
| 2 | Baseline check | `tasks.check` 29015 | ran; 44 tests already failed on `main` (Project seed, see Findings) |
| 3 | Implementer turn, new thread, asks one question | `tasks.copy_turn` 29018 | pass: `state: asking_for_input`, one question stored, run 1 `interrupted` |
| 4 | Answer the question | `tasks.copy_turn` 29020 | sent; then Stopped (step 5) |
| 5 | Stop mid-turn (Operation cancel) | cancel of 29020 | pass: Orbit ended the turn at once; the next turn's settle step stopped run 2 with `run.interrupt` (`interrupted` at 22:37:55, `settled: [29020]`) |
| 6 | Continue | `tasks.copy_turn` 29022 | `tasks.turn_failed`: the Claude CLI died (SIGABRT, `claude_process_exited`) when fork failed (see Findings). Conn reported the run `failed`, as T3 would |
| 7 | Continue | `tasks.copy_turn` 29030 | pass: `state: done`, 104 Composer packages and the ranged npm packages updated, Pest 148/148 |
| 8 | Handoff check | `tasks.check` 2875, 2876 | 2876 passed (`5bc32e4`) |
| 9 | Codex reviewer turn | `tasks.copy_turn` 29051 | pass: `codexHigh`, `state: done`, verdict APPROVE |
| 10 | Freeze while idle (Incus pause 10 s) | none | pass: projection identical before and after (same SHA-1); Gateway index read `conn.server_unreachable` while frozen, `read_error: null` after |
| 11 | Freeze during a turn (30 s, during a running run) | `tasks.copy_turn` 29078 | pass: the run finished `done` after the thaw |
| 12 | Thread index and projection after wake | `conn:thread:list --instance 3729` | pass: both threads `completed`, `needs_input: false`, times set |
| 13 | Close | `tasks.cancel` 29082 (discard), `instance.destroy` 29083 | pass |

Orbit's `instance:sleep` refuses a task copy (`instance.lifecycle_busy`: a task runs), so
steps 10 and 11 froze the container directly with `incus pause` and `incus start`, the freeze
Orbit's sleep uses.

## RPCs Orbit used

Commands run as Orbit's `copy_exec` (`runuser -u agent`, `env -i HOME=/home/agent`). The T3
column comes from the same commands in a Project 78 task copy (Instance 3715, stock `t3`
v0.1.7), compared by key path with null and typed values treated alike.

| RPC | Exit | Fields Orbit reads | Conn vs T3 |
| --- | --- | --- | --- |
| `thread list --project /srv/workspace --json` | 0 | `threadId`, `title`, `status` | Same; Conn adds `blockedOnThreadWait`, `pendingBackgroundTasks`, `pinned`, `pullRequestCount`, `openPullRequestCount` |
| `thread show --messages 200 --json THREAD` | 0 | `thread`, `messages[].role/text/runId` | Same; Conn adds the five fields above and `lastTitleRegeneration` |
| `thread send --wait --json` | 0 | the turn's end state, run ID | Same; turns 29018, 29030, 29051, 29066, 29078 |
| helper `create` (`orchestration.subscribeShell`, `thread.create`) | 0 | `projects[].workspaceRoot/id/archivedAt` | Works; Conn omits a null `archivedAt` (JavaScript reads `undefined == null` as true) |
| helper `read` (`orchestration.getThreadProjection`) | 0 | `runs[].id/status`, `runtimeRequests[].id/kind/status/nodeId`, `nodes[].runId`, `turnItems[]` of type `user_input_request` with `questions` | Same key paths |
| helper `interrupt` (`run.interrupt` + readback) | 0 | `interrupted`, `runs`, `pending` | Works: run 1 `interrupted`, its `user_input` request `cancelled` |
| helper `stop` (settle step) | 0 | `stopped`, `over`, `state` | Works: run 2 `interrupted` |
| `auth session issue --scope ... --ttl 1m --json` / `auth session revoke` | 0 | `token`, `sessionId` | Same; every helper call above depends on it |
| `GET /api/orchestration/shell`, protocol 2 (Gateway idle read and thread index) | HTTP 200 | `threads[]`, `archivedThreads[]`, `status`, `activityRunStatus`, `pendingRuntimeRequest`, `pendingBackgroundTasks`, `blockedOnThreadWait`, `latestUserMessageAt`, `latestRunCompletedAt` | Every field present in both. Conn adds `activeOrderKey`, `lastTitleRegeneration`, `latestRunBackgroundWake`, `tags`; it omits null project fields (`archivedAt`, `faviconPath` and others) that Orbit does not read |

## Memory per container

Sampled every 15 s (118 samples, RSS):

| Process | Conn Server copy | Stock T3 copy (Instance 3715, during a turn) |
| --- | --- | --- |
| Agent server | `conn-server` 12 to 25 MiB | `t3 serve` 445 MiB |
| `thread send --wait` CLI | not sampled | 254 MiB |
| Claude SDK host (only while a Claude session lives) | up to 93 MiB | in the server |
| `claude` CLI | up to 262 MiB | same CLI |
| Codex app-server | up to 182 MiB | same CLI |

## Findings

None is a Conn Server defect.

1. **Continuation runs.** When Claude runs a shell command in the background, Conn starts a
   provider continuation run when it ends (runs 6 and 8, `message:provider-continuation:*`).
   `thread send --wait` followed it, and Orbit read the continuation's reply. Not compared
   with T3 here.
2. **Project 20: Pest browser tests leak Playwright servers.** Each full Pest run leaves about
   36 `playwright run-server` processes (11 tasks each). In `t3.service` they reached systemd's
   default `TasksMax` (614 = 15% of the container's 4096), and fork failed: step 6. Stock T3
   has the same unit and limit. This needs a fix in the Project's browser tests.
3. **Project 20's seed lacks `node_modules/satori`.** 44 of 148 tests fail on `main` in a fresh
   copy until `npm ci` runs; `npm ci` also needs `npx playwright install chromium`
   (`PLAYWRIGHT_BROWSERS_PATH=0`).
4. **Orbit: Project 20 cannot publish from a copy.** The reviewer's publish answered
   `tasks.copy_publish_held`: Project 20 is not on `ORBIT_TASKS_COPY_PUBLISH_PROJECTS`. The PR
   was published by hand from a bundle of the reviewed commit, and the group was cancelled
   with discard.
5. **Orbit: a task copy cannot sleep.** `instance:sleep` answers `instance.lifecycle_busy`
   while the task is open.

6. **Orbit: the Conn launch path will refuse a Conn Server.** `t3_copy_rpc.mjs`
   `launchIdentity` accepts only `serverVersion === "0.1.7"`; the Conn Server reports its
   contract version, `0.1.10` (`conn_contract::T3_SERVER_VERSION`). Conn's launch through
   Orbit (`inspect-launch`, `launch`) would answer `conn.launch_server_changed` on Project 20.
   Task groups do not use this path. Read in code; not run.

## Not proven here

- Grok idle state: no Grok turn ran.
- The Conn launch path (finding 6).

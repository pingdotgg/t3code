# The Orbit profile: what Conn needs from the Conn Server

Research for Nick and the Orbit orchestrator, 2026-11-14. It changes no code. It proposes;
it decides nothing.

Every statement carries its source:

- **[measured]**: a command run for this document. The method is named.
- **[code]**: read in code. A path is given. `M/` is the Conn monorepo at the pin
  (`b12470dcad`). `O/` is a shallow clone of `hardimpactdev/orbit`, taken on 2026-11-14.
  `R/` is this repository.
- **[docs]**: read in a document. A path is given.
- **[brief]**: a fact from the orchestrator's brief. I did not check it.
- **[estimate]**: my estimate. The basis is given.

## The answer

The direction this document serves is Nick's latest lean: **a loose fork of T3 Code.** Conn
keeps its client stack. In the end it uses only the Conn Server. It changes what it must for
Orbit. Upstream changes come in when we choose. The client and the server move as one
pinned pair.

| Target | Methods to build | `/mcp` tools to build | HTTP routes to build | Rough size [estimate] |
| --- | --- | --- | --- | --- |
| (a) Orbit container only | **0** of 67 needed (all served); 1 useful method remains | **0** needed or useful | **0** needed; 3 useful routes remain | Profile remainder not re-estimated; Orbit additions about 2 to 4 k (section 4) |
| (b) Container and host, what the client really uses | **15** needed (51 with the useful ones the rip-out list keeps) | **9** needed (17 with the useful ones) | **0** needed (11 with the useful ones) | Remaining work not re-estimated |
| (c) Full parity with the T3 server | **68**, including 1 unclassified method | **17** | **38** | Remaining work not re-estimated |

The dated size basis is about 140 k lines of Rust [measured on 2026-11-14, `wc -l` over
`crates/*/src`]. Current coverage is 169 of 237 methods, 70 of 87 tools and 19 of 57 HTTP
contract routes, plus seven endpoints outside that HTTP contract. The original size
estimates are not estimates of the remaining work. Section 2 gives the current gaps;
section 3 keeps the dated binary measurements.

Five points carry the rest of the document:

1. **A container is already served.** Every method a container needs is served, and since
   2026-11-14 every `/mcp` tool too: `t3_background_wait`, which our Claude instructions tell
   the agent to call, is served as T3 serves it. A Stop during a Claude cold start now ends the
   run at once, as in T3 (it waited for the boot, up to about 6.5 minutes).
   Orbit's task-turn path also uses four CLI items; they are built (section 1b).
   **Proven in a container on 2026-11-15** [measured, Beast]: in a container made from
   Orbit's Instance image, Orbit's create flow and task-turn path give the same exit codes and
   the same fields Orbit reads as the image's own T3, after two fixes found there (an abort 5
   minutes after start; a turn lost to a systemd restart). The server holds 2.8 MiB anon
   (15.8 MiB `Pss` with its binary's pages) against 353 to 376 MiB for T3, and answers 90 ms
   after its start against 1.1 to 2.0 s. `docs/status.md`, "Proof on Beast".
2. **Selectivity buys little in bytes.** The macOS release binary is 17.1 MB; the Linux musl
   binary 22.9 MB [measured, 2026-11-15]. The generated
   contract is 36% of its code, and SQLite is 15%. Turning off everything a container does
   not need saves about 3 to 4% [estimate from a symbol map]. It saves about 8% of the
   upstream churn we follow. The real lever on upkeep is the loose fork, not a container
   build.
3. **The three Orbit additions that save the most** (section 4): a credential that the
   Gateway signs, which ends pairing, hourly renewal and vault round trips; start-up from
   files Orbit writes, which ends the `t3` CLI calls in `clone-t3`; and Swamp on `/mcp`
   with a service credential, which ends the CLI and WebSocket workaround for task turns.
4. **Maintenance.** The host target (b) still needs 15 methods and 9 tools, and no HTTP
   route; their size has not been re-estimated. After that there is one server kind, and
   the contract is ours to change for Orbit. Orbit's workarounds go away. The upkeep becomes merges by
   choice plus a watch on the provider layer: 783 upstream commits and 58 k changed lines in
   30 days [measured].
5. **Some facts in the brief do not match Orbit's code or docs** (section 1b): the 6.9 s
   `clone-t3` step, about 1 s per CLI call, 6 s for 48 servers, and 408 to 496 MiB freed by a
   sleeping container. The five `claudeLow` to `claudeMax` instances apply to task copies
   only.

---

## 1. Who calls the server in a container, and for what

### 1a. The Conn client (a person works in a container thread)

The Electron main process makes **no** RPC calls. Every call comes from the web renderer
(`apps/web`) or the mobile app, through `packages/client-runtime` [code, `M/apps/desktop/src`;
a reference scan of all 236 tags].

| Surface | Methods and streams (one call site each) |
| --- | --- |
| Connection | `GET /.well-known/t3/environment` (`client-runtime/src/environment/descriptor.ts:13`), `subscribeServerConfig` (`rpc/session.ts:301`), `server.probe` (`:451`), `subscribeServerLifecycle` (`state/server.ts:755`), `subscribeAuthAccess` (`state/auth.ts:163`), `server.reportClientActivity` |
| Thread view | `orchestration.subscribeShell` (`state/shell.ts:628`), `subscribeThread` (`state/threads.ts:1005`), `getTurnItem`, `getOlderSettledThreads`, `getThreadFamily`, `getThreadTitles`, `getThreadLinkMetadata`, `getNativeChildWork`, `subscribeCommandOutput`, `getArchivedShellSnapshot`, `forceStopThread`, `stopWorkflow`, `getWorkflowScript` (`state/orchestration.ts:59-241`); HTTP `threads/:id/bounded` and `/history` (`boundedThreadSnapshotHttp.ts`, `threadHistoryHttp.ts`) |
| Composer | `orchestration.dispatchCommand` (`message.dispatch`, `thread.model-selection.set`, `runtime-mode.set`, `interaction-mode.set`; `operations/commands.ts:293-809`), `launchThread` (`:783`), `subscribePromptSuggestion`, `provider.uploadFeedback`, `secrets.answerRequest` |
| Attachments | `attachments.createUploadUrl`, `attachments.delete` (`state/attachments.ts:26,30`), `assets.persistChatAttachments`, `assets.createUrl` |
| Changed files and diffs | `review.getDiffPreview`, `getDiffFileContents`, `getBranchCommits` (`state/review.ts:36-116`), `orchestration.getTurnDiff`, `getFullThreadDiff`, `subscribeVcsStatus` |
| Review guides | `pullRequests.reviewGuide`, `generateReviewGuide` (`state/pullRequests.ts:619,1032`) |
| Terminals | `terminal.open/write/resize/clear/close/attach/observe` (`state/terminal.ts:58-119`), `subscribeTerminalMetadata` |
| Files and search | `projects.searchEntries/listEntries/readFile/writeFile/listIgnoredFiles/searchContents`, `filesystem.browse`, `filesystem.getMetadata`, `shell.openInEditor` |
| Checkpoints, rollback, fork | `dispatchCommand` with `checkpoint.rollback`, `thread.fork`, `thread.merge_back` (`commands.ts:1004-1102`) |
| Settings | `server.updateSettings`, `upsertKeybinding`, `removeKeybinding`, `listTextGeneratorModels`, `checkSecretSource`, `checkOtlpEndpoint`, the 11 ACP registry methods |
| Provider and model pickers | `providers` on `subscribeServerConfig`, `server.refreshProviders`, `server.updateProvider`, `provider.consumeResetCredit`, `server.getUsageSummary`, `refreshUsageRates` |
| Provider sign-in and install | `provider.auth.*` (7), `provider.install.*` (4), `provider.chatgpt.*` (3) (`state/server.ts:1493-1559`) |
| Source control and PRs | `pullRequests.*` (35), `git.*` (3), `sourceControl.*` (8 of 9; `cloneRepository` has no client caller), `projectClone.*`, `subscribeProjectClones`, `vcs.*` (9), `subscribeVcsBranch`, `subscribeWorktreeSetup`, `worktreeSetup.cancel` |
| Previews | `preview.*` (12), `subscribePreviewEvents`, `subscribeDiscoveredLocalServers` |
| Devices | `device.*` (10), `subscribeDeviceState` |
| Annotations, scheduled tasks | `annotations.*` (3), `scheduledTasks.*` (8) |
| Test logins, credentials | `testLogins.*` (5), `credentials.*` (2) |
| Peer links, guest share, relay | `peerLinks.*` (4), `guestShare.create`, `cloud.*` (2) |
| Other | `mcpApps.*` (4), `panels.*` (2), `agentSessions.*` (2), resource telemetry, storage cleanup, diagnostics, `server.getNpmRelease`, `updateServer*`, `commitDesktopUpdate`, `restart` |

Only one method has no client caller: `sourceControl.cloneRepository`. `server.getConfig`
appears only as a type; the client reads its config from `subscribeServerConfig`. Only mobile
calls `vcs.createWorktree`. About 75 methods are called from the web only.

### 1b. Swamp and the Gateway (Orbit, today)

Every call Orbit makes to the server in a container [code, `O/`]:

| Caller | Call | Purpose | Where |
| --- | --- | --- | --- |
| Image build | writes `t3.service`, `systemctl enable` | installs the unit | `apps/gateway/app/Domain/Instances/InstanceImage.php:76,94,332-356` |
| `clone-container` | Incus proxy `<wg ip>:<3800-3999>` → `:3773` | publishes the server | `swamp/scripts/instance_clone.py:540-557` |
| `clone-container` | writes `model.env`, `.claude.json`, `config.toml`, `settings.json`, `/etc/machine-info`, then `/etc/orbit/instance` last | the first boot starts the server | `instance_clone.py:361-369,662-666`; `InstanceContainer.php:397-485` |
| `clone-t3` | `systemctl is-active/start t3.service` | starts it if the boot did not | `swamp/scripts/instance_clone_guest.py:570-577` |
| `clone-t3` | `t3 auth session issue --label "Orbit Gateway" --token-only`, and the same for `"Orbit Swamp"` | two admin sessions | `instance_clone_guest.py:581-583` |
| `clone-t3` | `curl --retry 30 /.well-known/t3/environment` | waits for readiness | `instance_clone_guest.py:584-604` |
| `clone-t3` | `t3 project add /srv/workspace --title <name>` | the project | `instance_clone_guest.py:610-613` |
| `clone-sessions` | `GET /.well-known/t3/environment`, `GET /api/auth/session` per token | checks both sessions | `instance_clone_guest.py:631-672` |
| Hourly renewal | `incus exec … t3 auth session issue --label 'Orbit Gateway' --json`, then `/api/auth/session` | a new Gateway session | `apps/gateway/extensions/conn/src/ConnServiceProvider.php:66`; `swamp/workflows/workflow-operation-conn-environment-renew.yaml:94` |
| Gateway registration | `GET /.well-known/t3/environment`, `/api/auth/session` | `POST /conn/environments` | `extensions/conn/src/Infrastructure/HttpT3ServerClient.php:34,50` |
| Thread index (each minute, **off by default**) | `GET /api/orchestration/shell` with `x-t3-orchestration-protocol: 2`, all servers at once | `GET /conn/threads` | `HttpT3ServerClient.php:79-101`; `docs/reference/conn.md:349` |
| Idle sleep | `GET /api/orchestration/shell` | is the agent active? | `Domain/ConnAgentActivity.php:37` |
| Pairing | `POST /api/auth/pairing-token` | device link | `workflow-operation-conn-pairing-create.yaml:87` |
| Held session | `POST /api/auth/pairing-token`, then `POST /oauth/token` | the Gateway pairs itself | `workflow-operation-conn-session-hold.yaml:92,135` |
| Revocation | `/ws` `subscribeAuthAccess`, `POST /api/auth/clients/revoke`, `POST /api/auth/pairing-links/revoke` | ends sessions and links | `swamp/extensions/behaviors/operations/conn-revocation/read_sessions.ts:26-47` |
| Task turn | `cat settings.json`, `cat model-manifest.json` | checks the model | `swamp/ansible/task-copy-turn.yml:68-100` |
| Task turn | `t3 thread start --provider P --model M --wait --json`, `t3 thread send --wait --json`, `t3 thread list --json`, `t3 thread show --messages 200 --json` | runs and reads a turn | `task-copy-turn.yml:147,251,379-381,466,480` |
| Task turn, a run that asks | `t3_copy_rpc.mjs`: reads `server-runtime.json`, `t3 auth session issue --scope … --ttl 1m`, `POST /api/auth/websocket-ticket`, `/ws`, `orchestration.getThreadProjection`, `dispatchCommand {run.interrupt}`, `t3 auth session revoke` | reads the question, stops the run | `swamp/ansible/t3_copy_rpc.mjs:30-137` |

How Orbit handles a question: the turn stops at its question. Orbit stores the question and
interrupts the run. The answer goes in as the next `t3 thread send`. **Orbit never calls
`runtime-request.respond`** [docs, `O/docs/reference/development-containers.md:1605-1613`].

**Gaps for a drop-in: none left on the task-turn path (2026-11-14).** The four CLI items this
path needs are built [code, `R/crates/conn-server/src/cli_thread.rs`, `cli.rs`,
`model_manifest.rs`]:

1. `t3 thread start|send|list|show`, with every option Orbit passes, the same output, error
   texts and exit codes as the T3 CLI (0, 1, and 2 for a run that waits for an answer).
2. `auth session issue` with a repeated `--scope`; `--scopes <list>` stays.
3. `model-manifest.json` in `userdata`, fetched and written as the T3 server writes it.
4. `auth session issue --json` in T3's key order, with the `sessionId` that
   `t3_copy_rpc.mjs` revokes with `t3 auth session revoke`.

Proof [measured, macOS]: `R/crates/conn-server/tools/thread-cli-diff.mjs` runs Orbit's commands
on the T3 server with its own `t3` and on the Conn Server with ours, with a stub `codex` and
T3's recorded transcripts: 30 steps, no difference beyond two fields the engine fills
differently (`branch`, `itemCount`). It covers a turn that completes, fails or asks, a send,
unknown thread, model and provider, and `t3_copy_rpc.mjs`'s read, interrupt and revoke.
`orbit-flow.mjs` runs the path in Orbit's order on the fake provider. `R/crates/conn-server/DROP-IN.md` section 1 has the table.

**In a real container** [measured, Beast, 2026-11-15]: every call in the table above, issued as
Orbit's scripts issue it through `incus exec` in a container from Orbit's image, on our musl
binary and on the image's own T3 0.1.7 (42 steps): the same exit codes and HTTP statuses, and
the same values or forms in every field Orbit reads. The rest differs only in key order, extra
fields and id forms (Orbit takes ids as `\S{1,255}`). Codex was a stand-in, so a real model turn
in a container is not proven. `docs/status.md`, "Proof on Beast".

Section 4c proposes to replace the CLI path rather than copy it.

**Closed on 2026-11-14: provider instance settings.** The server ignored `providerInstances`
for Claude and Codex, so the binary, home, launch arguments, environment and `enabled` that a
container's settings name did not apply, and the task copies' `claudeLow` … `claudeMax`
instances did not exist. They are built now, from the settings written before the first
start and again on each change, as the T3 server builds them [code,
`R/crates/conn-server/src/instances.rs`; proof, `R/crates/conn-server/tools/instances-flow.mjs`
and the Claude and Codex conformance checks]. Left: Claude's `customModels` and
`autoCompactWindow` [docs, `R/docs/status.md`, "Provider instance settings for Claude and
Codex"].

**Closed on 2026-11-15: the Codex status probe.** Each Codex instance is probed as the T3
server probes it: its own `codex app-server` with its binary, home and environment, then
`initialize`, `account/read`, skills, models, config and usage. A missing or broken binary, a
bad `CODEX_HOME` or a signed-out account now shows in the provider list, not at the first
turn; in a container the entry is `ready` with the router as its endpoint and no usage. The
probe's process ends after it; an idle container starts no Codex process [code,
`R/crates/conn-provider-codex/src/status.rs`; proof,
`R/crates/conn-provider-codex/tools/probe-conformance/run.mjs`, 17 of 17 equal, and
`instances-flow.mjs`]. Also on 2026-11-15: a Stop that abandons a Codex start stops the turn
when its `turn/start` reached Codex anyway (Nick's decision; the T3 server leaves it running).

**The brief's facts, checked against Orbit's code and docs:**

| Fact in the brief | Finding |
| --- | --- |
| Usable in 17 to 26 s | Not found. The docs say about 24 s to success, and the app answers 502 for 10 to 20 s more (`development-containers.md:1018,1038`). |
| `clone-t3` took 6.9 s | Not found. The level that holds both `clone-workspace` and `clone-t3` takes 4.2 s (`:1014`). |
| About 1 s per `t3` CLI call | Not found in the docs. Measured in a container (2026-11-15): 0.54 to 0.65 s for T3 0.1.7, 34 to 75 ms for the Conn Server. |
| About 6 s for 48 servers | **Contradicted.** 43 servers take 150 to 190 ms per pass, and 200 servers take 0.6 s (`conn.md:371-376`). The poll is off by default. |
| A sleeping container frees 408 to 496 MiB | Not found. A frozen clone holds about 13 MiB of RAM and about 340 MiB of swap (`development-containers.md:1263`). Measured awake (2026-11-15): a container from Orbit's image with no app holds 503 to 505 MiB (`memory.current`; 378 to 381 MiB anon) with T3 0.1.7, and 145 MiB (33 MiB anon) with the Conn Server. |
| Five `providerInstances` | Only for task copies. Every clone gets `{"linkedEnvironmentsEnabled": true}` (`InstanceContainer.php:461-485`). The Conn Server builds them since 2026-11-14. |
| `401 invalid_mcp_credential` | Correct for T3: `M/apps/server/src/mcp/McpHttpServer.ts:132,288`. Orbit's docs only say "refused". |
| Everything else (gate file, `model.env`, state path, label, ports, hourly renewal, two users, the AI router, the cloned files) | Confirmed in code. |

**A container that freezes and wakes** [tests, `docs/status.md` "Timers after a clock
jump"]. Every timer was tried on jumps of 10 minutes, 2 hours and 3 days. Under Orbit's cgroup
freezer the monotonic clock runs on, so each deadline fires once at the thaw; measured with
`incus pause` on Beast on 2026-11-15 (30 s, 3 min, 10 min) [measured]. Fixed: two
periodic checks (the socket revocation check, the desktop parent watch) caught up with
thousands of ticks at once; client activity leases and `/mcp` credential liveness counted only
monotonic time. A turn that was running stays running at the thaw; whether it ends is the
CLI's choice, as in T3. In a container on Beast a held turn stayed `running` through 10
minutes and completed, a scheduled task due during a pause ran at the thaw, and a client
socket open across a pause longer than 60 s was closed at the thaw (the client reconnects)
[measured, `docs/status.md` "Proof on Beast"].

**The checks touch nothing of the host** [check, `R/tools/canary.mjs`, the last check of
`tools/check.sh`]: no read of a provider, `gh` or `git` setting or credential, no real provider
or host CLI, no connection outside loopback. See `docs/status.md`, "The canary".

**The idle check, proven against T3** [check, `R/crates/conn-server/tools/idle-diff.mjs`, in
`tools/check.sh`]. Orbit's idle sleep reads `status`, `activityRunStatus`,
`blockedOnThreadWait`, `pendingBackgroundTasks`, `pendingRuntimeRequest` (`createdAt`,
`blocking`), `latestUserAuthoredMessageAt` or `latestUserMessageAt` and `latestRunCompletedAt`
from `threads` and `archivedThreads` (`ConnAgentActivity.php:52-118`). The thread index also
reads `id` and `title` (`ConnThreadIndex.php:187-216`), and a refusal's `reason`
(`HttpT3ServerClient.php:132-135`). The check brings the T3 server and the Conn Server into
the same 14 states on the Codex stub and compares those fields, Orbit's verdicts, the HTTP
status and content type. The same in all but one state. Fixed on the way: the shell showed
`running` where T3 shows `queued` while a message waits, and a SIGTERM ended a running turn
where T3 continues it on the next start; and since 2026-11-15 a Codex subagent that ends after
its turn wakes the agent with a new turn, as in T3 (before, Orbit read idle where T3 read
active). No known difference is left.

### 1c. The agent itself, through `/mcp`

Agents in a thread call `/mcp` with a token per provider session. They can use 70 served
tools: orchestration, scheduled tasks, annotations, PR links, watches and guides, previews, HTML renders,
attachments, worktree hand-off, secrets, test logins, panels and MCP Apps. Tools that act as
the calling thread are hidden from outside clients [code,
`R/crates/conn-mcp/src/outside-hidden.txt`].

**The Conn Server already accepts an environment session on `/mcp`**, with
`orchestration:read`. T3 accepts only an MCP OAuth client there. This is one deliberate
difference [code, `R/crates/conn-mcp/README.md`, "Auth"]. So Swamp could drive turns over
`/mcp` today on the Conn Server.

---

## 2. The profile table

Verdicts: **N** needed, **U** useful, **X** not needed, **O** Orbit does it. There are two
verdicts per item: **C** for a container and **H** for a host (the Mac with the desktop app,
and the headless mini). The full per-item tables are in appendices A to C. They are
checked against `R/crates/conn-contract/methods.json`, the running method table
(`R/crates/conn-server/src/table.rs`, built by `serve`), `R/crates/conn-mcp/tools.implemented`
and the router (`R/crates/conn-server/src/http.rs` and `src/routes/`). HTTP contract names
come from `R/tools/upkeep/http-routes.json`. Served counts describe this tree; C/H verdicts
and size measurements retain the dated research framing. The current contract also has
`server.getSettings`, which is unserved and unclassified here; only the full-parity total
includes it. Section 11 proposes what to hide or remove, independently of what is served.

### Methods (237; 169 served) [measured counts]

| Area | Methods | Served | C: N / U / X / O | H: N / U / X / O |
| --- | --- | --- | --- | --- |
| agentSessions | 2 | 0 | 0 / 0 / 2 / 0 | 0 / 2 / 0 / 0 |
| annotations | 3 | 3 | 0 / 3 / 0 / 0 | 0 / 3 / 0 / 0 |
| assets | 2 | 2 | 2 / 0 / 0 / 0 | 2 / 0 / 0 / 0 |
| attachments | 2 | 2 | 2 / 0 / 0 / 0 | 2 / 0 / 0 / 0 |
| cloud | 2 | 0 | 0 / 0 / 2 / 0 | 0 / 0 / 2 / 0 |
| credentials | 2 | 0 | 0 / 0 / 2 / 0 | 0 / 2 / 0 / 0 |
| device | 10 | 0 | 0 / 0 / 10 / 0 | 10 / 0 / 0 / 0 |
| filesystem | 2 | 2 | 2 / 0 / 0 / 0 | 2 / 0 / 0 / 0 |
| git | 3 | 3 | 0 / 1 / 0 / 2 | 3 / 0 / 0 / 0 |
| guestShare | 1 | 0 | 0 / 0 / 1 / 0 | 0 / 0 / 1 / 0 |
| mcpApps | 4 | 4 | 0 / 4 / 0 / 0 | 0 / 4 / 0 / 0 |
| orchestration | 23 | 23 | 18 / 5 / 0 / 0 | 21 / 2 / 0 / 0 |
| panels | 2 | 2 | 0 / 2 / 0 / 0 | 0 / 2 / 0 / 0 |
| peerLinks | 4 | 0 | 0 / 0 / 4 / 0 | 4 / 0 / 0 / 0 |
| preview | 12 | 8 | 0 / 0 / 12 / 0 | 8 / 1 / 3 / 0 |
| projectClone | 3 | 0 | 0 / 0 / 3 / 0 | 0 / 3 / 0 / 0 |
| projects | 10 | 10 | 10 / 0 / 0 / 0 | 10 / 0 / 0 / 0 |
| provider | 16 | 8 | 1 / 2 / 13 / 0 | 7 / 9 / 0 / 0 |
| pullRequests | 35 | 35 | 0 / 8 / 2 / 25 | 33 / 2 / 0 / 0 |
| review | 3 | 3 | 3 / 0 / 0 / 0 | 3 / 0 / 0 / 0 |
| scheduledTasks | 8 | 8 | 0 / 8 / 0 / 0 | 5 / 3 / 0 / 0 |
| secrets | 1 | 1 | 0 / 1 / 0 / 0 | 1 / 0 / 0 / 0 |
| server | 43 | 13 | 5 / 8 / 29 / 0 | 10 / 22 / 10 / 0 |
| shell | 1 | 1 | 0 / 0 / 1 / 0 | 1 / 0 / 0 / 0 |
| sourceControl | 9 | 9 | 0 / 0 / 6 / 3 | 4 / 5 / 0 / 0 |
| subscribe* (top level) | 12 | 10 | 7 / 1 / 4 / 0 | 9 / 3 / 0 / 0 |
| terminal | 7 | 7 | 7 / 0 / 0 / 0 | 7 / 0 / 0 / 0 |
| testLogins | 5 | 5 | 0 / 0 / 5 / 0 | 0 / 5 / 0 / 0 |
| vcs | 9 | 9 | 9 / 0 / 0 / 0 | 9 / 0 / 0 / 0 |
| worktreeSetup | 1 | 1 | 1 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |
| **Total** | **237** | **169** | **67 / 43 / 96 / 30** | **152 / 68 / 16 / 0** |

The C/H columns classify 236 methods; `server.getSettings` adds one unclassified method
in the `server` area.

- **Container:** all 67 needed methods are served. One useful method is not:
  `provider.consumeResetCredit`.
- **Host:** 152 are needed, and 15 of them are not served: `device.*` (10),
  `peerLinks.*` (4), and `preview.stopLocalServer`. The last stops only a server that
  the port scan (`subscribeDiscoveredLocalServers`, useful, not served) listed; it comes with
  that scan.
- **Not needed anywhere: 16 methods.** These are T3 Connect (`cloud.*`, `guestShare`), the
  ACP registry's download and install (9; Nick ruled out installs), the Electron tab relay
  (`preview.desktop*`, 3) and `server.commitDesktopUpdate`.

### `/mcp` tools (87; 70 served) [measured counts]

| | N | U | X | O |
| --- | --- | --- | --- | --- |
| Container | 21 (all served) | 44 (all served) | 14 (2 served) | 8 (3 served) |
| Host | 67 (58 served) | 20 (12 served) | 0 | 0 |

- Every needed or useful container tool is served.
- On a host, 9 needed tools are missing: `device_*` (4), linked machines
  (`t3_environment_link/links/unlink/preferences_update`, 4) and `write_pull_request_guides`
  (no review guide generator yet). PR watching and guide reads are served since 2026-11-19.

### HTTP routes (57 contract routes; 19 served) [measured counts]

| | N | U | X |
| --- | --- | --- | --- |
| Container | 11 (all served) | 10 (7 served) | 36 (1 served) |
| Host | 14 (all served) | 16 (5 served) | 27 (none served) |

- Every needed route is served. `threads/:id/transcript` (context import in the composer),
  `POST /api/pull-requests/diff` and all four webhook routes are served.
- Appendix C also lists seven served endpoints outside `EnvironmentHttpApi`; these do not
  add gaps or C/H verdicts to the profile.
- Not needed on either: the 16 voice routes, the 10 T3 Connect routes (with
  `connect-devices`) and `browser-session`.
- Useful: `bounded` and `history`. The client falls back to the socket snapshot without them
  [code, `M/packages/client-runtime/src/state/boundedThreadSnapshotHttp.ts:111-121`].

### Providers and source control hosts

| Item | Served | C | H | Evidence |
| --- | --- | --- | --- | --- |
| Claude (Agent SDK through the SDK host) | yes, every `providerInstances` instance | N | N | Every run Orbit has seen uses Claude [brief]; task copies use five instances, `claudeLow` to `claudeMax` |
| Codex (`codex app-server`) | yes, every instance, probed as T3 probes it | U | N | Orbit writes `~/.codex/config.toml` for the router [code, `InstanceContainer.php:422-424`]. No live Codex turn has run here [docs, `R/docs/status.md`]. |
| Grok (ACP) | yes, off by default | U | U | See section 8 |
| Kiro, fx, Antigravity, ACP registry (offline part) | no | U | U | Section 8 |
| Cursor, OpenCode, Muse (SDK) | no | X | U | Not used by Orbit |
| GitHub | sign-in, lookup, clone, publish, discovery, PR links, panel reads and actions, checkout; some operations return typed errors | O (Swamp pushes and opens the PR) | N | `workflow-operation-task-publish.yaml:764-946` |
| GitLab | removed; unknown git remote | X | X | GitHub only (Nick, 2026-11-16; `FORK.md`) |
| Bitbucket, Azure DevOps, Forgejo, GitCafe, Cursor origin | removed; unknown git remote | X | X | GitHub only (Nick, 2026-11-16; `FORK.md`) |

### Totals for the three targets

| | Methods | Tools | Routes |
| --- | --- | --- | --- |
| (a) container: needed, not served | 0 | 0 | 0 |
| (a) container: needed or useful, not served | 1 | 0 | 3 |
| (b) container or host: needed, not served | 15 | 9 | 0 |
| (b) container or host: needed or useful, minus what section 11 hides or removes | 51 | 17 | 11 |
| (c) full parity: not served | 68 | 17 | 38 |

Remaining work by area. Estimates for unchanged gaps retain the original research basis;
implemented areas have no remaining-size estimate.

| Area | Remaining items in (b) | Estimate |
| --- | --- | --- |
| Review guide writing | `write_pull_request_guides` (and `pullRequests.generateReviewGuide` for real) | Not estimated: T3's guide generator, a temporary checkout and the guide normalization |
| Agent browser and previews | `preview.stopLocalServer` | Not re-estimated; browser tools and eight preview methods are registered |
| Devices | 10 methods, 4 tools | 5 to 7 k (T3's `device/` was about 8,400 lines) |
| Peer links, linked environments, MCP OAuth | 4 methods, 4 tools, 8 useful routes | 3 to 5 k |
| Provider sign-in | 6 methods | 1.5 to 2.5 k |
| The rest | useful features in appendices A to C | Not re-estimated |

**What full parity still adds beyond (b):** 16 methods and 27 routes that the section 11
list removes (T3 Connect, voice, guest share, ACP registry installs, Electron relay), plus
the unclassified `server.getSettings`. Their remaining size has not been re-estimated.

---

## 3. What is built and not strictly needed: what could it give us?

Nothing here is proposed for deletion.

Binary sizes are the bytes of code each part adds to the macOS arm64 release build. **How:**
one unstripped release build (`CARGO_PROFILE_RELEASE_STRIP=false`) at `4864dcb`, made before
the "no full build" instruction arrived. Symbols were taken from `nm -n -C`. Each symbol's
size is the distance to the next symbol. Every symbol whose name contains a module path was
counted for that module, generic code included. The method is close to what
`cargo bloat --crates` does, so treat the results as **estimates** within about 20%. The
stripped build was **17,091,936 bytes** [measured]. The main checkout's build at `fce65e3`
is **17,397,232 bytes** [measured, `ls -l`, read only].

| Part | Code bytes [estimate] | Idle memory | Attack surface | Upstream churn, 30 days [measured] | A use in Orbit | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Scheduled tasks (`conn-features::scheduled`, `jiff`) | 64 K + 39 K | One timer and a JSON file of at most 500 tasks (`R/crates/conn-features/src/scheduled/mod.rs:12,73`). Not measured apart. | Starts agent turns on a timer or through the webhook route (`GET`, `POST`, `PUT`, `PATCH` and `HEAD`); webhook methods and delivery inspection are served. | 35 commits / 3.2 k lines in `ScheduledTaskService.ts`; 153 / 11.5 k for all of `conn-features` | The engine for recurring work inside one Instance, such as a nightly dependency check or a test run that reports to the thread. Orbit's Swamp has its own schedules (`project-schedule-definition-*`), so this is per-Instance only. | Keep on |
| Annotations (`conn-features::annotations`) | 39 K | None at idle; files under `userdata/annotations` | RPC only | 1 commit in `annotations.ts` | Review of a preview: a person marks the app in the client, and the agent works through the notes with `annotations_*`. It fits Orbit's preview through the app Route only if the client's overlay runs on that Route. | Keep on |
| Text generators and titles (`conn-server::text_generation`) | 29 K + 3 K | None | Outbound HTTP to the user's endpoint with the saved key | in `settings.rs`'s churn | Thread titles and commit messages through the AI router, with no key in the container: point the generator at the bridge forwarder. | Keep on, routed to the AI router |
| Hosts beyond GitHub | Removed | None | No host-specific API or CLI | No longer followed | None in Orbit | Removed (Nick, 2026-11-16; `FORK.md`) |
| Repository lookup, clone, publish | about 52 K (`repository`, `repositories`) | None | `git` child processes; outbound calls | in source control's 238 commits | Orbit clones and publishes. On the mini: "new project from a GitHub repository" from a phone. | Keep, off in the container profile |
| TLS stack (rustls, ring, webpki) | about 330 K, plus about 0.2 MB of roots [estimate] | None | Every outbound HTTPS call | n/a | Needed only for GitHub's API and a text generator over HTTPS. In a container the router is plain HTTP on the bridge. `ring` also verifies Ed25519, which section 4b needs. | Keep |
| Grok and the ACP runtime (`conn-provider-acp`) | 157 K (Grok's own part 31 K) | 310 KiB per idle Grok session, 11 KiB after close (`R/docs/status.md`, ACP part 3) | A child process when enabled; CLI probes every 5 minutes when enabled; off by default | 187 commits / 20.8 k lines | ACP agents in containers once the router serves them (section 8) | Keep on, off by setting as T3 has it |
| Payload limits (`conn-server::limits`) | 14 K | None | Reduces surface | generated, `limits-diff` check | Keeps a misbehaving client from filling a small container | Keep on |
| The secret store (settings secrets inline in `settings.json`, `secrets/*.bin` read for text generator keys) | in `settings` (22 K) | None | Secrets at rest in the container | `settingsSecrets.ts` 10 commits | The router's placeholder key needs no secret. A host keeps user keys here. | Keep |
| Keybindings | 21 K | None | None | 18 commits / 413 lines | The desktop's shortcuts | Keep on |
| Codex | 131 K | One `codex app-server` while a session lives | A child process | 139 commits / 9.4 k lines | Orbit already writes Codex's router config | Keep on |
| Process diagnostics, `signalProcess`, host resources | about 9 K plus method code | None | `signalProcess` can signal processes the server started | small | Debug a stuck agent in a container from the client | Keep on |

What dominates the binary [measured, same method]:

| Part | Code bytes |
| --- | --- |
| `conn-contract`, mostly serde code generated for the contract types | 3.47 MB (36%) |
| SQLite (C) | 1.42 MB |
| `conn-server` | 0.46 MB |
| `conn-engine` | 0.40 MB |
| rustls with ring | about 0.33 MB |
| `conn-provider-claude` | 0.24 MB |
| `conn-vcs` | 0.17 MB |
| `conn-source-control` | 0.16 MB |
| `conn-mcp` | 0.16 MB |
| `conn-provider-acp` | 0.16 MB |
| `conn-provider-codex` | 0.13 MB |
| Total code (`__text`) | 9.63 MB |

**What a container build could drop:** repository lookup, clone and publish, Kiro, fx and registry code once it exists, and maybe TLS. That is
about 0.5 to 0.7 MB, **3 to 4% of the binary** [estimate]. Idle memory barely changes:
unused code is mapped but never paged in. The server idles at 2.8 MiB `Pss_Anon` in an Orbit
Instance container [measured, Beast, 2026-11-15].

Commands that give the real numbers later, on a quiet machine or on Beast:

```sh
export CARGO_BUILD_JOBS=3 CARGO_INCREMENTAL=0
cargo build --release -p conn-server --bin conn-server && ls -l target/release/conn-server
CARGO_PROFILE_RELEASE_STRIP=false CARGO_TARGET_DIR=target/unstripped \
  cargo build --release -p conn-server --bin conn-server
nm -n -C --defined-only target/unstripped/release/conn-server   # then group by module path
# with cargo-bloat in a local root, not global:
cargo install --root /tmp/bloat cargo-bloat && \
  CARGO_PROFILE_RELEASE_STRIP=false /tmp/bloat/bin/cargo-bloat --release -p conn-server --crates -n 40
# Orbit's target, on Linux:
cargo build --release --target x86_64-unknown-linux-musl -p conn-server
# once a container feature set exists (section 5):
cargo build --release -p conn-server --no-default-features --features container
```

---

## 4. What Orbit needs that no T3 server gives

These are proposals for Nick and the Orbit orchestrator. Nothing here is built. The loose
fork makes them possible: the contract outside the provider protocols becomes ours.

### 4a. Start from files Orbit writes before boot

- **Replaces:** in `clone-t3`, two `t3 auth session issue` calls and `t3 project add`, plus
  the readiness wait between them [code, `instance_clone_guest.py:581-613`]. The hourly
  renewal also runs `t3 auth session issue` through `incus exec`.
- **Cost today:** the level that holds `clone-t3` takes 4.2 s [docs, `:1014`]. The brief's
  6.9 s and about 1 s per CLI call were not found.
- **Proposal:** a root-owned file, for example `/etc/orbit/conn-server.json`, written in
  `clone-container` with the other boot files. The server reads it at start:
  - `projects`: `[{root, title}]`. The server adds them as `--project` does now
    (`projects.json`).
  - `trust`: the Gateway's public keys (4b).
  - `label`: or keep `/etc/machine-info`, read live (4e).
  - `providers`: the default provider instance, and the effort per turn instead of five
    instances (4c).
  - `profile`: `container` (section 5).
- **Orbit must change:** write the file; drop the session and project steps from
  `clone-t3`; `clone-sessions` checks one signed token instead of two stored sessions.

### 4b. Trust in a credential that the Gateway signs

- **Replaces:** pairing (`pairing-token`, then `/oauth/token`), the hourly renewal, the
  vault's stored sessions, held sessions, and the revocation cleanup.
- **Proposal:**
  - The Gateway signs a short token: Ed25519, as a JWS or PASETO `v4.public`. Its claims are
    `aud` (the environment id), `sub` (Gateway, Swamp, or a person and device), `scope`,
    `exp` of an hour or less, and `jti`.
  - The server verifies it offline against the public keys in the boot file. There is no
    server-side session row.
  - The Conn client gets the token from the Gateway when it opens the environment. That is
    Nick's "Orbit hands it to the Conn client at the moment the client needs it". The
    desktop already talks to the Gateway (`M/apps/desktop/src/ipc/methods/orbitGateway.ts:14`).
  - The server then issues its normal WebSocket ticket.
- **Key material:**
  - The private key lives only at the Gateway (its vault).
  - The container holds the public keys and its own environment id.
  - A stolen container image gives an attacker public keys only: they cannot mint a token.
    They can read what the image holds (the workspace, state, the router's placeholder key).
  - The risk moves to the Gateway key. Keep one key per Node or per cluster. List several
    keys to rotate. Keep `exp` short. Keep a small `jti` deny list for revocation.
- **Cost:** no new dependency. `ring`, already in the tree for TLS, verifies Ed25519
  [code, `R/crates/conn-source-control/Cargo.toml:25`]. About 300 lines [estimate].
- **Orbit must change:** add a signing endpoint, drop the renew, hold and cleanup workflows,
  and pass tokens to clients.

### 4c. What Swamp lacks

| Need | Today | Proposal |
| --- | --- | --- |
| Answer a pending question | Interrupt the run, then send the answer as a new turn (`development-containers.md:1605`) | `t3_pending_request` with `action: respond`, served now on `/mcp` |
| Interrupt | `t3_copy_rpc.mjs`: a one-minute session, a ticket, `/ws`, `run.interrupt` | `t3_thread_interrupt`, served now |
| Send and wait | `t3 thread send --wait --json` | `t3_thread_send` plus `t3_thread_wait`, served now |
| List providers and models | `cat settings.json` and `model-manifest.json` | `orchestrator_capabilities`, served now |
| Effort per turn | Five provider instances with `CLAUDE_CODE_EFFORT_LEVEL`, because "Claude Code takes `CLAUDE_CODE_EFFORT_LEVEL` over the `--effort` that T3 passes" (`:1623`) | Effort as a model option on the turn. The client already sends options with `thread.model-selection.set`. Whether `t3_thread_send` or `t3_thread_configure` takes the effort is **to check**. The router env file must not set the variable. |
| Token use per turn | "T3's CLI reports no token use" (`TaskCopyTurnProjection.php:20`) | Usage is in the thread projection; expose it in `t3_thread_read` |
| A service credential | Sessions from the CLI | A 4b token with `sub: swamp` and `orchestration:operate` |

The Conn Server already accepts an environment session on `/mcp`. So the only server work
is effort per turn, token use, and the 4b verifier. **Orbit must change:** replace
`task-copy-turn.yml`'s CLI calls and `t3_copy_rpc.mjs` with one MCP client.

### 4d. A thread index the Gateway can read cheaply

- **Today:** a full `GET /api/orchestration/shell` per server, each minute. It is off by
  default, and 43 servers take 150 to 190 ms per pass [docs, `conn.md:349,371-376`].
- **Proposal:** a delta read, `GET /api/orchestration/shell?since=<sequence>`, answered from
  the engine's `shell_changes` table [code, `R/crates/conn-engine/src/store.rs`]. It
  answers `304` with no change.
- A push (the server calls the Gateway) needs an outbound path from the container to the
  Gateway and a credential. Keep it for later.
- **Orbit must change:** store the last sequence per server.

### 4e. The instance descriptor, live (the "Orbit row")

- **Today:** the label comes from `/etc/machine-info`, read once at start [brief]. The
  fields of `/etc/orbit/instance` are `ORBIT_INSTANCE_ID`, `ORBIT_INSTANCE`, `ORBIT_PROJECT`,
  `ORBIT_PROJECT_ID`, `ORBIT_PROJECT_NAME`, `ORBIT_NODE`, `ORBIT_URL`, and optionally
  `ORBIT_DEV_PORTS` and `ORBIT_DEV_PORTS_TAKEN` [code, `InstanceContainer.php:452-457`].
- **Proposal:** read both files on each descriptor request (they are small), or watch them.
  Return an `orbit` object in `/.well-known/t3/environment` and in `ServerConfig`. The
  client shows an Orbit row: Instance, project, Node and the app URL.
- This is a contract change: one optional field, which the client ignores until it knows it.

### 4f. A GitHub view that fits Orbit's flow

- **Facts:** Swamp pushes and opens the PR with a GitHub App token that the Gateway mints.
  The token never enters the container [code, `workflow-operation-task-publish.yaml:764-946`].
  The Gateway already reads PRs for branches with the App
  (`GET /projects/{id}/branches`, `conn.md:430-438`).
- **What the panel should show in a container:** the PR linked to the thread, read only:
  its state, checks, reviews and a link. There are no review actions in the container; they
  stay on the host or on GitHub.
- **Where the data comes from:**
  - Swamp calls `link_pull_request` on the thread after it opens the PR. This is served now.
  - The client reads the PR detail from the Gateway, which holds the App. The server does
    not call GitHub from a container.
- **Client change:** the thread PR panel takes its data from the Gateway when the
  environment is an Orbit container.
- **Server change:** none beyond the link tools.

---

## 5. How to be selective

| Choice | What it does | Checks | Verdict |
| --- | --- | --- | --- |
| Cargo features (a `container` build) | Compiles parts out | `check.sh` must build, lint and test every feature set we ship: twice the build time on a loaded machine | Saves about 3 to 4% of the binary [estimate]. Not worth it alone. |
| One binary, a runtime profile | A profile (`container`, `host`) decides which method groups register (others answer "not supported"), which routes mount, which capabilities are advertised, and which providers are offered | One build. The method-table check, the decode coverage and the `/mcp` catalog check run once per profile. | **Recommended** |
| Both | Profile for behaviour; one feature only for a part with a real dependency cost (TLS) | As above, plus one build | Later, if TLS ever leaves the container |

Why the profile: the bytes are not where the savings are, but the client's capability gates
are. A profile also makes "advertise only what is served" (rule 6) true per place. The
smallest sensible container build would be about 16.4 to 16.6 MB on macOS [estimate]. The
musl build is 22.9 MB at `958e748` [measured, Beast, 2026-11-15]; it was 15.7 MB on 2026-11-13.

---

## 6. Upkeep, with numbers

**Method.** `R/tools/upkeep/churn.mjs` (added with this document) reads
`tools/upkeep/followed-files.txt`. It counts non-merge commits and changed lines (added plus
deleted), with test files left out, over the 30 days before the pin (2026-10-15 to
2026-11-14). The monorepo's history is complete (not shallow). The totals are 5,772
non-merge commits in 30 days, about 192 a day; 96 of them are from ForkBot [measured].

| Followed part | Commits | Lines |
| --- | --- | --- |
| `conn-engine` (orchestration-v2 without the adapters, checkpointing) | 528 | 56,741 |
| `conn-mcp` | 256 | 16,241 |
| `conn-source-control` | 238 | 119,350, of which **75,217** are GitHub's GraphQL schema file (generated) |
| `conn-vcs` | 210 | 11,726 |
| `conn-provider-claude` | 190 | 10,864 (the adapter: 163 / 9,141) |
| `conn-provider-acp` | 187 | 20,841 |
| `conn-features` | 153 | 11,540 |
| `conn-provider-codex` | 139 | 9,438 |
| `conn-wire` (`ws.ts`) | 132 | 2,909 |
| `auth.rs` | 88 | 3,536 |
| `settings.rs` | 84 | 2,326 |
| `conn-files` | 70 | 3,580 |
| `conn-provider-support` | 61 | 561 |
| `environment.rs` | 57 | 608 |
| `conn-terminal` | 44 | 2,590 |
| SDK and CLI pins (`apps/server/package.json`) | 38 | 77 |
| `http.rs` | 33 | 634 |
| `keybindings.rs` | 18 | 413 |
| **All followed paths, each commit once** | **1,655** | **265,030** |

**The share the profile still follows.** A container profile stops following the five extra
source control hosts (about 9.5 k lines) and Kiro, fx and the registry (about 5.5 k lines).
That is about **8%** of the hand-written churn (265 k minus the 75 k schema) [estimate]. The
engine, the providers and `/mcp` are most of it, and every profile keeps them. **A profile
does not cut upkeep. Choosing what to merge does** (section 10).

**The one measured bump:** about 4 hours for 278 upstream commits, with 81 methods served
[docs, `R/docs/upkeep.md`]. That is about 0.9 minutes per upstream commit. At about 192
commits a day, nightly bumps would take about 2.8 hours a day, if the cost were linear
[estimate; the real cost depends on which areas a commit touches].

---

## 7. Is Conn easier or harder to maintain with this?

**Plainly: harder for the next months, easier after that, if Conn becomes a loose fork with
one server.**

What moves out:

- **Orbit's workarounds:** the CLI and WebSocket path for task turns, the five effort
  instances, hourly renewals, held sessions, pairing for the Gateway, the full-shell poll,
  and `model-manifest.json` reads. Sections 4a to 4d replace them.
- **Conn's fork pain:** Conn's own server features (annotations, scheduled tasks, panels,
  test logins) no longer collide with upstream's `apps/server` on each nightly merge. They
  live in this repository.
- **Two server kinds:** once the T3 server leaves Conn, the client needs no capability flag
  to tell them apart.

What is new to maintain:

- The host target (b): 15 needed methods and 9 tools remain, and no HTTP route; size not re-estimated.
- A pinned client–server pair, and its release.
- **Version skew:** a new client against an old container image. Orbit upgrades the agent
  bundle fleet-wide with a symlink flip and `try-restart` [code, `DROP-IN.md` §1,
  `instance-folder.yml:141-168`], so skew stays short if bumps roll out together.

**How the client behaves today when a method is not served** [code, `M/`]:

- **The wire.** An unknown tag is a defect (`Die`), in T3 (`effect RpcServer.ts:286`) and
  here (`R/crates/conn-server/src/table.rs:60`).
- **Streams.** A transport failure resubscribes with backoff, from 1 s up to 30 s, with no
  limit (`client-runtime/src/rpc/client.ts:119-124,396-416`). A defect is different. On the
  generic `subscribe` path it becomes a failure, and it is **not retried** until the view
  remounts or the session changes (`client.ts:434`; `state/runtime.ts:873`).
- **Queries and commands.** The component decides what to show. A command defect is logged
  to the console (`runtime.ts:465`). There is no global "not supported" handling.
- **Gates that exist:** `capabilities.pullRequests` (the rail entry,
  `WorkspaceRail.tsx:363`), `pullRequestChecks`, `serverBrowser`, `peerLinks` with
  `linkedEnvironmentsEnabled`, `storageCleanup`, `voiceTranscription`, `npmReleaseLookup`,
  `vcsBranchStatus`, `commandOutputStreaming` and `threadForceStop`.
- **Version.** `orchestrationProtocolVersion` must be 2, or the connection is blocked
  (`connection/compatibility.ts:11-28`). `serverVersion` is a soft check: an older server
  gets an update hint (`versionSkew.ts:55`).

**Client surfaces with operation limits or unserved methods** (the dated C/H verdicts
remain separate from registration):

| Surface | Methods it calls | What happens today |
| --- | --- | --- |
| Git actions control (commit, push, PR) | `git.runStackedAction` | Registered; commit is served, push and PR creation return a typed error |
| Thread PR panel, when a PR is linked | `pullRequests.*` | All 35 methods are registered; disabled guide generation and unavailable actions return typed errors |
| Provider sign-in and install in Settings | `provider.auth.*`, `provider.install.*` | Sign-in is served as in T3: Claude, Codex and Grok are CLI-owned (`setup.canAuthenticate: false`), so the UI shows no sign-in and every `provider.auth.*` call answers T3's `ProviderSetupError`. Install actions fail; the UI follows `providers[].auth.status` |
| Device panel | `device.*` | The stream is served; the actions fail |
| Test logins and credentials | `testLogins.*`, `credentials.*` | Test-login methods are served; the two site-credential methods remain unserved |
| Secret request card | `secrets.answerRequest` | Served |
| MCP App frames, agent panels | `mcpApps.*`, `panels.*` | Registered; panel browser URL/tab automation returns `capability_denied` |
| Onboarding scan | `agentSessions.*` | A failing scan |
| Usage, ACP registry settings, resource telemetry | `server.getUsageSummary`, `*AcpRegistry*`, `subscribeResourceTelemetry` | A failing panel |
| Workflow script view | `orchestration.getWorkflowScript` | Served |

---

## 8. ACP: what is free and what is not

**What is free:** one shared runtime (`R/crates/conn-provider-acp`: JSON-RPC, the turn
mapper, tools, permissions, prompts, Stop and close). A flavor that speaks plain ACP needs
only a small `flavor` entry.

**What is not free** [code, `R/crates/conn-provider-acp/README.md`; T3 line counts measured
without tests]:

| Agent | Beyond the plain path | T3 size | Upstream churn, 30 days [measured] |
| --- | --- | --- | --- |
| Grok (built) | Background work and subagents: wake buffer, deferred finalize, continuation, subagent carryover (5 failing transcripts); Grok extras | `provider-grok` 4,002 lines; the shared `provider-acp` adapter 15,801 | 44 commits / 2.2 k (Grok); 107 / 9.8 k (shared) |
| Kiro | ACP protocol 2 replies | 1,534 | 9 / 1.7 k |
| fx | Its flavor | 1,362 | 10 / 1.5 k |
| Antigravity | Its own adapter and stdout filter; the client file host (`ProviderHost`) | adapter 311 lines plus its flavor | 17 / 0.2 k |
| ACP registry | 11 `server.*` methods; installs are ruled out, so only the 2 offline ones apply | 5,840 | 44 / 2.3 k |

**What any agent needs in a container:**

- Its binary in Orbit's agent bundle. Orbit installs nothing at run time.
- Its model traffic through the AI router, with no sign-in in the container.
- The router forwards Anthropic's API today (`ANTHROPIC_BASE_URL`) and an OpenAI Responses
  endpoint for Codex [code, `InstanceContainer.php:397-424`].
- Whether it can serve xAI (Grok), Kiro (AWS) or Antigravity (Google) is **an open question
  for Orbit**. Without that, an ACP agent in a container cannot sign in.

**Proposed order:**

1. Nothing new until the router serves a second vendor.
2. Then the agent the router serves first. Grok's flavor exists, so if the router serves
   xAI, Grok's background work comes next.
3. Then Kiro (protocol 2 replies are shared work), then fx.
4. Antigravity last: its own adapter and the file host.

---

## 9. The staged path to "Conn supports only the Conn Server"

**Nick's rule:** "We cannot jeopardize breaking conn atm. we would really build the server
and conn client (desktop + mobile) in isolation."

Every stage is built and proven in isolation first:

- **No change to `nckrtl/conn`.**
- The client for the Conn Server lives in a **separate copy** with its own app identity: its
  own bundle id (for example `…conn.lab`), its own URL scheme, and its own data folder.
- Tests use temp state folders and scratch containers.
- Each switch needs **Nick's explicit word and a way back.** The switches are a container,
  the mini, his Mac, dropping the T3 server, and changing the upstream merge.

| Stage | Proven before it (checkable) | State that moves | How it ships and starts | In isolation, in practice | First live step | Way back |
| --- | --- | --- | --- | --- | --- | --- |
| 0. The isolated client copy | The copy builds with its own identity. The 22 recorder scenarios pass against the Conn Server in the copy. No file in `nckrtl/conn` changes. | None | A separate repository or fork branch of the client, never merged into Conn | Its own bundle id, URL scheme and data folder, so it never reads Conn's saved environments | Nick installs the copy beside Conn | Delete the copy |
| 1. Orbit containers | (a) is complete: `t3_background_wait` (done 2026-11-14); the four CLI items (built 2026-11-14) or Swamp on `/mcp`. Orbit's container flow passes in a scratch container on Linux. The 4b verifier, if chosen. The section 7 flags hide what a container does not serve. A week of real use shows no "not supported" on the paths people take. | New containers start fresh. An existing container keeps settings, keybindings, its environment id, attachments and annotations (same files). Threads, pairings and scheduled tasks need the converter (below). | The musl binary in the agent bundle; `bin/t3` points at it (`DROP-IN.md` §6a) | A scratch Instance only, opened from the isolated client copy | One new scratch Instance with the Conn Server, with Nick's word | Point `bin/t3` back at the T3 tarball, then `try-restart` |
| 2. The Mac mini | (b) for what Nick uses there: `peerLinks`, linked environments, scheduled tasks, PR panels. A supervisor for `server.restart`. The converter, proven on a **copy** of a T3 home that Nick makes. | Threads and projects: one import event per thread from T3's projection rows, keeping ids. Scheduled tasks: from the `scheduled_tasks` table into JSON. Settings secrets: from `secrets/*.bin` back into `settings.json`. Sessions **cannot** move (T3 signs tokens; we store hashes), so devices pair again. | A launchd service running `conn-server serve`, with its own `--base-dir` and port | A second server with its own state folder and port, beside the T3 server; the T3 service is untouched | The isolated client connects to it; Nick runs one orchestrator thread there | Stop the Conn Server service; the T3 server never stopped |
| 3. The Mac with the desktop app | (b) for the desktop: previews and the agent browser, devices, PR panels, provider sign-in. A native spawn path (no `ELECTRON_RUN_AS_NODE`, `--bootstrap-fd 3`). A replacement for fds 4 to 7 (updates, telemetry, the in-app browser), or an explicit drop. Signed binaries. | As stage 2, from a copy of the Mac's T3 home | The binary in the isolated desktop copy's bundle. The desktop updates the server by updating itself. The SDK host could run on Electron's own Node (`ELECTRON_RUN_AS_NODE`) instead of a 152 MB single executable [estimate]. | The isolated desktop copy, with its own data folder and home; Conn's desktop keeps its T3 server | Nick uses the isolated desktop for one project | Use the normal Conn app |
| 4. The T3 server leaves Conn | Stages 1 to 3 have run for an agreed time. The loose fork's merge gate (section 10) works. | None new | Conn's desktop and mobile take the client copy's changes | Only now does `nckrtl/conn` change | A Conn release with the Conn Server | The previous Conn release, which still bundles the T3 server |

**The converter.** None exists [code: a search for `statev2` in `R/crates` finds nothing].

- T3 keeps `userdata/statev2.sqlite`: events, about 20 projection tables, auth, scheduled
  tasks, peer links, PR review data [code, `M/apps/server/src/persistence/Migrations`].
- We keep `engine.sqlite` with our own schema, plus `auth.json`, `scheduled-tasks.json` and
  `projects.json`.
- The same files: `settings.json`, `keybindings.json`, `environment-id`,
  `server-runtime.json`, `attachments/` and `annotations/`.
- **One difference to fix or record:** our worktrees default to `userdata/worktrees`, while
  T3 uses `<home>/worktrees` [code, `R/crates/conn-server/src/host.rs:45-53`;
  `M/apps/server/src/config.ts:162`].

---

## 10. The upstream question: a loose fork

**The choice (Nick's lean):** a loose fork. Conn stays very close to T3 Code, keeps its
client stack, uses only the Conn Server in the end, and changes what Orbit needs. **The
client and the Conn Server move as one pinned pair.** Upstream changes come in by choice.

**The client stack at the pin** [code, `package.json` files]:

- **Web:** React with Vite (`vite-plus`), TanStack Router and Tailwind 4.
- **Desktop:** Electron 44 with `electron-builder` and `electron-updater`, around the web
  renderer.
- **Mobile:** Expo 58 with React Native 0.88, plus native Swift and Kotlin modules.
- **Effect** throughout, for RPC and state.
- **Astro** is used only by `apps/marketing` (Astro 7), the marketing site. It is not in the
  app.

### Where conflicts will come from [measured, 30 days]

| What upstream changed | Commits |
| --- | --- |
| Client only (web, desktop, mobile, client-runtime) | 2,692 |
| Server only | 1,435 |
| Client and server or contract together | **475**: these need a matching Conn Server change before the pair can move |
| Contract | 423 |
| The provider layer (adapters, `apps/server/src/provider`, the ACP and Codex packages, `provider-core/src/server`, `package.json`) | **783** commits / 58,033 lines |
| The T3 testkit (recorded transcripts we replay as proofs) | 94 / 21,371 |
| Claude Agent SDK pin | moved 3 times (0.3.276 → 0.3.284 → 0.3.316 → 0.3.321) |

### What keeps a loose fork cheap

| Cheap to merge | Expensive to merge |
| --- | --- |
| Whole folders removed (`apps/server`, T3 Connect, voice) | Edits inside upstream files that upstream also edits often |
| New files and folders (Orbit row, Gateway token source, Gateway PR data) | Changing a shared type in `packages/contracts` |
| A feature hidden by a capability or a setting, in one place | Forking `client-runtime` state files: they hold most RPC call sites |
| Our own contract additions as new optional fields | Renaming upstream methods |

### How often to merge, and the gate

- **Merge on a schedule we choose:** weekly, or before a planned Conn release.
- At about 0.9 minutes per upstream commit [estimate from the one bump], a weekly merge of
  about 1,350 commits is a day's work. Most of that cost is in the 475 commits that touch
  the client and the server together.
- A merge lands only when the Conn Server passes `tools/check.sh` with `CONN_MONOREPO` at
  the merged commit, plus the recorder scenarios in the isolated client.
- A red merge waits, and the pair stays on the old commit.

### Options compared

| Option | Cost | Gives |
| --- | --- | --- |
| (i) Merge nightly; land only when the Conn Server passes | About 2.8 h a day of bump work if linear [estimate]. Red nights hold the client back. | Latest upstream UI every day |
| (ii) Merge in planned steps (the loose fork) | The same work per commit, in batches. Fewer red gates. Bigger merges when the contract moved a lot. | Control; time to build matching server parts |
| (iii) Diverge and stop merging | Conn alone carries about 640 k lines of client code (below) | Full freedom; no upstream features |

**Recommendation for the loose fork: option (ii)**, with a watch list (below).

### What to watch upstream after a divergence (testing Nick's view)

Nick's view is that the provider layer is the one part worth watching. **It holds, with
three additions:**

1. **The provider layer.** 783 commits / 58 k lines in 30 days [measured]. These are the
   rules for driving the Claude Agent SDK, `codex app-server` and ACP agents.
2. **SDK and CLI pins** (`apps/server/package.json`). Rule 3 of `AGENTS.md` asks for the same
   versions as T3.
3. **The agent-facing texts:** `orchestrationInstructions.ts` (27 commits) and
   `runtimeInstructions.ts` (11).
4. **The testkit transcripts** (94 commits), which are our recorded proofs.
5. **Security fixes in `auth`** (88 commits / 3.5 k lines), read for faults, not for parity.

**What gets simpler with one server:**

- No capability flags to tell two server kinds apart.
- `apps/server` leaves Conn's merges.
- Conn's own server features stop colliding with upstream.
- The contract outside the provider protocols becomes ours to change for Orbit (section 4).

---

## 11. The rip-out or adjust list for the client

The rule: hide by capability or setting where upstream edits the file often. Remove only
whole folders. This list and the profile table agree.

| Client area | Action | Proposed profile exclusions (C / H) | Upstream merge cost |
| --- | --- | --- | --- |
| Thread view, composer, diffs, review, terminals, files, checkpoints, fork | Keep | none | none |
| Settings, keybindings, text generators, scheduled tasks, annotations | Keep | none | none |
| Provider and model pickers | Adjust for Orbit: effort as a turn option; the provider list from the server | none | low (one setting) |
| Provider sign-in and install | Hide in a container (a capability); keep on a host | C: 13 `provider.*`; H: none | low |
| PR panel and rail | Adjust for Orbit: in a container, a read-only panel from Gateway data; keep in full on a host | C: 27 `pullRequests.*`, 2 `git.*`; H: none | **medium**: `client-runtime/state/pullRequests.ts` is a busy upstream file |
| Git actions control | Adjust: commit only in a container; push and PR from Orbit | C: push and PR part of `git.runStackedAction` | medium |
| Previews and agent browser | Hide in a container (`serverBrowser` off); keep on a host | C: 12 `preview.*`, 2 streams | low (the gate exists) |
| Devices | Hide in a container; keep on the Mac | C: 10 `device.*` | low (a new gate) |
| Test logins, credentials | Hide in a container; keep on a host | C: 7 | low |
| Source control sign-in, repository clone and publish | Hide in a container (Orbit does it) | C: 9 `sourceControl.*`, `projectClone.*` (3) | low |
| Environment list and pairing | Adjust for Orbit: environments from the Gateway, with a Gateway token, no pairing link | none (pairing routes stay for hosts) | medium (new files, plus one hook in `environments/`) |
| Orbit row | Add (new files) | none | low |
| Peer links, linked environments | Keep on a host (the mini) | C: 4 | none |
| T3 Connect, Clerk, cloud relay, guest share | **Remove** | 3 methods, 10 routes (with `connect-devices`), DPoP | low if removed as folders (`apps/web/src/cloud`, `components/clerk`) |
| Voice through the server | **Remove**, or keep on-device only (iOS already transcribes on the device) | 16 routes | low |
| ACP registry download and install | **Remove** (Nick ruled installs out) | 9 methods | low |
| Electron tab relay and desktop update through the server | **Remove**; the desktop updates by updating itself | 4 methods | medium (desktop files) |
| Storage cleanup, resource telemetry, usage | Hide in a container | C: 10 | low |
| Onboarding import, MCP Apps, panels, secret requests | Keep (useful) | none | none |

---

## 12. If the only clients were our own Mac and iOS apps (facts only)

This option is set aside. The facts, briefly:

- **Only for clients Nick does not need:**
  - the browser web client: static files, cookie sessions, CORS
    (`M/apps/server/src/http.ts:256-272,516-523`);
  - guest pages;
  - Windows and WSL host code (about 200 lines);
  - Android device code;
  - T3 Connect with Clerk (about 9,700 lines in `cloud/`);
  - server-side voice models.
- **Shaped by upstream's stack:**
  - Effect's RPC framing on `/ws`: `Exit` and `Cause`, an `Ack` per chunk, 5 s pings and
    frame parts. A native client must speak it. We copied it in `R/crates/conn-wire`
    (478 lines).
  - The Electron back channel: fds 4 to 7 and `preview.desktop*`.
- **The agent browser** already runs in a headless Chromium on the server (`ServerBrowser.ts`,
  the `serverBrowser` capability). It does not need Electron.
- **A WKWebView has no CDP** [general knowledge; nothing in the code mentions it].

---

## 13. The present clients, and the surfaces Nick's use needs

Lines of source without tests [measured, `wc -l` over `.ts`, `.tsx`, `.js`, `.mjs`, `.css`
and native files]:

| Part | Lines |
| --- | --- |
| `apps/web/src` | 348,437 |
| `apps/desktop/src` | 51,223 |
| `apps/mobile` | 178,976 (158,567 TypeScript in `src`; 9,563 Swift and 8,411 Kotlin in `modules`) |
| `packages/client-runtime/src` | 61,359 |
| For comparison: `apps/server/src` | 287,471 |
| For comparison: `packages/contracts/src` | 31,045 |

Surfaces Nick's container and host use need (the start list for a later client plan):

| Surface | Container | Host |
| --- | --- | --- |
| Thread view, composer, model, effort | yes | yes |
| Changed files, diffs, review | yes | yes |
| Terminals | yes | yes |
| Files and search | yes | yes |
| Checkpoints, rollback, fork | yes | yes |
| Settings, keybindings, text generators | yes | yes |
| Orbit row; environments from the Gateway | yes | — |
| PR panel | read only, from the Gateway | full |
| Git actions | commit only | full |
| Previews and agent browser | — (the app Route) | yes |
| Devices | — | yes (Mac) |
| Scheduled tasks | useful | yes (mini) |
| Linked machines | — | yes (mini) |
| Provider sign-in | — | yes |

---

## 14. Open questions

**For Nick:**

1. The loose fork with merges by choice: weekly, or per release?
2. The Gateway-signed credential (4b): yes? With one key per Node, or one per cluster?
3. Effort per turn instead of five provider instances: yes?
4. The PR panel in a container: read only, from the Gateway?
5. Voice: remove the server routes and keep on-device only?
6. Should a container run the agent browser? It needs a 105 to 128 MB Chromium in the
   image.
7. When may stage 1's first scratch Instance run?
8. Converting the mini's and the Mac's T3 threads: is a fresh start acceptable?

**For the Orbit orchestrator:**

1. Can the AI router serve xAI, AWS (Kiro) or Google (Antigravity)?
2. Can Swamp move task turns to `/mcp` (4c)?
3. Who writes `/etc/orbit/conn-server.json`, and can it hold the Gateway's public keys?
4. Is the delta read (4d) enough, or does the Gateway want a push?
5. Why does every clone set `linkedEnvironmentsEnabled: true`? Does any container use
   linked environments?
6. Should default Instances sleep? A frozen clone holds about 13 MiB of RAM and about
   340 MiB of swap [docs]. Awake, a container from the image without an app holds 503 to
   505 MiB with T3 and 145 MiB with the Conn Server [measured, 2026-11-15].
7. Can Swamp call `link_pull_request` after it opens a PR?

---

## 15. What I could not measure

- **Real per-part sizes from a build with parts compiled out.** No such features exist, and
  the machine was loaded. The numbers come from a symbol map.
- **Idle memory per part.**
- **Linux sizes.** Measured since, on Beast on 2026-11-15: see section 3.
- **Conn's own edits inside upstream files.** The checkout has no `upstream` remote, so I
  could not measure how far Conn has already moved from T3 Code.
- **The client's churn per area.** The measurement did not finish in time.
- **Whether `t3_thread_send` or `t3_thread_configure` carries effort.**
- **The brief's timing facts** (6.9 s, 1 s per call, 6 s for 48 servers): not in Orbit's
  code or docs.

---

## Appendix A. Every method

Served means registered in the running server's method table; it does not promise every
operation or platform is supported. `server.getSettings` is in the current contract but
has no C/H verdict or size estimate in this dated profile (shown as —).

C is the container verdict, H the host verdict. "Size if built": S under 300 lines, M 300 to
1,500, L more [estimate].

| Method | Served | C | H | Size if built | Why |
| --- | --- | --- | --- | --- | --- |
| `agentSessions.import` | no | X | U | M | onboarding import of Claude/Codex transcripts |
| `agentSessions.scan` | no | X | U | M | onboarding import of Claude/Codex transcripts |
| `annotations.create` | yes | U | U |  | review notes on a preview |
| `annotations.remove` | yes | U | U |  | review notes on a preview |
| `annotations.subscribe` | yes | U | U |  | review notes on a preview |
| `assets.createUrl` | yes | N | N |  | images and files in the composer |
| `assets.persistChatAttachments` | yes | N | N |  | images and files in the composer |
| `attachments.createUploadUrl` | yes | N | N |  | images and files in the composer |
| `attachments.delete` | yes | N | N |  | images and files in the composer |
| `cloud.getRelayClientStatus` | no | X | X | L | T3 Connect relay (Clerk); Orbit gives WireGuard |
| `cloud.installRelayClient` | no | X | X | L | T3 Connect relay (Clerk); Orbit gives WireGuard |
| `credentials.fillForSite` | no | X | U | M | autofill test logins into preview tabs |
| `credentials.listForSite` | no | X | U | M | autofill test logins into preview tabs |
| `device.action` | no | X | N | L | iOS simulators on the Mac (device/ is about 8,400 lines in T3) |
| `device.close` | no | X | N | L | iOS simulators on the Mac (device/ is about 8,400 lines in T3) |
| `device.configure` | no | X | N | L | iOS simulators on the Mac (device/ is about 8,400 lines in T3) |
| `device.detail` | no | X | N | L | iOS simulators on the Mac (device/ is about 8,400 lines in T3) |
| `device.easAccount` | no | X | N | L | iOS simulators on the Mac (device/ is about 8,400 lines in T3) |
| `device.list` | no | X | N | L | iOS simulators on the Mac (device/ is about 8,400 lines in T3) |
| `device.open` | no | X | N | L | iOS simulators on the Mac (device/ is about 8,400 lines in T3) |
| `device.shutdown` | no | X | N | L | iOS simulators on the Mac (device/ is about 8,400 lines in T3) |
| `device.simlockIdentity` | no | X | N | L | iOS simulators on the Mac (device/ is about 8,400 lines in T3) |
| `device.testHost` | no | X | N | L | iOS simulators on the Mac (device/ is about 8,400 lines in T3) |
| `filesystem.browse` | yes | N | N |  | project and file pickers |
| `filesystem.getMetadata` | yes | N | N |  | project and file pickers |
| `git.preparePullRequestThread` | yes | O | N |  | pull request checkout into a thread |
| `git.resolvePullRequest` | yes | O | N |  | pull request checkout into a thread |
| `git.runStackedAction` | yes | U | N |  | commit only; push and PR creation return a typed error |
| `guestShare.create` | no | X | X | L | guest link through T3 Connect |
| `mcpApps.callTool` | yes | U | U |  | MCP App UIs inside a thread |
| `mcpApps.readResource` | yes | U | U |  | MCP App UIs inside a thread |
| `mcpApps.toolInfo` | yes | U | U |  | MCP App UIs inside a thread |
| `mcpApps.updateModelContext` | yes | U | U |  | MCP App UIs inside a thread |
| `orchestration.dispatchCommand` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.forceStopThread` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.getArchivedShellSnapshot` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.getFullThreadDiff` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.getNativeChildWork` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.getOlderSettledThreads` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.getThreadFamily` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.getThreadLinkMetadata` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.getThreadProjection` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.getThreadTitles` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.getTurnDiff` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.getTurnItem` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.getWorkflowScript` | yes | U | U |  | Claude workflow runs |
| `orchestration.getWorktreeThreadIds` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.launchThread` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.searchThread` | yes | U | N |  | thread search |
| `orchestration.searchThreadStream` | yes | U | N |  | thread search |
| `orchestration.searchThreads` | yes | U | N |  | thread search |
| `orchestration.stopWorkflow` | yes | U | U |  | Claude workflow runs |
| `orchestration.subscribeCommandOutput` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.subscribePromptSuggestion` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.subscribeShell` | yes | N | N |  | thread view, composer, diffs |
| `orchestration.subscribeThread` | yes | N | N |  | thread view, composer, diffs |
| `panels.requests` | yes | U | U |  | agent opens a panel in the client |
| `panels.respond` | yes | U | U |  | agent opens a panel in the client |
| `peerLinks.answerRequest` | no | X | N | L | threads on other machines (mini reaches every machine) |
| `peerLinks.link` | no | X | N | L | threads on other machines (mini reaches every machine) |
| `peerLinks.list` | no | X | N | L | threads on other machines (mini reaches every machine) |
| `peerLinks.unlink` | no | X | N | L | threads on other machines (mini reaches every machine) |
| `preview.adjust` | yes | X | N |  | agent browser and preview tabs; container previews go through the app Route |
| `preview.clearProfile` | yes | X | N |  | agent browser and preview tabs; container previews go through the app Route |
| `preview.close` | yes | X | N |  | agent browser and preview tabs; container previews go through the app Route |
| `preview.desktopRegister` | no | X | X | M | Electron tab relay; not needed by a native client |
| `preview.desktopRequests` | no | X | X | M | Electron tab relay; not needed by a native client |
| `preview.desktopRespond` | no | X | X | M | Electron tab relay; not needed by a native client |
| `preview.list` | yes | X | N |  | agent browser and preview tabs; container previews go through the app Route |
| `preview.open` | yes | X | N |  | agent browser and preview tabs; container previews go through the app Route |
| `preview.reportProfiles` | yes | X | U |  |  |
| `preview.reportStatus` | yes | X | N |  | agent browser and preview tabs; container previews go through the app Route |
| `preview.resize` | yes | X | N |  | agent browser and preview tabs; container previews go through the app Route |
| `preview.stopLocalServer` | no | X | N | L | stops a server that `subscribeDiscoveredLocalServers` found; unreachable without that port scan, which stays unregistered |
| `projectClone.cancel` | no | X | U | M | clone from the client; Orbit clones containers |
| `projectClone.retry` | no | X | U | M | clone from the client; Orbit clones containers |
| `projectClone.start` | no | X | U | M | clone from the client; Orbit clones containers |
| `projects.createFromThread` | yes | N | N |  | file tree, search, editor |
| `projects.createNew` | yes | N | N |  | file tree, search, editor |
| `projects.ensureScratch` | yes | N | N |  | file tree, search, editor |
| `projects.listEntries` | yes | N | N |  | file tree, search, editor |
| `projects.listIgnoredFiles` | yes | N | N |  | file tree, search, editor |
| `projects.mutate` | yes | N | N |  | file tree, search, editor |
| `projects.readFile` | yes | N | N |  | file tree, search, editor |
| `projects.searchContents` | yes | N | N |  | file tree, search, editor |
| `projects.searchEntries` | yes | N | N |  | file tree, search, editor |
| `projects.writeFile` | yes | N | N |  | file tree, search, editor |
| `provider.auth.cancel` | yes | X | N |  | provider sign-in: T3's `ProviderSetupError` for CLI-owned providers |
| `provider.auth.complete` | yes | X | N |  | provider sign-in: T3's `ProviderSetupError` for CLI-owned providers |
| `provider.auth.logout` | yes | X | N |  | provider sign-in: T3's `ProviderSetupError` for CLI-owned providers |
| `provider.auth.removeMethod` | yes | X | N |  | provider sign-in: T3's `ProviderSetupError` for CLI-owned providers |
| `provider.auth.respond` | yes | X | N |  | provider sign-in: T3's `ProviderSetupError` for CLI-owned providers |
| `provider.auth.start` | yes | X | N |  | provider sign-in: T3's `ProviderSetupError` for CLI-owned providers |
| `provider.auth.subscribe` | yes | N | N |  | sign-in state stream |
| `provider.chatgpt.handoff.subscribe` | no | X | U | M | ChatGPT profile handoff for Codex |
| `provider.chatgpt.import-profile` | no | X | U | M | ChatGPT profile handoff for Codex |
| `provider.chatgpt.reconnect-profile` | no | X | U | M | ChatGPT profile handoff for Codex |
| `provider.consumeResetCredit` | no | X | U | S |  |
| `provider.install.cancel` | no | X | U | M | install a provider CLI; Orbit bundles agents |
| `provider.install.remove` | no | X | U | M | install a provider CLI; Orbit bundles agents |
| `provider.install.start` | no | X | U | M | install a provider CLI; Orbit bundles agents |
| `provider.install.subscribe` | yes | U | U |  |  |
| `provider.uploadFeedback` | no | U | U | S |  |
| `pullRequests.activity` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.changeBreakdown` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.checks` | yes | U | N |  | read-only PR view; in a container the data would come from the Gateway |
| `pullRequests.comment` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.detail` | yes | U | N |  | read-only PR view; in a container the data would come from the Gateway |
| `pullRequests.diffFileContents` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.filesViewed` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.filterOptions` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.generateReviewGuide` | yes | X | U |  | registered; returns a typed error when guides are off |
| `pullRequests.invalidate` | yes | U | N |  | read-only PR view; in a container the data would come from the Gateway |
| `pullRequests.labelCandidates` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.linkedThreads` | yes | U | N |  | read-only PR view; in a container the data would come from the Gateway |
| `pullRequests.list` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.listStats` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.preview` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.replyToThread` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.reportState` | yes | U | N |  | read-only PR view; in a container the data would come from the Gateway |
| `pullRequests.requestReviewers` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.reviewGuide` | yes | X | U |  | AI review guide |
| `pullRequests.reviewerCandidates` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.routing` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.routingIdentity` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.runAction` | yes | O | N |  | registered; returns a typed error for unavailable actions |
| `pullRequests.setFilesViewed` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.setLabels` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.setReaction` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.setThreadResolution` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.stack` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.submitReview` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.subscribeLinkedThreadRefreshes` | yes | U | N |  | read-only PR view; in a container the data would come from the Gateway |
| `pullRequests.subscribeRefreshes` | yes | U | N |  | read-only PR view; in a container the data would come from the Gateway |
| `pullRequests.summary` | yes | U | N |  | read-only PR view; in a container the data would come from the Gateway |
| `pullRequests.threadComments` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.update` | yes | O | N |  | PR panel: list, review, comment, merge |
| `pullRequests.updateComment` | yes | O | N |  | PR panel: list, review, comment, merge |
| `review.getBranchCommits` | yes | N | N |  | changed files and diffs |
| `review.getDiffFileContents` | yes | N | N |  | changed files and diffs |
| `review.getDiffPreview` | yes | N | N |  | changed files and diffs |
| `scheduledTasks.delete` | yes | U | N |  | scheduled tasks (mini) |
| `scheduledTasks.getWebhookDelivery` | yes | U | U |  | webhook triggers |
| `scheduledTasks.listWebhookDeliveries` | yes | U | U |  | webhook triggers |
| `scheduledTasks.rotateWebhookToken` | yes | U | U |  | webhook triggers |
| `scheduledTasks.runNow` | yes | U | N |  | scheduled tasks (mini) |
| `scheduledTasks.setEnabled` | yes | U | N |  | scheduled tasks (mini) |
| `scheduledTasks.subscribe` | yes | U | N |  | scheduled tasks (mini) |
| `scheduledTasks.upsert` | yes | U | N |  | scheduled tasks (mini) |
| `secrets.answerRequest` | yes | U | N |  | agent asks for a secret |
| `server.acceptAcpRegistryUrlAuth` | no | X | U | S | ACP registry, offline part |
| `server.checkOtlpEndpoint` | no | X | U | S | telemetry |
| `server.checkSecretSource` | no | X | U | S | 1Password secret source |
| `server.commitDesktopUpdate` | no | X | X | M | Electron update back channel; not a native client |
| `server.deleteAcpRegistrySession` | no | X | X | L | ACP registry download and install: Nick ruled it out |
| `server.disableAcpRegistryProvider` | no | X | X | L | ACP registry download and install: Nick ruled it out |
| `server.discoverSourceControl` | yes | U | N |  | source control settings |
| `server.getConfig` | yes | N | N |  | connection and settings |
| `server.getDatabaseStorage` | no | X | U | M | storage cleanup; containers are disposable |
| `server.getHostResources` | yes | U | U |  | diagnostics |
| `server.getNpmRelease` | no | X | U | M | self-update; a native app ships the binary |
| `server.getProcessDiagnostics` | yes | U | U |  | diagnostics |
| `server.getProcessResourceHistory` | no | X | U | M | resource telemetry |
| `server.getResourceTelemetryHistory` | no | X | U | M | resource telemetry |
| `server.getSettings` | no | — | — | — | settings read; not classified in this dated profile |
| `server.getStorageCleanupReport` | no | X | U | M | storage cleanup; containers are disposable |
| `server.getTraceDiagnostics` | no | X | U | S | telemetry |
| `server.getUsageSummary` | no | X | U | M | usage; the AI router accounts in a container |
| `server.importAcpRegistrySession` | no | X | X | L | ACP registry download and install: Nick ruled it out |
| `server.listAcpRegistryProviders` | no | X | X | L | ACP registry download and install: Nick ruled it out |
| `server.listAcpRegistrySessions` | no | X | X | L | ACP registry download and install: Nick ruled it out |
| `server.listTextGeneratorModels` | yes | U | N |  | text generators |
| `server.logoutAcpRegistry` | no | X | X | L | ACP registry download and install: Nick ruled it out |
| `server.prepareAcpRegistryAgent` | no | X | X | L | ACP registry download and install: Nick ruled it out |
| `server.prepareTriage` | no | X | U | S |  |
| `server.probe` | yes | N | N |  | connection and settings |
| `server.reclaimDatabaseSpace` | no | X | U | M | storage cleanup; containers are disposable |
| `server.refreshProviders` | yes | N | N |  | connection and settings |
| `server.refreshUsageRates` | no | X | U | M | usage; the AI router accounts in a container |
| `server.removeKeybinding` | yes | U | N |  | keybindings |
| `server.reportClientActivity` | yes | N | N |  | connection and settings |
| `server.restart` | yes | U | N |  | restart under a supervisor |
| `server.retryResourceTelemetry` | no | X | U | M | resource telemetry |
| `server.runStorageCleanup` | no | X | U | M | storage cleanup; containers are disposable |
| `server.searchAcpRegistry` | no | X | X | L | ACP registry download and install: Nick ruled it out |
| `server.setAcpRegistryProvider` | no | X | X | L | ACP registry download and install: Nick ruled it out |
| `server.signalProcess` | yes | U | U |  | diagnostics |
| `server.uninstallAcpRegistryManagedBinary` | no | X | U | S | ACP registry, offline part |
| `server.updateProvider` | no | X | U | M | update a provider CLI |
| `server.updateServer` | no | X | U | M | self-update; a native app ships the binary |
| `server.updateServerWithProgress` | no | X | U | M | self-update; a native app ships the binary |
| `server.updateSettings` | yes | N | N |  | connection and settings |
| `server.upsertKeybinding` | yes | U | N |  | keybindings |
| `shell.openInEditor` | yes | X | N |  | open in the host's editor |
| `sourceControl.appAccess` | yes | X | N |  | GitHub sign-in; no GitHub credential in a container |
| `sourceControl.cloneRepository` | yes | O | U |  | repository create/clone; Orbit does it |
| `sourceControl.lookupRepository` | yes | O | U |  | repository create/clone; Orbit does it |
| `sourceControl.publishRepository` | yes | O | U |  | repository create/clone; Orbit does it |
| `sourceControl.signInCancel` | yes | X | N |  | GitHub sign-in; no GitHub credential in a container |
| `sourceControl.signInStart` | yes | X | N |  | GitHub sign-in; no GitHub credential in a container |
| `sourceControl.signInWait` | yes | X | N |  | GitHub sign-in; no GitHub credential in a container |
| `sourceControl.star` | yes | X | U |  | stars |
| `sourceControl.starred` | yes | X | U |  | stars |
| `subscribeAuthAccess` | yes | N | N |  | connection streams |
| `subscribeDeviceState` | yes | U | N |  | device panel opens setup when this fails |
| `subscribeDiscoveredLocalServers` | no | X | U | M | port scan for previews |
| `subscribePreviewEvents` | yes | X | N |  | preview tabs |
| `subscribeProjectClones` | yes | X | U |  |  |
| `subscribeResourceTelemetry` | no | X | U | M |  |
| `subscribeServerConfig` | yes | N | N |  | connection streams |
| `subscribeServerLifecycle` | yes | N | N |  | connection streams |
| `subscribeTerminalMetadata` | yes | N | N |  | connection streams |
| `subscribeVcsBranch` | yes | N | N |  | connection streams |
| `subscribeVcsStatus` | yes | N | N |  | connection streams |
| `subscribeWorktreeSetup` | yes | N | N |  | connection streams |
| `terminal.attach` | yes | N | N |  | terminals |
| `terminal.clear` | yes | N | N |  | terminals |
| `terminal.close` | yes | N | N |  | terminals |
| `terminal.observe` | yes | N | N |  | terminals |
| `terminal.open` | yes | N | N |  | terminals |
| `terminal.resize` | yes | N | N |  | terminals |
| `terminal.write` | yes | N | N |  | terminals |
| `testLogins.list` | yes | X | U |  | test logins (Conn only) |
| `testLogins.remove` | yes | X | U |  | test logins (Conn only) |
| `testLogins.reveal` | yes | X | U |  | test logins (Conn only) |
| `testLogins.save` | yes | X | U |  | test logins (Conn only) |
| `testLogins.update` | yes | X | U |  | test logins (Conn only) |
| `vcs.createRef` | yes | N | N |  | branches, worktrees, status |
| `vcs.createWorktree` | yes | N | N |  | branches, worktrees, status |
| `vcs.init` | yes | N | N |  | branches, worktrees, status |
| `vcs.listRefs` | yes | N | N |  | branches, worktrees, status |
| `vcs.pull` | yes | N | N |  | branches, worktrees, status |
| `vcs.refreshBranch` | yes | N | N |  | branches, worktrees, status |
| `vcs.refreshStatus` | yes | N | N |  | branches, worktrees, status |
| `vcs.removeWorktree` | yes | N | N |  | branches, worktrees, status |
| `vcs.switchRef` | yes | N | N |  | branches, worktrees, status |
| `worktreeSetup.cancel` | yes | N | N |  |  |


## Appendix B. Every `/mcp` tool

| Tool | Served | C | H | Size if built | Why |
| --- | --- | --- | --- | --- | --- |
| `annotations_claim` | yes | U | U |  | agents work through review notes |
| `annotations_complete` | yes | U | U |  | agents work through review notes |
| `annotations_list` | yes | U | U |  | agents work through review notes |
| `annotations_release` | yes | U | U |  | agents work through review notes |
| `create_threads` | yes | U | N |  | new top-level threads |
| `database_query` | yes | U | U |  | Conn database panel |
| `delegate_task` | yes | N | N |  | core orchestration |
| `delete_scheduled_task` | yes | U | N |  | scheduled tasks |
| `device_close` | no | X | N | L | simulators |
| `device_list` | no | X | N | L | simulators |
| `device_open` | no | X | N | L | simulators |
| `device_screenshot` | no | X | N | L | simulators |
| `fill_credential` | no | X | U | M | test logins |
| `html_preview` | yes | U | N |  | charts; needs headless Chromium on the server |
| `html_render` | yes | U | N |  | charts; needs headless Chromium on the server |
| `link_pull_request` | yes | U | N |  | PR links on a thread; Swamp could link the PR it opens |
| `link_pull_requests` | yes | U | N |  | PR links on a thread; Swamp could link the PR it opens |
| `list_scheduled_tasks` | yes | U | N |  | scheduled tasks |
| `list_thread_pull_requests` | yes | U | N |  | PR links on a thread; Swamp could link the PR it opens |
| `mcp_call` | yes | U | U |  | MCP Apps |
| `mcp_connect` | yes | U | U |  | MCP Apps |
| `orchestrator_capabilities` | yes | N | N |  | core orchestration |
| `panel_open` | yes | U | U |  |  |
| `preview_act` | yes | U | N |  | agent browser; needs headless Chromium on the server |
| `preview_cdp_endpoint` | yes | U | N |  | agent browser; needs headless Chromium on the server |
| `preview_dialog` | yes | U | N |  | agent browser; needs headless Chromium on the server |
| `preview_evaluate` | yes | U | N |  | agent browser; needs headless Chromium on the server |
| `preview_navigate` | yes | U | N |  | agent browser; needs headless Chromium on the server |
| `preview_open` | yes | U | N |  | agent browser; needs headless Chromium on the server |
| `preview_recording_start` | yes | U | N |  | agent browser; needs headless Chromium on the server |
| `preview_recording_stop` | yes | U | N |  | agent browser; needs headless Chromium on the server |
| `preview_resize` | yes | U | N |  | agent browser; needs headless Chromium on the server |
| `preview_set_appearance` | yes | U | N |  | agent browser; needs headless Chromium on the server |
| `preview_snapshot` | yes | U | N |  | agent browser; needs headless Chromium on the server |
| `preview_status` | yes | U | N |  | agent browser; needs headless Chromium on the server |
| `preview_wait_for` | yes | U | N |  | agent browser; needs headless Chromium on the server |
| `read_pull_request_guide` | yes | O | N |  | stored review guides; the panel's guide store |
| `request_credentials` | yes | X | U |  | test logins |
| `request_secret` | yes | U | N |  | agent asks for a secret |
| `run_scheduled_task_now` | yes | U | N |  | scheduled tasks |
| `save_test_login` | yes | X | U |  | test logins |
| `schedule_task` | yes | U | N |  | scheduled tasks |
| `send_to_user` | yes | N | N |  | core orchestration |
| `t3_attachment_discard` | yes | U | N |  | attachments between threads |
| `t3_attachment_prepare_upload` | yes | U | N |  | attachments between threads |
| `t3_background_wait` | yes | N | N |  | agents wait on background commands; named in T3's instructions |
| `t3_environment_link` | no | X | N | L | linked machines |
| `t3_environment_links` | no | X | N | L | linked machines |
| `t3_environment_preferences_update` | no | X | N | L | linked machines |
| `t3_environment_read` | yes | N | N |  | core orchestration |
| `t3_environment_unlink` | no | X | N | L | linked machines |
| `t3_pending_request` | yes | N | N |  | core orchestration |
| `t3_preview_close` | yes | U | N |  | agent browser; needs headless Chromium on the server |
| `t3_preview_list` | yes | U | N |  | agent browser; needs headless Chromium on the server |
| `t3_project_clone` | no | O | U | M | Orbit owns projects in a container |
| `t3_project_create` | no | O | U | M | Orbit owns projects in a container |
| `t3_project_delete` | no | O | U | M | Orbit owns projects in a container |
| `t3_project_list` | yes | N | N |  | core orchestration |
| `t3_project_read` | yes | N | N |  | core orchestration |
| `t3_project_update` | no | O | U | M | Orbit owns projects in a container |
| `t3_queue` | yes | N | N |  | core orchestration; Swamp's service calls |
| `t3_theme_read` | no | X | U | S | client theme |
| `t3_theme_set` | no | X | U | S | client theme |
| `t3_thread_configure` | yes | N | N |  | core orchestration; Swamp's service calls |
| `t3_thread_interrupt` | yes | N | N |  | core orchestration; Swamp's service calls |
| `t3_thread_launch` | yes | N | N |  | core orchestration; Swamp's service calls |
| `t3_thread_list` | yes | N | N |  | core orchestration; Swamp's service calls |
| `t3_thread_organize` | yes | N | N |  | core orchestration; Swamp's service calls |
| `t3_thread_read` | yes | N | N |  | core orchestration; Swamp's service calls |
| `t3_thread_search` | yes | N | N |  | core orchestration; Swamp's service calls |
| `t3_thread_send` | yes | N | N |  | core orchestration; Swamp's service calls |
| `t3_thread_send_attachments` | yes | U | N |  | attachments between threads |
| `t3_thread_transfer` | no | X | U | L | move a thread between machines |
| `t3_thread_update` | yes | N | N |  | core orchestration; Swamp's service calls |
| `t3_thread_wait` | yes | N | N |  | core orchestration; Swamp's service calls |
| `t3_workflow_stop` | yes | U | U |  |  |
| `t3_worktree_handoff` | yes | U | N |  | worktree hand-off |
| `t3_worktree_list` | yes | U | N |  | worktree hand-off |
| `t3_worktree_status` | yes | U | N |  | worktree hand-off |
| `task_cancel` | yes | N | N |  | core orchestration |
| `task_status` | yes | N | N |  | core orchestration |
| `tool_search` | yes | U | U |  |  |
| `unlink_pull_request` | yes | U | N |  | PR links on a thread; Swamp could link the PR it opens |
| `unlink_pull_requests` | yes | U | N |  | PR links on a thread; Swamp could link the PR it opens |
| `unwatch_pull_request` | yes | O | N |  | PR watching; hidden from delegated children |
| `watch_pull_request` | yes | O | N |  | PR watching: a 2-minute sweep wakes the thread; hidden from delegated children |
| `write_pull_request_guides` | no | O | N | M | needs T3's review guide generator (a temporary checkout and a model run); unregistered until then |


## Appendix C. Every HTTP route

The first table covers all 57 `EnvironmentHttpApi` routes. The seven additional served
endpoints below it are outside that contract and the dated C/H classification. GET routes
also accept HEAD (explicitly for webhooks); the router handles OPTIONS for CORS. Neither is
counted as a separate profile row.

| Route | Served | C | H | Size if built | Why |
| --- | --- | --- | --- | --- | --- |
| `GET /.well-known/oauth-authorization-server` | no | X | U | M | MCP OAuth for outside MCP clients and peer links |
| `GET /.well-known/oauth-protected-resource` | no | X | U | M | MCP OAuth for outside MCP clients and peer links |
| `GET /.well-known/oauth-protected-resource/mcp` | no | X | U | M | MCP OAuth for outside MCP clients and peer links |
| `GET /.well-known/t3/environment` | yes | N | N |  | connect and sign in; Orbit reads session and revokes clients |
| `POST /api/auth/browser-session` | no | X | X | M | cookie session for a browser web client |
| `GET /api/auth/clients` | yes | N | N |  | connect and sign in; Orbit reads session and revokes clients |
| `POST /api/auth/clients/revoke` | yes | N | N |  | connect and sign in; Orbit reads session and revokes clients |
| `POST /api/auth/clients/revoke-others` | yes | N | N |  | connect and sign in; Orbit reads session and revokes clients |
| `POST /api/auth/connect-devices/approve` | no | X | X | L | T3 Connect relay (Clerk, DPoP) |
| `POST /api/auth/connect-devices/revoke` | no | X | X | L | T3 Connect relay (Clerk, DPoP) |
| `POST /api/auth/pairing-links/revoke` | yes | U | N |  | pairing; Orbit uses it today, a signed trust root would replace it |
| `POST /api/auth/pairing-token` | yes | U | N |  | pairing; Orbit uses it today, a signed trust root would replace it |
| `GET /api/auth/session` | yes | N | N |  | connect and sign in; Orbit reads session and revokes clients |
| `POST /api/auth/websocket-ticket` | yes | N | N |  | connect and sign in; Orbit reads session and revokes clients |
| `POST /api/auth/websocket-ticket/:use` | yes | N | N |  | connect and sign in; Orbit reads session and revokes clients |
| `POST /api/connect/link-proof` | no | X | X | L | T3 Connect relay (Clerk, DPoP) |
| `GET /api/connect/link-state` | no | X | X | L | T3 Connect relay (Clerk, DPoP) |
| `POST /api/connect/preferences` | no | X | X | L | T3 Connect relay (Clerk, DPoP) |
| `POST /api/connect/reachability` | no | X | X | L | T3 Connect relay (Clerk, DPoP) |
| `POST /api/connect/relay-config` | no | X | X | L | T3 Connect relay (Clerk, DPoP) |
| `POST /api/connect/unlink` | no | X | X | L | T3 Connect relay (Clerk, DPoP) |
| `GET /api/hooks/:hookId/:token` | yes | U | U |  | scheduled-task webhooks |
| `PATCH /api/hooks/:hookId/:token` | yes | U | U |  | scheduled-task webhooks |
| `POST /api/hooks/:hookId/:token` | yes | U | U |  | scheduled-task webhooks |
| `PUT /api/hooks/:hookId/:token` | yes | U | U |  | scheduled-task webhooks |
| `GET /api/orchestration/shell` | yes | N | N |  | Gateway's thread index; thread snapshot |
| `GET /api/orchestration/threads/:threadId` | yes | N | N |  | Gateway's thread index; thread snapshot |
| `GET /api/orchestration/threads/:threadId/bounded` | no | U | U | M | long threads; the client falls back to the socket snapshot |
| `GET /api/orchestration/threads/:threadId/history` | no | U | U | M | long threads; the client falls back to the socket snapshot |
| `GET /api/orchestration/threads/:threadId/transcript` | yes | U | N |  | import a thread's context into the composer |
| `GET /api/projects` | no | U | U | S | `t3 project add` reads it; not needed once projects come from boot files |
| `POST /api/projects/mutate` | yes | N | U |  | `t3 project add` |
| `POST /api/pull-requests/diff` | yes | X | N |  | PR code tab |
| `POST /api/t3-connect/health` | no | X | X | L | T3 Connect relay (Clerk, DPoP) |
| `POST /api/t3-connect/mint-credential` | no | X | X | L | T3 Connect relay (Clerk, DPoP) |
| `POST /api/voice/acceleration` | no | X | X | L | server-side speech models; iOS transcribes on the device |
| `POST /api/voice/cloud/:provider/key` | no | X | X | L | server-side speech models; iOS transcribes on the device |
| `POST /api/voice/cloud/:provider/transcribe` | no | X | X | L | server-side speech models; iOS transcribes on the device |
| `GET /api/voice/cloud/keys` | no | X | X | L | server-side speech models; iOS transcribes on the device |
| `GET /api/voice/cloud/openrouter/models` | no | X | X | L | server-side speech models; iOS transcribes on the device |
| `POST /api/voice/model-unload-timeout` | no | X | X | L | server-side speech models; iOS transcribes on the device |
| `GET /api/voice/models` | no | X | X | L | server-side speech models; iOS transcribes on the device |
| `POST /api/voice/models/cancel` | no | X | X | L | server-side speech models; iOS transcribes on the device |
| `POST /api/voice/models/download` | no | X | X | L | server-side speech models; iOS transcribes on the device |
| `POST /api/voice/models/link` | no | X | X | L | server-side speech models; iOS transcribes on the device |
| `POST /api/voice/models/prepare` | no | X | X | L | server-side speech models; iOS transcribes on the device |
| `POST /api/voice/models/remove` | no | X | X | L | server-side speech models; iOS transcribes on the device |
| `POST /api/voice/models/select` | no | X | X | L | server-side speech models; iOS transcribes on the device |
| `POST /api/voice/post-process` | no | X | X | L | server-side speech models; iOS transcribes on the device |
| `GET /api/voice/status` | no | X | X | L | server-side speech models; iOS transcribes on the device |
| `POST /api/voice/transcribe` | no | X | X | L | server-side speech models; iOS transcribes on the device |
| `POST /oauth/mcp/approval` | no | X | U | M | MCP OAuth for outside MCP clients and peer links |
| `GET /oauth/mcp/authorize` | no | X | U | M | MCP OAuth for outside MCP clients and peer links |
| `POST /oauth/mcp/decision` | no | X | U | M | MCP OAuth for outside MCP clients and peer links |
| `POST /oauth/mcp/register` | no | X | U | M | MCP OAuth for outside MCP clients and peer links |
| `POST /oauth/mcp/token` | no | X | U | M | MCP OAuth for outside MCP clients and peer links |
| `POST /oauth/token` | yes | N | N |  | connect and sign in; Orbit reads session and revokes clients |

### Additional served endpoints

| Route | Served | Purpose |
| --- | --- | --- |
| `GET /health` | yes | Conn Server health and method coverage |
| `GET /ws` | yes | client RPC WebSocket upgrade |
| `GET /api/assets/:token/*name` | yes | signed assets, including HTML renders |
| `POST /api/attachments/upload/:token` | yes | attachment upload |
| `GET /api/preview-stream/ws` | yes | authenticated browser stream |
| `POST /mcp` | yes | MCP requests |
| `DELETE /mcp` | yes | MCP session close |

# Upkeep: keep the Conn Server in step with Conn

The Conn Server lives in the Conn monorepo (`apps/conn-server`), so it always meets the Conn
commit it is part of. Every generator reads this tree, and a generated file that differs from
it fails a check. No step calls a model.

## When the checks run

Pull requests and `sync/**` pushes trigger both workflows directly when their path filters
match. Both workflows also support manual runs.

After the first completion of CI for a main push, `conn-server-after-ci.yml` applies the same
filters to the original push range. It runs the selected workflows at the pushed SHA even
if CI failed. Companion results are published on that SHA. A companion retry updates the
same report for each gate of that source CI run.

The path filters are:

- `conn-server-ci.yml` (production musl build): `apps/conn-server/**` and both workflow files.
- `conn-server-checks.yml` (`tools/check.sh`, including monorepo comparisons):
  `apps/conn-server/**`, `apps/server/**`, `apps/web/**`, `packages/**` and both workflow files.

`conn-server-checks.yml` builds release and debug comparison binaries in parallel, shares
them as one-day artifacts, and runs four comparison groups. Rust validation runs in parallel with the build;
all groups run the canary. Only companion jobs for main pushes save Rust and pnpm caches.
The final `Conn Server checks` gate fails if any group fails or skips.
Each check has a timeout that stops its process group; each CI job also has a time limit.
The nightly sync waits for the workflows triggered by its changes before it merges.

## In the nightly sync

The sync follows the Conn Server every night (Nick, 2026-11-16; `FORK.md`, "Upstream scope").
On the `sync/*` branch, after the upstream merge:

1. Run `tools/follow-conn.sh --capture`. It regenerates what is generated, runs
   `tools/check.sh` and reports the upstream commits each part follows.
2. Port each upstream change in scope that the report or a red check names, as the T3 server
   makes it. Scope is the container profile: the areas `docs/orbit-profile.md` rates needed
   or useful. Each port gets the test or the check that failed without it.
3. Skip what is out of scope: Windows, the providers this server does not build, the hosts
   and features the profile rates not needed. A check that goes red only for such a change
   gets its scope fixed, with the reason; it is not weakened.
4. An in-scope change that cannot be ported that night becomes a known difference with its
   reason, in the check's known list and in `docs/status.md`.
5. Commit on the sync branch, and let both workflows pass before the merge.

Source-control parity follows only GitHub and the core registry's unknown-host fallback
(`FORK.md`, "Upstream scope"). `registry-diff` constructs T3's registry with its GitHub
definition alone; it does not import or harvest other hosts. The followed files include
source-control core and GitHub, but no other host packages.

## The tools

| Command | What it does |
| --- | --- |
| `tools/follow-conn.sh [--since <commit>] [--capture] [--no-checks]` | Regenerates the contract, the `/mcp` catalog and texts, the keybindings, the upstream tables (`tools/gen-upstream.mjs`: scopes, settings keys, HTTP routes, the T3 server version, settings secrets), the Codex and ACP instruction texts and the Claude model catalog, runs `tools/check.sh`, and prints the report of what moved in Conn since `<commit>` (default: the last commit that changed `apps/conn-server`). `--capture` also regenerates the provider crates' reference events (about 2 minutes). It never commits. It exits 1 when a step fails, or when the contract has more Opaque fallbacks than before. |
| `tools/check.sh` | Every check that needs no model. |

`follow-conn.sh` keeps its log and report in `target/follow-conn/<commit>.{log,report.txt}`.
Run it in your own checkout or worktree, after `vp i` at the root and `npm ci` in
`helpers/sdk-host`: `--capture` puts temporary test files into the monorepo's `apps/server`.

## Green (exit 0)

1. Commit every change on a branch, with the report as the commit body, and open a pull
   request when Nick allows it. The Conn Server checks run on it.
2. Read **What to do** at the top of the report: it lists the red checks, the served methods
   and `/mcp` tools that changed shape, the provider parts with upstream commits and the state
   of their conformance checks, pins that differ, and changed reference events. A green run
   can still list work there.

A new method that we do not serve stays unregistered and answers "not supported": that is
correct, not a failure. A changed provider file means the provider crate may need to follow it.

## Red (exit 1)

The tree keeps the regenerated state. Fix it as below, or commit it on a branch with `WIP: red`
in the subject and the report as the body, and hand the branch to a person or an agent.

## Fix a red run

Read the report, then the log. Then:

| Failed step | Usual cause | Fix |
| --- | --- | --- |
| `gen-contract` | A schema shape the generator does not know, or an Effect upgrade | Change `crates/conn-contract/tools/gen-contract.mjs`. Never edit `generated.rs`. |
| More Opaque fallbacks | Same | Same. The report prints a warning. |
| `gen-tools` | The T3 server registers a new service, or drops a tool we serve | Add the service to the mock list in `gen-tools.mjs`, or remove the tool from `tools.implemented` and from `conn-mcp`. |
| `gen-keybindings` | `packages/shared` moved its defaults | Update `gen-keybindings.mjs`. |
| `gen-upstream` | An upstream table moved or changed shape (scope maps, `EnvironmentHttpApi`, `settingsSecrets.ts` groups) | Update `tools/gen-upstream.mjs`; its error names the source. Never edit a generated file. |
| `opaque fallbacks` | The contract generator met a shape it cannot type | Teach `gen-contract.mjs` the shape. |
| `cargo test` in `scopes` | The T3 server added or dropped a payload-dependent scope rule | Follow `requiredScopesForRpcCall` and `clientRpcRequiredScopes` in `scopes.rs` `from_payload` and `HAND_PAYLOAD_RULES`. |
| `cargo test engine_commands` | The contract dropped or renamed a command type the engine handles | Follow the rename in `crates/conn-engine/src/commands.rs`. |
| `check-copies` | A hand-kept auth or wire table no longer matches upstream | Update `auth.rs` or `conn-wire` to the value the check prints. |
| `decode coverage` | A newly registered method has no run that decodes its answer | Add a call to `effect-client.mjs`; only if that is impossible, a line with a reason in `decode-coverage.pending`. |
| `settings-diff` | The T3 server's settings rules moved | Follow the printed path in `settings.rs`, and add a case to `settings-cases.json`. |
| `cargo clippy`, `cargo test`, `release build` | A changed method type | Follow the **changed** lines of the report in `crates/conn-server/src/methods`. |
| `effect-client`, `replay`, `client-check` | The wire, the frame parts or the client reducers moved | Compare with `packages/shared/src/socketFrameParts.ts` and the `effect` version in the lockfile. |
| `parity` | `/mcp` answers moved | Compare with the T3 server's `/mcp` for the tools in the report. |
| `cargo test` in `conn-mcp` catalog | `fixtures/ts-tools-list.json` is a T3 `tools/list` from an older Conn | `node crates/conn-mcp/tools/parity.mjs --record-tools-list crates/conn-mcp/fixtures/ts-tools-list.json target/release/examples/replay_server` |
| `codex conformance`, `claude conformance` | What a CLI is sent moved upstream (argv, environment, the spawn script, a prompt text) | Follow the adapter commits in the report. The diff names the field. A launch difference is a defect, never a listed exception. |
| `claude t3-replay` | A T3 Claude transcript changed its result | Fix the session; if it is a known gap, list it in `crates/conn-provider-claude/tools/t3-replay/expected-failures.txt` with the reason. A listed one that passes fails too: remove it. |
| `claude catalog --check` | T3's bundled Claude models moved | `crates/conn-provider-claude/tools/gen-catalog/run.sh` (follow-conn.sh runs it). |
| `gen-upstream` says a settings key "needs …" | A settings patch key needs a new scope set | Teach `gen-upstream.mjs` and `scopes.rs` `settings_scopes` the domain. |
| `cargo deny` | A new advisory | Plan the crate change; add a dated exception to `deny.toml` only with a reason. |

Then run `tools/check.sh` until it is green, and commit as for a green run.

For each part in **Upstream commits per part** that changed, read the commits (the report
prints the subjects) and the diff in Conn (`git diff <old> <new> -- <the part's files>`), and
compare them with that part here. A served method whose shape changed needs the same: the
report groups them by the types that moved. When the report says a pin differs
(`← differs`), move the pin (`helpers/sdk-host/package.json` and `npm install` for the Claude
Agent SDK; `check-copies` fails until it matches T3's lockfile), then run `follow-conn.sh`
again with `--capture`.

`--capture` runs both capture tools. `tools/reference-events.mjs` then puts back every
reference file whose events did not change (uuids, capture-day times, temp folder names and
notes are normalized), so `git diff` shows only real changes, and the report lists them.

## Notes

- To find the Conn commit that broke a check, check out older commits of the monorepo in a
  worktree and run `tools/check.sh` there.
- `tools/upkeep/followed-files.txt` maps Conn pathspecs to the part here that follows them
  (crates and some files of `conn-server`). Add a pathspec when a part starts to follow a
  file. The report lists new upstream files no part follows; that list is for reading, and
  never fails a run.
- `tools/upkeep/http-routes.json` is generated: the T3 server's HTTP routes. The report
  compares it with the routes this server registers.
- A new upstream method, route or command type that we do not serve is reported, not
  failed. A changed scope, settings secret field or server version changes a generated file
  and shows in the report.
- `tools/upkeep/mcp-tools.json` holds a digest of each T3 `/mcp` tool. It lets the next
  run say which tool changed and which part.

## Bumps

Before the move into the monorepo (2026-11-15) the Conn Server pinned one Conn commit in
`conn.pin` and moved it with `tools/bump-conn.sh`. These are the records of those bumps.

### 2026-11-14: b685417bb6 → b12470dcad

The first real bump: 278 Conn commits (an upstream merge of 266), about 300 files. About
four hours, most of it reading upstream changes and finishing the tools.

- **Red at the raw bump (13 checks):** the build broke on two contract changes
  (`ClientServerSettingsPatch`, `AuthPairingLink.connectDeviceRequest`), so every check that
  needs the binary failed; the Codex instruction text was stale, because the bump did not
  run its generator. Two tests held the method count by hand.
- **Found by reading, not by a check:** the access scope of `requireConnectDeviceApproval`,
  the client patch keys, two allowed tools in Claude's read-only list, the new Claude spawn
  script and system prompt text. Each now has a generator or a check.
- **Providers:** SDK 0.3.321 and Codex 0.166.0 did not move. Claude conformance: no
  differences after the spawn script and prompt fix. T3 replay: 15 of 18 pass, the same 3
  as before. Codex conformance: no open difference after the text regeneration. Codex
  answers now keep the native question id. Not followed: Codex Stop that waits for "Force
  stop" (the engine has no unresponsive Stop), T3's reaping of a recorded Claude CLI after a
  restart, the Claude Monitor wake and self-resumed subagent rows, skill mentions from
  handoff history, `autoCompactEnabled`.
- **Served shapes:** `thread.metadata.update` continuation, `projects.listIgnoredFiles`
  query, `serverTime`, and the `/mcp` thread list and read changes are followed and tested.
- **New upstream, not served:** `pullRequests.subscribeLinkedThreadRefreshes`; HTTP
  `/api/auth/connect-devices/approve` and `/revoke` (T3 Connect device approval); the `/mcp`
  tools `send_to_user`, `t3_theme_read`, `t3_theme_set`; environment themes.
- **Tools changed:** see the table above; the report starts with "What to do".

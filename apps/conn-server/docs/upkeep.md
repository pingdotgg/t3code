# Upkeep: keep the Conn Server in step with Conn

The Conn Server follows one Conn commit. `conn.pin` holds it. Each night the bot merges
upstream T3 Code into Conn. After that merge, the same run moves the pin here and checks
what broke. No step calls a model.

## The tools

| Command | What it does |
| --- | --- |
| `tools/conn-checkout --source <git dir or URL> [--commit <sha>] [--dest <dir>] [--web]` | Makes or updates a Conn checkout, runs `vp i` when the lockfile changed, and prints `export CONN_MONOREPO=…`. From a local Git directory it adds a detached worktree and never touches that repository's working tree. |
| `CONN_MONOREPO=<checkout> tools/bump-conn.sh [<commit>] [--capture]` | Writes `conn.pin`, regenerates the contract, the `/mcp` catalog and texts, the keybindings, the upstream tables (`tools/gen-upstream.mjs`: scopes, settings keys, HTTP routes, the T3 server version, settings secrets), the Codex instruction text and the Claude model catalog, runs `tools/check.sh`, and prints the report. `--capture` also regenerates the provider crates' reference events (about 2 minutes). It never commits. It exits 1 when a step fails, or when the contract has more Opaque fallbacks than before. |
| `CONN_MONOREPO=<checkout> tools/check.sh` | Every check that needs no model. |

`bump-conn.sh` keeps its log and report in `target/bump-conn/<commit>.{log,report.txt}`.

## What the bot runs

Run this in a clean checkout of `conn-server`, on a new branch, after the sync merge is on
Conn `main`. `<conn>` is a Conn Git directory or a URL with read access to `nckrtl/conn`.
`<sha>` is the new Conn `main` commit.

```sh
git switch -c conn-bump/$(date +%F)
eval "$(tools/conn-checkout --source <conn> --commit <sha>)"
(cd helpers/sdk-host && npm ci)    # else the Claude conformance check is skipped
tools/bump-conn.sh <sha> --capture | tee bump-report.txt
```

1. The checkout must be the bot's own. Never point `CONN_MONOREPO` at a checkout that
   another job uses.
2. `tools/conn-checkout` keeps one checkout in `~/.cache/conn-server/conn` and moves it to
   each new commit. The second night costs one `vp i` at most.
3. Install `cargo-deny` on the bot's machine. Without it, `check.sh` skips that check and
   says so.

## Green (exit 0)

1. Commit every change on `conn-bump/<date>`, with the report as the commit body.
2. Merge it into `main` here. (When this repository has a remote: push the branch and
   open a pull request, only when Nick allows it.)
3. Post the report where the Conn sync result goes. Read **What to do** at its top first:
   it lists the red checks, the served methods and `/mcp` tools that changed shape, the
   provider parts with upstream commits and the state of their conformance checks, pins that
   differ, and changed reference events. A green bump can still list work there.

A green run can still need work. A new method that we do not serve stays unregistered and
answers "not supported": that is correct, not a failure. A changed provider file means the
provider crate may need to follow it.

## Red (exit 1)

1. Do not merge. `main` here keeps the old pin, so it stays green.
2. Commit the bumped tree as it is on `conn-bump/<date>`, with `WIP: red` in the subject and
   the report as the body. Keep `target/bump-conn/<commit>.log`.
3. Post the report with the failed steps. Hand the branch to a person or an agent.

## Fix a red bump

Start on the `conn-bump/<date>` branch, with `CONN_MONOREPO` at the new commit. Read the
report, then the log. Then:

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
| `cargo test` in `conn-mcp` catalog | `fixtures/ts-tools-list.json` is a T3 `tools/list` from the old pin | `node crates/conn-mcp/tools/parity.mjs --record-tools-list crates/conn-mcp/fixtures/ts-tools-list.json target/release/examples/replay_server` |
| `codex conformance`, `claude conformance` | What a CLI is sent moved upstream (argv, environment, the spawn script, a prompt text) | Follow the adapter commits in the report. The diff names the field. A launch difference is a defect, never a listed exception. |
| `claude t3-replay` | A T3 Claude transcript changed its result | Fix the session; if it is a known gap, list it in `crates/conn-provider-claude/tools/t3-replay/expected-failures.txt` with the reason. A listed one that passes fails too: remove it. |
| `claude catalog --check` | T3's bundled Claude models moved | `crates/conn-provider-claude/tools/gen-catalog/run.sh` (bump-conn.sh runs it). |
| `gen-upstream` says a settings key "needs …" | A settings patch key needs a new scope set | Teach `gen-upstream.mjs` and `scopes.rs` `settings_scopes` the domain. |
| `cargo deny` | A new advisory | Plan the crate change; add a dated exception to `deny.toml` only with a reason. |

Then run `tools/check.sh` until it is green, commit, and merge as for a green run.

For each part in **Upstream commits per part** that changed, read the commits (the report
prints the subjects) and the diff in Conn (`git diff <old> <new> -- <the part's files>`), and
compare them with that part here. A served method whose shape changed needs the same: the
report groups them by the types that moved. When the report says a pin differs
(`← differs`), move the pin (`helpers/sdk-host/package.json` and `npm install` for the Claude
Agent SDK; `check-copies` fails until it matches T3's lockfile), then run the bump again with
`--capture`.

`--capture` runs both capture tools. `tools/reference-events.mjs` then puts back every
reference file whose events did not change (uuids, capture-day times, temp folder names and
notes are normalized), so `git diff` shows only real changes, and the report lists them.

## Notes

- The bump also works backwards (`tools/bump-conn.sh <older sha>`), for example to find
  the Conn commit that broke a check.
- `tools/upkeep/followed-files.txt` maps Conn pathspecs to the part here that follows them
  (crates and some files of `conn-server`). Add a pathspec when a part starts to follow a
  file. The report lists new upstream files no part follows; that list is for reading, and
  never fails a bump.
- `tools/upkeep/http-routes.json` is generated: the T3 server's HTTP routes. The report
  compares it with the routes this server registers.
- A new upstream method, route or command type that we do not serve is reported, not
  failed. A changed scope, settings secret field or server version changes a generated file
  and shows in the report.
- `tools/upkeep/mcp-tools.json` holds a digest of each T3 `/mcp` tool. It lets the next
  bump say which tool changed and which part.

## Bumps

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

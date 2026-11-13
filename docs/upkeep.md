# Upkeep: keep the Conn Server in step with Conn

The Conn Server follows one Conn commit. `conn.pin` holds it. Each night the bot merges
upstream T3 Code into Conn. After that merge, the same run moves the pin here and checks
what broke. No step calls a model.

## The tools

| Command | What it does |
| --- | --- |
| `tools/conn-checkout --source <git dir or URL> [--commit <sha>] [--dest <dir>] [--web]` | Makes or updates a Conn checkout, runs `vp i` when the lockfile changed, and prints `export CONN_MONOREPO=…`. From a local Git directory it adds a detached worktree and never touches that repository's working tree. |
| `CONN_MONOREPO=<checkout> tools/bump-conn.sh [<commit>]` | Writes `conn.pin`, regenerates the contract, the `/mcp` catalog and texts, the keybindings and the upstream tables (`tools/gen-upstream.mjs`: scopes, HTTP routes, the T3 server version, settings secrets), runs `tools/check.sh`, and prints the report. It never commits. It exits 1 when a step fails, or when the contract has more Opaque fallbacks than before. |
| `CONN_MONOREPO=<checkout> tools/check.sh` | Every check that needs no model. |

`bump-conn.sh` keeps its log and report in `target/bump-conn/<commit>.{log,report.txt}`.

## What the bot runs

Run this in a clean checkout of `conn-server`, on a new branch, after the sync merge is on
Conn `main`. `<conn>` is a Conn Git directory or a URL with read access to `nckrtl/conn`.
`<sha>` is the new Conn `main` commit.

```sh
git switch -c conn-bump/$(date +%F)
eval "$(tools/conn-checkout --source <conn> --commit <sha>)"
tools/bump-conn.sh <sha> | tee bump-report.txt
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
3. Post the report where the Conn sync result goes. The lines to read first are
   **new in this bump and not served**, **Scopes**, **Engine commands**, **HTTP routes** and
   **Upstream commits per part**.

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
| `cargo deny` | A new advisory | Plan the crate change; add a dated exception to `deny.toml` only with a reason. |

Then run `tools/check.sh` until it is green, commit, and merge as for a green run.

For each part in **Upstream commits per part** that changed, read the commits (the report
prints the subjects) and the diff in Conn (`git diff <old> <new> -- <the part's files>`), and
compare them with that part here. When the
report says a pin differs (`← differs`), update the pin in the crate and re-record its
reference events with the crate's capture tool. `bump-conn.sh --capture` is the place to
call those tools; they are not hooked in yet.

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

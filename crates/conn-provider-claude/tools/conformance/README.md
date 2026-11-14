# Conformance check

Proves that the `claude` CLI gets the same start and the same input from the Conn Server as
from the T3 server. No model is called.

```sh
CONN_MONOREPO=/path/to/conn ./run.sh            # all scenarios
./run.sh fork image                              # some
```

Needs: `npm ci` in `helpers/sdk-host`, and `vp i` in the Conn monorepo checkout at the pinned
commit, given as `CONN_MONOREPO` (there is no default). Rerun it on
every SDK, CLI or pinned-commit change. Exit 0 means no difference.

## How it works

- `stub-claude` stands in for the CLI. It records its argv, environment, working directory and
  every stdin line, and replays a recorded CLI transcript from `testdata/cli`.
- `claudeConformance.test.ts` runs each scenario through the T3 server's own `ClaudeAdapterV2`
  with its real Agent SDK query runner (`layerQueryRunner`), with the environment
  `createClaudeAdapterV2` builds. `run.sh` copies it into the monorepo, runs it with
  `vp test`, and deletes it.
- `examples/conformance.rs` runs the same scenarios through `ClaudeProvider` and the SDK helper.
- Both start from the same base environment (`env -i`, a throwaway `HOME`, an empty
  `CLAUDE_CONFIG_DIR`); `compare.mjs` diffs the records.
- The base environment's `SHELL` is a stand-in login shell (`$OUT/login-shell`). Each side
  first runs its server's start-up step on it: T3's `fixPath` (`os-jank.ts`) on the base
  environment, ours `conn_support::login_env::hydrate`. So every scenario's CLI gets the merged
  `PATH` (`mergePathEntries`: the shell's entries first, a blank entry and repeats dropped),
  `__MISE_DIFF` and `JAVA_HOME`. A full run then repeats `fresh_turn` with `JAVA_HOME` already
  set (`$OUT/java-home-set`), where the shell's value must not replace it.

An interrupt runs beside the turn's events on both sides (T3 forks `interruptTurn` with
`requestRuntimeRestart`, as `ProviderTurnControlService` calls it), and the next step waits
for it to finish. That is how T3's effect outbox orders a Stop and the next turn of a thread,
so the reference does not depend on timing. The stub exits when its stdin ends, as the real
CLI does: T3's `turn_interrupt_restart` transcript, recorded with the real CLI, shows a clean
exit (`runtime_exit` success) after the interrupt and then a new `query.open`.

Normalized in the comparison, and nothing else: uuids and the SDK's control request ids (random
per run; numbered by first appearance), the stub's path, and the order of environment entries.
A stdin line that differs only in JSON key order is reported as such and fails the check.

## Scenarios (`scenarios.json`)

| Scenario                   | Covers                                                          |
| -------------------------- | --------------------------------------------------------------- |
| `fresh_turn`               | first turn: argv, env, `initialize`, prompt                     |
| `resumed_turn`             | a new provider session on the same thread (`--resume`)          |
| `mcp_turn`                 | the `t3-code` MCP server: allow rule, system prompt, `mcp_set_servers` |
| `permission`               | approval-required: two `can_use_tool` prompts, decline and accept |
| `interrupt`                | `interrupt` during output, the CLI closed, then a second turn in a new CLI (`--resume`): 2 starts |
| `interrupt_twice`          | the same twice: the resumed CLI is interrupted and closed too; 3 starts |
| `model_change_live`        | a model change on a live CLI: `set_model`, `apply_flag_settings` |
| `model_change_restart`     | a model change where the CLI opened in another mode: a new CLI |
| `fork`                     | `forkSession` on disk, then the fork's first turn               |
| `image`                    | an image attachment                                             |
| `settings_bypass_disabled` | settings forbid bypass (downgrade to `auto`), settings entrypoint |
| `live_selection_effort`    | a new effort sent to the running turn: `apply_flag_settings` during the turn |
| `live_selection_model`     | a new model sent to the running turn: nothing until the next turn |
| `stop_background_idle`     | Stop with no turn running while a background task holds the CLI (`interruptTurn` with `requestRuntimeRestart` on the settled turn): the CLI is closed, the next turn resumes in a new one; 2 starts. Its first script is constructed (`constructed/README.md`) |
| `read_only_sandbox`        | `approvalPolicy: never` and a read-only sandbox (`policyOverride`), with `t3-code`: `dontAsk`, the read-only tools and allow rules |

Not covered here: steering, subagents, elicitation and dialogs, and a CLI that fails to start.

# Conformance check

Proves that the `claude` CLI gets the same start and the same input from the Conn Server as
from the T3 server. No model is called.

```sh
CONN_MONOREPO=/path/to/conn ./run.sh            # all scenarios
./run.sh fork image                              # some
```

Needs: `npm ci` in `helpers/sdk-host`, and `vp i` in the Conn monorepo checkout at the pinned
commit (default `/Users/nckrtl/.t3/headless/worktrees/conn/conn-server-monorepo`). Rerun it on
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
| `interrupt`                | `interrupt` during output, then a second turn                   |
| `model_change_live`        | a model change on a live CLI: `set_model`, `apply_flag_settings` |
| `model_change_restart`     | a model change where the CLI opened in another mode: a new CLI |
| `fork`                     | `forkSession` on disk, then the fork's first turn               |
| `image`                    | an image attachment                                             |
| `settings_bypass_disabled` | settings forbid bypass (downgrade to `auto`), settings entrypoint |

Not covered here: steering, subagents, elicitation and dialogs, a CLI that fails to start, and
the read-only sandbox (the provider trait carries no sandbox policy yet).

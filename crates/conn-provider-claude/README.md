# conn-provider-claude

The Claude provider for `conn-server`. It drives the `claude` CLI over its stdio stream-JSON
protocol and implements `Provider` and `Session` from `conn-provider`. Reference behaviour:
`ClaudeAdapterV2.ts` at the pinned contract commit.

## Layout

| Module     | Holds                                                                                |
| ---------- | ------------------------------------------------------------------------------------ |
| `protocol` | Typed CLI messages; unknown kinds and changed shapes fall back to raw JSON           |
| `launch`   | Executable, argv, environment, `initialize`, runtime mode → permission mode          |
| `mapper`   | Pure state machine: CLI messages → `ProviderEvent`s and CLI replies                  |
| `process`  | The child: bounded line reader, stdin writer, stderr tail, reaping, group kill       |
| `session`  | `Session`: lazy start, control requests, a driver task per process                   |
| `ids`      | `IdAllocatorV2` id formats, clock, uuid. General; a Codex crate needs the same thing |

`ids`, the line framing and supervisor in `process`, and the driver loop in `session` are not
Claude-specific. Move them to a shared crate when Codex lands; nothing is shared yet.

## Launch policy (matches the TS server)

- **Executable:** `ClaudeSettings.binaryPath`, default `claude` on PATH, `~` expanded.
- **Setting sources:** none passed. The CLI loads user, project and local settings, hooks
  and permission rules included, as under T3.
- **Environment:** inherit the host environment, then:
  - remove a parent Claude session's variables (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
    messaging socket and token, `CLAUDE_EFFORT`, `CLAUDE_PID`, ...), plus
    `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `DEBUG`
  - set `CLAUDE_CODE_ENTRYPOINT=t3-code`
  - set `CLAUDE_CONFIG_DIR` when `homePath` is set
  - apply the instance's own env
  - set `MCP_CONNECTION_NONBLOCKING=0` on resume
  - set `T3CODE_THREAD_ID`
  - set `CLAUDE_AGENT_SDK_VERSION=0.3.321` and `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`, as the
    SDK does
  - no auth; in a container the inherited environment points at the AI router
- **argv:** the SDK's order and `--flag=value` form:
  - `--thinking=adaptive --thinking-display=summarized [--effort=…] --model=…`
  - `--permission-prompt-tool=stdio [--resume=…] --tools=default --permission-mode=…`
  - `[--allow-dangerously-skip-permissions] --include-partial-messages --add-dir=<cwd>`
  - `[--session-id=…] --thinking-display summarized --settings {"showThinkingSummaries":true}`
- **`initialize`:** `appendSystemPrompt` (T3's runtime instructions), `title`,
  `promptSuggestions: false`, `supportedDialogKinds: ["resume_return"]`.
- **Permission mode:**
  - `plan` interaction → `plan`
  - `approval-required` → `default`
  - `auto-accept-edits` → `acceptEdits`
  - `auto` → `auto` (the callback allows without asking)
  - `full-access` → `bypassPermissions`

## Event mapping

| CLI                                              | Events                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| user message written                             | `provider_turn.updated` running (weak ref `turn:<attempt>`), `provider_thread.updated` active                    |
| `stream_event` `message_start` / `message_delta` | `provider_turn.updated` with `tokenUsage`                                                                        |
| text / thinking deltas                           | every 50 ms: `node` + `message` + `turn_item` (`assistant_message`, streaming) or `reasoning`                    |
| block stop or `assistant` snapshot               | the same, completed                                                                                              |
| `assistant` `tool_use`                           | `node.updated` + `turn_item.updated` (`command_execution`, `file_change`, `web_search`, `dynamic_tool`) running  |
| `user` `tool_result`                             | the same, completed / failed / cancelled / interrupted, with output                                              |
| `can_use_tool`                                   | approval: `node` + `runtime_request` + `turn_item` (`approval_request`)                                          |
| `can_use_tool` AskUserQuestion                   | `user_input_request` with questions; the answers go back as `updatedInput.answers`                               |
| `can_use_tool` ExitPlanMode                      | `plan.updated` (proposed plan), tool denied as T3 does                                                           |
| `elicitation`                                    | field-less form: an `mcp-elicitation` approval card; anything else is declined                                   |
| `request_user_dialog`                            | `resume_return`: a question; other kinds: `cancelled`                                                            |
| `control_cancel_request`                         | request, node and item marked `cancelled`; answered as the SDK does                                              |
| `system` `compact_boundary`                      | `compaction` turn item                                                                                           |
| `system` `informational` (not info)              | `system_notice` turn item                                                                                        |
| `result`                                         | open rows closed, `provider_turn.updated` (status, `turnTokenUsage`), `provider_thread.updated`, `turn.terminal` |
| process exit mid-turn                            | `turn.terminal` failed, `transport_error` / `claude_process_exited`                                              |
| unknown kind, subagent frames, `api_retry`       | decoded, logged once per kind, skipped                                                                           |

`src/replay_tests.rs` replays recorded CLI output through the mapper. Four recordings produce
the same events as the TS adapter does for the same lines: a simple turn, a permission turn,
an interrupt followed by a turn, and two turns. The comparison applies the documented
normalizations listed under "Known differences".

## Known differences from `ClaudeAdapterV2`

Normalized in the comparison:

- Runtime request ids end in a random uuid.
- `threadId: null` appears where TS leaves the key out.
- These TS fields are missing:
  - `nativeMetadata`: the attachment budget.
  - `goal`.
  - `pendingBackgroundWork`: the trait has no field for it.
  - `failureItemOrdinal`.
  - `turnTokenUsage.otherUsage`: the process-wide usage ledger.
- TS sends an extra `provider_turn.updated` with unchanged usage.

Not implemented (decoded where the CLI sends something, then skipped):

- **Subagents:** `Agent` tool rows, `task_*` lifecycle and subagent streams.
- **Lists and events:** TodoWrite todo lists, `steer.updated`, `prompt_suggestion.updated`.
- **Retries and limits:** the `api_retry` row and retry state on the terminal, usage-limit
  notices from `rate_limit_event`.
- **Compaction:** the running compaction row before its boundary.
- **Tool rows:** titles (Read/Grep labels, MCP display names), icons and sources, image
  previews, web search results, and file patches formatted as diffs.
- **Context window:** `maxTokens` is fixed at 200,000. It ignores the model catalog, `[1m]`
  and auto-compact thresholds.
- **Models:** model slugs are not canonicalized through the catalog. The provider entry uses
  a static model list, while TS reads it from the CLI's `initialize` answer.
- **Attachments:** images and files are not sent.
- **T3 MCP:** no `mcp_set_servers`, no `mcp__t3-code__*` allow rule, no orchestration
  instructions, no device `SubagentStart` hook. The server has no `/mcp` yet.
- **Steer:** a mid-turn message is written as a queued CLI turn. Its extra `result` is folded
  into the running provider turn. TS tracks prompt echoes (`msg_lifecycle`).
- **Interrupt:** returns when the CLI acknowledges. TS waits for the terminal.
- **Elicitation:** only field-less forms are accepted. TS fills simple forms.
- **Resume-dialog question:** the text is a stand-in for `formatClaudeResumeCompactionQuestion`.
- **Bypass downgrade:** settings that forbid bypass are not read, because that needs
  `resolveSettings`.
- **Process cleanup:** TS wraps the CLI in an agent scope and polls for descendants. Here the
  CLI runs in its own process group, and the group is killed after the CLI exits.

## Disk helpers (out of scope)

The TS adapter reads Claude's session files through the SDK:

| Helper                | Where (`ClaudeAdapterV2.ts`)                                                                                                              | T3 feature                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `forkSession`         | query runner `forkSession` (~1720, worker for custom homes ~1235); called by `forkThread` (~13596)                                        | Fork thread, fork from a turn                                                   |
| `getSessionMessages`  | after a fork, to find the copied head (~1772)                                                                                             | Fork, then rollback and resume at the right message                             |
| `getSubagentMessages` | `subagentLaunchToolUseId` (~1804), `subagentModel` (~1824); used by `recoverResumedClaudeSubagent` (~6811) and `forkedSkillModel` (~6775) | Subagent rows after a restart, a forked skill's model                           |
| `resolveSettings`     | `resolveBypassAvailability` (~5288, used at ~5570), `resolveSubagentPromptCacheTtl` (~5320, used at ~12128)                               | Full access falling back when bypass is disabled; a delegated child's cache TTL |

The CLI can fork at a point. `--resume <id> --fork-session --resume-session-at <assistant uuid>`
gave a new session id, and its transcript stopped at the anchor. The model still remembered a
fact from after the anchor. That came from Claude's auto-memory (`memory/` in the project
folder), not from the transcript.

## Tests

```sh
cargo test -p conn-provider-claude                         # offline: recordings, process, launch
cargo test -p conn-provider-claude live_ -- --ignored --test-threads=1   # real CLI, Haiku
cargo run --release -p conn-provider-claude --example rss  # memory of a host with one session
```

The live tests run in an empty temporary folder and delete it afterwards, along with the
session folder under `~/.claude/projects`. The permission test points `CLAUDE_CONFIG_DIR` at a
throwaway folder that holds only the user's `apiKeyHelper`. Otherwise the user's own allow rules
would answer the prompt before it reaches T3.

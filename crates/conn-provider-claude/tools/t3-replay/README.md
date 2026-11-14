# T3 transcript replay

The T3 server tests its Claude adapter against recorded transcripts
(`apps/server/src/orchestration-v2/testkit/fixtures/*/claude_transcript.ndjson`). Each one lists
what the adapter must send to its SDK query runner (`expect_outbound`: `query.open` with T3's
projection of the options, `prompt.offer`, `query.interrupt`, `permission.response`,
`session.fork`) and what the runner answers (`emit_inbound`). The SDK host protocol mirrors those
calls, so the same transcripts test the Conn Server's Claude session:

```sh
CONN_MONOREPO=/path/to/conn ./run.sh            # needs node
```

`fake-host.mjs` stands in for the SDK host and replays one transcript; `examples/t3_replay.rs`
drives `ClaudeSession` through the steps of the fixture's `input.ts` (`scenarios.json`; prompt
texts come from the transcript). Every outbound frame must equal the recorded one.

`tools/check.sh` runs `check.mjs`: it fails when a scenario that is not in
`expected-failures.txt` fails, and when a listed one passes (then remove it from the list).

## Result at the pinned commit

18 of 39 pass, all that are driven: `simple`, `multi_turn`, `command_output_streaming`,
`subagent`, `web_search`, `claude_local_bash_task`, `claude_mcp_tool_presentation`,
`claude_nested_subagent_model`, `claude_result_is_error`, `claude_background_task_interrupt`,
`tool_call_workspace_never`, `tool_call_denied_write`, `tool_call_read_only`,
`tool_call_read_only_on_request`, `tool_call_restricted_granular`, `turn_interrupt`,
`turn_interrupt_mid_tool`, `turn_interrupt_restart`.

Each scenario's runtime policy comes from T3's own fixture table: `policies.mjs` imports
`testkit/fixtures/index.ts` from `CONN_MONOREPO` and prints the thread's modes and the
scenario's `runtimePolicyOverride`, which T3's harness lays over the policy
(`RuntimePolicy.layerWithOverride`).

Not driven yet (their steps need more than this driver has):

| Scenarios | Needs |
| --- | --- |
| `claude_background_*` (6 more), `claude_nested_background_subagent_wake`, `claude_compact_after_peer_turn` | `await_run_status` and `release_replay_gate`: engine-started continuation turns and T3's replay gate |
| `claude_idle_resume`, `claude_compact_after_resume_wake` | `advance_clock`: the idle release on a test clock |
| `message_steering` | `restart` and `steer` steps |
| `queued_turn` | `queue_message` (the provider does not offer queued messages) |
| `thread_rollback` | a `rollback` step |
| `thread_fork_native*` (3), `thread_merge_back_siblings`, `multi_turn_restart`, `claude_subagent_resume_after_restart`, `claude_compact_after_peer_turn_no_echo` | no `input.ts` beside the transcript; driven by T3's own integration tests (`ThreadFork`, `ThreadMergeBack`, restart recovery) |

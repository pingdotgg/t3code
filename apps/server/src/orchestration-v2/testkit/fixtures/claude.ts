import type { ModelSelection } from "@t3tools/contracts";

import { assertSimpleClaudeOutput } from "./simple/claude_output.ts";
import { simpleInput } from "./simple/input.ts";
import type { OrchestratorReplayFixture } from "./shared.ts";

export const CLAUDE_MODEL_SELECTION = {
  provider: "claudeAgent",
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;

export const CLAUDE_REPLAY_FIXTURES: ReadonlyArray<OrchestratorReplayFixture> = [
  {
    name: "simple",
    buildInput: simpleInput,
    providers: [
      {
        provider: "claudeAgent",
        transcriptFile: new URL("./simple/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertSimpleClaudeOutput,
      },
    ],
  },

  // TODO(claude-v2/multi_turn): add `multi_turn/claude_transcript.ndjson` after the recorder can
  // write multiple Agent SDK `query()` calls into one transcript while preserving one Claude-native
  // provider-thread identity. Use `multi_turn/input.ts` for provider-neutral commands and
  // `multi_turn/codex_transcript.ndjson` as the Codex replay reference. The continuation semantics
  // must follow Claude Agent SDK docs for `sessionId`/resume behavior, not a hand-authored guess.

  // TODO(claude-v2/tool_call_read_only): add `tool_call_read_only/claude_transcript.ndjson` after
  // the adapter maps Claude tool-use/tool-result SDK messages into V2 tool nodes/items. Use
  // `tool_call_read_only/input.ts` for provider-neutral commands. Closest Codex references are
  // `todo_list/codex_transcript.ndjson` for read-heavy agent behavior and
  // `tool_call_read_only_on_request/codex_transcript.ndjson` for tool/projection shape.

  // TODO(claude-v2/approvals): add accepted and denied write fixtures after the live query runner
  // records Claude permission callbacks and callback responses. Cross-reference
  // `tool_call_read_only_on_request/codex_transcript.ndjson`,
  // `tool_call_workspace_never/codex_transcript.ndjson`, and
  // docs/orchestration-v2/provider-capability-system.md.

  // TODO(claude-v2/control): add queued-turn, interrupt, and steering fixtures once the real adapter
  // exposes those behaviors through capability-checked V2 paths. Cross-reference
  // `queued_turn/codex_transcript.ndjson`, `turn_interrupt/codex_transcript.ndjson`,
  // `message_steering/codex_transcript.ndjson`, and docs/orchestration-v2/feature-lifecycles.md.

  // TODO(claude-v2/context-transfer): add provider-switch handoff and return fixtures when portable
  // context handoff is implemented. Cross-reference docs/orchestration-v2/provider-switching-and-context.md
  // and docs/orchestration-v2/thread-lineage-and-context-transfer.md. The return fixture should
  // prefer a delta handoff into an existing Claude provider thread.

  // TODO(claude-v2/fork-rollback-subagents): add fork, rollback, and subagent fixtures only after
  // Claude's native behavior is proven by real transcripts, or after V2 has an explicit portable
  // fallback. Cross-reference `thread_fork_native/codex_transcript.ndjson`,
  // `thread_rollback/codex_transcript.ndjson`, `subagent/codex_transcript.ndjson`, and
  // docs/orchestration-v2/thread-lineage-and-context-transfer.md.
];

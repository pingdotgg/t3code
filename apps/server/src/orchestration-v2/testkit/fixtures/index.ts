import { assertClaudeMessageSteeringOutput } from "./message_steering/claude_output.ts";
import { assertMessageSteeringOutput } from "./message_steering/codex_output.ts";
import { assertCursorMessageSteeringOutput } from "./message_steering/cursor_output.ts";
import { assertGrokMessageSteeringOutput } from "./message_steering/grok_output.ts";
import { messageSteeringInput } from "./message_steering/input.ts";
import { assertMultiTurnClaudeOutput } from "./multi_turn/claude_output.ts";
import { assertMultiTurnOutput } from "./multi_turn/codex_output.ts";
import { multiTurnInput } from "./multi_turn/input.ts";
import { openCodeSubagentInput } from "./opencode_subagent/input.ts";
import { assertOpenCodeSubagentOutput } from "./opencode_subagent/output.ts";
import { assertPlanQuestionsOutput } from "./plan_questions/codex_output.ts";
import { assertOpenCodePlanQuestionsOutput } from "./plan_questions/opencode_output.ts";
import { planQuestionsInput } from "./plan_questions/input.ts";
import { assertProposedPlanOutput } from "./proposed_plan/codex_output.ts";
import { assertProposedPlanCursorOutput } from "./proposed_plan/cursor_output.ts";
import { proposedPlanInput } from "./proposed_plan/input.ts";
import { assertQueuedTurnOutput } from "./queued_turn/codex_output.ts";
import { queuedTurnInput } from "./queued_turn/input.ts";
import { assertSimpleClaudeOutput } from "./simple/claude_output.ts";
import { assertSimpleOutput } from "./simple/codex_output.ts";
import { simpleInput } from "./simple/input.ts";
import { assertSubagentOutput } from "./subagent/codex_output.ts";
import { assertClaudeSubagentOutput } from "./subagent/claude_output.ts";
import { subagentInput } from "./subagent/input.ts";
import { assertCursorSubagentOutput } from "./subagent/cursor_output.ts";
import { assertSubagentContinueOutput } from "./subagent_continue/codex_output.ts";
import { subagentContinueInput } from "./subagent_continue/input.ts";
import { assertClaudeThreadRollbackOutput } from "./thread_rollback/claude_output.ts";
import { assertThreadRollbackOutput } from "./thread_rollback/codex_output.ts";
import { threadRollbackInput } from "./thread_rollback/input.ts";
import { assertTodoListOutput } from "./todo_list/codex_output.ts";
import { assertTodoListCursorOutput } from "./todo_list/cursor_output.ts";
import { assertTodoListGrokOutput } from "./todo_list/grok_output.ts";
import { todoListInput } from "./todo_list/input.ts";
import { assertToolCallReadOnlyClaudeOutput } from "./tool_call_read_only/claude_output.ts";
import { assertToolCallReadOnlyCursorOutput } from "./tool_call_read_only/cursor_output.ts";
import { toolCallReadOnlyInput } from "./tool_call_read_only/input.ts";
import { assertToolCallReadOnlyOnRequestClaudeOutput } from "./tool_call_read_only_on_request/claude_output.ts";
import { assertToolCallReadOnlyOnRequestOutput } from "./tool_call_read_only_on_request/codex_output.ts";
import { toolCallReadOnlyOnRequestInput } from "./tool_call_read_only_on_request/input.ts";
import { assertToolCallRestrictedGranularClaudeOutput } from "./tool_call_restricted_granular/claude_output.ts";
import { assertToolCallRestrictedGranularOutput } from "./tool_call_restricted_granular/codex_output.ts";
import { toolCallRestrictedGranularInput } from "./tool_call_restricted_granular/input.ts";
import { assertToolCallWorkspaceNeverClaudeOutput } from "./tool_call_workspace_never/claude_output.ts";
import { assertToolCallWorkspaceNeverOutput } from "./tool_call_workspace_never/codex_output.ts";
import { toolCallWorkspaceNeverInput } from "./tool_call_workspace_never/input.ts";
import { assertTurnInterruptClaudeOutput } from "./turn_interrupt/claude_output.ts";
import { assertTurnInterruptOutput } from "./turn_interrupt/codex_output.ts";
import { turnInterruptInput } from "./turn_interrupt/input.ts";
import { assertTurnInterruptMidToolClaudeOutput } from "./turn_interrupt_mid_tool/claude_output.ts";
import { assertTurnInterruptMidToolCodexOutput } from "./turn_interrupt_mid_tool/codex_output.ts";
import { assertTurnInterruptMidToolCursorOutput } from "./turn_interrupt_mid_tool/cursor_output.ts";
import { turnInterruptMidToolInput } from "./turn_interrupt_mid_tool/input.ts";
import { assertTurnInterruptRestartClaudeOutput } from "./turn_interrupt_restart/claude_output.ts";
import { turnInterruptRestartInput } from "./turn_interrupt_restart/input.ts";
import { assertClaudeWebSearchOutput } from "./web_search/claude_output.ts";
import { assertWebSearchOutput } from "./web_search/codex_output.ts";
import { webSearchInput } from "./web_search/input.ts";
import {
  ACP_REGISTRY_MODEL_SELECTION,
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
  CURSOR_MODEL_SELECTION,
  GROK_MODEL_SELECTION,
  OPENCODE_MODEL_SELECTION,
  READ_ONLY_NEVER_POLICY,
  READ_ONLY_ON_REQUEST_POLICY,
  RESTRICTED_GRANULAR_POLICY,
  type OrchestratorReplayFixture,
  WORKSPACE_NEVER_POLICY,
} from "./shared.ts";

export const ORCHESTRATOR_REPLAY_FIXTURES = [
  {
    name: "acp_elicitation",
    buildInput: planQuestionsInput,
    providers: [
      {
        provider: "grok",
        transcriptFile: new URL("./acp_elicitation/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertPlanQuestionsOutput,
      },
      {
        provider: "acpRegistry",
        transcriptFile: new URL("./acp_elicitation/grok_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertPlanQuestionsOutput,
      },
    ],
  },
  {
    name: "simple",
    buildInput: simpleInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL("./simple/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertSimpleOutput,
      },
      {
        provider: "claudeAgent",
        transcriptFile: new URL("./simple/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertSimpleClaudeOutput,
      },
      {
        provider: "cursor",
        transcriptFile: new URL("./simple/cursor_transcript.ndjson", import.meta.url),
        modelSelection: CURSOR_MODEL_SELECTION,
        assertOutput: assertSimpleOutput,
      },
      {
        provider: "grok",
        transcriptFile: new URL("./simple/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        assertOutput: assertSimpleOutput,
      },
      {
        provider: "acpRegistry",
        transcriptFile: new URL("./simple/grok_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertSimpleOutput,
      },
      {
        provider: "opencode",
        transcriptFile: new URL("./simple/opencode_transcript.ndjson", import.meta.url),
        modelSelection: OPENCODE_MODEL_SELECTION,
        assertOutput: assertSimpleOutput,
      },
    ],
  },
  {
    name: "tool_call_read_only",
    buildInput: toolCallReadOnlyInput,
    providers: [
      {
        provider: "claudeAgent",
        transcriptFile: new URL("./tool_call_read_only/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertToolCallReadOnlyClaudeOutput,
      },
      {
        provider: "cursor",
        transcriptFile: new URL("./tool_call_read_only/cursor_transcript.ndjson", import.meta.url),
        modelSelection: CURSOR_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertToolCallReadOnlyCursorOutput,
      },
      {
        provider: "grok",
        transcriptFile: new URL("./tool_call_read_only/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertToolCallReadOnlyCursorOutput,
      },
      {
        provider: "acpRegistry",
        transcriptFile: new URL("./tool_call_read_only/grok_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertToolCallReadOnlyCursorOutput,
      },
    ],
  },
  {
    name: "tool_call_read_only_on_request",
    buildInput: toolCallReadOnlyOnRequestInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL(
          "./tool_call_read_only_on_request/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
        assertOutput: assertToolCallReadOnlyOnRequestOutput,
      },
      {
        provider: "claudeAgent",
        transcriptFile: new URL(
          "./tool_call_read_only_on_request/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
        assertOutput: assertToolCallReadOnlyOnRequestClaudeOutput,
      },
      {
        provider: "grok",
        transcriptFile: new URL(
          "./tool_call_read_only_on_request/grok_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: GROK_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
        assertOutput: assertToolCallReadOnlyOnRequestOutput,
      },
      {
        provider: "acpRegistry",
        transcriptFile: new URL(
          "./tool_call_read_only_on_request/grok_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
        assertOutput: assertToolCallReadOnlyOnRequestOutput,
      },
    ],
  },
  {
    name: "tool_call_workspace_never",
    buildInput: toolCallWorkspaceNeverInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL(
          "./tool_call_workspace_never/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertToolCallWorkspaceNeverOutput,
      },
      {
        provider: "claudeAgent",
        transcriptFile: new URL(
          "./tool_call_workspace_never/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertToolCallWorkspaceNeverClaudeOutput,
      },
    ],
  },
  {
    name: "tool_call_restricted_granular",
    buildInput: toolCallRestrictedGranularInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL(
          "./tool_call_restricted_granular/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: RESTRICTED_GRANULAR_POLICY,
        assertOutput: assertToolCallRestrictedGranularOutput,
      },
      {
        provider: "claudeAgent",
        transcriptFile: new URL(
          "./tool_call_restricted_granular/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: RESTRICTED_GRANULAR_POLICY,
        assertOutput: assertToolCallRestrictedGranularClaudeOutput,
      },
    ],
  },
  {
    name: "subagent",
    buildInput: subagentInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL("./subagent/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
        assertOutput: assertSubagentOutput,
      },
      {
        provider: "claudeAgent",
        transcriptFile: new URL("./subagent/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeSubagentOutput,
      },
      {
        provider: "cursor",
        transcriptFile: new URL("./subagent/cursor_transcript.ndjson", import.meta.url),
        modelSelection: CURSOR_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertCursorSubagentOutput,
      },
    ],
  },
  {
    name: "subagent_continue",
    buildInput: subagentContinueInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL("./subagent_continue/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertSubagentContinueOutput,
      },
    ],
  },
  {
    name: "opencode_subagent",
    buildInput: openCodeSubagentInput,
    providers: [
      {
        provider: "opencode",
        transcriptFile: new URL("./opencode_subagent/opencode_transcript.ndjson", import.meta.url),
        modelSelection: OPENCODE_MODEL_SELECTION,
        assertOutput: assertOpenCodeSubagentOutput,
      },
    ],
  },
  {
    name: "multi_turn",
    buildInput: multiTurnInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL("./multi_turn/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertMultiTurnOutput,
      },
      {
        provider: "claudeAgent",
        transcriptFile: new URL("./multi_turn/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertMultiTurnClaudeOutput,
      },
      {
        provider: "cursor",
        transcriptFile: new URL("./multi_turn/cursor_transcript.ndjson", import.meta.url),
        modelSelection: CURSOR_MODEL_SELECTION,
        assertOutput: assertMultiTurnOutput,
      },
      {
        provider: "grok",
        transcriptFile: new URL("./multi_turn/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        assertOutput: assertMultiTurnOutput,
      },
      {
        provider: "acpRegistry",
        transcriptFile: new URL("./multi_turn/grok_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertMultiTurnOutput,
      },
    ],
  },
  {
    name: "multi_turn_restart",
    buildInput: multiTurnInput,
    providers: [
      {
        provider: "claudeAgent",
        transcriptFile: new URL("./multi_turn_restart/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertMultiTurnClaudeOutput,
      },
    ],
  },
  {
    name: "queued_turn",
    buildInput: queuedTurnInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL("./queued_turn/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertQueuedTurnOutput,
      },
      {
        provider: "claudeAgent",
        transcriptFile: new URL("./queued_turn/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertQueuedTurnOutput,
      },
      {
        provider: "cursor",
        transcriptFile: new URL("./queued_turn/cursor_transcript.ndjson", import.meta.url),
        modelSelection: CURSOR_MODEL_SELECTION,
        assertOutput: assertQueuedTurnOutput,
      },
      {
        provider: "grok",
        transcriptFile: new URL("./queued_turn/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        assertOutput: assertQueuedTurnOutput,
      },
      {
        provider: "acpRegistry",
        transcriptFile: new URL("./queued_turn/grok_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertQueuedTurnOutput,
      },
    ],
  },
  {
    name: "todo_list",
    buildInput: todoListInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL("./todo_list/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertTodoListOutput,
      },
      {
        provider: "cursor",
        transcriptFile: new URL("./todo_list/cursor_transcript.ndjson", import.meta.url),
        modelSelection: CURSOR_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertTodoListCursorOutput,
      },
      {
        provider: "grok",
        transcriptFile: new URL("./todo_list/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        assertOutput: assertTodoListGrokOutput,
      },
      {
        provider: "acpRegistry",
        transcriptFile: new URL("./todo_list/grok_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertTodoListGrokOutput,
      },
    ],
  },
  {
    name: "web_search",
    buildInput: webSearchInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL("./web_search/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertWebSearchOutput,
      },
      {
        provider: "claudeAgent",
        transcriptFile: new URL("./web_search/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeWebSearchOutput,
      },
    ],
  },
  {
    name: "plan_questions",
    buildInput: planQuestionsInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL("./plan_questions/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertPlanQuestionsOutput,
      },
      {
        provider: "grok",
        transcriptFile: new URL("./plan_questions/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertPlanQuestionsOutput,
      },
      {
        provider: "opencode",
        transcriptFile: new URL("./plan_questions/opencode_transcript.ndjson", import.meta.url),
        modelSelection: OPENCODE_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertOpenCodePlanQuestionsOutput,
      },
    ],
  },
  {
    name: "proposed_plan",
    buildInput: proposedPlanInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL("./proposed_plan/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertProposedPlanOutput,
      },
      {
        provider: "cursor",
        transcriptFile: new URL("./proposed_plan/cursor_transcript.ndjson", import.meta.url),
        modelSelection: CURSOR_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertProposedPlanCursorOutput,
      },
    ],
  },
  {
    name: "message_steering",
    buildInput: messageSteeringInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL("./message_steering/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertMessageSteeringOutput,
      },
      {
        provider: "claudeAgent",
        transcriptFile: new URL("./message_steering/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeMessageSteeringOutput,
      },
      {
        provider: "cursor",
        transcriptFile: new URL("./message_steering/cursor_transcript.ndjson", import.meta.url),
        modelSelection: CURSOR_MODEL_SELECTION,
        assertOutput: assertCursorMessageSteeringOutput,
      },
      {
        provider: "grok",
        transcriptFile: new URL("./message_steering/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        assertOutput: assertGrokMessageSteeringOutput,
      },
      {
        provider: "acpRegistry",
        transcriptFile: new URL("./message_steering/grok_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertGrokMessageSteeringOutput,
      },
    ],
  },
  {
    name: "turn_interrupt",
    buildInput: turnInterruptInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL("./turn_interrupt/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptOutput,
      },
      {
        provider: "claudeAgent",
        transcriptFile: new URL("./turn_interrupt/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptClaudeOutput,
      },
      {
        provider: "grok",
        transcriptFile: new URL("./turn_interrupt/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptOutput,
      },
      {
        provider: "acpRegistry",
        transcriptFile: new URL("./turn_interrupt/grok_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptOutput,
      },
      {
        provider: "opencode",
        transcriptFile: new URL("./turn_interrupt/opencode_transcript.ndjson", import.meta.url),
        modelSelection: OPENCODE_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptOutput,
      },
    ],
  },
  {
    name: "turn_interrupt_mid_tool",
    buildInput: turnInterruptMidToolInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL(
          "./turn_interrupt_mid_tool/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptMidToolCodexOutput,
      },
      {
        provider: "claudeAgent",
        transcriptFile: new URL(
          "./turn_interrupt_mid_tool/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptMidToolClaudeOutput,
      },
      {
        provider: "cursor",
        transcriptFile: new URL(
          "./turn_interrupt_mid_tool/cursor_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CURSOR_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptMidToolCursorOutput,
      },
    ],
  },
  {
    name: "turn_interrupt_restart",
    buildInput: turnInterruptRestartInput,
    providers: [
      {
        provider: "claudeAgent",
        transcriptFile: new URL(
          "./turn_interrupt_restart/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptRestartClaudeOutput,
      },
    ],
  },
  {
    name: "thread_rollback",
    buildInput: threadRollbackInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL("./thread_rollback/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertThreadRollbackOutput,
      },
      {
        provider: "claudeAgent",
        transcriptFile: new URL("./thread_rollback/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeThreadRollbackOutput,
      },
    ],
  },
] satisfies ReadonlyArray<OrchestratorReplayFixture>;

// TODO(claude-v2/approvals-denied): add denied write fixtures after the live query runner records
// Claude denial callback responses. Cross-reference
// `tool_call_read_only_on_request/claude_transcript.ndjson`,
// `tool_call_workspace_never/claude_transcript.ndjson`,
// `tool_call_restricted_granular/claude_transcript.ndjson`, and
// docs/orchestration-v2/provider-capability-system.md.

// TODO(claude-v2/context-transfer): add provider-switch handoff and return fixtures when portable
// context handoff is implemented. Cross-reference docs/orchestration-v2/provider-switching-and-context.md
// and docs/orchestration-v2/thread-lineage-and-context-transfer.md. The return fixture should
// prefer a delta handoff into an existing Claude provider thread.

// TODO(claude-v2/context-transfer-fixtures): register provider-switch, merge-back, and cross-provider
// fork fixtures after each path has a real provider transcript. Cross-reference
// docs/orchestration-v2/provider-switching-and-context.md and
// docs/orchestration-v2/thread-lineage-and-context-transfer.md.

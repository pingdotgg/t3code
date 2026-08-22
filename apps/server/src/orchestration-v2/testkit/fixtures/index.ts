import { ProviderDriverKind } from "@t3tools/contracts";

import { claudeBackgroundTaskAfterRootInput } from "./claude_background_task_after_root/input.ts";
import { assertClaudeBackgroundTaskAfterRootOutput } from "./claude_background_task_after_root/output.ts";
import { claudeIdleResumeInput } from "./claude_idle_resume/input.ts";
import { assertClaudeIdleResumeOutput } from "./claude_idle_resume/output.ts";
import { claudeLocalBashTaskInput } from "./claude_local_bash_task/input.ts";
import { assertClaudeLocalBashTaskOutput } from "./claude_local_bash_task/output.ts";
import { claudeResultIsErrorInput } from "./claude_result_is_error/input.ts";
import { assertClaudeResultIsErrorOutput } from "./claude_result_is_error/output.ts";
import { grokSubagentLineageInput } from "./grok_subagent_lineage/input.ts";
import { assertGrokSubagentLineageOutput } from "./grok_subagent_lineage/output.ts";
import { assertClaudeMessageSteeringOutput } from "./message_steering/claude_output.ts";
import { assertMessageSteeringOutput } from "./message_steering/codex_output.ts";
import { assertCursorMessageSteeringOutput } from "./message_steering/cursor_output.ts";
import { assertGrokMessageSteeringOutput } from "./message_steering/grok_output.ts";
import { messageSteeringInput } from "./message_steering/input.ts";
import { assertMultiTurnClaudeOutput } from "./multi_turn/claude_output.ts";
import { assertMultiTurnOutput } from "./multi_turn/codex_output.ts";
import { multiTurnInput } from "./multi_turn/input.ts";
import { openCode2ArchiveThenDeleteInput } from "./opencode2_archive_then_delete/input.ts";
import { assertOpenCode2ArchiveThenDeleteOutput } from "./opencode2_archive_then_delete/output.ts";
import { openCode2AuthorizationFailureInput } from "./opencode2_authorization_failure/input.ts";
import { assertOpenCode2AuthorizationFailureOutput } from "./opencode2_authorization_failure/output.ts";
import { openCode2BackgroundStopInput } from "./opencode2_background_stop/input.ts";
import { assertOpenCode2BackgroundStopOutput } from "./opencode2_background_stop/output.ts";
import { openCode2BackgroundChildStopInput } from "./opencode2_background_child_stop/input.ts";
import { assertOpenCode2BackgroundChildStopOutput } from "./opencode2_background_child_stop/output.ts";
import { openCode2BackgroundChildStopRecoveryOrderInput } from "./opencode2_background_child_stop_recovery_order/input.ts";
import { assertOpenCode2BackgroundChildStopRecoveryOrderOutput } from "./opencode2_background_child_stop_recovery_order/output.ts";
import { openCode2BackgroundChildStopRecoveryRaceInput } from "./opencode2_background_child_stop_recovery_race/input.ts";
import { assertOpenCode2BackgroundChildStopRecoveryRaceOutput } from "./opencode2_background_child_stop_recovery_race/output.ts";
import { openCode2TwoBackgroundChildStopInput } from "./opencode2_two_background_child_stop/input.ts";
import { assertOpenCode2TwoBackgroundChildStopOutput } from "./opencode2_two_background_child_stop/output.ts";
import { openCode2TwoBackgroundChildReplayInput } from "./opencode2_two_background_child_replay/input.ts";
import { assertOpenCode2TwoBackgroundChildReplayOutput } from "./opencode2_two_background_child_replay/output.ts";
import { openCode2AmbiguousExecutionWakesInput } from "./opencode2_ambiguous_execution_wakes/input.ts";
import { assertOpenCode2AmbiguousExecutionWakesOutput } from "./opencode2_ambiguous_execution_wakes/output.ts";
import { openCode2RetiredSuppressWakeInput } from "./opencode2_retired_suppress_wake/input.ts";
import { assertOpenCode2RetiredSuppressWakeOutput } from "./opencode2_retired_suppress_wake/output.ts";
import { openCode2SharedExecutionReplayInput } from "./opencode2_shared_execution_replay/input.ts";
import { assertOpenCode2SharedExecutionReplayOutput } from "./opencode2_shared_execution_replay/output.ts";
import { openCode2SharedOrdinaryWakeReplayInput } from "./opencode2_shared_ordinary_wake_replay/input.ts";
import { assertOpenCode2SharedOrdinaryWakeReplayOutput } from "./opencode2_shared_ordinary_wake_replay/output.ts";
import { openCode2CompactionInput } from "./opencode2_compaction/input.ts";
import { assertOpenCode2CompactionOutput } from "./opencode2_compaction/output.ts";
import { openCode2FormReplyWithoutEventInput } from "./opencode2_form_reply_without_event/input.ts";
import { assertOpenCode2FormReplyWithoutEventOutput } from "./opencode2_form_reply_without_event/output.ts";
import { openCode2PermissionCancelInput } from "./opencode2_permission_cancel/input.ts";
import { assertOpenCode2PermissionCancelOutput } from "./opencode2_permission_cancel/output.ts";
import { openCode2PermissionCompletedThenFailedInput } from "./opencode2_permission_completed_then_failed/input.ts";
import { assertOpenCode2PermissionCompletedThenFailedOutput } from "./opencode2_permission_completed_then_failed/output.ts";
import { openCode2PermissionDeclineInput } from "./opencode2_permission_decline/input.ts";
import { assertOpenCode2PermissionDeclineOutput } from "./opencode2_permission_decline/output.ts";
import { openCode2PermissionExternalSubagentInput } from "./opencode2_permission_external_subagent/input.ts";
import { assertOpenCode2PermissionExternalSubagentOutput } from "./opencode2_permission_external_subagent/output.ts";
import { openCode2PermissionLocalSuccessThenFailureInput } from "./opencode2_permission_local_success_then_failure/input.ts";
import { assertOpenCode2PermissionLocalSuccessThenFailureOutput } from "./opencode2_permission_local_success_then_failure/output.ts";
import { openCode2PermissionRejectRaceInput } from "./opencode2_permission_reject_race/input.ts";
import { assertOpenCode2PermissionRejectRaceOutput } from "./opencode2_permission_reject_race/output.ts";
import { openCode2PermissionReplyFailureInput } from "./opencode2_permission_reply_failure/input.ts";
import { assertOpenCode2PermissionReplyFailureOutput } from "./opencode2_permission_reply_failure/output.ts";
import { openCode2PermissionReplyFailureAfterTerminalInput } from "./opencode2_permission_reply_failure_after_terminal/input.ts";
import { assertOpenCode2PermissionReplyFailureAfterTerminalOutput } from "./opencode2_permission_reply_failure_after_terminal/output.ts";
import { openCode2PermissionReplyFailureSubagentInput } from "./opencode2_permission_reply_failure_subagent/input.ts";
import { assertOpenCode2PermissionReplyFailureSubagentOutput } from "./opencode2_permission_reply_failure_subagent/output.ts";
import { openCode2PermissionSessionInput } from "./opencode2_permission_session/input.ts";
import { assertOpenCode2PermissionSessionOutput } from "./opencode2_permission_session/output.ts";
import { openCode2PermissionTerminalWithoutReplyInput } from "./opencode2_permission_terminal_without_reply/input.ts";
import { assertOpenCode2PermissionTerminalWithoutReplyOutput } from "./opencode2_permission_terminal_without_reply/output.ts";
import { openCode2QuestionLegacyInput } from "./opencode2_question_legacy/input.ts";
import { assertOpenCode2QuestionLegacyOutput } from "./opencode2_question_legacy/output.ts";
import { openCode2RetryInput } from "./opencode2_retry/input.ts";
import { assertOpenCode2RetryOutput } from "./opencode2_retry/output.ts";
import { openCode2RetryUnknownFinishInput } from "./opencode2_retry_unknown_finish/input.ts";
import { assertOpenCode2RetryUnknownFinishOutput } from "./opencode2_retry_unknown_finish/output.ts";
import { openCode2UnknownFinishIdleInput } from "./opencode2_unknown_finish_idle/input.ts";
import { assertOpenCode2UnknownFinishIdleOutput } from "./opencode2_unknown_finish_idle/output.ts";
import { openCode2ShellProjectionInput } from "./opencode2_shell_projection/input.ts";
import { assertOpenCode2ShellProjectionOutput } from "./opencode2_shell_projection/output.ts";
import { openCode2ShellTerminalsInput } from "./opencode2_shell_terminals/input.ts";
import { assertOpenCode2ShellTerminalsOutput } from "./opencode2_shell_terminals/output.ts";
import { openCode2SubagentBackgroundWakeInput } from "./opencode2_subagent_background_wake/input.ts";
import { assertOpenCode2SubagentBackgroundWakeOutput } from "./opencode2_subagent_background_wake/output.ts";
import { openCode2SubagentRateLimitInput } from "./opencode2_subagent_rate_limit/input.ts";
import { assertOpenCode2SubagentRateLimitOutput } from "./opencode2_subagent_rate_limit/output.ts";
import { openCode2SubagentQueuedTurnInput } from "./opencode2_subagent_queued_turn/input.ts";
import { assertOpenCode2SubagentQueuedTurnOutput } from "./opencode2_subagent_queued_turn/output.ts";
import { openCode2SubagentSupervisedInput } from "./opencode2_subagent_supervised/input.ts";
import { assertOpenCode2SubagentSupervisedOutput } from "./opencode2_subagent_supervised/output.ts";
import { openCode2ThreadDeleteInput } from "./opencode2_thread_delete/input.ts";
import { assertOpenCode2ThreadDeleteOutput } from "./opencode2_thread_delete/output.ts";
import { openCodeSubagentInput } from "./opencode_subagent/input.ts";
import { assertOpenCodeSubagentOutput } from "./opencode_subagent/output.ts";
import { assertPlanQuestionsOutput } from "./plan_questions/codex_output.ts";
import { assertOpenCodePlanQuestionsOutput } from "./plan_questions/opencode_output.ts";
import { planQuestionsInput } from "./plan_questions/input.ts";
import { assertProposedPlanOutput } from "./proposed_plan/codex_output.ts";
import { assertProposedPlanCursorOutput } from "./proposed_plan/cursor_output.ts";
import { proposedPlanInput } from "./proposed_plan/input.ts";
import { assertQueuedCancelledWhileActiveOutput } from "./queued_cancelled_while_active/codex_output.ts";
import { queuedCancelledWhileActiveInput } from "./queued_cancelled_while_active/input.ts";
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
import { assertSubagentV2Output } from "./subagent_v2/codex_output.ts";
import { subagentV2Input } from "./subagent_v2/input.ts";
import { assertSubagentV2NestedOutput } from "./subagent_v2_nested/codex_output.ts";
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
  OPENCODE2_MODEL_SELECTION,
  OPENCODE_MODEL_SELECTION,
  READ_ONLY_NEVER_POLICY,
  READ_ONLY_ON_REQUEST_POLICY,
  RESTRICTED_GRANULAR_POLICY,
  type OrchestratorReplayFixture,
  WORKSPACE_NEVER_POLICY,
} from "./shared.ts";

export const ORCHESTRATOR_REPLAY_FIXTURES: ReadonlyArray<OrchestratorReplayFixture> = [
  {
    name: "claude_background_task_after_root",
    buildInput: claudeBackgroundTaskAfterRootInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_background_task_after_root/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeBackgroundTaskAfterRootOutput,
      },
    ],
  },
  {
    name: "claude_local_bash_task",
    buildInput: claudeLocalBashTaskInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_local_bash_task/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeLocalBashTaskOutput,
      },
    ],
  },
  {
    name: "claude_idle_resume",
    buildInput: claudeIdleResumeInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./claude_idle_resume/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeIdleResumeOutput,
      },
    ],
  },
  {
    name: "claude_result_is_error",
    buildInput: claudeResultIsErrorInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_result_is_error/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeResultIsErrorOutput,
      },
    ],
  },
  {
    name: "grok_subagent_lineage",
    buildInput: grokSubagentLineageInput,
    providers: [
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./grok_subagent_lineage/grok_transcript.ndjson", import.meta.url),
        modelSelection: {
          ...GROK_MODEL_SELECTION,
          model: "grok-composer-2.5-fast",
        },
        assertOutput: assertGrokSubagentLineageOutput,
      },
    ],
  },
  {
    name: "acp_elicitation",
    buildInput: planQuestionsInput,
    providers: [
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./acp_elicitation/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertPlanQuestionsOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
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
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./simple/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertSimpleOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./simple/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertSimpleClaudeOutput,
      },
      {
        driver: ProviderDriverKind.make("cursor"),
        transcriptFile: new URL("./simple/cursor_transcript.ndjson", import.meta.url),
        modelSelection: CURSOR_MODEL_SELECTION,
        assertOutput: assertSimpleOutput,
      },
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./simple/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        assertOutput: assertSimpleOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL("./simple/grok_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertSimpleOutput,
      },
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./simple/opencode_transcript.ndjson", import.meta.url),
        modelSelection: OPENCODE_MODEL_SELECTION,
        assertOutput: assertSimpleOutput,
      },
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL("./simple/opencode2_transcript.ndjson", import.meta.url),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertSimpleOutput,
      },
    ],
  },
  {
    name: "tool_call_read_only",
    buildInput: toolCallReadOnlyInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./tool_call_read_only/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertToolCallReadOnlyClaudeOutput,
      },
      {
        driver: ProviderDriverKind.make("cursor"),
        transcriptFile: new URL("./tool_call_read_only/cursor_transcript.ndjson", import.meta.url),
        modelSelection: CURSOR_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertToolCallReadOnlyCursorOutput,
      },
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./tool_call_read_only/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertToolCallReadOnlyCursorOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
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
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL(
          "./tool_call_read_only_on_request/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
        assertOutput: assertToolCallReadOnlyOnRequestOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./tool_call_read_only_on_request/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
        assertOutput: assertToolCallReadOnlyOnRequestClaudeOutput,
      },
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL(
          "./tool_call_read_only_on_request/grok_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: GROK_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
        assertOutput: assertToolCallReadOnlyOnRequestOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
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
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL(
          "./tool_call_workspace_never/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertToolCallWorkspaceNeverOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
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
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL(
          "./tool_call_restricted_granular/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: RESTRICTED_GRANULAR_POLICY,
        assertOutput: assertToolCallRestrictedGranularOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
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
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./subagent/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
        assertOutput: assertSubagentOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./subagent/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeSubagentOutput,
      },
      {
        driver: ProviderDriverKind.make("cursor"),
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
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./subagent_continue/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertSubagentContinueOutput,
      },
    ],
  },
  {
    name: "subagent_v2",
    buildInput: subagentV2Input,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./subagent_v2/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertSubagentV2Output,
      },
    ],
  },
  {
    name: "subagent_v2_nested",
    buildInput: subagentV2Input,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./subagent_v2_nested/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertSubagentV2NestedOutput,
      },
    ],
  },
  {
    name: "opencode_subagent",
    buildInput: openCodeSubagentInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode_subagent/opencode_transcript.ndjson", import.meta.url),
        modelSelection: OPENCODE_MODEL_SELECTION,
        assertOutput: assertOpenCodeSubagentOutput,
      },
    ],
  },
  {
    name: "opencode2_archive_then_delete",
    buildInput: openCode2ArchiveThenDeleteInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_archive_then_delete/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2ArchiveThenDeleteOutput,
      },
    ],
  },
  {
    name: "opencode2_authorization_failure",
    buildInput: openCode2AuthorizationFailureInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_authorization_failure/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          ...OPENCODE2_MODEL_SELECTION,
          model: "openai/gpt-5.6-sol",
        },
        assertOutput: assertOpenCode2AuthorizationFailureOutput,
      },
    ],
  },
  {
    name: "opencode2_background_stop",
    buildInput: openCode2BackgroundStopInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_background_stop/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2BackgroundStopOutput,
      },
    ],
  },
  {
    name: "opencode2_background_child_stop",
    buildInput: openCode2BackgroundChildStopInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_background_child_stop/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2BackgroundChildStopOutput,
      },
    ],
  },
  {
    name: "opencode2_background_child_stop_recovery_order",
    buildInput: openCode2BackgroundChildStopRecoveryOrderInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_background_child_stop_recovery_order/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2BackgroundChildStopRecoveryOrderOutput,
      },
    ],
  },
  {
    name: "opencode2_background_child_stop_recovery_race",
    buildInput: openCode2BackgroundChildStopRecoveryRaceInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_background_child_stop_recovery_race/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2BackgroundChildStopRecoveryRaceOutput,
      },
    ],
  },
  {
    name: "opencode2_two_background_child_stop",
    buildInput: openCode2TwoBackgroundChildStopInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_two_background_child_stop/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2TwoBackgroundChildStopOutput,
      },
    ],
  },
  {
    name: "opencode2_two_background_child_replay",
    buildInput: openCode2TwoBackgroundChildReplayInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_two_background_child_replay/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2TwoBackgroundChildReplayOutput,
      },
    ],
  },
  {
    name: "opencode2_shared_ordinary_wake_replay",
    buildInput: openCode2SharedOrdinaryWakeReplayInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_shared_ordinary_wake_replay/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2SharedOrdinaryWakeReplayOutput,
      },
    ],
  },
  {
    name: "opencode2_shared_execution_replay",
    buildInput: openCode2SharedExecutionReplayInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_shared_execution_replay/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2SharedExecutionReplayOutput,
      },
    ],
  },
  {
    name: "opencode2_ambiguous_execution_wakes",
    buildInput: openCode2AmbiguousExecutionWakesInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_ambiguous_execution_wakes/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2AmbiguousExecutionWakesOutput,
      },
    ],
  },
  {
    name: "opencode2_retired_suppress_wake",
    buildInput: openCode2RetiredSuppressWakeInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_retired_suppress_wake/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2RetiredSuppressWakeOutput,
      },
    ],
  },
  {
    name: "opencode2_compaction",
    buildInput: openCode2CompactionInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_compaction/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2CompactionOutput,
      },
    ],
  },
  {
    name: "opencode2_form_reply_without_event",
    buildInput: openCode2FormReplyWithoutEventInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_form_reply_without_event/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2FormReplyWithoutEventOutput,
      },
    ],
  },
  {
    name: "opencode2_permission_cancel",
    buildInput: openCode2PermissionCancelInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_permission_cancel/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        runtimePolicyOverride: RESTRICTED_GRANULAR_POLICY,
        assertOutput: assertOpenCode2PermissionCancelOutput,
      },
    ],
  },
  {
    name: "opencode2_permission_completed_then_failed",
    buildInput: openCode2PermissionCompletedThenFailedInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_permission_completed_then_failed/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        runtimePolicyOverride: RESTRICTED_GRANULAR_POLICY,
        assertOutput: assertOpenCode2PermissionCompletedThenFailedOutput,
      },
    ],
  },
  {
    name: "opencode2_permission_decline",
    buildInput: openCode2PermissionDeclineInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_permission_decline/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        runtimePolicyOverride: RESTRICTED_GRANULAR_POLICY,
        assertOutput: assertOpenCode2PermissionDeclineOutput,
      },
    ],
  },
  {
    name: "opencode2_permission_external_subagent",
    buildInput: openCode2PermissionExternalSubagentInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_permission_external_subagent/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2PermissionExternalSubagentOutput,
      },
    ],
  },
  {
    name: "opencode2_permission_local_success_then_failure",
    buildInput: openCode2PermissionLocalSuccessThenFailureInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_permission_local_success_then_failure/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        runtimePolicyOverride: RESTRICTED_GRANULAR_POLICY,
        assertOutput: assertOpenCode2PermissionLocalSuccessThenFailureOutput,
      },
    ],
  },
  {
    name: "opencode2_permission_reject_race",
    buildInput: openCode2PermissionRejectRaceInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_permission_reject_race/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        runtimePolicyOverride: RESTRICTED_GRANULAR_POLICY,
        assertOutput: assertOpenCode2PermissionRejectRaceOutput,
      },
    ],
  },
  {
    name: "opencode2_permission_reply_failure",
    buildInput: openCode2PermissionReplyFailureInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_permission_reply_failure/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2PermissionReplyFailureOutput,
      },
    ],
  },
  {
    name: "opencode2_permission_reply_failure_after_terminal",
    buildInput: openCode2PermissionReplyFailureAfterTerminalInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_permission_reply_failure_after_terminal/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        runtimePolicyOverride: RESTRICTED_GRANULAR_POLICY,
        assertOutput: assertOpenCode2PermissionReplyFailureAfterTerminalOutput,
      },
    ],
  },
  {
    name: "opencode2_permission_session",
    buildInput: openCode2PermissionSessionInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_permission_session/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        runtimePolicyOverride: RESTRICTED_GRANULAR_POLICY,
        assertOutput: assertOpenCode2PermissionSessionOutput,
      },
    ],
  },
  {
    name: "opencode2_permission_terminal_without_reply",
    buildInput: openCode2PermissionTerminalWithoutReplyInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_permission_terminal_without_reply/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        runtimePolicyOverride: RESTRICTED_GRANULAR_POLICY,
        assertOutput: assertOpenCode2PermissionTerminalWithoutReplyOutput,
      },
    ],
  },
  {
    name: "opencode2_permission_reply_failure_subagent",
    buildInput: openCode2PermissionReplyFailureSubagentInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_permission_reply_failure_subagent/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2PermissionReplyFailureSubagentOutput,
      },
    ],
  },
  {
    name: "opencode2_question_legacy",
    buildInput: openCode2QuestionLegacyInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_question_legacy/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2QuestionLegacyOutput,
      },
    ],
  },
  {
    name: "opencode2_retry",
    buildInput: openCode2RetryInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL("./opencode2_retry/opencode2_transcript.ndjson", import.meta.url),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2RetryOutput,
      },
    ],
  },
  {
    name: "opencode2_retry_unknown_finish",
    buildInput: openCode2RetryUnknownFinishInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_retry_unknown_finish/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2RetryUnknownFinishOutput,
      },
    ],
  },
  {
    name: "opencode2_shell_projection",
    buildInput: openCode2ShellProjectionInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_shell_projection/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2ShellProjectionOutput,
      },
    ],
  },
  {
    name: "opencode2_subagent_background_wake",
    buildInput: openCode2SubagentBackgroundWakeInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_subagent_background_wake/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2SubagentBackgroundWakeOutput,
      },
    ],
  },
  {
    name: "opencode2_subagent_queued_turn",
    buildInput: openCode2SubagentQueuedTurnInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_subagent_queued_turn/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2SubagentQueuedTurnOutput,
      },
    ],
  },
  {
    name: "opencode2_subagent_rate_limit",
    buildInput: openCode2SubagentRateLimitInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_subagent_rate_limit/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2SubagentRateLimitOutput,
      },
    ],
  },
  {
    name: "opencode2_subagent_supervised",
    buildInput: openCode2SubagentSupervisedInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_subagent_supervised/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        runtimePolicyOverride: RESTRICTED_GRANULAR_POLICY,
        assertOutput: assertOpenCode2SubagentSupervisedOutput,
      },
    ],
  },
  {
    name: "opencode2_shell_terminals",
    buildInput: openCode2ShellTerminalsInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_shell_terminals/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2ShellTerminalsOutput,
      },
    ],
  },
  {
    name: "opencode2_thread_delete",
    buildInput: openCode2ThreadDeleteInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_thread_delete/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2ThreadDeleteOutput,
      },
    ],
  },
  {
    name: "opencode2_unknown_finish_idle",
    buildInput: openCode2UnknownFinishIdleInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL(
          "./opencode2_unknown_finish_idle/opencode2_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2UnknownFinishIdleOutput,
      },
    ],
  },
  {
    name: "multi_turn",
    buildInput: multiTurnInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./multi_turn/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertMultiTurnOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./multi_turn/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertMultiTurnClaudeOutput,
      },
      {
        driver: ProviderDriverKind.make("cursor"),
        transcriptFile: new URL("./multi_turn/cursor_transcript.ndjson", import.meta.url),
        modelSelection: CURSOR_MODEL_SELECTION,
        assertOutput: assertMultiTurnOutput,
      },
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./multi_turn/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        assertOutput: assertMultiTurnOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL("./multi_turn/grok_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertMultiTurnOutput,
      },
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL("./multi_turn/opencode2_transcript.ndjson", import.meta.url),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertMultiTurnOutput,
      },
    ],
  },
  {
    name: "multi_turn_restart",
    buildInput: multiTurnInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./multi_turn_restart/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertMultiTurnClaudeOutput,
      },
    ],
  },
  {
    name: "queued_cancelled_while_active",
    buildInput: queuedCancelledWhileActiveInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./queued_turn/codex_transcript.ndjson", import.meta.url),
        recordedScenario: "queued_turn",
        transcriptEntriesThroughLabel: "turn/completed",
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertQueuedCancelledWhileActiveOutput,
      },
    ],
  },
  {
    name: "queued_turn",
    buildInput: queuedTurnInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./queued_turn/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertQueuedTurnOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./queued_turn/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertQueuedTurnOutput,
      },
      {
        driver: ProviderDriverKind.make("cursor"),
        transcriptFile: new URL("./queued_turn/cursor_transcript.ndjson", import.meta.url),
        modelSelection: CURSOR_MODEL_SELECTION,
        assertOutput: assertQueuedTurnOutput,
      },
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./queued_turn/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        assertOutput: assertQueuedTurnOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL("./queued_turn/grok_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertQueuedTurnOutput,
      },
      {
        driver: ProviderDriverKind.make("opencode2"),
        transcriptFile: new URL("./queued_turn/opencode2_transcript.ndjson", import.meta.url),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertQueuedTurnOutput,
      },
    ],
  },
  {
    name: "todo_list",
    buildInput: todoListInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./todo_list/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertTodoListOutput,
      },
      {
        driver: ProviderDriverKind.make("cursor"),
        transcriptFile: new URL("./todo_list/cursor_transcript.ndjson", import.meta.url),
        modelSelection: CURSOR_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertTodoListCursorOutput,
      },
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./todo_list/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        assertOutput: assertTodoListGrokOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
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
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./web_search/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertWebSearchOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
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
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./plan_questions/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertPlanQuestionsOutput,
      },
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./plan_questions/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertPlanQuestionsOutput,
      },
      {
        driver: ProviderDriverKind.make("opencode"),
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
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./proposed_plan/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertProposedPlanOutput,
      },
      {
        driver: ProviderDriverKind.make("cursor"),
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
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./message_steering/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertMessageSteeringOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./message_steering/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeMessageSteeringOutput,
      },
      {
        driver: ProviderDriverKind.make("cursor"),
        transcriptFile: new URL("./message_steering/cursor_transcript.ndjson", import.meta.url),
        modelSelection: CURSOR_MODEL_SELECTION,
        assertOutput: assertCursorMessageSteeringOutput,
      },
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./message_steering/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        assertOutput: assertGrokMessageSteeringOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
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
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./turn_interrupt/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./turn_interrupt/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptClaudeOutput,
      },
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./turn_interrupt/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL("./turn_interrupt/grok_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptOutput,
      },
      {
        driver: ProviderDriverKind.make("opencode"),
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
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL(
          "./turn_interrupt_mid_tool/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptMidToolCodexOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./turn_interrupt_mid_tool/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptMidToolClaudeOutput,
      },
      {
        driver: ProviderDriverKind.make("cursor"),
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
        driver: ProviderDriverKind.make("claudeAgent"),
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
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./thread_rollback/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertThreadRollbackOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./thread_rollback/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeThreadRollbackOutput,
      },
    ],
  },
];

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

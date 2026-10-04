import { ProviderDriverKind } from "@t3tools/contracts";

import { claudeBackgroundSubagentAfterRootInput } from "./claude_background_subagent_after_root/input.ts";
import { assertClaudeBackgroundSubagentAfterRootOutput } from "./claude_background_subagent_after_root/output.ts";
import { claudeBackgroundTaskAfterRootInput } from "./claude_background_task_after_root/input.ts";
import { assertClaudeBackgroundTaskAfterRootOutput } from "./claude_background_task_after_root/output.ts";
import { claudeBackgroundSubagentLifecycleInput } from "./claude_background_subagent_lifecycle/input.ts";
import { assertClaudeBackgroundSubagentLifecycleOutput } from "./claude_background_subagent_lifecycle/output.ts";
import { claudeBackgroundTaskInterruptInput } from "./claude_background_task_interrupt/input.ts";
import { claudeBackgroundWakeBeforeQueuedPromptInput } from "./claude_background_wake_before_queued_prompt/input.ts";
import { assertClaudeBackgroundWakeBeforeQueuedPromptOutput } from "./claude_background_wake_before_queued_prompt/output.ts";
import { claudeBackgroundWakeBeforeQueuedPromptNoEchoInput } from "./claude_background_wake_before_queued_prompt_no_echo/input.ts";
import { assertClaudeBackgroundWakeBeforeQueuedPromptNoEchoOutput } from "./claude_background_wake_before_queued_prompt_no_echo/output.ts";
import { assertClaudeBackgroundTaskInterruptOutput } from "./claude_background_task_interrupt/output.ts";
import { claudeBackgroundMonitorWakeInput } from "./claude_background_monitor_wake/input.ts";
import { assertClaudeBackgroundMonitorWakeOutput } from "./claude_background_monitor_wake/output.ts";
import { claudeBackgroundTaskWakeInput } from "./claude_background_task_wake/input.ts";
import { assertClaudeBackgroundTaskWakeOutput } from "./claude_background_task_wake/output.ts";
import {
  claudeCompactAfterPeerTurnInput,
  claudeCompactAfterPeerTurnNoEchoInput,
} from "./claude_compact_after_peer_turn/input.ts";
import { assertClaudeCompactAfterPeerTurnOutput } from "./claude_compact_after_peer_turn/output.ts";
import { assertClaudeCompactAfterPeerTurnNoEchoOutput } from "./claude_compact_after_peer_turn_no_echo/output.ts";
import { claudeCompactAfterResumeWakeInput } from "./claude_compact_after_resume_wake/input.ts";
import { assertClaudeCompactAfterResumeWakeOutput } from "./claude_compact_after_resume_wake/output.ts";
import { claudeIdleResumeInput } from "./claude_idle_resume/input.ts";
import { assertClaudeIdleResumeOutput } from "./claude_idle_resume/output.ts";
import { claudeLocalBashTaskInput } from "./claude_local_bash_task/input.ts";
import { assertClaudeLocalBashTaskOutput } from "./claude_local_bash_task/output.ts";
import { claudeNestedBackgroundSubagentWakeInput } from "./claude_nested_background_subagent_wake/input.ts";
import { assertClaudeNestedBackgroundSubagentWakeOutput } from "./claude_nested_background_subagent_wake/output.ts";
import { claudeNestedSubagentModelInput } from "./claude_nested_subagent_model/input.ts";
import { assertClaudeNestedSubagentModelOutput } from "./claude_nested_subagent_model/output.ts";
import { claudeMcpToolPresentationInput } from "./claude_mcp_tool_presentation/input.ts";
import { assertClaudeMcpToolPresentationOutput } from "./claude_mcp_tool_presentation/output.ts";
import { claudeResultIsErrorInput } from "./claude_result_is_error/input.ts";
import { assertClaudeResultIsErrorOutput } from "./claude_result_is_error/output.ts";
import { grokAutoBlockedCommandInput } from "./grok_auto_blocked_command/input.ts";
import { assertGrokAutoBlockedCommandOutput } from "./grok_auto_blocked_command/output.ts";
import { grokBackgroundBashInput } from "./grok_background_bash/input.ts";
import { assertGrokBackgroundBashOutput } from "./grok_background_bash/output.ts";
import { grokBackgroundBashFastWakeInput } from "./grok_background_bash_fast_wake/input.ts";
import { assertGrokBackgroundBashFastWakeOutput } from "./grok_background_bash_fast_wake/output.ts";
import { grokBackgroundSubagentInput } from "./grok_background_subagent/input.ts";
import { assertGrokBackgroundSubagentOutput } from "./grok_background_subagent/output.ts";
import { grokMonitorInput } from "./grok_monitor/input.ts";
import { assertGrokMonitorOutput } from "./grok_monitor/output.ts";
import { grokPromptErrorInput } from "./grok_prompt_error/input.ts";
import { assertGrokPromptErrorOutput } from "./grok_prompt_error/output.ts";
import { grokSubagentLineageInput } from "./grok_subagent_lineage/input.ts";
import { assertGrokSubagentLineageOutput } from "./grok_subagent_lineage/output.ts";
import { assertClaudeMessageSteeringOutput } from "./message_steering/claude_output.ts";
import { assertMessageSteeringOutput } from "./message_steering/codex_output.ts";
import { assertCursorMessageSteeringOutput } from "./message_steering/cursor_output.ts";
import { assertGrokMessageSteeringOutput } from "./message_steering/grok_output.ts";
import { messageSteeringInput } from "./message_steering/input.ts";
import { assertPiMessageSteeringOutput } from "./message_steering/pi_output.ts";
import { piCompactionInput } from "./pi_compaction/input.ts";
import { assertPiCompactionOutput } from "./pi_compaction/output.ts";
import { providerThreadResumeInput } from "./provider_thread_resume/input.ts";
import { assertPiProviderThreadResumeOutput } from "./provider_thread_resume/pi_output.ts";
import { assertMultiTurnClaudeOutput } from "./multi_turn/claude_output.ts";
import { assertMultiTurnOutput } from "./multi_turn/codex_output.ts";
import { assertPiMultiTurnOutput } from "./multi_turn/pi_output.ts";
import { multiTurnInput } from "./multi_turn/input.ts";
import { openCodeChildApprovalInput } from "./opencode_child_approval/input.ts";
import { assertOpenCodeChildApprovalOutput } from "./opencode_child_approval/output.ts";
import { openCodeRunningChildApprovalInput } from "./opencode_running_child_approval/input.ts";
import { assertOpenCodeRunningChildApprovalOutput } from "./opencode_running_child_approval/output.ts";
import { openCodeSubagentInput } from "./opencode_subagent/input.ts";
import { openCode2InboxInput } from "./opencode2_inbox/input.ts";
import { openCode2RevertInput } from "./opencode2_revert/input.ts";
import { assertOpenCode2RevertOutput } from "./opencode2_revert/output.ts";
import { assertOpenCode2InboxOutput } from "./opencode2_inbox/output.ts";
import { openCode2CommandInput } from "./opencode2_command/input.ts";
import { assertOpenCode2CommandOutput } from "./opencode2_command/output.ts";
import { openCode2CompactionInput } from "./opencode2_compaction/input.ts";
import { assertOpenCode2CompactionOutput } from "./opencode2_compaction/output.ts";
import { openCode2InterruptInput } from "./opencode2_interrupt/input.ts";
import { assertOpenCode2InterruptOutput } from "./opencode2_interrupt/output.ts";
import { openCode2PermissionInput } from "./opencode2_permission/input.ts";
import { assertOpenCode2PermissionOutput } from "./opencode2_permission/output.ts";
import { openCode2QuestionInput } from "./opencode2_question/input.ts";
import { assertOpenCode2QuestionOutput } from "./opencode2_question/output.ts";
import { openCode2BackgroundInput } from "./opencode2_background/input.ts";
import { assertOpenCode2BackgroundOutput } from "./opencode2_background/output.ts";
import { openCode2NestedBackgroundInput } from "./opencode2_nested_background/input.ts";
import { assertOpenCode2NestedBackgroundOutput } from "./opencode2_nested_background/output.ts";
import { openCode2SubagentInput } from "./opencode2_subagent/input.ts";
import { assertOpenCode2SubagentOutput } from "./opencode2_subagent/output.ts";
import { openCode2ResumeAfterRestartInput } from "./opencode2_resume_after_restart/input.ts";
import { assertOpenCode2ResumeAfterRestartOutput } from "./opencode2_resume_after_restart/output.ts";
import { openCode2SimpleInput } from "./opencode2_simple/input.ts";
import { openCode2SkillInput } from "./opencode2_skill/input.ts";
import { assertOpenCode2SkillOutput } from "./opencode2_skill/output.ts";
import { assertOpenCode2SimpleOutput } from "./opencode2_simple/output.ts";
import { openCode2ToolCallInput } from "./opencode2_tool_call/input.ts";
import { assertOpenCode2ToolCallOutput } from "./opencode2_tool_call/output.ts";
import { assertOpenCodeSubagentOutput } from "./opencode_subagent/output.ts";
import {
  assertCodexPlanQuestionsOutput,
  assertPlanQuestionsOutput,
} from "./plan_questions/codex_output.ts";
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
import { assertSkillInvocationCursorOutput } from "./skill_invocation/cursor_output.ts";
import { skillInvocationInput } from "./skill_invocation/input.ts";
import { assertSimpleOutput } from "./simple/codex_output.ts";
import { assertPiSimpleOutput } from "./simple/pi_output.ts";
import { simpleInput } from "./simple/input.ts";
import { assertSubagentOutput } from "./subagent/codex_output.ts";
import { assertClaudeSubagentOutput } from "./subagent/claude_output.ts";
import { subagentInput } from "./subagent/input.ts";
import { assertCursorSubagentOutput } from "./subagent/cursor_output.ts";
import { assertSubagentContinueOutput } from "./subagent_continue/codex_output.ts";
import { subagentContinueInput } from "./subagent_continue/input.ts";
import { assertSubagentV2Output } from "./subagent_v2/codex_output.ts";
import { subagentV2Input, subagentV2NestedInput } from "./subagent_v2/input.ts";
import { assertSubagentV2ApprovalOutput } from "./subagent_v2_approval/codex_output.ts";
import {
  SUBAGENT_V2_APPROVAL_POLICY,
  subagentV2ApprovalInput,
} from "./subagent_v2_approval/input.ts";
import { assertSubagentV2NestedOutput } from "./subagent_v2_nested/codex_output.ts";
import { assertSubagentV2NestedApprovalOutput } from "./subagent_v2_nested_approval/codex_output.ts";
import { subagentV2NestedApprovalInput } from "./subagent_v2_nested_approval/input.ts";
import { assertClaudeThreadRollbackOutput } from "./thread_rollback/claude_output.ts";
import { assertThreadRollbackOutput } from "./thread_rollback/codex_output.ts";
import { threadRollbackInput } from "./thread_rollback/input.ts";
import { assertPiThreadRollbackOutput } from "./thread_rollback/pi_output.ts";
import { assertThreadRollbackAfterRestartOutput } from "./thread_rollback_after_restart/codex_output.ts";
import { threadRollbackAfterRestartInput } from "./thread_rollback_after_restart/input.ts";
import { threadRollbackAfterStopInput } from "./thread_rollback_after_stop/input.ts";
import { assertPiThreadRollbackAfterStopOutput } from "./thread_rollback_after_stop/pi_output.ts";
import { assertThreadRollbackToStoppedTurnOutput } from "./thread_rollback_to_stopped_turn/codex_output.ts";
import { threadRollbackToStoppedTurnInput } from "./thread_rollback_to_stopped_turn/input.ts";
import { assertTodoListOutput } from "./todo_list/codex_output.ts";
import { assertTodoListCursorOutput } from "./todo_list/cursor_output.ts";
import { assertTodoListGrokOutput } from "./todo_list/grok_output.ts";
import { todoListInput } from "./todo_list/input.ts";
import { assertToolCallDeniedWriteClaudeOutput } from "./tool_call_denied_write/claude_output.ts";
import {
  DENIED_WRITE_POLICY,
  TOOL_CALL_DENIED_WRITE_TARGET,
  toolCallDeniedWriteInput,
} from "./tool_call_denied_write/input.ts";
import { assertToolCallReadOnlyClaudeOutput } from "./tool_call_read_only/claude_output.ts";
import { assertToolCallReadOnlyCursorOutput } from "./tool_call_read_only/cursor_output.ts";
import { toolCallReadOnlyInput } from "./tool_call_read_only/input.ts";
import {
  assertToolCallReadOnlyOnRequestGrokOutput,
  assertToolCallReadOnlyOnRequestOutput,
} from "./tool_call_read_only_on_request/output.ts";
import { toolCallReadOnlyOnRequestInput } from "./tool_call_read_only_on_request/input.ts";
import {
  stopBackgroundWorkAfterFailedTurnInput,
  stopBackgroundWorkAfterReleaseInput,
} from "./stop_background_work_after_failed_turn/input.ts";
import { assertStopBackgroundWorkAfterFailedTurnOutput } from "./stop_background_work_after_failed_turn/output.ts";
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
import { assertTurnInterruptMidToolPiOutput } from "./turn_interrupt_mid_tool/pi_output.ts";
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
  OPENCODE2_MODEL_SELECTION,
  PI_MODEL_SELECTION,
  READ_ONLY_NEVER_POLICY,
  READ_ONLY_ON_REQUEST_POLICY,
  RESTRICTED_GRANULAR_POLICY,
  type OrchestratorReplayFixture,
  WORKSPACE_NEVER_POLICY,
} from "./shared.ts";

export const ORCHESTRATOR_REPLAY_FIXTURES: ReadonlyArray<OrchestratorReplayFixture> = [
  {
    name: "claude_background_subagent_after_root",
    buildInput: claudeBackgroundSubagentAfterRootInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_background_subagent_after_root/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeBackgroundSubagentAfterRootOutput,
      },
    ],
  },
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
    name: "claude_background_subagent_lifecycle",
    buildInput: claudeBackgroundSubagentLifecycleInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_background_subagent_lifecycle/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeBackgroundSubagentLifecycleOutput,
      },
    ],
  },
  {
    name: "claude_background_task_interrupt",
    buildInput: claudeBackgroundTaskInterruptInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_background_task_interrupt/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeBackgroundTaskInterruptOutput,
      },
    ],
  },
  {
    name: "claude_background_wake_before_queued_prompt",
    buildInput: claudeBackgroundWakeBeforeQueuedPromptInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_background_wake_before_queued_prompt/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeBackgroundWakeBeforeQueuedPromptOutput,
      },
    ],
  },
  {
    name: "claude_background_wake_before_queued_prompt_no_echo",
    buildInput: claudeBackgroundWakeBeforeQueuedPromptNoEchoInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_background_wake_before_queued_prompt_no_echo/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeBackgroundWakeBeforeQueuedPromptNoEchoOutput,
      },
    ],
  },
  {
    name: "claude_compact_after_resume_wake",
    buildInput: claudeCompactAfterResumeWakeInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_compact_after_resume_wake/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeCompactAfterResumeWakeOutput,
      },
    ],
  },
  {
    name: "claude_compact_after_peer_turn",
    buildInput: claudeCompactAfterPeerTurnInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_compact_after_peer_turn/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeCompactAfterPeerTurnOutput,
      },
    ],
  },
  {
    name: "claude_compact_after_peer_turn_no_echo",
    buildInput: claudeCompactAfterPeerTurnNoEchoInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_compact_after_peer_turn_no_echo/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeCompactAfterPeerTurnNoEchoOutput,
      },
    ],
  },
  {
    name: "claude_background_monitor_wake",
    buildInput: claudeBackgroundMonitorWakeInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_background_monitor_wake/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeBackgroundMonitorWakeOutput,
      },
    ],
  },
  {
    name: "claude_background_task_wake",
    buildInput: claudeBackgroundTaskWakeInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_background_task_wake/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeBackgroundTaskWakeOutput,
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
    name: "claude_nested_background_subagent_wake",
    buildInput: claudeNestedBackgroundSubagentWakeInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_nested_background_subagent_wake/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeNestedBackgroundSubagentWakeOutput,
      },
    ],
  },
  {
    name: "claude_nested_subagent_model",
    buildInput: claudeNestedSubagentModelInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_nested_subagent_model/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeNestedSubagentModelOutput,
      },
    ],
  },
  {
    name: "claude_mcp_tool_presentation",
    buildInput: claudeMcpToolPresentationInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_mcp_tool_presentation/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeMcpToolPresentationOutput,
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
    name: "grok_auto_blocked_command",
    buildInput: grokAutoBlockedCommandInput,
    providers: [
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL(
          "./grok_auto_blocked_command/grok_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: { ...GROK_MODEL_SELECTION, model: "grok-4.7-build-fast" },
        assertOutput: assertGrokAutoBlockedCommandOutput,
      },
    ],
  },
  {
    name: "grok_background_bash",
    buildInput: grokBackgroundBashInput,
    providers: [
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./grok_background_bash/grok_transcript.ndjson", import.meta.url),
        modelSelection: { ...GROK_MODEL_SELECTION, model: "grok-4.7-build-fast" },
        runContinuationWorker: true,
        assertOutput: assertGrokBackgroundBashOutput,
      },
    ],
  },
  {
    name: "grok_background_bash_fast_wake",
    buildInput: grokBackgroundBashFastWakeInput,
    providers: [
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL(
          "./grok_background_bash_fast_wake/grok_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: { ...GROK_MODEL_SELECTION, model: "grok-4.7-build-fast" },
        runContinuationWorker: true,
        assertOutput: assertGrokBackgroundBashFastWakeOutput,
      },
    ],
  },
  {
    name: "grok_background_subagent",
    buildInput: grokBackgroundSubagentInput,
    providers: [
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL(
          "./grok_background_subagent/grok_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: GROK_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertGrokBackgroundSubagentOutput,
      },
    ],
  },
  {
    name: "grok_monitor",
    buildInput: grokMonitorInput,
    providers: [
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./grok_monitor/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertGrokMonitorOutput,
      },
    ],
  },
  {
    name: "grok_prompt_error",
    buildInput: grokPromptErrorInput,
    providers: [
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./grok_prompt_error/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        assertOutput: assertGrokPromptErrorOutput,
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
      // Grok Build still elicits with the pre-1.0 session/elicitation wire
      // method the current spec removed; T3 supports standard ACP only, so
      // the scenario covers the registry driver until Grok ships
      // elicitation/create.
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL("./acp_elicitation/registry_transcript.ndjson", import.meta.url),
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
        transcriptFile: new URL("./simple/registry_transcript.ndjson", import.meta.url),
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
        driver: ProviderDriverKind.make("pi"),
        transcriptFile: new URL("./simple/pi_transcript.ndjson", import.meta.url),
        modelSelection: PI_MODEL_SELECTION,
        assertOutput: assertPiSimpleOutput,
      },
    ],
  },
  {
    name: "skill_invocation",
    buildInput: skillInvocationInput,
    providers: [
      {
        driver: ProviderDriverKind.make("cursor"),
        transcriptFile: new URL("./skill_invocation/cursor_transcript.ndjson", import.meta.url),
        modelSelection: CURSOR_MODEL_SELECTION,
        assertOutput: assertSkillInvocationCursorOutput,
      },
    ],
  },
  {
    name: "tool_call_denied_write",
    buildInput: toolCallDeniedWriteInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./tool_call_denied_write/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: DENIED_WRITE_POLICY,
        expectedAbsentWorkspacePaths: [TOOL_CALL_DENIED_WRITE_TARGET],
        assertOutput: assertToolCallDeniedWriteClaudeOutput,
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
        transcriptFile: new URL(
          "./tool_call_read_only/registry_transcript.ndjson",
          import.meta.url,
        ),
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
        // gpt-6-luna declines the write under a read-only sandbox, so nothing asks for approval.
        modelSelection: { ...CODEX_MODEL_SELECTION, model: "gpt-6-sol" },
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
        assertOutput: assertToolCallReadOnlyOnRequestOutput,
      },
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL(
          "./tool_call_read_only_on_request/grok_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: GROK_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
        assertOutput: assertToolCallReadOnlyOnRequestGrokOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL(
          "./tool_call_read_only_on_request/registry_transcript.ndjson",
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
        // gpt-6 models write through the shell; gpt-5.6-terra's apply_patch raises the
        // file-change approval this fixture covers.
        modelSelection: { ...CODEX_MODEL_SELECTION, model: "gpt-5.6-terra" },
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
        // gpt-5.6-luna still runs multi-agent v1 (collabAgentToolCall); subagent_v2 covers v2.
        modelSelection: { ...CODEX_MODEL_SELECTION, model: "gpt-5.6-luna" },
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
        // gpt-5.6-luna still runs multi-agent v1 (collabAgentToolCall); subagent_v2 covers v2.
        modelSelection: { ...CODEX_MODEL_SELECTION, model: "gpt-5.6-luna" },
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
    name: "subagent_v2_approval",
    buildInput: subagentV2ApprovalInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./subagent_v2_approval/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: SUBAGENT_V2_APPROVAL_POLICY,
        assertOutput: assertSubagentV2ApprovalOutput,
      },
    ],
  },
  {
    name: "subagent_v2_nested",
    buildInput: subagentV2NestedInput,
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
    name: "subagent_v2_nested_approval",
    buildInput: subagentV2NestedApprovalInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL(
          "./subagent_v2_nested_approval/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: SUBAGENT_V2_APPROVAL_POLICY,
        assertOutput: assertSubagentV2NestedApprovalOutput,
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
  // OpenCode 2 runtime of the same driver, recorded against 2.0.18 over HTTP and SSE.
  {
    name: "opencode2_simple",
    buildInput: openCode2SimpleInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode2_simple/opencode_transcript.ndjson", import.meta.url),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2SimpleOutput,
      },
    ],
  },
  {
    name: "opencode2_tool_call",
    buildInput: openCode2ToolCallInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_tool_call/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2ToolCallOutput,
      },
    ],
  },
  {
    name: "opencode2_interrupt",
    buildInput: openCode2InterruptInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_interrupt/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2InterruptOutput,
      },
    ],
  },
  {
    name: "opencode2_inbox",
    buildInput: openCode2InboxInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode2_inbox/opencode_transcript.ndjson", import.meta.url),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2InboxOutput,
      },
    ],
  },
  {
    name: "opencode2_revert",
    buildInput: openCode2RevertInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode2_revert/opencode_transcript.ndjson", import.meta.url),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2RevertOutput,
      },
    ],
  },
  {
    name: "opencode2_permission",
    buildInput: openCode2PermissionInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_permission/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2PermissionOutput,
      },
    ],
  },
  {
    name: "opencode2_question",
    buildInput: openCode2QuestionInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode2_question/opencode_transcript.ndjson", import.meta.url),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2QuestionOutput,
      },
    ],
  },
  {
    name: "opencode2_subagent",
    buildInput: openCode2SubagentInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode2_subagent/opencode_transcript.ndjson", import.meta.url),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2SubagentOutput,
      },
    ],
  },
  {
    name: "opencode2_background",
    buildInput: openCode2BackgroundInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_background/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        runContinuationWorker: true,
        assertOutput: assertOpenCode2BackgroundOutput,
      },
    ],
  },
  {
    name: "opencode2_nested_background",
    buildInput: openCode2NestedBackgroundInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_nested_background/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "openrouter/deepseek/deepseek-v4-flash",
        },
        assertOutput: assertOpenCode2NestedBackgroundOutput,
      },
    ],
  },
  {
    name: "opencode2_compaction",
    buildInput: openCode2CompactionInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_compaction/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2CompactionOutput,
      },
    ],
  },
  {
    name: "opencode2_resume_after_restart",
    buildInput: openCode2ResumeAfterRestartInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_resume_after_restart/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2ResumeAfterRestartOutput,
      },
    ],
  },
  // Recorded live against 2.0.18 on OpenRouter with the workspace's own command and skill.
  ...(
    [
      ["opencode2_command", openCode2CommandInput, assertOpenCode2CommandOutput],
      ["opencode2_skill", openCode2SkillInput, assertOpenCode2SkillOutput],
    ] as const
  ).map(([name, buildInput, assertOutput]) => ({
    name,
    buildInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(`./${name}/opencode_transcript.ndjson`, import.meta.url),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "openrouter/deepseek/deepseek-v4-flash",
        },
        assertOutput,
      },
    ],
  })),
  {
    name: "opencode_child_approval",
    buildInput: openCodeChildApprovalInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode_child_approval/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE_MODEL_SELECTION,
        assertOutput: assertOpenCodeChildApprovalOutput,
      },
    ],
  },
  {
    name: "opencode_running_child_approval",
    buildInput: openCodeRunningChildApprovalInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode_running_child_approval/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE_MODEL_SELECTION,
        assertOutput: assertOpenCodeRunningChildApprovalOutput,
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
        transcriptFile: new URL("./multi_turn/registry_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertMultiTurnOutput,
      },
      {
        driver: ProviderDriverKind.make("pi"),
        transcriptFile: new URL("./multi_turn/pi_transcript.ndjson", import.meta.url),
        modelSelection: PI_MODEL_SELECTION,
        assertOutput: assertPiMultiTurnOutput,
      },
    ],
  },
  {
    name: "pi_compaction",
    buildInput: piCompactionInput,
    providers: [
      {
        driver: ProviderDriverKind.make("pi"),
        transcriptFile: new URL("./pi_compaction/pi_transcript.ndjson", import.meta.url),
        modelSelection: PI_MODEL_SELECTION,
        assertOutput: assertPiCompactionOutput,
      },
    ],
  },
  {
    name: "provider_thread_resume",
    buildInput: providerThreadResumeInput,
    providers: [
      {
        driver: ProviderDriverKind.make("pi"),
        transcriptFile: new URL("./provider_thread_resume/pi_transcript.ndjson", import.meta.url),
        modelSelection: PI_MODEL_SELECTION,
        assertOutput: assertPiProviderThreadResumeOutput,
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
        transcriptFile: new URL("./queued_turn/registry_transcript.ndjson", import.meta.url),
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
        transcriptFile: new URL("./todo_list/registry_transcript.ndjson", import.meta.url),
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
        assertOutput: assertCodexPlanQuestionsOutput,
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
        transcriptFile: new URL("./message_steering/registry_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertGrokMessageSteeringOutput,
      },
      {
        driver: ProviderDriverKind.make("pi"),
        transcriptFile: new URL("./message_steering/pi_transcript.ndjson", import.meta.url),
        modelSelection: PI_MODEL_SELECTION,
        assertOutput: assertPiMessageSteeringOutput,
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
        transcriptFile: new URL("./turn_interrupt/registry_transcript.ndjson", import.meta.url),
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
      {
        driver: ProviderDriverKind.make("pi"),
        transcriptFile: new URL("./turn_interrupt_mid_tool/pi_transcript.ndjson", import.meta.url),
        modelSelection: PI_MODEL_SELECTION,
        assertOutput: assertTurnInterruptMidToolPiOutput,
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
      {
        driver: ProviderDriverKind.make("pi"),
        transcriptFile: new URL("./thread_rollback/pi_transcript.ndjson", import.meta.url),
        modelSelection: PI_MODEL_SELECTION,
        assertOutput: assertPiThreadRollbackOutput,
      },
    ],
  },
  {
    name: "thread_rollback_after_restart",
    buildInput: threadRollbackAfterRestartInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL(
          "./thread_rollback_after_restart/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertThreadRollbackAfterRestartOutput,
      },
    ],
  },
  {
    name: "thread_rollback_after_stop",
    buildInput: threadRollbackAfterStopInput,
    providers: [
      {
        driver: ProviderDriverKind.make("pi"),
        transcriptFile: new URL(
          "./thread_rollback_after_stop/pi_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: PI_MODEL_SELECTION,
        assertOutput: assertPiThreadRollbackAfterStopOutput,
      },
    ],
  },
  {
    name: "thread_rollback_to_stopped_turn",
    buildInput: threadRollbackToStoppedTurnInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL(
          "./thread_rollback_to_stopped_turn/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertThreadRollbackToStoppedTurnOutput,
      },
    ],
  },
  {
    name: "stop_background_work_after_failed_turn",
    buildInput: stopBackgroundWorkAfterFailedTurnInput,
    providers: [
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL(
          "./stop_background_work_after_failed_turn/registry_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertStopBackgroundWorkAfterFailedTurnOutput,
      },
    ],
  },
  {
    name: "stop_background_work_after_release",
    buildInput: stopBackgroundWorkAfterReleaseInput,
    providers: [
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL(
          "./stop_background_work_after_failed_turn/registry_transcript.ndjson",
          import.meta.url,
        ),
        recordedScenario: "stop_background_work_after_failed_turn",
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertStopBackgroundWorkAfterFailedTurnOutput,
      },
    ],
  },
];

// TODO(claude-v2/context-transfer): add provider-switch handoff and return fixtures when portable
// context handoff is implemented. Cross-reference docs/orchestration-v2/provider-switching-and-context.md
// and docs/orchestration-v2/thread-lineage-and-context-transfer.md. The return fixture should
// prefer a delta handoff into an existing Claude provider thread.

// TODO(claude-v2/context-transfer-fixtures): register provider-switch, merge-back, and cross-provider
// fork fixtures after each path has a real provider transcript. Cross-reference
// docs/orchestration-v2/provider-switching-and-context.md and
// docs/orchestration-v2/thread-lineage-and-context-transfer.md.

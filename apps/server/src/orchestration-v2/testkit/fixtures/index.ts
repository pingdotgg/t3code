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
import { kiroCompactionInput } from "./kiro_compaction/input.ts";
import { kiroForkFromTurnInput } from "./kiro_fork_from_turn/input.ts";
import { assertKiroForkFromTurnOutput } from "./kiro_fork_from_turn/output.ts";
import { kiroMessageSteeringInput } from "./kiro_message_steering/input.ts";
import { assertKiroMessageSteeringOutput } from "./kiro_message_steering/output.ts";
import { assertKiroCompactionOutput } from "./kiro_compaction/output.ts";
import { KIRO_EFFORT_LEVEL, KIRO_EFFORT_MODEL, kiroEffortInput } from "./kiro_effort/input.ts";
import { assertKiroEffortOutput } from "./kiro_effort/output.ts";
import { kiroModelSwitchInput } from "./kiro_model_switch/input.ts";
import { assertKiroModelSwitchOutput } from "./kiro_model_switch/output.ts";
import {
  kiroFullAccessWriteInput,
  kiroSupervisedWriteInput,
} from "./kiro_permission_modes/input.ts";
import {
  assertKiroFullAccessWriteOutput,
  assertKiroSupervisedWriteOutput,
} from "./kiro_permission_modes/output.ts";
import { kiroSubagentInterruptInput } from "./kiro_subagent_interrupt/input.ts";
import { assertKiroSubagentInterruptOutput } from "./kiro_subagent_interrupt/output.ts";
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
import { MUSE_PERMISSION_DECLINED_FILE, musePermissionInput } from "./muse_permission/input.ts";
import { assertMusePermissionOutput } from "./muse_permission/output.ts";
import { museSubagentApprovalInput } from "./muse_subagent_approval/input.ts";
import { assertMuseSubagentApprovalOutput } from "./muse_subagent_approval/output.ts";
import { museSubagentInterruptInput } from "./muse_subagent_interrupt/input.ts";
import { assertMuseSubagentInterruptOutput } from "./muse_subagent_interrupt/output.ts";
import { museWorkflowInput } from "./muse_workflow/input.ts";
import { assertMuseWorkflowOutput } from "./muse_workflow/output.ts";
import { assertMuseSubagentV2Output } from "./subagent_v2/muse_output.ts";
import { assertMuseMultiTurnOutput } from "./multi_turn/muse_output.ts";
import { assertMuseTurnInterruptOutput } from "./turn_interrupt/muse_output.ts";
import { piCompactionInput } from "./pi_compaction/input.ts";
import { assertPiCompactionOutput } from "./pi_compaction/output.ts";
import { providerThreadResumeInput } from "./provider_thread_resume/input.ts";
import { assertKiroProviderThreadResumeOutput } from "./provider_thread_resume/kiro_output.ts";
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
import { assertOpenCode2MissingStepUsageOutput } from "./opencode2_missing_step_usage/output.ts";
import { assertCodexModelRerouteOutput } from "./codex_model_reroute/output.ts";
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
import { malformedSessionUpdateInput } from "./malformed_session_update/input.ts";
import { assertMalformedSessionUpdateOutput } from "./malformed_session_update/output.ts";
import { assertSubagentOutput } from "./subagent/codex_output.ts";
import { assertClaudeSubagentOutput } from "./subagent/claude_output.ts";
import { subagentInput } from "./subagent/input.ts";
import { assertCursorSubagentOutput } from "./subagent/cursor_output.ts";
import { assertKiroSubagentOutput } from "./subagent/kiro_output.ts";
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
import { assertToolCallDeniedWriteFxOutput } from "./tool_call_denied_write/fx_output.ts";
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
  assertToolCallReadOnlyOnRequestKiroOutput,
  assertToolCallReadOnlyOnRequestOutput,
} from "./tool_call_read_only_on_request/output.ts";
import {
  toolCallReadOnlyOnRequestInput,
  toolCallReadOnlyOnRequestKiroInput,
} from "./tool_call_read_only_on_request/input.ts";
import { assertToolCallReadOnlyOnRequestFxOutput } from "./tool_call_read_only_on_request/fx_output.ts";
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
import { assertCommandOutputStreamingOutput } from "./command_output_streaming/output.ts";
import { commandOutputStreamingInput } from "./command_output_streaming/input.ts";
import { assertTurnInterruptOutput } from "./turn_interrupt/codex_output.ts";
import { turnInterruptInput } from "./turn_interrupt/input.ts";
import { fxEarlyStopInput } from "./fx_early_stop/input.ts";
import { assertFxEarlyStopOutput } from "./fx_early_stop/fx_output.ts";
import { fxSubagentInput } from "./fx_subagent/input.ts";
import { assertFxSubagentOutput } from "./fx_subagent/fx_output.ts";
import { assertTurnInterruptMidToolClaudeOutput } from "./turn_interrupt_mid_tool/claude_output.ts";
import { assertTurnInterruptMidToolCodexOutput } from "./turn_interrupt_mid_tool/codex_output.ts";
import { assertTurnInterruptMidToolCursorOutput } from "./turn_interrupt_mid_tool/cursor_output.ts";
import {
  turnInterruptMidToolInput,
  turnInterruptMidToolKiroInput,
} from "./turn_interrupt_mid_tool/input.ts";
import { assertTurnInterruptMidToolKiroOutput } from "./turn_interrupt_mid_tool/kiro_output.ts";
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
  FX_MODEL_SELECTION,
  GROK_MODEL_SELECTION,
  KIRO_MODEL_SELECTION,
  MUSE_MODEL_SELECTION,
  OPENCODE_MODEL_SELECTION,
  OPENCODE2_MODEL_SELECTION,
  PI_MODEL_SELECTION,
  READ_ONLY_NEVER_POLICY,
  READ_ONLY_ON_REQUEST_POLICY,
  RESTRICTED_GRANULAR_POLICY,
  type OrchestratorReplayFixture,
  WORKSPACE_NEVER_POLICY,
} from "./shared.ts";

import { ORCHESTRATOR_REPLAY_FIXTURES_01 } from "./replayFixtures-01.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES_02 } from "./replayFixtures-02.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES_03 } from "./replayFixtures-03.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES_04 } from "./replayFixtures-04.ts";

export const ORCHESTRATOR_REPLAY_FIXTURES: ReadonlyArray<OrchestratorReplayFixture> = [
  ...ORCHESTRATOR_REPLAY_FIXTURES_01,
  ...ORCHESTRATOR_REPLAY_FIXTURES_02,
  ...ORCHESTRATOR_REPLAY_FIXTURES_03,
  ...ORCHESTRATOR_REPLAY_FIXTURES_04,
];

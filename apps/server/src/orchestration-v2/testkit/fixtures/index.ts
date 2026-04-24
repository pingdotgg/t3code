import { assertMessageSteeringOutput } from "./message_steering/codex_output.ts";
import { messageSteeringInput } from "./message_steering/input.ts";
import { assertMultiTurnOutput } from "./multi_turn/codex_output.ts";
import { multiTurnInput } from "./multi_turn/input.ts";
import { assertPlanQuestionsOutput } from "./plan_questions/codex_output.ts";
import { planQuestionsInput } from "./plan_questions/input.ts";
import { assertProposedPlanOutput } from "./proposed_plan/codex_output.ts";
import { proposedPlanInput } from "./proposed_plan/input.ts";
import { assertQueuedTurnOutput } from "./queued_turn/codex_output.ts";
import { queuedTurnInput } from "./queued_turn/input.ts";
import { assertSimpleOutput } from "./simple/codex_output.ts";
import { simpleInput } from "./simple/input.ts";
import { assertSubagentOutput } from "./subagent/codex_output.ts";
import { subagentInput } from "./subagent/input.ts";
import { assertThreadRollbackOutput } from "./thread_rollback/codex_output.ts";
import { threadRollbackInput } from "./thread_rollback/input.ts";
import { assertTodoListOutput } from "./todo_list/codex_output.ts";
import { todoListInput } from "./todo_list/input.ts";
import { assertToolCallReadOnlyOnRequestOutput } from "./tool_call_read_only_on_request/codex_output.ts";
import { toolCallReadOnlyOnRequestInput } from "./tool_call_read_only_on_request/input.ts";
import { assertToolCallRestrictedGranularOutput } from "./tool_call_restricted_granular/codex_output.ts";
import { toolCallRestrictedGranularInput } from "./tool_call_restricted_granular/input.ts";
import { assertToolCallWorkspaceNeverOutput } from "./tool_call_workspace_never/codex_output.ts";
import { toolCallWorkspaceNeverInput } from "./tool_call_workspace_never/input.ts";
import { assertTurnInterruptOutput } from "./turn_interrupt/codex_output.ts";
import { turnInterruptInput } from "./turn_interrupt/input.ts";
import { assertWebSearchOutput } from "./web_search/codex_output.ts";
import { webSearchInput } from "./web_search/input.ts";
import { CODEX_MODEL_SELECTION, type OrchestratorReplayFixture } from "./shared.ts";

const CODEX_READ_ONLY_ON_REQUEST_POLICY = {
  approvalPolicy: "on-request",
  sandboxPolicy: {
    type: "readOnly",
    access: { type: "fullAccess" },
    networkAccess: false,
  },
} as const;

const CODEX_READ_ONLY_NEVER_POLICY = {
  approvalPolicy: "never",
  sandboxPolicy: {
    type: "readOnly",
    access: { type: "fullAccess" },
    networkAccess: false,
  },
} as const;

const CODEX_WORKSPACE_NEVER_POLICY = {
  approvalPolicy: "never",
  sandboxPolicy: {
    type: "workspaceWrite",
    writableRoots: [],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: false,
  },
} as const;

const CODEX_RESTRICTED_GRANULAR_POLICY = {
  approvalPolicy: {
    granular: {
      mcp_elicitations: true,
      request_permissions: true,
      rules: true,
      sandbox_approval: true,
      skill_approval: true,
    },
  },
  sandboxPolicy: {
    type: "readOnly",
    access: {
      type: "restricted",
      includePlatformDefaults: false,
      readableRoots: [],
    },
    networkAccess: false,
  },
} as const;

export const ORCHESTRATOR_REPLAY_FIXTURES = [
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
        runtimePolicyOverride: CODEX_READ_ONLY_ON_REQUEST_POLICY,
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
        runtimePolicyOverride: CODEX_WORKSPACE_NEVER_POLICY,
        assertOutput: assertToolCallWorkspaceNeverOutput,
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
        runtimePolicyOverride: CODEX_RESTRICTED_GRANULAR_POLICY,
        assertOutput: assertToolCallRestrictedGranularOutput,
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
        runtimePolicyOverride: CODEX_READ_ONLY_ON_REQUEST_POLICY,
        assertOutput: assertSubagentOutput,
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
        runtimePolicyOverride: CODEX_READ_ONLY_NEVER_POLICY,
        assertOutput: assertTodoListOutput,
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
    ],
  },
  {
    name: "plan_questions",
    buildInput: planQuestionsInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL("./plan_questions/codex_transcript.ndjson", import.meta.url),
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimePolicyOverride: CODEX_READ_ONLY_NEVER_POLICY,
        assertOutput: assertPlanQuestionsOutput,
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
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimePolicyOverride: CODEX_READ_ONLY_NEVER_POLICY,
        assertOutput: assertProposedPlanOutput,
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
        runtimePolicyOverride: CODEX_READ_ONLY_ON_REQUEST_POLICY,
        assertOutput: assertMessageSteeringOutput,
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
        runtimePolicyOverride: CODEX_WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptOutput,
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
    ],
  },
] satisfies ReadonlyArray<OrchestratorReplayFixture>;

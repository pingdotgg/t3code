import { assertMessageSteeringOutput } from "./message_steering/codex_output.ts";
import { messageSteeringInput } from "./message_steering/input.ts";
import { assertMultiTurnOutput } from "./multi_turn/codex_output.ts";
import { multiTurnInput } from "./multi_turn/input.ts";
import { assertSimpleOutput } from "./simple/codex_output.ts";
import { simpleInput } from "./simple/input.ts";
import { assertSubagentOutput } from "./subagent/codex_output.ts";
import { subagentInput } from "./subagent/input.ts";
import { assertThreadRollbackOutput } from "./thread_rollback/codex_output.ts";
import { threadRollbackInput } from "./thread_rollback/input.ts";
import { assertToolCallReadOnlyOnRequestOutput } from "./tool_call_read_only_on_request/codex_output.ts";
import { toolCallReadOnlyOnRequestInput } from "./tool_call_read_only_on_request/input.ts";
import { assertToolCallRestrictedGranularOutput } from "./tool_call_restricted_granular/codex_output.ts";
import { toolCallRestrictedGranularInput } from "./tool_call_restricted_granular/input.ts";
import { assertToolCallWorkspaceNeverOutput } from "./tool_call_workspace_never/codex_output.ts";
import { toolCallWorkspaceNeverInput } from "./tool_call_workspace_never/input.ts";
import { assertTurnInterruptOutput } from "./turn_interrupt/codex_output.ts";
import { turnInterruptInput } from "./turn_interrupt/input.ts";
import { CODEX_MODEL_SELECTION, type OrchestratorReplayFixture } from "./shared.ts";

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
    name: "message_steering",
    buildInput: messageSteeringInput,
    providers: [
      {
        provider: "codex",
        transcriptFile: new URL("./message_steering/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
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

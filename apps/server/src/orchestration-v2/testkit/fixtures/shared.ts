import { assert } from "@effect/vitest";
import {
  type ChatAttachment,
  CommandId,
  isOrchestrationV2WorkActive,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserMessageInputIntent,
  ProviderInstanceId,
  type ProviderInteractionMode,
  type ProviderDriverKind,
  type ProviderReplayTranscript,
  type ProviderUserInputAnswers,
  type RuntimeMode,
} from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import type {
  OrchestratorV2ScenarioResult,
  OrchestratorV2ScenarioStep,
} from "../OrchestratorScenario.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { RuntimePolicyV2Override } from "../../RuntimePolicy.ts";
import { assertProviderTurnsReferenceNodes, assertRootNodesCountForRuns, assertRunsHaveRootNodes, assertTurnItemsAreOrdered } from "./shared-part2.ts";

export const SIMPLE_PROMPT = "Respond with the following text: fixture simple ok";
export const MULTI_TURN_FIRST_PROMPT = "Respond with exactly: first fixture turn complete";
export const MULTI_TURN_SECOND_PROMPT = "Respond with exactly: second fixture turn complete";
export const PROVIDER_THREAD_RESUME_FIRST_PROMPT =
  "Respond with exactly: provider thread resume fixture first turn complete";
export const PROVIDER_THREAD_RESUME_SECOND_PROMPT =
  "Using the conversation history available in this resumed thread, first repeat the exact final answer you gave in the previous turn. Then on a new line write exactly: provider thread resume fixture second turn complete";
export const TOOL_CALL_READ_ONLY_WORKSPACE_ROOT = "/tmp/claude-replay-tool_call_read_only";
export const TOOL_CALL_READ_ONLY_PROMPT = `Read ${TOOL_CALL_READ_ONLY_WORKSPACE_ROOT}/package.json and ${TOOL_CALL_READ_ONLY_WORKSPACE_ROOT}/tsconfig.json, then answer exactly: read only tool fixture complete`;
export const CLAUDE_LOCAL_BASH_TASK_PROMPT =
  "Run a local Bash typecheck command, then answer exactly: claude local bash task fixture complete";
export const CLAUDE_RESULT_IS_ERROR_PROMPT = "Say hello before the credentials expire.";
export const CLAUDE_RESULT_IS_ERROR_FOLLOW_UP = "Try again now that auth is back.";
export const TOOL_CALL_WRITE_PROMPT =
  "Create or overwrite .codex-probe-write-action.txt with exactly this text: codex app-server approval fixture. Use a local shell command or file edit only, then briefly report what happened. Do not read package metadata, use GitHub, use web, or use MCP.";
export const MESSAGE_STEERING_INITIAL_PROMPT =
  "Respond with exactly: steering fixture initial response";
export const SUBAGENT_PROMPT =
  "Spawn 2 subagents, one to read package.json and one to read tsconfig.json";
export const SUBAGENT_V2_NESTED_PROMPT =
  "Spawn one subagent and tell it to spawn its own subagent, which must in turn spawn one more subagent whose only task is to reply with exactly: Hello. Each agent waits for its child and replies with exactly what the child said. Wait for your subagent, then reply with exactly what it said.";
export const SUBAGENT_V2_PROMPT =
  "Spawn one subagent whose only task is to reply with exactly: Hello. Wait for it to finish, then reply with exactly what it said.";
export const SUBAGENT_V2_APPROVAL_PROMPT =
  "Do not run any commands yourself. Spawn one subagent whose only task is to run this exact shell command: printf 'subagent approval fixture' > subagent-approval.txt and then reply with exactly: Written. Wait for it to finish, then reply with exactly what it said.";
export const SUBAGENT_V2_NESTED_APPROVAL_PROMPT =
  "Do not run any commands yourself. Spawn one subagent and tell it not to run any commands itself but to spawn its own subagent, whose only task is to run this exact shell command: printf 'nested approval fixture' > nested-approval.txt and then reply with exactly: Written. Each agent waits for its child and replies with exactly what the child said. Wait for your subagent, then reply with exactly what it said.";
export const OPENCODE_SUBAGENT_PROMPT =
  "Use the task tool exactly once. Delegate to the general subagent with this prompt: Respond exactly CHILD_OK. After the task completes, respond exactly PARENT_OK.";
export const SUBAGENT_CONTINUE_PROMPT =
  "Spawn one subagent and have it reply exactly: initial subagent response";
export const SUBAGENT_CONTINUE_PARENT_PROMPT =
  "Have the same subagent you spawned earlier reply exactly: continued subagent response";
export const SUBAGENT_CONTINUE_CHILD_PROMPT = "Reply exactly: continued subagent response";
export const OPENCODE2_SIMPLE_PROMPT =
  "Think carefully step by step about whether 391 is prime, showing your reasoning, then answer in one short sentence.";
export const OPENCODE2_TOOL_CALL_PROMPT =
  "Use the read tool to read hello.txt, then run the shell command `echo TOOL_OK` with the bash tool, then reply DONE.";
export const OPENCODE2_INTERRUPT_PROMPT =
  "Run the shell command `sleep 60 && echo LATE` with the bash tool, then reply DONE.";
export const OPENCODE2_PERMISSION_PROMPT =
  "Run the shell command `echo FIRST` with the bash tool. After it completes, run `echo SECOND` with the bash tool. Then reply with what happened.";
export const OPENCODE2_STEER_PROMPT =
  "Run the shell command `sleep 12 && echo A` with the bash tool, then reply DONE_A.";
export const OPENCODE2_STEER_TEXT = "Also mention the word STEERED in your final reply.";
export const OPENCODE2_QUEUED_PROMPT = "Reply exactly QUEUED_B.";
export const OPENCODE2_CANCELLED_PROMPT = "Reply exactly QUEUED_C.";
export const OPENCODE2_REVERT_FIRST_PROMPT =
  "Create a file named reverted.txt containing the word ALPHA using the write tool, then reply DONE.";
export const OPENCODE2_REVERT_SECOND_PROMPT =
  "Overwrite reverted.txt so it contains the word BETA using the write tool, then reply DONE.";
export const OPENCODE2_QUESTION_PROMPT =
  "Before doing anything, use the question tool to ask me which color I prefer, offering the options red and blue. After I answer, reply with only the chosen color.";
export const OPENCODE2_SUBAGENT_PROMPT =
  "Use the subagent tool to delegate to the explore subagent with the prompt: 'List the files in the current directory and report their names.' Wait for it, then summarize its answer in one line.";
export const OPENCODE2_NESTED_BACKGROUND_PROMPT =
  "Use the subagent tool (foreground, do not set background) to delegate to the general subagent with this exact prompt: 'Use the subagent tool with background set to true to delegate to the general subagent with the prompt: Run the shell command `sleep 25` with the shell tool, then reply exactly GRANDCHILD_OK. As soon as it is launched, reply exactly MIDDLE_OK and end your turn without waiting for it.' Wait for that subagent to return, then reply exactly ROOT_OK.";
export const OPENCODE2_BACKGROUND_PROMPT =
  "Use the subagent tool with background enabled to delegate to the general subagent with the prompt: 'Run the shell command `sleep 20` with the bash tool and then reply exactly CHILD_OK.' As soon as it is launched, reply exactly PARENT_OK and end your turn without waiting for it.";
export const OPENCODE2_COMPACTION_FIRST_PROMPT = "Remember the codeword PAPAYA. Reply OK.";
export const OPENCODE2_COMPACTION_RECALL_PROMPT = "What was the codeword? One word.";
export const OPENCODE2_RESTART_PROMPT =
  "Run the shell command `sleep 25 && echo RESUMED` with the bash tool, then reply with its output.";
export const OPENCODE2_RESTART_RECALL_PROMPT =
  "What did I last ask you to run? Answer in one short sentence.";
export const OPENCODE2_COMMAND_PROMPT = "/hello WORLD";
export const OPENCODE2_SKILL_PROMPT = "Use $greet to say hi in three words.";
export const TURN_INTERRUPT_PROMPT =
  "Do not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.";
export const TURN_INTERRUPT_MID_TOOL_PROMPT =
  "Run this exact local command: `node -e \"console.log('interrupt fixture tool started'); setTimeout(() => {}, 30000)\"`. Do not answer until it completes, then respond exactly: interrupt fixture should not finish naturally.";
const COMMAND_OUTPUT_STREAMING_COMMAND =
  "for i in 1 2 3 4; do printf '\\033[32mstream line %s\\033[0m\\n' $i; sleep 1; done; printf 'progress 50%%\\rprogress 100%%\\n'";
export const COMMAND_OUTPUT_STREAMING_PROMPT = `Run this exact shell command in the foreground and wait for it to finish: \`${COMMAND_OUTPUT_STREAMING_COMMAND}\`. Then respond exactly: command output fixture complete`;
export const TURN_INTERRUPT_RECOVERY_PROMPT =
  "Respond with exactly: interrupt recovery fixture complete";
export const MESSAGE_STEERING_STEER_PROMPT =
  "Actually, respond with exactly: steering fixture observed";
export const THREAD_ROLLBACK_FIRST_PROMPT =
  "Respond with exactly: rollback fixture first turn complete";
export const THREAD_ROLLBACK_SECOND_PROMPT =
  "Respond with exactly: rollback fixture second turn complete";
export const THREAD_ROLLBACK_AFTER_PROMPT = "Repeat the conversation verbatim.";
export const THREAD_FORK_NATIVE_SOURCE_PROMPT =
  "Respond with the following text: source fork seed ok";
export const THREAD_FORK_NATIVE_TARGET_PROMPT = "Respond with the following text: fork native ok";
const THREAD_MERGE_BACK_SIBLINGS_SOURCE_MARKER = "merge-sibling-source-3C7K";
const THREAD_MERGE_BACK_SIBLINGS_FIRST_MARKER = "merge-sibling-first-6V2J";
const THREAD_MERGE_BACK_SIBLINGS_SECOND_MARKER = "merge-sibling-second-9X5B";
export const THREAD_MERGE_BACK_SIBLINGS_SOURCE_PROMPT = `Remember the opaque marker ${THREAD_MERGE_BACK_SIBLINGS_SOURCE_MARKER} for later in this conversation. Respond with exactly: merge sibling source stored`;
export const THREAD_MERGE_BACK_SIBLINGS_FIRST_FORK_PROMPT = `Remember the fork-local marker ${THREAD_MERGE_BACK_SIBLINGS_FIRST_MARKER}. Respond with exactly: first merge sibling stored`;
export const THREAD_MERGE_BACK_SIBLINGS_SECOND_FORK_PROMPT = `Remember the fork-local marker ${THREAD_MERGE_BACK_SIBLINGS_SECOND_MARKER}. Respond with exactly: second merge sibling stored`;
export const THREAD_MERGE_BACK_SIBLINGS_FIRST_HANDOFF_PROMPT = [
  "Context handoff (merge_back / fork_delta_summary):",
  "Merge-back context from first forked conversation.",
  "",
  "Fork delta:",
  `- User introduced opaque marker ${THREAD_MERGE_BACK_SIBLINGS_FIRST_MARKER}.`,
  "- Assistant confirmed: first merge sibling stored",
  "",
  "User message:",
  "Retain the first transferred marker for later. Respond with exactly: first merge delta stored",
].join("\n");
export const THREAD_MERGE_BACK_SIBLINGS_SECOND_HANDOFF_PROMPT = [
  "Context handoff (merge_back / fork_delta_summary):",
  "Merge-back context from second forked conversation.",
  "",
  "Fork delta:",
  `- User introduced opaque marker ${THREAD_MERGE_BACK_SIBLINGS_SECOND_MARKER}.`,
  "- Assistant confirmed: second merge sibling stored",
  "",
  "User message:",
  "Retain the second transferred marker for later. Respond with exactly: second merge delta stored",
].join("\n");
export const THREAD_MERGE_BACK_SIBLINGS_RECALL = [
  THREAD_MERGE_BACK_SIBLINGS_SOURCE_MARKER,
  THREAD_MERGE_BACK_SIBLINGS_FIRST_MARKER,
  THREAD_MERGE_BACK_SIBLINGS_SECOND_MARKER,
].join("|");
export const THREAD_MERGE_BACK_SIBLINGS_RECALL_PROMPT =
  "Return the source marker followed by both transferred fork markers in merge order, separated by single | characters. Respond with only the markers and separators.";
export const THREAD_FORK_NATIVE_PRIOR_TURN_ALPHA_PROMPT =
  "For this fork-boundary fixture, respond with exactly: fork boundary alpha";
export const THREAD_FORK_NATIVE_PRIOR_TURN_BETA_PROMPT =
  "For this fork-boundary fixture, respond with exactly: fork boundary beta";
export const THREAD_FORK_NATIVE_PRIOR_TURN_REPEAT_PROMPT =
  "Repeat the user-visible conversation so far verbatim. Include only user and assistant messages. Do not include hidden system/developer content.";
export const TODO_LIST_PROMPT =
  "Use the update_plan tool to track exactly three steps: inspect package.json, inspect tsconfig.json, report completion. Then read package.json and tsconfig.json, and answer exactly: todo list fixture complete";
export const PLAN_QUESTIONS_PROMPT =
  "Use request_user_input to ask one multiple-choice clarifying question about whether this fixture should prefer strict schemas or UI flexibility. After receiving the answer, respond exactly: plan questions fixture complete";
export const PROPOSED_PLAN_PROMPT =
  "Create a short implementation plan for adding deterministic replay fixtures. Do not ask questions. Present the final plan in a proposed plan block.";
export const WEB_SEARCH_PROMPT =
  "Search the web for FIFA World Cup ticket pricing, then answer exactly: web search fixture complete";
export const SKILL_INVOCATION_PROMPT = "$review README.md";
export const SKILL_INVOCATION_CURSOR_MESSAGE = "/review README.md";

export type OrchestratorFixtureInputStep =
  | {
      readonly type: "message";
      readonly text: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
    }
  | {
      /** Forks the thread at a run into a second thread, then sends `text` there. */
      readonly type: "fork";
      readonly fromRunIndex: number;
      readonly text: string;
    }
  | {
      readonly type: "queue_message";
      readonly text: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly createdBy?: Extract<
        OrchestrationV2Command,
        { readonly type: "message.dispatch" }
      >["createdBy"];
      readonly creationSource?: Extract<
        OrchestrationV2Command,
        { readonly type: "message.dispatch" }
      >["creationSource"];
    }
  | {
      readonly type: "cancel_queued_run";
      readonly targetRunIndex: number;
    }
  | {
      readonly type: "await_run_status";
      readonly targetRunIndex: number;
      readonly status: OrchestrationV2RunStatus;
      readonly waitForTurnItemType?: OrchestrationV2TurnItem["type"];
    }
  | {
      /** Replay finishes background-held runs through the adapter's debounce receipt. */
      readonly type: "finish_held_run";
      readonly targetRunIndex: number;
      readonly status: OrchestrationV2RunStatus;
    }
  | {
      readonly type: "capture_shell_snapshot";
      readonly key: string;
    }
  | {
      readonly type: "release_replay_gate";
      readonly label: string;
    }
  | {
      readonly type: "steer";
      readonly text: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly targetRunIndex: number;
    }
  | {
      readonly type: "restart";
      readonly text: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly targetRunIndex: number;
    }
  | {
      readonly type: "interrupt";
      readonly targetRunIndex: number;
      readonly waitForTurnItemType?: OrchestrationV2TurnItem["type"];
      /** With waitForTurnItemType: wait until that item has this status. */
      readonly waitForTurnItemStatus?: OrchestrationV2TurnItem["status"];
      /** With waitForTurnItemType: wait for it in one of the run's subagent threads. */
      readonly inSubagentThread?: boolean;
    }
  | {
      readonly type: "stop_background_work";
      readonly targetRunIndex: number;
    }
  | {
      readonly type: "release_replay_gate_after_waiting";
      readonly label: string;
      readonly targetRunIndex: number;
    }
  | {
      readonly type: "approve_next_runtime_request";
      readonly decision?: Extract<
        OrchestrationV2Command,
        { readonly type: "runtime-request.respond" }
      >["decision"];
      readonly shellSnapshotKeyWhilePending?: string;
    }
  | {
      readonly type: "answer_next_user_input_request";
      readonly answers: ProviderUserInputAnswers;
    }
  | {
      readonly type: "rollback";
      readonly checkpointScopeSuffix: string;
      readonly checkpointSuffix: string;
    }
  | {
      readonly type: "advance_clock";
      readonly duration: Duration.Input;
    }
  | {
      /** Picks another model of the same provider instance; later messages use it. */
      readonly type: "set_model";
      readonly model: string;
    };

export interface OrchestratorFixtureInput {
  readonly interactionMode?: ProviderInteractionMode;
  readonly runtimeMode?: RuntimeMode;
  /** Files committed before replay, keyed by relative path; seed the same files when recording so workspace reads match. */
  readonly workspaceFiles?: Readonly<Record<string, string>>;
  readonly steps: ReadonlyArray<OrchestratorFixtureInputStep>;
}

export interface ProviderOrchestratorReplayVariant {
  readonly driver: ProviderDriverKind;
  readonly transcriptFile: URL;
  readonly recordedScenario?: string;
  readonly transcriptEntriesThroughLabel?: string;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicyOverride?: RuntimePolicyV2Override;
  readonly runContinuationWorker?: boolean;
  readonly expectedAbsentWorkspacePaths?: ReadonlyArray<string>;
  readonly assertOutput: (
    result: OrchestratorV2ScenarioResult,
    transcript: ProviderReplayTranscript,
  ) => void;
}

export interface OrchestratorReplayFixture {
  readonly name: string;
  readonly buildInput: () => OrchestratorFixtureInput;
  readonly providers: ReadonlyArray<ProviderOrchestratorReplayVariant>;
}

export interface MaterializedOrchestratorFixtureInput {
  readonly commands: ReadonlyArray<OrchestrationV2Command>;
  readonly steps: ReadonlyArray<OrchestratorV2ScenarioStep>;
  readonly projectionThreadIds: ReadonlyArray<ThreadId>;
}

export interface FixtureIds {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

export const CODEX_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-luna",
} satisfies ModelSelection;

function assertTurnItemsReferenceProjection(projection: OrchestrationV2ThreadProjection) {
  for (const item of projection.turnItems) {
    if (item.runId !== null) {
      assert.isTrue(
        projection.runs.some((run) => run.id === item.runId),
        `turn item ${item.id} must reference an existing run`,
      );
    }
    if (item.nodeId !== null) {
      assert.isTrue(
        projection.nodes.some((node) => node.id === item.nodeId),
        `turn item ${item.id} must reference an existing node`,
      );
    }
    if (item.providerTurnId !== null) {
      assert.isTrue(
        projection.providerTurns.some((turn) => turn.id === item.providerTurnId),
        `turn item ${item.id} must reference an existing provider turn`,
      );
    }
  }
}

export function assertVisibleTurnItemsMirrorLocalTurnItems(
  projection: OrchestrationV2ThreadProjection,
) {
  assert.lengthOf(
    projection.visibleTurnItems,
    projection.turnItems.length,
    "non-fork visible turn items must mirror local canonical turn items",
  );

  for (const [index, item] of projection.turnItems.entries()) {
    const visibleItem = projection.visibleTurnItems[index];
    assert.isDefined(visibleItem, `missing visible turn item at position ${index}`);
    assert.equal(visibleItem.position, index);
    assert.equal(visibleItem.visibility, "local");
    assert.equal(visibleItem.sourceThreadId, item.threadId);
    assert.equal(visibleItem.sourceItemId, item.id);
    assert.deepEqual(visibleItem.item, item);
  }
}

function assertMessagesReferenceProjection(projection: OrchestrationV2ThreadProjection) {
  for (const message of projection.messages) {
    if (message.runId !== null) {
      assert.isTrue(
        projection.runs.some((run) => run.id === message.runId),
        `message ${message.id} must reference an existing run`,
      );
    }
    if (message.nodeId !== null) {
      assert.isTrue(
        projection.nodes.some((node) => node.id === message.nodeId),
        `message ${message.id} must reference an existing node`,
      );
    }
  }
}

function assertRuntimeRequestsReferenceProjection(projection: OrchestrationV2ThreadProjection) {
  for (const request of projection.runtimeRequests) {
    const requestNode = projection.nodes.find((node) => node.id === request.nodeId);
    assert.isTrue(
      requestNode !== undefined,
      `runtime request ${request.id} must reference an existing node`,
    );
    if (
      requestNode !== undefined &&
      (request.kind === "command" || request.kind === "file-read" || request.kind === "file-change")
    ) {
      assert.equal(
        requestNode.kind,
        "approval_request",
        `runtime request ${request.id} must reference an approval request node`,
      );
    }
    if (request.providerTurnId !== null) {
      assert.isTrue(
        projection.providerTurns.some((turn) => turn.id === request.providerTurnId),
        `runtime request ${request.id} must reference an existing provider turn`,
      );
    }
  }
}

export function assertSemanticProjectionIntegrity(projection: OrchestrationV2ThreadProjection) {
  assertRunsHaveRootNodes(projection);
  assertRootNodesCountForRuns(projection);
  assertProviderTurnsReferenceNodes(projection);
  assertTurnItemsAreOrdered(projection);
  assertTurnItemsReferenceProjection(projection);
  assertMessagesReferenceProjection(projection);
  assertRuntimeRequestsReferenceProjection(projection);
}

export function assertRunProviderTurnCardinality(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly rootRunCount: number;
  readonly providerTurnCountAtLeast?: number;
}) {
  assert.lengthOf(input.projection.runs, input.rootRunCount);
  assert.isAtLeast(
    input.projection.providerTurns.length,
    input.providerTurnCountAtLeast ?? input.rootRunCount,
  );
}

export function assertNoExtraAppRunsForProviderChildren(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly expectedAppRuns: number;
}) {
  assert.lengthOf(
    input.projection.runs,
    input.expectedAppRuns,
    "provider child activity must not create additional app runs",
  );
}

export function assertProviderNativeSubagentRootTurns(result: OrchestratorV2ScenarioResult) {
  const activity = (statuses: ReadonlyArray<OrchestrationV2ExecutionNode["status"]>) =>
    statuses
      .map((status) => (isOrchestrationV2WorkActive(status) ? "active" : status))
      .filter((status, index, all) => status !== all[index - 1]);
  for (const projection of result.projections.values()) {
    for (const subagent of projection.subagents) {
      if (subagent.origin !== "provider_native" || subagent.childThreadId === null) continue;
      const childThreadId = subagent.childThreadId;
      const child = result.projections.get(childThreadId);
      assert.isDefined(child, `missing child thread for subagent ${subagent.id}`);
      assert.equal(child.thread.creationSource, "provider");
      assert.deepEqual(child.thread.forkedFrom, { type: "node", nodeId: subagent.id });
      assert.lengthOf(child.runs, 0);
      const roots = child.nodes.filter((node) => node.kind === "root_turn");
      assert.isNotEmpty(roots, `child ${childThreadId} must have a root turn`);
      for (const root of roots) assert.isNull(root.runId);

      const runByChildUpdate = new Map<string, string | undefined>();
      for (const event of result.domainEvents) {
        if (event.threadId !== childThreadId) continue;
        const update = `${event.type}:${JSON.stringify(event.payload)}`;
        const storedBy = runByChildUpdate.get(update);
        if (runByChildUpdate.has(update) && storedBy !== event.runId) {
          assert.fail(
            `child ${childThreadId} stored ${event.type} in ${storedBy} and ${event.runId}`,
          );
        }
        runByChildUpdate.set(update, event.runId);
      }

      const rootEvents = result.domainEvents.flatMap((event, index) =>
        event.type === "node.updated" &&
        event.payload.threadId === childThreadId &&
        event.payload.kind === "root_turn"
          ? [{ index, status: event.payload.status }]
          : [],
      );
      const firstItemIndex = result.domainEvents.findIndex(
        (event) =>
          event.type === "turn-item.updated" &&
          event.payload.threadId === childThreadId &&
          event.payload.type !== "user_message",
      );
      assert.equal(rootEvents[0]?.status, "running");
      if (firstItemIndex !== -1) {
        assert.isBelow(
          rootEvents[0]?.index ?? Infinity,
          firstItemIndex,
          `child ${childThreadId} must be working before its first item`,
        );
      }
      const subagentStatuses = result.domainEvents.flatMap((event) =>
        event.type === "subagent.updated" && event.payload.id === subagent.id
          ? [event.payload.status]
          : [],
      );
      const rootActivity = activity(rootEvents.map((event) => event.status));
      const subagentActivity = activity(subagentStatuses);
      const wokenAfterEnd =
        child.subagents.length > 0 && rootActivity.length > subagentActivity.length;
      assert.deepEqual(
        wokenAfterEnd ? rootActivity.slice(0, subagentActivity.length) : rootActivity,
        subagentActivity,
        `child ${childThreadId} root turn must follow subagent ${subagent.id}`,
      );
      if (wokenAfterEnd) {
        assert.notEqual(rootActivity.at(-1), "active", `child ${childThreadId} must end its turns`);
        const childSubagentIds = new Set(child.subagents.map((nested) => nested.id));
        const nestedEndIndexes = result.domainEvents.flatMap((event, index) =>
          event.type === "subagent.updated" &&
          childSubagentIds.has(event.payload.id) &&
          !isOrchestrationV2WorkActive(event.payload.status)
            ? [index]
            : [],
        );
        const subagentEndIndex = result.domainEvents.findLastIndex(
          (event) =>
            event.type === "subagent.updated" &&
            event.payload.id === subagent.id &&
            !isOrchestrationV2WorkActive(event.payload.status),
        );
        const wakeStarts = rootEvents.filter(
          (event, position) =>
            event.index > subagentEndIndex &&
            isOrchestrationV2WorkActive(event.status) &&
            !isOrchestrationV2WorkActive(rootEvents[position - 1]?.status ?? "completed"),
        );
        assert.isNotEmpty(wakeStarts, `child ${childThreadId} woke without a new turn`);
        assert.isAtMost(
          wakeStarts.length,
          nestedEndIndexes.length,
          `child ${childThreadId} woke more often than its subagents ended`,
        );
        for (const wake of wakeStarts) {
          assert.isTrue(
            nestedEndIndexes.some((endIndex) => endIndex < wake.index),
            `child ${childThreadId} woke before any of its subagents ended`,
          );
        }
      }
    }
  }
}

export function assertExecutionNodeKinds(
  projection: OrchestrationV2ThreadProjection,
  expectedKinds: ReadonlyArray<OrchestrationV2ExecutionNode["kind"]>,
) {
  const kinds = projection.nodes.map((node) => node.kind);
  for (const expectedKind of expectedKinds) {
    assert.include(kinds, expectedKind);
  }
}

export function assertTurnItemTypes(
  projection: OrchestrationV2ThreadProjection,
  expectedTypes: ReadonlyArray<OrchestrationV2TurnItem["type"]>,
) {
  const actualTypes = projection.turnItems.map((item) => item.type);
  for (const expectedType of expectedTypes) {
    assert.include(actualTypes, expectedType);
  }
}

export function assertTurnItemTypeSequence(
  projection: OrchestrationV2ThreadProjection,
  expectedTypes: ReadonlyArray<OrchestrationV2TurnItem["type"]>,
) {
  assert.deepEqual(
    projection.turnItems.map((item) => item.type),
    expectedTypes,
  );
}

export function assertVisibleTurnItemTypeSequence(
  projection: OrchestrationV2ThreadProjection,
  expectedTypes: ReadonlyArray<OrchestrationV2TurnItem["type"]>,
) {
  assert.deepEqual(
    projection.visibleTurnItems.map((row) => row.item.type),
    expectedTypes,
  );
}

export function assertAssistantTextIncludes(
  projection: OrchestrationV2ThreadProjection,
  expectedText: string,
) {
  assert.isTrue(
    projection.turnItems.some(
      (item) => item.type === "assistant_message" && item.text.includes(expectedText),
    ),
    `expected assistant output to include ${JSON.stringify(expectedText)}`,
  );
}

export function assertRuntimeRequestCounts(
  projection: OrchestrationV2ThreadProjection,
  expected: { readonly total: number; readonly resolved?: number },
) {
  assert.lengthOf(projection.runtimeRequests, expected.total);
  if (expected.resolved !== undefined) {
    assert.equal(
      projection.runtimeRequests.filter((request) => request.status === "resolved").length,
      expected.resolved,
    );
  }
}

function countReplayLabelsWithPrefix(transcript: ProviderReplayTranscript, prefix: string): number {
  return transcript.entries.filter(
    (entry) => entry.type !== "runtime_exit" && (entry.label?.startsWith(prefix) ?? false),
  ).length;
}

export function assertReplayLabelPrefixCount(
  transcript: ProviderReplayTranscript,
  prefix: string,
  expected: number,
) {
  assert.equal(countReplayLabelsWithPrefix(transcript, prefix), expected);
}

export function assertRuntimeRequestKinds(
  projection: OrchestrationV2ThreadProjection,
  expectedKinds: ReadonlyArray<string>,
) {
  assert.deepEqual(
    projection.runtimeRequests.map((request) => request.kind),
    expectedKinds,
  );
}

export function assertAllRuntimeRequestsResolved(projection: OrchestrationV2ThreadProjection) {
  assert.deepEqual(
    projection.runtimeRequests.map((request) => request.status),
    projection.runtimeRequests.map(() => "resolved"),
  );
}

export function assertConversationMessageRoles(
  projection: OrchestrationV2ThreadProjection,
  expectedRoles: ReadonlyArray<string>,
) {
  assert.deepEqual(
    projection.messages.map((message) => message.role),
    expectedRoles,
  );
}

export function assertNoAcpClientFileOrTerminalRequests(transcript: ProviderReplayTranscript) {
  const frames = transcript.entries.flatMap((entry) =>
    entry.type === "runtime_exit"
      ? []
      : [entry.frame as { method?: unknown; params?: { clientCapabilities?: unknown } }],
  );
  assert.deepInclude(
    frames.find((frame) => frame.method === "initialize")?.params?.clientCapabilities ?? {},
    { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    "T3 must not advertise client fs or terminals",
  );
  assert.deepEqual(
    frames.flatMap((frame) =>
      typeof frame.method === "string" && /^(fs|terminal)\//u.test(frame.method)
        ? [frame.method]
        : [],
    ),
    [],
    "the agent must not route file or terminal work through T3",
  );
}

export function assertUserMessagesInclude(
  projection: OrchestrationV2ThreadProjection,
  expectedTexts: ReadonlyArray<string>,
) {
  for (const expectedText of expectedTexts) {
    assert.isTrue(
      projection.turnItems.some(
        (item) => item.type === "user_message" && item.text.includes(expectedText),
      ),
      `expected user input to include ${JSON.stringify(expectedText)}`,
    );
  }
}

export function assertVisibleUserMessagesInclude(
  projection: OrchestrationV2ThreadProjection,
  expectedTexts: ReadonlyArray<string>,
) {
  for (const expectedText of expectedTexts) {
    assert.isTrue(
      projection.visibleTurnItems.some(
        (row) => row.item.type === "user_message" && row.item.text.includes(expectedText),
      ),
      `expected visible user input to include ${JSON.stringify(expectedText)}`,
    );
  }
}

export function assertVisibleUserMessagesExclude(
  projection: OrchestrationV2ThreadProjection,
  rejectedTexts: ReadonlyArray<string>,
) {
  for (const rejectedText of rejectedTexts) {
    assert.isFalse(
      projection.visibleTurnItems.some(
        (row) => row.item.type === "user_message" && row.item.text.includes(rejectedText),
      ),
      `expected visible user input to exclude ${JSON.stringify(rejectedText)}`,
    );
  }
}

export function assertUserMessageInputIntents(
  projection: OrchestrationV2ThreadProjection,
  expectedIntents: ReadonlyArray<OrchestrationV2UserMessageInputIntent>,
) {
  assert.deepEqual(
    projection.turnItems
      .filter((item) => item.type === "user_message")
      .map((item) => item.inputIntent),
    expectedIntents,
  );
}

export function backgroundNotifications(projection: OrchestrationV2ThreadProjection) {
  return projection.turnItems.flatMap((item) =>
    item.type === "notification"
      ? [{ summary: item.summary, outcome: item.outcome, source: item.source }]
      : [],
  );
}
export * from "./shared-part2.ts";

import { assert } from "@effect/vitest";
import {
  type ChatAttachment,
  CommandId,
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
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type {
  OrchestratorV2ScenarioResult,
  OrchestratorV2ScenarioStep,
} from "../OrchestratorScenario.ts";
import { IdAllocatorV2, type IdAllocatorV2Error } from "../../IdAllocator.ts";
import type { RuntimePolicyV2Override } from "../../RuntimePolicy.ts";

export const SIMPLE_PROMPT = "Respond with the following text: fixture simple ok";
export const MULTI_TURN_FIRST_PROMPT = "Respond with exactly: first fixture turn complete";
export const MULTI_TURN_SECOND_PROMPT = "Respond with exactly: second fixture turn complete";
export const PROVIDER_THREAD_RESUME_FIRST_PROMPT =
  "Respond with exactly: provider thread resume fixture first turn complete";
export const PROVIDER_THREAD_RESUME_SECOND_PROMPT =
  "Using the conversation history available in this resumed thread, first repeat the exact final answer you gave in the previous turn. Then on a new line write exactly: provider thread resume fixture second turn complete";
export const TOOL_CALL_READ_ONLY_WORKSPACE_ROOT = "/tmp/claude-replay-tool_call_read_only";
export const TOOL_CALL_READ_ONLY_PROMPT = `Read ${TOOL_CALL_READ_ONLY_WORKSPACE_ROOT}/package.json and ${TOOL_CALL_READ_ONLY_WORKSPACE_ROOT}/tsconfig.json, then answer exactly: read only tool fixture complete`;
export const TOOL_CALL_WRITE_PROMPT =
  "Create or overwrite .codex-probe-write-action.txt with exactly this text: codex app-server approval fixture. Use a local shell command or file edit only, then briefly report what happened. Do not read package metadata, use GitHub, use web, or use MCP.";
export const MESSAGE_STEERING_INITIAL_PROMPT =
  "Respond with exactly: steering fixture initial response";
export const SUBAGENT_PROMPT =
  "Spawn 2 subagents, one to read package.json and one to read tsconfig.json";
export const SUBAGENT_V2_PROMPT = "just say hello";
export const OPENCODE_SUBAGENT_PROMPT =
  "Use the task tool exactly once. Delegate to the general subagent with this prompt: Respond exactly CHILD_OK. After the task completes, respond exactly PARENT_OK.";
export const SUBAGENT_CONTINUE_PROMPT =
  "Spawn one subagent and have it reply exactly: initial subagent response";
export const SUBAGENT_CONTINUE_PARENT_PROMPT =
  "@hooke have the same subagent reply exactly: continued subagent response";
export const SUBAGENT_CONTINUE_CHILD_PROMPT = "Reply exactly: continued subagent response";
export const TURN_INTERRUPT_PROMPT =
  "Do not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.";
export const TURN_INTERRUPT_MID_TOOL_PROMPT =
  "Run this exact local command: `node -e \"console.log('interrupt fixture tool started'); setTimeout(() => {}, 30000)\"`. Do not answer until it completes, then respond exactly: interrupt fixture should not finish naturally.";
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
export const THREAD_FORK_NATIVE_CONTINUE_SOURCE_MARKER = "source-marker-7Q9V";
export const THREAD_FORK_NATIVE_CONTINUE_FORK_MARKER = "fork-marker-2K4M";
export const THREAD_FORK_NATIVE_CONTINUE_RECALL = `${THREAD_FORK_NATIVE_CONTINUE_SOURCE_MARKER}|${THREAD_FORK_NATIVE_CONTINUE_FORK_MARKER}`;
export const THREAD_FORK_NATIVE_CONTINUE_SOURCE_PROMPT = `Remember the opaque marker ${THREAD_FORK_NATIVE_CONTINUE_SOURCE_MARKER} for later in this conversation. Respond with exactly: source marker stored`;
export const THREAD_FORK_NATIVE_CONTINUE_FIRST_PROMPT = `Remember the second opaque marker ${THREAD_FORK_NATIVE_CONTINUE_FORK_MARKER} for later in this conversation. Respond with exactly: fork marker stored`;
export const THREAD_FORK_NATIVE_CONTINUE_SECOND_PROMPT =
  "Return the two opaque markers previously provided in chronological order, separated by a single | character. Respond with only the markers and separator.";
export const THREAD_FORK_NATIVE_SIBLINGS_SOURCE_MARKER = "sibling-source-8R3D";
export const THREAD_FORK_NATIVE_SIBLINGS_FIRST_MARKER = "sibling-first-5L2P";
export const THREAD_FORK_NATIVE_SIBLINGS_SECOND_MARKER = "sibling-second-9N6C";
export const THREAD_FORK_NATIVE_SIBLINGS_SOURCE_PROMPT = `Remember the opaque marker ${THREAD_FORK_NATIVE_SIBLINGS_SOURCE_MARKER} for later in this conversation. Respond with exactly: sibling source stored`;
export const THREAD_FORK_NATIVE_SIBLINGS_FIRST_PROMPT = `Remember the fork-local marker ${THREAD_FORK_NATIVE_SIBLINGS_FIRST_MARKER}. Return the source marker followed by this marker, separated by |. Respond with only the markers and separator.`;
export const THREAD_FORK_NATIVE_SIBLINGS_SECOND_PROMPT = `Remember the fork-local marker ${THREAD_FORK_NATIVE_SIBLINGS_SECOND_MARKER}. Return the source marker followed by this marker, separated by |. Respond with only the markers and separator.`;
export const THREAD_MERGE_BACK_SOURCE_MARKER = "merge-source-4H8Q";
export const THREAD_MERGE_BACK_FORK_MARKER = "merge-fork-7T2W";
export const THREAD_MERGE_BACK_SOURCE_PROMPT = `Remember the opaque marker ${THREAD_MERGE_BACK_SOURCE_MARKER} for later in this conversation. Respond with exactly: merge source stored`;
export const THREAD_MERGE_BACK_FORK_PROMPT = `Remember the fork-local marker ${THREAD_MERGE_BACK_FORK_MARKER}. Respond with exactly: merge fork stored`;
export const THREAD_MERGE_BACK_HANDOFF_PROMPT = [
  "Context handoff (merge_back / fork_delta_summary):",
  "Merge-back context from forked conversation.",
  "",
  "Fork delta:",
  `- User introduced opaque marker ${THREAD_MERGE_BACK_FORK_MARKER}.`,
  "- Assistant confirmed: merge fork stored",
  "",
  "User message:",
  "Retain the transferred fork marker for later. Respond with exactly: merge delta stored",
].join("\n");
export const THREAD_MERGE_BACK_RECALL = `${THREAD_MERGE_BACK_SOURCE_MARKER}|${THREAD_MERGE_BACK_FORK_MARKER}`;
export const THREAD_MERGE_BACK_RECALL_PROMPT =
  "Return the source marker followed by the transferred fork marker, separated by a single | character. Respond with only the markers and separator.";
export const THREAD_MERGE_BACK_SIBLINGS_SOURCE_MARKER = "merge-sibling-source-3C7K";
export const THREAD_MERGE_BACK_SIBLINGS_FIRST_MARKER = "merge-sibling-first-6V2J";
export const THREAD_MERGE_BACK_SIBLINGS_SECOND_MARKER = "merge-sibling-second-9X5B";
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

export type OrchestratorFixtureInputStep =
  | {
      readonly type: "message";
      readonly text: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
    }
  | {
      readonly type: "queue_message";
      readonly text: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
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
    }
  | {
      readonly type: "approve_next_runtime_request";
      readonly decision?: Extract<
        OrchestrationV2Command,
        { readonly type: "runtime-request.respond" }
      >["decision"];
    }
  | {
      readonly type: "answer_next_user_input_request";
      readonly answers: ProviderUserInputAnswers;
    }
  | {
      readonly type: "rollback";
      readonly checkpointScopeSuffix: string;
      readonly checkpointSuffix: string;
    };

export interface OrchestratorFixtureInput {
  readonly interactionMode?: ProviderInteractionMode;
  readonly steps: ReadonlyArray<OrchestratorFixtureInputStep>;
}

export interface ProviderOrchestratorReplayVariant {
  readonly driver: ProviderDriverKind;
  readonly transcriptFile: URL;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicyOverride?: RuntimePolicyV2Override;
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
  model: "gpt-5.4",
} satisfies ModelSelection;

export const CLAUDE_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;

export const CURSOR_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("cursor"),
  model: "composer-2.5",
} satisfies ModelSelection;

export const GROK_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("grok"),
  model: "grok-build",
} satisfies ModelSelection;

export const OPENCODE_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "openai/gpt-5.4-mini",
  options: [{ id: "agent", value: "build" }],
} satisfies ModelSelection;

export const ACP_REGISTRY_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("acpRegistry"),
  model: "default",
} satisfies ModelSelection;

export const READ_ONLY_ON_REQUEST_POLICY = {
  approvalPolicy: "on-request",
  sandboxPolicy: {
    type: "readOnly",
    access: { type: "fullAccess" },
    networkAccess: false,
  },
} as const satisfies RuntimePolicyV2Override;

export const READ_ONLY_NEVER_POLICY = {
  approvalPolicy: "never",
  sandboxPolicy: {
    type: "readOnly",
    access: { type: "fullAccess" },
    networkAccess: false,
  },
} as const satisfies RuntimePolicyV2Override;

export const WORKSPACE_NEVER_POLICY = {
  approvalPolicy: "never",
  sandboxPolicy: {
    type: "workspaceWrite",
    writableRoots: [],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: false,
  },
} as const satisfies RuntimePolicyV2Override;

export const RESTRICTED_GRANULAR_POLICY = {
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
} as const satisfies RuntimePolicyV2Override;

export function createThreadCommand(input: {
  readonly commandId: CommandId;
  readonly ids: FixtureIds;
  readonly scenario: string;
  readonly modelSelection: ModelSelection;
  readonly interactionMode?: ProviderInteractionMode;
}): OrchestrationV2Command {
  return {
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: input.commandId,
    threadId: input.ids.threadId,
    projectId: input.ids.projectId,
    title: `Replay fixture: ${input.scenario}`,
    modelSelection: input.modelSelection,
    runtimeMode: "full-access",
    interactionMode: input.interactionMode ?? "default",
    branch: null,
    worktreePath: null,
  };
}

export function dispatchMessageCommand(input: {
  readonly commandId: CommandId;
  readonly ids: FixtureIds;
  readonly modelSelection: ModelSelection;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly dispatchMode?: Extract<
    OrchestrationV2Command,
    { readonly type: "message.dispatch" }
  >["dispatchMode"];
}): OrchestrationV2Command {
  return {
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: input.commandId,
    threadId: input.ids.threadId,
    messageId: input.messageId,
    text: input.text,
    attachments: [...(input.attachments ?? [])],
    modelSelection: input.modelSelection,
    dispatchMode: input.dispatchMode ?? { type: "start_immediately" },
  };
}

export function materializeFixtureInput(input: {
  readonly scenario: string;
  readonly fixtureInput: OrchestratorFixtureInput;
  readonly driver: ProviderDriverKind;
  readonly modelSelection: ModelSelection;
}): Effect.Effect<MaterializedOrchestratorFixtureInput, IdAllocatorV2Error, IdAllocatorV2> {
  return Effect.gen(function* () {
    const idAllocator = yield* IdAllocatorV2;
    const projectId = yield* idAllocator.allocate.project({ fixtureName: input.scenario });
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName: input.scenario,
      projectId,
    });
    const ids = { threadId, projectId } satisfies FixtureIds;
    const commands: Array<OrchestrationV2Command> = [];
    const steps: Array<OrchestratorV2ScenarioStep> = [];
    let messageIndex = 0;
    const activeRunDispatchKeys = new Set<string>();

    const runIdFor = (runOrdinal: number) =>
      idAllocator.derive.run({ threadId: ids.threadId, ordinal: runOrdinal });

    const pushDispatch = (
      command: OrchestrationV2Command,
      options: {
        readonly await?: boolean;
        readonly key?: string;
        readonly advanceClockAfter?: boolean;
      } = {},
    ) => {
      commands.push(command);
      steps.push({
        type: "dispatch",
        command,
        await: options.await ?? true,
        ...(options.key === undefined ? {} : { key: options.key }),
      });
      if (options.advanceClockAfter ?? true) {
        steps.push({ type: "advance_clock", duration: "1 millis" });
      }
    };

    pushDispatch(
      createThreadCommand({
        commandId: yield* idAllocator.allocate.command({
          fixtureName: input.scenario,
          commandName: "thread-create",
        }),
        ids,
        scenario: input.scenario,
        modelSelection: input.modelSelection,
        ...(input.fixtureInput.interactionMode === undefined
          ? {}
          : { interactionMode: input.fixtureInput.interactionMode }),
      }),
    );

    for (const [stepIndex, step] of input.fixtureInput.steps.entries()) {
      switch (step.type) {
        case "message":
          messageIndex += 1;
          {
            const nextStep = input.fixtureInput.steps[stepIndex + 1];
            const shouldRunInBackground =
              (nextStep !== undefined &&
                ((nextStep.type === "interrupt" && nextStep.targetRunIndex === messageIndex) ||
                  nextStep.type === "queue_message" ||
                  (nextStep.type === "restart" && nextStep.targetRunIndex === messageIndex))) ||
              nextStep?.type === "approve_next_runtime_request" ||
              nextStep?.type === "answer_next_user_input_request";
            const key = `run:${messageIndex}`;
            pushDispatch(
              dispatchMessageCommand({
                commandId: yield* idAllocator.allocate.command({
                  fixtureName: input.scenario,
                  commandName: `message-${messageIndex}`,
                }),
                ids,
                modelSelection: input.modelSelection,
                messageId: yield* idAllocator.allocate.message({
                  threadId: ids.threadId,
                  ordinal: messageIndex,
                }),
                text: step.text,
                ...(step.attachments === undefined ? {} : { attachments: step.attachments }),
              }),
              shouldRunInBackground ? { await: false, key } : undefined,
            );
            if (shouldRunInBackground) {
              activeRunDispatchKeys.add(key);
            } else if (
              !(
                nextStep !== undefined &&
                (nextStep.type === "steer" || nextStep.type === "restart") &&
                nextStep.targetRunIndex === messageIndex
              )
            ) {
              steps.push({ type: "await_thread_idle", threadId: ids.threadId });
            }
          }
          break;
        case "queue_message":
          messageIndex += 1;
          pushDispatch(
            dispatchMessageCommand({
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `queue-message-${messageIndex}`,
              }),
              ids,
              modelSelection: input.modelSelection,
              messageId: yield* idAllocator.allocate.message({
                threadId: ids.threadId,
                ordinal: messageIndex,
              }),
              text: step.text,
              ...(step.attachments === undefined ? {} : { attachments: step.attachments }),
            }),
          );
          steps.push({ type: "await", key: `run:${messageIndex - 1}` });
          steps.push({ type: "await_thread_idle", threadId: ids.threadId });
          break;
        case "answer_next_user_input_request":
          pushDispatch(
            {
              type: "runtime-request.respond",
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `answer-user-input-request-${messageIndex}`,
              }),
              threadId: ids.threadId,
              requestId: yield* idAllocator.allocate.runtimeRequest({
                driver: input.driver,
                nativeRequestId: `fixture-placeholder-${messageIndex}`,
              }),
              answers: step.answers,
            },
            { advanceClockAfter: false },
          );
          steps[steps.length - 1] = {
            type: "respond_to_next_runtime_request",
            threadId: ids.threadId,
            commandId: commands.at(-1)!.commandId,
            answers: step.answers,
          };
          steps.push({ type: "advance_clock", duration: "1 millis" });
          steps.push({ type: "await_thread_idle", threadId: ids.threadId });
          break;
        case "approve_next_runtime_request":
          pushDispatch(
            {
              type: "runtime-request.respond",
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `approve-runtime-request-${messageIndex}`,
              }),
              threadId: ids.threadId,
              requestId: yield* idAllocator.allocate.runtimeRequest({
                driver: input.driver,
                nativeRequestId: `fixture-placeholder-${messageIndex}`,
              }),
              decision: step.decision ?? "accept",
            },
            { advanceClockAfter: false },
          );
          steps[steps.length - 1] = {
            type: "respond_to_next_runtime_request",
            threadId: ids.threadId,
            commandId: commands.at(-1)!.commandId,
            decision: step.decision ?? "accept",
          };
          steps.push({ type: "advance_clock", duration: "1 millis" });
          steps.push({ type: "await_thread_idle", threadId: ids.threadId });
          break;
        case "steer":
          messageIndex += 1;
          steps.push({
            type: "await_run_steerable",
            threadId: ids.threadId,
            runId: runIdFor(step.targetRunIndex),
          });
          pushDispatch(
            dispatchMessageCommand({
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `steer-${messageIndex}`,
              }),
              ids,
              modelSelection: input.modelSelection,
              messageId: yield* idAllocator.allocate.message({
                threadId: ids.threadId,
                ordinal: messageIndex,
              }),
              text: step.text,
              ...(step.attachments === undefined ? {} : { attachments: step.attachments }),
              dispatchMode: {
                type: "steer_active",
                targetRunId: runIdFor(step.targetRunIndex),
              },
            }),
          );
          if (input.fixtureInput.steps[stepIndex + 1]?.type !== "approve_next_runtime_request") {
            if (activeRunDispatchKeys.delete(`run:${step.targetRunIndex}`)) {
              steps.push({ type: "await", key: `run:${step.targetRunIndex}` });
            }
            steps.push({ type: "await_thread_idle", threadId: ids.threadId });
          }
          break;
        case "restart":
          messageIndex += 1;
          steps.push({
            type: "await_run_steerable",
            threadId: ids.threadId,
            runId: runIdFor(step.targetRunIndex),
          });
          pushDispatch(
            dispatchMessageCommand({
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `restart-${messageIndex}`,
              }),
              ids,
              modelSelection: input.modelSelection,
              messageId: yield* idAllocator.allocate.message({
                threadId: ids.threadId,
                ordinal: messageIndex,
              }),
              text: step.text,
              ...(step.attachments === undefined ? {} : { attachments: step.attachments }),
              dispatchMode: {
                type: "restart_active",
                targetRunId: runIdFor(step.targetRunIndex),
              },
            }),
          );
          if (input.fixtureInput.steps[stepIndex + 1]?.type !== "approve_next_runtime_request") {
            if (activeRunDispatchKeys.delete(`run:${step.targetRunIndex}`)) {
              steps.push({ type: "await", key: `run:${step.targetRunIndex}` });
            }
            steps.push({ type: "await_thread_idle", threadId: ids.threadId });
          }
          break;
        case "interrupt":
          steps.push({
            type: "await_run_steerable",
            threadId: ids.threadId,
            runId: runIdFor(step.targetRunIndex),
          });
          if (step.waitForTurnItemType !== undefined) {
            steps.push({
              type: "await_run_turn_item",
              threadId: ids.threadId,
              runId: runIdFor(step.targetRunIndex),
              itemType: step.waitForTurnItemType,
            });
          }
          pushDispatch(
            {
              type: "run.interrupt",
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `interrupt-${step.targetRunIndex}`,
              }),
              threadId: ids.threadId,
              runId: runIdFor(step.targetRunIndex),
            },
            { advanceClockAfter: false },
          );
          if (activeRunDispatchKeys.delete(`run:${step.targetRunIndex}`)) {
            steps.push({ type: "await", key: `run:${step.targetRunIndex}` });
          }
          steps.push({ type: "advance_clock", duration: "1 millis" });
          steps.push({ type: "await_thread_idle", threadId: ids.threadId });
          break;
        case "rollback":
          {
            const scopeId = yield* idAllocator.allocate.checkpointScope({
              threadId: ids.threadId,
              name: step.checkpointScopeSuffix,
            });
            pushDispatch({
              type: "checkpoint.rollback",
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `rollback-${step.checkpointSuffix}`,
              }),
              threadId: ids.threadId,
              scopeId,
              checkpointId: yield* idAllocator.allocate.checkpoint({
                checkpointScopeId: scopeId,
                name: step.checkpointSuffix,
              }),
            });
          }
          break;
      }
    }

    if (activeRunDispatchKeys.size > 0) {
      steps.push({ type: "await_all" });
      steps.push({ type: "await_thread_idle", threadId: ids.threadId });
    }

    return {
      commands,
      steps,
      projectionThreadIds: [ids.threadId],
    };
  });
}

export function projectionFor(
  result: OrchestratorV2ScenarioResult,
  scenario: string,
): OrchestrationV2ThreadProjection {
  const projections = [...result.projections.values()].filter(
    (projection) => projection.thread.lineage.parentThreadId === null,
  );

  assert.equal(projections.length, 1, `expected one root projection for ${scenario}`);
  const projection = projections[0];
  assert.isDefined(projection, `missing projection for ${scenario}`);
  return projection;
}

export function assertBaseProjection(input: {
  readonly result: OrchestratorV2ScenarioResult;
  readonly transcript: ProviderReplayTranscript;
  readonly runCount: number;
  readonly providerTurnCountAtLeast?: number;
  readonly runStatuses?: ReadonlyArray<OrchestrationV2RunStatus>;
}) {
  const projection = projectionFor(input.result, input.transcript.scenario);

  assert.equal(
    projection.thread.providerInstanceId,
    ProviderInstanceId.make(input.transcript.provider),
  );
  assert.lengthOf(projection.runs, input.runCount);
  assert.isAtLeast(projection.providerThreads.length, 1);
  assert.isAtLeast(
    projection.providerTurns.length,
    input.providerTurnCountAtLeast ?? input.runCount,
    `expected provider turns; runs=${projection.runs.map((run) => `${run.id}:${run.status}`).join(",")}; sessions=${projection.providerSessions.map((session) => `${session.id}:${session.status}`).join(",")}; items=${projection.turnItems.map((item) => (item.type === "error" ? `${item.type}:${item.failure.message}` : item.type)).join(",")}`,
  );
  assert.isAtLeast(input.result.domainEvents.length, 1);
  assert.deepEqual(
    input.result.storedEvents.map((stored) => stored.sequence),
    input.result.storedEvents.map((_, index) => index + 1),
  );
  assert.deepEqual(
    input.result.storedEvents.map((stored) => stored.event.id),
    input.result.domainEvents.map((event) => event.id),
  );

  if (input.runStatuses) {
    assert.deepEqual(
      projection.runs.map((run) => run.status),
      input.runStatuses,
    );
  }
}

export function assertRunOrdinals(
  projection: OrchestrationV2ThreadProjection,
  expectedOrdinals: ReadonlyArray<number>,
) {
  assert.deepEqual(
    projection.runs.map((run) => run.ordinal),
    expectedOrdinals,
  );
}

export function assertRunsHaveRootNodes(projection: OrchestrationV2ThreadProjection) {
  for (const run of projection.runs) {
    assert.isNotNull(run.rootNodeId, `run ${run.id} must have a root node`);
    assert.isTrue(
      projection.nodes.some((node) => node.id === run.rootNodeId && node.kind === "root_turn"),
      `run ${run.id} root node must exist`,
    );
  }
}

export function assertRootNodesCountForRuns(projection: OrchestrationV2ThreadProjection) {
  const rootNodes = projection.nodes.filter((node) => node.kind === "root_turn");
  assert.isAtLeast(rootNodes.length, projection.runs.length);
  for (const node of rootNodes) {
    assert.equal(node.countsForRun, true, `root node ${node.id} must count for its app run`);
  }
}

export function assertProviderTurnsReferenceNodes(projection: OrchestrationV2ThreadProjection) {
  for (const providerTurn of projection.providerTurns) {
    assert.isTrue(
      projection.nodes.some((node) => node.id === providerTurn.nodeId),
      `provider turn ${providerTurn.id} must reference an execution node`,
    );
    assert.isTrue(
      projection.providerThreads.some((thread) => thread.id === providerTurn.providerThreadId),
      `provider turn ${providerTurn.id} must reference a provider thread`,
    );
  }
}

export function assertTurnItemsAreOrdered(projection: OrchestrationV2ThreadProjection) {
  const ordinals = projection.turnItems.map((item) => item.ordinal);
  assert.deepEqual(
    ordinals,
    [...ordinals].toSorted((left, right) => left - right),
  );
}

export function assertTurnItemsReferenceProjection(projection: OrchestrationV2ThreadProjection) {
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

export function assertMessagesReferenceProjection(projection: OrchestrationV2ThreadProjection) {
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

export function assertRuntimeRequestsReferenceProjection(
  projection: OrchestrationV2ThreadProjection,
) {
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

export function countReplayLabelsWithPrefix(
  transcript: ProviderReplayTranscript,
  prefix: string,
): number {
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

export function assertUserMessagesExclude(
  projection: OrchestrationV2ThreadProjection,
  rejectedTexts: ReadonlyArray<string>,
) {
  for (const rejectedText of rejectedTexts) {
    assert.isFalse(
      projection.turnItems.some(
        (item) => item.type === "user_message" && item.text.includes(rejectedText),
      ),
      `expected user input to exclude ${JSON.stringify(rejectedText)}`,
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

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
import type { FixtureIds, MaterializedOrchestratorFixtureInput, OrchestratorFixtureInput } from "./shared.ts";

export const CLAUDE_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;

export const CURSOR_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("cursor"),
  model: "composer-2.5",
} satisfies ModelSelection;

export const MUSE_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("muse"),
  model: "muse-spark-1.3-contributor",
} satisfies ModelSelection;

export const GROK_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("grok"),
  model: "grok-build",
} satisfies ModelSelection;

/** fx fixtures run on fx's Default; the replay adapter has no probed model, so it writes none. */
export const FX_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("fx"),
  model: "default",
} satisfies ModelSelection;

/** Kiro's cheapest listed model, so recordings stay cheap and do not depend on "auto" routing. */
export const KIRO_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("kiro"),
  model: "claude-haiku-4.5",
} satisfies ModelSelection;

export const OPENCODE_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "openai/gpt-5.4-mini",
  options: [{ id: "agent", value: "build" }],
} satisfies ModelSelection;

export const OPENCODE2_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "opencode/space-bunny-free",
  options: [{ id: "variant", value: "high" }],
} satisfies ModelSelection;

export const PI_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("pi"),
  model: "openrouter/deepseek/deepseek-v4-flash",
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
  readonly runtimeMode?: RuntimeMode;
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
    runtimeMode: input.runtimeMode ?? "full-access",
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
  readonly createdBy?: Extract<
    OrchestrationV2Command,
    { readonly type: "message.dispatch" }
  >["createdBy"];
  readonly creationSource?: Extract<
    OrchestrationV2Command,
    { readonly type: "message.dispatch" }
  >["creationSource"];
  readonly dispatchMode?: Extract<
    OrchestrationV2Command,
    { readonly type: "message.dispatch" }
  >["dispatchMode"];
}): OrchestrationV2Command {
  return {
    type: "message.dispatch",
    createdBy: input.createdBy ?? "user",
    creationSource: input.creationSource ?? "web",
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
}): Effect.Effect<
  MaterializedOrchestratorFixtureInput,
  IdAllocator.IdAllocatorV2Error,
  IdAllocator.IdAllocatorV2
> {
  return Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projectId = yield* idAllocator.allocate.project({ fixtureName: input.scenario });
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName: input.scenario,
      projectId,
    });
    const ids = { threadId, projectId } satisfies FixtureIds;
    const commands: Array<OrchestrationV2Command> = [];
    const steps: Array<OrchestratorV2ScenarioStep> = [];
    let messageIndex = 0;
    let runIndex = 0;
    let forkThreadId: ThreadId | undefined;
    const activeRunDispatchKeys = new Set<string>();

    const runIdFor = (runOrdinal: number) =>
      idAllocator.derive.run({ threadId: ids.threadId, ordinal: runOrdinal });

    // A `set_model` step changes the selection every later message carries.
    let modelSelection = input.modelSelection;
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
        modelSelection,
        ...(input.fixtureInput.interactionMode === undefined
          ? {}
          : { interactionMode: input.fixtureInput.interactionMode }),
        ...(input.fixtureInput.runtimeMode === undefined
          ? {}
          : { runtimeMode: input.fixtureInput.runtimeMode }),
      }),
    );

    // Multiple requests keep runs busy between answers; wait for each request, not thread idle.
    const answersNext = (stepIndex: number) => {
      const next = input.fixtureInput.steps[stepIndex + 1]?.type;
      return next === "approve_next_runtime_request" || next === "answer_next_user_input_request";
    };
    for (const [stepIndex, step] of input.fixtureInput.steps.entries()) {
      switch (step.type) {
        case "message":
          messageIndex += 1;
          runIndex += 1;
          {
            const nextStep = input.fixtureInput.steps[stepIndex + 1];
            const shouldRunInBackground =
              (nextStep !== undefined &&
                ((nextStep.type === "interrupt" && nextStep.targetRunIndex === runIndex) ||
                  nextStep.type === "queue_message" ||
                  (nextStep.type === "restart" && nextStep.targetRunIndex === runIndex) ||
                  (nextStep.type === "release_replay_gate_after_waiting" &&
                    nextStep.targetRunIndex === runIndex) ||
                  // Continuations start while busy; waiting for idle would deadlock.
                  (nextStep.type === "await_run_status" && nextStep.targetRunIndex > runIndex) ||
                  // Held open until the test clock moves, so it cannot go idle first.
                  nextStep.type === "finish_held_run")) ||
              nextStep?.type === "approve_next_runtime_request" ||
              nextStep?.type === "answer_next_user_input_request";
            const key = `run:${runIndex}`;
            pushDispatch(
              dispatchMessageCommand({
                commandId: yield* idAllocator.allocate.command({
                  fixtureName: input.scenario,
                  commandName: `message-${messageIndex}`,
                }),
                ids,
                modelSelection,
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
                nextStep.targetRunIndex === runIndex
              )
            ) {
              steps.push({ type: "await_thread_idle", threadId: ids.threadId });
            }
          }
          break;
        case "queue_message": {
          messageIndex += 1;
          runIndex += 1;
          const nextStep = input.fixtureInput.steps[stepIndex + 1];
          pushDispatch(
            dispatchMessageCommand({
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `queue-message-${messageIndex}`,
              }),
              ids,
              modelSelection,
              messageId: yield* idAllocator.allocate.message({
                threadId: ids.threadId,
                ordinal: messageIndex,
              }),
              text: step.text,
              ...(step.createdBy === undefined ? {} : { createdBy: step.createdBy }),
              ...(step.creationSource === undefined ? {} : { creationSource: step.creationSource }),
              ...(step.attachments === undefined ? {} : { attachments: step.attachments }),
              dispatchMode: { type: "queue_after_active" },
            }),
          );
          const shouldSkipQueueBarrier =
            nextStep?.type === "queue_message" ||
            (nextStep?.type === "cancel_queued_run" && nextStep.targetRunIndex === runIndex);
          if (!shouldSkipQueueBarrier) {
            const queueBarrierKey =
              Array.from(activeRunDispatchKeys).at(-1) ?? `run:${runIndex - 1}`;
            activeRunDispatchKeys.delete(queueBarrierKey);
            steps.push({ type: "await", key: queueBarrierKey });
            steps.push({ type: "await_thread_idle", threadId: ids.threadId });
          }
          break;
        }
        case "cancel_queued_run":
          pushDispatch({
            type: "queued-run.cancel",
            commandId: yield* idAllocator.allocate.command({
              fixtureName: input.scenario,
              commandName: `cancel-queued-run-${step.targetRunIndex}`,
            }),
            threadId: ids.threadId,
            runId: runIdFor(step.targetRunIndex),
          });
          break;
        case "await_run_status":
          steps.push({
            type: "await_run_status",
            threadId: ids.threadId,
            runId: runIdFor(step.targetRunIndex),
            status: step.status,
          });
          if (step.waitForTurnItemType !== undefined) {
            steps.push({
              type: "await_run_turn_item",
              threadId: ids.threadId,
              runId: runIdFor(step.targetRunIndex),
              itemType: step.waitForTurnItemType,
            });
          }
          break;
        case "finish_held_run":
          steps.push({
            type: "finish_held_run",
            threadId: ids.threadId,
            runId: runIdFor(step.targetRunIndex),
            status: step.status,
          });
          break;
        case "capture_shell_snapshot":
          steps.push({ type: "capture_shell_snapshot", key: step.key });
          break;
        case "release_replay_gate":
          steps.push({ type: "release_replay_gate", label: step.label });
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
          if (!answersNext(stepIndex)) {
            steps.push({ type: "await_thread_idle", threadId: ids.threadId });
          }
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
            ...(step.shellSnapshotKeyWhilePending === undefined
              ? {}
              : { shellSnapshotKeyWhilePending: step.shellSnapshotKeyWhilePending }),
          };
          steps.push({ type: "advance_clock", duration: "1 millis" });
          if (!answersNext(stepIndex)) {
            steps.push({ type: "await_thread_idle", threadId: ids.threadId });
          }
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
              modelSelection,
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
          {
            const nextStepType = input.fixtureInput.steps[stepIndex + 1]?.type;
            if (
              nextStepType !== "approve_next_runtime_request" &&
              nextStepType !== "answer_next_user_input_request"
            ) {
              if (activeRunDispatchKeys.delete(`run:${step.targetRunIndex}`)) {
                steps.push({ type: "await", key: `run:${step.targetRunIndex}` });
              }
              steps.push({ type: "await_thread_idle", threadId: ids.threadId });
            }
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
              modelSelection,
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
          {
            const nextStepType = input.fixtureInput.steps[stepIndex + 1]?.type;
            if (
              nextStepType !== "approve_next_runtime_request" &&
              nextStepType !== "answer_next_user_input_request"
            ) {
              if (activeRunDispatchKeys.delete(`run:${step.targetRunIndex}`)) {
                steps.push({ type: "await", key: `run:${step.targetRunIndex}` });
              }
              steps.push({ type: "await_thread_idle", threadId: ids.threadId });
            }
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
              ...(step.waitForTurnItemStatus === undefined
                ? {}
                : { itemStatus: step.waitForTurnItemStatus }),
              ...(step.inSubagentThread === true ? { inSubagentThreads: true } : {}),
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
        case "stop_background_work":
          steps.push({ type: "await_thread_idle", threadId: ids.threadId });
          steps.push({ type: "capture_shell_snapshot", key: "before-stop" });
          pushDispatch(
            {
              type: "run.interrupt",
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: `stop-background-work-${step.targetRunIndex}`,
              }),
              threadId: ids.threadId,
              runId: runIdFor(step.targetRunIndex),
              holdQueue: true,
            },
            { advanceClockAfter: false },
          );
          steps.push({ type: "await_no_background_work", threadId: ids.threadId });
          break;
        case "release_replay_gate_after_waiting":
          steps.push({
            type: "release_replay_gate_after_waiting",
            label: step.label,
            threadId: ids.threadId,
            runId: runIdFor(step.targetRunIndex),
          });
          break;
        case "advance_clock":
          steps.push({ type: "advance_clock", duration: step.duration });
          break;
        case "set_model":
          modelSelection = { ...input.modelSelection, model: step.model };
          pushDispatch({
            type: "thread.model-selection.set",
            commandId: yield* idAllocator.allocate.command({
              fixtureName: input.scenario,
              commandName: `set-model-${step.model}`,
            }),
            threadId: ids.threadId,
            modelSelection,
          });
          break;
        case "fork":
          {
            const targetThreadId = yield* idAllocator.allocate.thread({
              fixtureName: `${input.scenario}-fork`,
              projectId: ids.projectId,
            });
            forkThreadId = targetThreadId;
            pushDispatch({
              type: "thread.fork",
              createdBy: "user",
              creationSource: "web",
              commandId: yield* idAllocator.allocate.command({
                fixtureName: input.scenario,
                commandName: "thread-fork",
              }),
              sourceThreadId: ids.threadId,
              targetThreadId,
              sourcePoint: { type: "run", runId: runIdFor(step.fromRunIndex) },
              title: "Forked thread",
            });
            pushDispatch(
              dispatchMessageCommand({
                commandId: yield* idAllocator.allocate.command({
                  fixtureName: input.scenario,
                  commandName: "fork-message",
                }),
                ids: { ...ids, threadId: targetThreadId },
                modelSelection,
                messageId: yield* idAllocator.allocate.message({
                  threadId: targetThreadId,
                  ordinal: 1,
                }),
                text: step.text,
              }),
            );
            steps.push({ type: "await_thread_idle", threadId: targetThreadId });
          }
          break;
        case "rollback":
          {
            const scopeId = yield* idAllocator.allocate.checkpointScope({
              threadId: ids.threadId,
              name: step.checkpointScopeSuffix,
            });
            pushDispatch({
              type: "checkpoint.rollback",
              restoreFiles: false,
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
      projectionThreadIds:
        forkThreadId === undefined ? [ids.threadId] : [ids.threadId, forkThreadId],
    };
  });
}

/** Reads `key` from a recorded frame or payload of unknown shape. */
export function field(value: unknown, key: string): unknown {
  return Predicate.hasProperty(value, key) ? value[key] : undefined;
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


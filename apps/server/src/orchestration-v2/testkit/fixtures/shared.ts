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
  type ProviderKind,
  type ProviderInteractionMode,
  type ProviderReplayTranscript,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { Effect } from "effect";

import type {
  OrchestratorV2ScenarioResult,
  OrchestratorV2ScenarioStep,
} from "../OrchestratorScenario.ts";
import { IdAllocatorV2, type IdAllocatorV2Error } from "../../IdAllocator.ts";
import type { RuntimePolicyV2Override } from "../../RuntimePolicy.ts";

export const SIMPLE_PROMPT = "Respond with the following text: fixture simple ok";
export const TOOL_CALL_WRITE_PROMPT =
  "Create or overwrite .codex-probe-write-action.txt with exactly this text: codex app-server approval fixture. Use a local shell command or file edit only, then briefly report what happened. Do not read package metadata, use GitHub, use web, or use MCP.";
export const SUBAGENT_PROMPT =
  "Spawn 2 subagents, one to read package.json and one to read tsconfig.json";
export const TURN_INTERRUPT_PROMPT =
  "Do not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.";
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
      readonly type: "interrupt";
      readonly targetRunIndex: number;
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
  readonly provider: ProviderKind;
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
  provider: "codex",
  model: "gpt-5.4",
} satisfies ModelSelection;

export function createThreadCommand(input: {
  readonly commandId: CommandId;
  readonly ids: FixtureIds;
  readonly scenario: string;
  readonly modelSelection: ModelSelection;
  readonly interactionMode?: ProviderInteractionMode;
}): OrchestrationV2Command {
  return {
    type: "thread.create",
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
                (((nextStep.type === "steer" || nextStep.type === "interrupt") &&
                  nextStep.targetRunIndex === messageIndex) ||
                  nextStep.type === "queue_message")) ||
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
            } else {
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
                provider: input.modelSelection.provider,
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
                provider: input.modelSelection.provider,
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
          if (
            input.fixtureInput.steps[stepIndex + 1]?.type !== "approve_next_runtime_request" &&
            activeRunDispatchKeys.delete(`run:${step.targetRunIndex}`)
          ) {
            steps.push({ type: "await", key: `run:${step.targetRunIndex}` });
            steps.push({ type: "await_thread_idle", threadId: ids.threadId });
          }
          break;
        case "interrupt":
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
  const projections = [...result.projections.values()];

  assert.equal(projections.length, 1, `expected one projection for ${scenario}`);
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

  assert.equal(projection.thread.defaultProvider, input.transcript.provider);
  assert.lengthOf(projection.runs, input.runCount);
  assert.isAtLeast(projection.providerThreads.length, 1);
  assert.isAtLeast(
    projection.providerTurns.length,
    input.providerTurnCountAtLeast ?? input.runCount,
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

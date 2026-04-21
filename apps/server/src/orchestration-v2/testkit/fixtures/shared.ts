import { assert } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProviderKind,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../OrchestratorScenario.ts";

export const SIMPLE_PROMPT = "Respond with the following text: fixture simple ok";
export const TOOL_CALL_WRITE_PROMPT =
  "Create or overwrite .codex-probe-write-action.txt with exactly this text: codex app-server approval fixture. Use a local shell command or file edit only, then briefly report what happened. Do not read package metadata, use GitHub, use web, or use MCP.";
export const SUBAGENT_PROMPT =
  "Spawn 2 subagents, one to read package.json and one to read tsconfig.json";
export const TURN_INTERRUPT_PROMPT =
  "Do not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.";

export type OrchestratorFixtureInputStep =
  | {
      readonly type: "message";
      readonly text: string;
    }
  | {
      readonly type: "steer";
      readonly text: string;
      readonly targetRunIndex: number;
    }
  | {
      readonly type: "interrupt";
      readonly targetRunIndex: number;
    }
  | {
      readonly type: "rollback";
      readonly checkpointScopeSuffix: string;
      readonly checkpointSuffix: string;
    };

export interface OrchestratorFixtureInput {
  readonly steps: ReadonlyArray<OrchestratorFixtureInputStep>;
}

export interface ProviderOrchestratorReplayVariant {
  readonly provider: ProviderKind;
  readonly transcriptFile: URL;
  readonly modelSelection: ModelSelection;
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
  readonly projectionThreadIds: ReadonlyArray<ThreadId>;
}

export interface FixtureIds {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

export const CODEX_MODEL_SELECTION = {
  provider: "codex",
  model: "crest-alpha",
} satisfies ModelSelection;

export function commandId(scenario: string, suffix: string): CommandId {
  return CommandId.make(`cmd:${scenario}:${suffix}`);
}

export function messageId(scenario: string, index: number): MessageId {
  return MessageId.make(`msg:${scenario}:${index}`);
}

export function runId(scenario: string, index: number): RunId {
  return RunId.make(`run:${scenario}:${index}`);
}

export function checkpointScopeId(scenario: string, suffix: string): CheckpointScopeId {
  return CheckpointScopeId.make(`checkpoint-scope:${scenario}:${suffix}`);
}

export function checkpointId(scenario: string, suffix: string): CheckpointId {
  return CheckpointId.make(`checkpoint:${scenario}:${suffix}`);
}

export function fixtureIds(scenario: string): FixtureIds {
  return {
    threadId: ThreadId.make(`thread:${scenario}`),
    projectId: ProjectId.make("project:orchestrator-replay"),
  };
}

export function createThreadCommand(input: {
  readonly scenario: string;
  readonly ids: FixtureIds;
  readonly modelSelection: ModelSelection;
}): OrchestrationV2Command {
  return {
    type: "thread.create",
    commandId: commandId(input.scenario, "thread-create"),
    threadId: input.ids.threadId,
    projectId: input.ids.projectId,
    title: `Replay fixture: ${input.scenario}`,
    modelSelection: input.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  };
}

export function dispatchMessageCommand(input: {
  readonly scenario: string;
  readonly ids: FixtureIds;
  readonly modelSelection: ModelSelection;
  readonly text: string;
  readonly index: number;
  readonly dispatchMode?: Extract<
    OrchestrationV2Command,
    { readonly type: "message.dispatch" }
  >["dispatchMode"];
}): OrchestrationV2Command {
  return {
    type: "message.dispatch",
    commandId: commandId(input.scenario, `message-${input.index}`),
    threadId: input.ids.threadId,
    messageId: messageId(input.scenario, input.index),
    text: input.text,
    attachments: [],
    modelSelection: input.modelSelection,
    dispatchMode: input.dispatchMode ?? { type: "start_immediately" },
  };
}

export function materializeFixtureInput(input: {
  readonly scenario: string;
  readonly fixtureInput: OrchestratorFixtureInput;
  readonly modelSelection: ModelSelection;
}): MaterializedOrchestratorFixtureInput {
  const ids = fixtureIds(input.scenario);
  const commands: Array<OrchestrationV2Command> = [
    createThreadCommand({
      scenario: input.scenario,
      ids,
      modelSelection: input.modelSelection,
    }),
  ];
  let messageIndex = 0;

  for (const step of input.fixtureInput.steps) {
    switch (step.type) {
      case "message":
        messageIndex += 1;
        commands.push(
          dispatchMessageCommand({
            scenario: input.scenario,
            ids,
            modelSelection: input.modelSelection,
            text: step.text,
            index: messageIndex,
          }),
        );
        break;
      case "steer":
        messageIndex += 1;
        commands.push(
          dispatchMessageCommand({
            scenario: input.scenario,
            ids,
            modelSelection: input.modelSelection,
            text: step.text,
            index: messageIndex,
            dispatchMode: {
              type: "steer_active",
              targetRunId: runId(input.scenario, step.targetRunIndex),
            },
          }),
        );
        break;
      case "interrupt":
        commands.push({
          type: "run.interrupt",
          commandId: commandId(input.scenario, `interrupt-${step.targetRunIndex}`),
          threadId: ids.threadId,
          runId: runId(input.scenario, step.targetRunIndex),
        });
        break;
      case "rollback":
        commands.push({
          type: "checkpoint.rollback",
          commandId: commandId(input.scenario, `rollback-${step.checkpointSuffix}`),
          threadId: ids.threadId,
          scopeId: checkpointScopeId(input.scenario, step.checkpointScopeSuffix),
          checkpointId: checkpointId(input.scenario, step.checkpointSuffix),
        });
        break;
    }
  }

  return {
    commands,
    projectionThreadIds: [ids.threadId],
  };
}

export function projectionFor(
  result: OrchestratorV2ScenarioResult,
  scenario: string,
): OrchestrationV2ThreadProjection {
  const threadId = fixtureIds(scenario).threadId;
  const projection = result.projections.get(threadId);

  assert.isDefined(projection, `missing projection for ${threadId}`);
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
  const ids = fixtureIds(input.transcript.scenario);

  assert.equal(projection.thread.id, ids.threadId);
  assert.equal(projection.thread.defaultProvider, input.transcript.provider);
  assert.lengthOf(projection.runs, input.runCount);
  assert.isAtLeast(projection.providerThreads.length, 1);
  assert.isAtLeast(
    projection.providerTurns.length,
    input.providerTurnCountAtLeast ?? input.runCount,
  );
  assert.isAtLeast(input.result.domainEvents.length, 1);

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
    assert.isTrue(
      projection.nodes.some((node) => node.id === request.nodeId),
      `runtime request ${request.id} must reference an existing node`,
    );
    if (request.providerTurnId !== null) {
      assert.isTrue(
        projection.providerTurns.some((turn) => turn.id === request.providerTurnId),
        `runtime request ${request.id} must reference an existing provider turn`,
      );
    }
    if (request.runtimeItemId !== null) {
      assert.isTrue(
        projection.runtimeItems.some((item) => item.id === request.runtimeItemId),
        `runtime request ${request.id} must reference an existing runtime item`,
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

export function assertRuntimeItemKinds(
  projection: OrchestrationV2ThreadProjection,
  expectedKinds: ReadonlyArray<string>,
) {
  const actualKinds = projection.runtimeItems.map((item) => item.kind);
  for (const expectedKind of expectedKinds) {
    assert.include(actualKinds, expectedKind);
  }
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

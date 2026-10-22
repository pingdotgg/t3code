import { describe, expect, it } from "vite-plus/test";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  TurnItemId,
  ProviderSessionId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  MessageId,
  RunId,
} from "@t3tools/contracts";
import {
  deriveMessageRevertTargets,
  deriveRevertTargets,
  supportsThreadRollback,
} from "./threadCheckpoints.js";
import { v2Projection } from "./orchestrationV2TestFixtures.js";

const runId = RunId.make("run-8");
const messageId = MessageId.make("message-8");
const entries = [
  { runId: RunId.make("run-3") },
  { runId, userMessage: { id: messageId, inputIntent: "turn_start" } },
];

describe("rewind targets", () => {
  it("uses the ready predecessor's identity across ordinal gaps", () => {
    const targets = deriveRevertTargets({
      entries,
      checkpoints: [{ runId: RunId.make("run-3"), checkpointTurnCount: 3, status: "ready" }],
      threadStartCheckpointReady: true,
    });
    expect(targets.get(messageId)).toBe(3);
  });

  it("excludes steer, inherited and unsettled messages and missing predecessors", () => {
    for (const entry of [
      { ...entries[1]!, inherited: true },
      { runId, userMessage: { id: messageId, inputIntent: "steer" } },
      { runId, userMessage: { id: messageId, inputIntent: undefined } },
    ]) {
      expect(
        deriveRevertTargets({ entries: [entry], checkpoints: [], threadStartCheckpointReady: true })
          .size,
      ).toBe(0);
    }
    expect(
      deriveRevertTargets({ entries, checkpoints: [], threadStartCheckpointReady: true }).size,
    ).toBe(0);
    expect(
      deriveRevertTargets({
        entries: [entries[1]!],
        checkpoints: [],
        threadStartCheckpointReady: true,
        unsettledRunId: runId,
      }).size,
    ).toBe(0);
  });

  it("honors provider and session rollback capabilities", () => {
    expect(supportsThreadRollback(v2Projection, { supportsConversationRollback: false })).toBe(
      false,
    );
    expect(supportsThreadRollback(v2Projection, undefined)).toBe(false);
    expect(supportsThreadRollback(v2Projection, {})).toBe(true);
  });
});

function run(
  ordinal: number,
  status: OrchestrationV2Run["status"] = "completed",
): OrchestrationV2Run {
  return {
    id: RunId.make(`run-${ordinal}`),
    ordinal,
    threadId: v2Projection.thread.id,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${ordinal}`),
    rootNodeId: null,
    activeAttemptId: RunAttemptId.make(`attempt-${ordinal}`),
    status,
    requestedAt: v2Projection.updatedAt,
    startedAt: v2Projection.updatedAt,
    completedAt: v2Projection.updatedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
}
function checkpoint(ordinal: number): OrchestrationV2Checkpoint {
  return {
    id: CheckpointId.make(`checkpoint-${ordinal}`),
    scopeId: CheckpointScopeId.make("scope"),
    runId: ordinal === 0 ? null : RunId.make(`run-${ordinal}`),
    appRunOrdinal: ordinal === 0 ? null : ordinal,
    ordinalWithinScope: ordinal,
    threadId: v2Projection.thread.id,
    nodeId: NodeId.make("node"),
    parentCheckpointId: null,
    ref: CheckpointRef.make(`refs/t3/${ordinal}`),
    status: "ready",
    files: [],
    capturedAt: v2Projection.updatedAt,
  };
}
function userMessage(
  ordinal: number,
  inputIntent: "turn_start" | "queued_turn" | "steer" = "turn_start",
) {
  const item: OrchestrationV2TurnItem = {
    id: TurnItemId.make(`item-${ordinal}`),
    threadId: v2Projection.thread.id,
    runId: RunId.make(`run-${ordinal}`),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    type: "user_message",
    status: "completed",
    title: "Prompt",
    startedAt: v2Projection.updatedAt,
    completedAt: v2Projection.updatedAt,
    updatedAt: v2Projection.updatedAt,
    text: "Prompt",
    attachments: [],
    messageId: MessageId.make(`message-${ordinal}`),
    createdBy: "user",
    creationSource: "mobile",
    inputIntent,
  };
  return {
    visibility: "local" as const,
    position: ordinal,
    sourceThreadId: v2Projection.thread.id,
    sourceItemId: item.id,
    item,
  };
}

function rewindProjection() {
  const providerThreadId = ProviderThreadId.make("provider-thread");
  return {
    ...v2Projection,
    thread: { ...v2Projection.thread, activeProviderThreadId: providerThreadId },
    providerThreads: [
      {
        id: providerThreadId,
        providerInstanceId: v2Projection.thread.providerInstanceId,
        providerSessionId: ProviderSessionId.make("session"),
        driver: ProviderDriverKind.make("codex"),
        appThreadId: v2Projection.thread.id,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 3,
        lastRunOrdinal: 8,
        handoffIds: [],
        forkedFrom: null,
        createdAt: v2Projection.updatedAt,
        updatedAt: v2Projection.updatedAt,
      },
    ],
    providerTurns: [3, 8].map((ordinal) => ({
      id: ProviderTurnId.make(`turn-${ordinal}`),
      providerThreadId,
      runAttemptId: RunAttemptId.make(`attempt-${ordinal}`),
      ordinal,
      nodeId: NodeId.make("node"),
      nativeTurnRef: null,
      status: "completed" as const,
      startedAt: v2Projection.updatedAt,
      completedAt: v2Projection.updatedAt,
    })),
    checkpointScopes: [
      {
        id: CheckpointScopeId.make("scope"),
        kind: "root_run" as const,
        advancesAppRunCount: true,
        parentScopeId: null,
        threadId: v2Projection.thread.id,
        runId: null,
        nodeId: NodeId.make("node"),
        providerThreadId,
        ordinalWithinParent: 0,
        cwd: "/workspace",
        createdAt: v2Projection.updatedAt,
      },
    ],
  };
}

describe("projected message rewind targets", () => {
  it("does not treat the first loaded run as thread start when earlier history is unknown", () => {
    const projection = {
      ...rewindProjection(),
      runs: [run(8)],
      checkpoints: [checkpoint(0), checkpoint(8)],
      visibleTurnItems: [userMessage(8)],
    };
    expect(deriveMessageRevertTargets(projection).size).toBe(0);
  });
  it("uses complete run metadata when the preceding message is outside the bounded timeline", () => {
    const previous = checkpoint(3);
    const projection = {
      ...rewindProjection(),
      runs: [run(1, "rolled_back"), run(3), run(8)],
      checkpoints: [checkpoint(0), previous, checkpoint(8)],
      visibleTurnItems: [userMessage(8, "queued_turn")],
    };
    expect(deriveMessageRevertTargets(projection).get(MessageId.make("message-8"))).toBe(previous);
    for (const change of [
      { visibleTurnItems: [userMessage(8, "steer")] },
      { visibleTurnItems: [{ ...userMessage(8), visibility: "inherited" as const }] },
      { runs: [run(3), run(8, "running")] },
      { runs: [run(3), run(8, "queued")] },
      { checkpoints: [checkpoint(0), { ...previous, status: "missing" as const }] },
      { providerThreads: [] },
      { providerTurns: [] },
    ])
      expect(deriveMessageRevertTargets({ ...projection, ...change }).size).toBe(0);
  });

  it("uses thread start for the first remaining run after an earlier rewind", () => {
    const start = checkpoint(0);
    expect(
      deriveMessageRevertTargets(
        {
          ...rewindProjection(),
          runs: [run(1, "rolled_back"), run(8)],
          checkpoints: [start, checkpoint(8)],
          visibleTurnItems: [userMessage(8)],
        },
        { historyComplete: true },
      ).get(MessageId.make("message-8")),
    ).toBe(start);
  });

  it("honors both session capability flags", () => {
    for (const [canRollbackThread, providerCanRollbackConversation] of [
      [true, true],
      [false, true],
      [true, false],
    ]) {
      const session = {
        id: ProviderSessionId.make("session"),
        providerInstanceId: v2Projection.thread.providerInstanceId,
        capabilities: {
          threads: { canRollbackThread },
          checkpointing: { providerCanRollbackConversation },
        },
      } as OrchestrationV2ProviderSession;
      expect(supportsThreadRollback({ ...v2Projection, providerSessions: [session] }, {})).toBe(
        canRollbackThread && providerCanRollbackConversation,
      );
    }
  });
});

it("ignores nested-scope baselines when rewinding the first message", () => {
  const start = checkpoint(0);
  const nested = {
    ...start,
    id: CheckpointId.make("nested-start"),
    scopeId: CheckpointScopeId.make("nested-scope"),
  };
  const projection = rewindProjection();
  const targets = deriveMessageRevertTargets({
    ...projection,
    runs: [run(1)],
    checkpoints: [start, nested],
    visibleTurnItems: [userMessage(1)],
    checkpointScopes: [
      ...projection.checkpointScopes,
      {
        ...projection.checkpointScopes[0]!,
        id: nested.scopeId,
        kind: "subagent",
        advancesAppRunCount: false,
        parentScopeId: start.scopeId,
      },
    ],
  });
  expect(targets.get(MessageId.make("message-1"))).toBe(start);
});

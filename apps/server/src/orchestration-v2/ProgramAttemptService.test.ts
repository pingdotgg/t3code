import { assert, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  ProgramAttemptId,
  ProgramAttemptRequestId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProgramAttemptService from "./ProgramAttemptService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const attemptId = ProgramAttemptId.make("attempt:s1");
const projectId = ProjectId.make("project:s1");
const threadId = ThreadId.make("thread:s1");
const runId = RunId.make("run:s1");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.6-sol" } as const;
const now = DateTime.makeUnsafe("2026-08-19T00:00:00.000Z");

function makeProjection(status: OrchestrationV2RunStatus): OrchestrationV2ThreadProjection {
  const terminal = ThreadManagementService.isTerminalRunStatus(status);
  return {
    thread: {
      createdBy: "system",
      creationSource: "server",
      id: threadId,
      projectId,
      title: "S1 disposable task",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "prepared",
      worktreePath: "/repo-worktrees/prepared",
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: terminal ? now : null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:s1:user"),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: status === "preparing" ? null : now,
        completedAt: terminal ? now : null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems:
      status === "completed"
        ? [
            {
              id: TurnItemId.make("turn-item:s1:assistant"),
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "assistant_message",
              messageId: MessageId.make("message:s1:assistant"),
              text: "Disposable task finished.",
              streaming: false,
            },
          ]
        : [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  };
}

const launchInput = {
  attemptId,
  requestId: ProgramAttemptRequestId.make("request:s1:launch"),
  projectId,
  title: "S1 disposable task",
  prompt: "Reply once, then stop.",
  checkout: {
    repositoryRoot: "/repo",
    gitCommonDir: "/repo/.git",
    worktreePath: "/repo-worktrees/prepared",
    branch: "prepared",
    startingCommit: "abc123",
  },
  providerPolicy: {
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
  },
};

function makeHarness() {
  return Effect.gen(function* () {
    const projection = yield* Ref.make(makeProjection("preparing"));
    const launch = vi.fn(() =>
      Ref.get(projection).pipe(
        Effect.map((current) => ({ threadId, projection: current, resumed: false })),
      ),
    );
    const interruptThread = vi.fn(
      (_input: ThreadManagementService.ThreadManagementInterruptInput) =>
        Effect.succeed({ type: "no_active_run" as const }),
    );
    const services = Layer.mergeAll(
      Layer.succeed(ThreadLaunchService.ThreadLaunchService, { launch }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadProjection: () => Ref.get(projection),
        interruptThread,
      }),
    );
    const layer = ProgramAttemptService.layer.pipe(
      Layer.provide(services),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );
    return { layer, projection, launch, interruptThread };
  });
}

it.effect("replays one launch and retains one terminal result until acknowledgement", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* Effect.gen(function* () {
      const attempts = yield* ProgramAttemptService.ProgramAttemptService;
      const first = yield* attempts.launch(launchInput);
      const replay = yield* attempts.launch(launchInput);
      assert.equal(first.threadId, threadId);
      assert.equal(first.runId, runId);
      assert.equal(replay.threadId, threadId);
      assert.equal(harness.launch.mock.calls.length, 2);

      yield* Ref.set(harness.projection, makeProjection("completed"));
      const terminal = yield* attempts.observe(attemptId);
      const terminalReplay = yield* attempts.observe(attemptId);
      assert.deepEqual(terminal.terminalResult, terminalReplay.terminalResult);
      assert.equal(terminal.terminalResult?.output, "Disposable task finished.");

      const acknowledged = yield* attempts.acknowledge({
        attemptId,
        requestId: ProgramAttemptRequestId.make("request:s1:ack"),
      });
      const acknowledgementReplay = yield* attempts.acknowledge({
        attemptId,
        requestId: ProgramAttemptRequestId.make("request:s1:ack"),
      });
      assert.isTrue(acknowledged.terminalAcknowledged);
      assert.isNull(acknowledged.terminalResult);
      assert.deepEqual(acknowledgementReplay, acknowledged);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("makes repeated cancellation harmless", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* Effect.gen(function* () {
      const attempts = yield* ProgramAttemptService.ProgramAttemptService;
      yield* attempts.launch(launchInput);
      yield* Ref.set(harness.projection, makeProjection("running"));
      const cancel = {
        attemptId,
        requestId: ProgramAttemptRequestId.make("request:s1:cancel"),
        reason: "operator stop",
      };
      yield* attempts.cancel(cancel);
      yield* attempts.cancel(cancel);
      assert.equal(harness.interruptThread.mock.calls.length, 2);
      assert.equal(
        harness.interruptThread.mock.calls[0]?.[0].commandId,
        `program-attempt:${attemptId}:cancel`,
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

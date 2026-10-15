import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { createOrchestrationV2TurnItemVisibility } from "@t3tools/shared/orchestrationV2Timeline";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerActivation from "../serverActivation.ts";
import {
  idleCompactionWindow,
  idleCompactionCandidate,
  PROMPT_CACHE_TTL_MS,
} from "./IdleCompaction.ts";
import * as IdleCompactionService from "./IdleCompactionService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { resolveAutoSettlementAt } from "./ThreadSettlementService.ts";

const NOW_MS = Date.parse("2026-10-14T12:00:00.000Z");
const MINUTE_MS = 60_000;
const at = (offset = 0) => DateTime.makeUnsafe(NOW_MS + offset);

function projection(): {
  -readonly [Key in keyof OrchestrationV2ThreadProjection]: OrchestrationV2ThreadProjection[Key];
} {
  const threadId = ThreadId.make("idle-thread");
  const runId = RunId.make("normal-run");
  const messageId = MessageId.make("normal-message");
  const providerThreadId = ProviderThreadId.make("provider-thread");
  const instanceId = ProviderInstanceId.make("custom-codex");
  const nodeId = NodeId.make("root-node");
  const modelSelection = { instanceId, model: "gpt-5.4" };
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Idle thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at(-MINUTE_MS),
      updatedAt: at(),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(),
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "completed",
        requestedAt: at(-MINUTE_MS),
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "Explain this code",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: at(-MINUTE_MS),
        updatedAt: at(-MINUTE_MS),
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: nodeId,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: { usedTokens: 20_000 },
        createdAt: at(-MINUTE_MS),
        updatedAt: at(),
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerTurns: [],
    runtimeRequests: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: at(),
  };
}

describe("idle compaction eligibility", () => {
  it("is opt-in and supports configured instances of each compacting driver", () => {
    expect(DEFAULT_SERVER_SETTINGS.compactIdleThreads).toBe(false);
    expect(idleCompactionCandidate(projection(), false, NOW_MS)).toBeNull();
    for (const driver of Object.keys(PROMPT_CACHE_TTL_MS)) {
      const value = projection();
      value.providerThreads = [
        { ...value.providerThreads[0]!, driver: ProviderDriverKind.make(driver) },
      ];
      expect(idleCompactionCandidate(value, true, NOW_MS)?.driver).toBe(driver);
    }
  });

  it("skips deleted, archived, settled, parked snoozes, and unsupported drivers", () => {
    for (const patch of [
      { deletedAt: at() },
      { archivedAt: at() },
      { settledOverride: "settled" as const },
      { settledAt: at() },
      { snoozedUntil: at(MINUTE_MS), snoozedAt: at() },
    ]) {
      const value = projection();
      value.thread = { ...value.thread, ...patch };
      expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    }
    const value = projection();
    value.providerThreads = [
      { ...value.providerThreads[0]!, driver: ProviderDriverKind.make("acpRegistry") },
    ];
    expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    value.providerThreads = projection().providerThreads;
    value.thread = {
      ...value.thread,
      snoozedUntil: at(MINUTE_MS),
      snoozedAt: at(-1),
      pinnedAt: at(),
      settledOverride: "active",
      autoSettleDisabledAt: at(),
    };
    expect(idleCompactionCandidate(value, true, NOW_MS)).not.toBeNull();
  });

  it("requires normal completion and skips every live or queued run", () => {
    for (const status of [
      "preparing",
      "queued",
      "starting",
      "running",
      "waiting",
      "failed",
      "interrupted",
      "cancelled",
      "rolled_back",
    ] as const) {
      const value = projection();
      value.runs = [{ ...value.runs[0]!, status }];
      expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    }
    for (const patch of [{ completedAt: null }, { idleCompactionOfRunId: RunId.make("earlier") }]) {
      const value = projection();
      value.runs = [{ ...value.runs[0]!, ...patch }];
      expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    }
    const value = projection();
    value.messages = [{ ...value.messages[0]!, text: "/compact" }];
    expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    value.messages = [{ ...value.messages[0]!, text: "new input", updatedAt: at(1) }];
    expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    value.messages = projection().messages;
    value.runs = [
      ...value.runs,
      { ...value.runs[0]!, id: RunId.make("held"), ordinal: 0, status: "queued", queueHeld: true },
    ];
    expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
  });

  it("skips pending requests and any background work, including a dev server", () => {
    const value = projection();
    value.runtimeRequests = [
      { status: "pending" } as OrchestrationV2ThreadProjection["runtimeRequests"][number],
    ];
    expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    value.runtimeRequests = [];
    for (const kind of ["subagent", "monitor", "background_task", "command"] as const) {
      value.providerThreads = [
        { ...value.providerThreads[0]!, pendingBackgroundTasks: [{ taskId: "work", kind }] },
      ];
      expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    }
  });

  it("requires measured occupancy, preferring current turn usage to cumulative accounting", () => {
    const value = projection();
    for (const usage of [null, { usedTokens: 19_999, totalProcessedTokens: 500_000 }]) {
      value.providerThreads = [{ ...value.providerThreads[0]!, contextUsage: usage }];
      expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    }
    value.providerTurns = [
      {
        id: ProviderTurnId.make("provider-turn"),
        providerThreadId: value.providerThreads[0]!.id,
        nodeId: NodeId.make("root-node"),
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        tokenUsage: { usedTokens: 20_000, updatedAt: DateTime.formatIso(at()) },
      },
    ];
    expect(idleCompactionCandidate(value, true, NOW_MS)).not.toBeNull();
    value.thread = {
      ...value.thread,
      providerInstanceId: ProviderInstanceId.make("different-instance"),
    };
    expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
  });
});

describe("idle compaction timing", () => {
  it("fires in the last 10% of each provider's cache TTL and supports the dev override", () => {
    expect(idleCompactionWindow(at(), ProviderDriverKind.make("claudeAgent"))).toEqual({
      startMs: NOW_MS + 54 * MINUTE_MS,
      endMs: NOW_MS + 60 * MINUTE_MS,
    });
    expect(idleCompactionWindow(at(), ProviderDriverKind.make("codex"))).toEqual({
      startMs: NOW_MS + 27 * MINUTE_MS,
      endMs: NOW_MS + 30 * MINUTE_MS,
    });
    expect(idleCompactionWindow(at(), ProviderDriverKind.make("future-driver"))).toEqual({
      startMs: NOW_MS + 27 * MINUTE_MS,
      endMs: NOW_MS + 30 * MINUTE_MS,
    });
    expect(idleCompactionWindow(at(), ProviderDriverKind.make("codex"), MINUTE_MS)).toEqual({
      startMs: NOW_MS + MINUTE_MS,
      endMs: NOW_MS + 4 * MINUTE_MS,
    });
  });
});

const layerDatabase = SqlitePersistence.layerMemory;
const layerProjections = ProjectionStore.layer.pipe(Layer.provide(layerDatabase));

const seed = Effect.fn("seedIdleCompactionThread")(function* (
  value: OrchestrationV2ThreadProjection,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make("thread-created"),
    type: "thread.created",
    threadId: value.thread.id,
    occurredAt: at(),
    payload: value.thread,
  });
  yield* store.apply({
    id: EventId.make("run.created"),
    type: "run.created",
    threadId: value.thread.id,
    occurredAt: at(),
    payload: value.runs[0]!,
  });
  yield* store.apply({
    id: EventId.make("message.updated"),
    type: "message.updated",
    threadId: value.thread.id,
    occurredAt: at(),
    payload: value.messages[0]!,
  });
  yield* store.apply({
    id: EventId.make("provider-thread.updated"),
    type: "provider-thread.updated",
    threadId: value.thread.id,
    occurredAt: at(),
    payload: value.providerThreads[0]!,
  });
});

it.effect.each([null, "fork", "subagent"] as const)(
  "keeps SQL and memory eligibility aligned for %s children",
  (relationshipToParent) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const value = projection();
      value.thread = {
        ...value.thread,
        lineage: {
          rootThreadId: ThreadId.make("root-thread"),
          parentThreadId: relationshipToParent === null ? null : ThreadId.make("parent-thread"),
          relationshipToParent,
        },
      };
      yield* seed(value);
      const persisted = yield* store.getThreadProjection(value.thread.id);
      const candidate = idleCompactionCandidate(persisted, true, NOW_MS);
      expect(candidate !== null).toBe(relationshipToParent !== "subagent");
      expect(yield* store.getIdleCompactionCandidates({ completedAfter: at(-MINUTE_MS) })).toEqual(
        candidate === null ? [] : [candidate],
      );
    }).pipe(Effect.provide(layerProjections)),
);

it.effect("keeps the prior activity anchor and hides the system prompt after idle compaction", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const value = projection();
    yield* seed(value);
    expect(
      (yield* store.getIdleCompactionCandidates({ completedAfter: at(-MINUTE_MS) }))[0]?.runId,
    ).toBe(value.runs[0]!.id);
    const finished = {
      ...value.runs[0]!,
      id: RunId.make("idle-compaction"),
      ordinal: 2,
      userMessageId: MessageId.make("idle-prompt"),
      idleCompactionOfRunId: value.runs[0]!.id,
      requestedAt: at(MINUTE_MS),
      startedAt: at(MINUTE_MS),
      completedAt: at(2 * MINUTE_MS),
    };
    const prompt = {
      ...value.messages[0]!,
      id: finished.userMessageId,
      runId: finished.id,
      createdBy: "system" as const,
      creationSource: "server" as const,
      text: "/compact",
      createdAt: at(MINUTE_MS),
      updatedAt: at(MINUTE_MS),
    };
    yield* store.apply({
      id: EventId.make("idle-run"),
      type: "run.created",
      threadId: value.thread.id,
      occurredAt: at(MINUTE_MS),
      payload: finished,
    });
    yield* store.apply({
      id: EventId.make("idle-message"),
      type: "message.updated",
      threadId: value.thread.id,
      occurredAt: at(MINUTE_MS),
      payload: prompt,
    });
    expect(yield* store.getIdleCompactionCandidates({ completedAfter: at(-MINUTE_MS) })).toEqual(
      [],
    );
    const shell = (yield* store.getThreadShell(value.thread.id))!;
    const memoryShell = ProjectionStore.threadShellFromProjection(
      yield* store.getThreadProjection(value.thread.id),
    );
    for (const result of [shell, memoryShell]) {
      expect(result.latestRunId).toBe(value.runs[0]!.id);
      expect(result.latestRunCompletedAt).toEqual(at());
      expect(result.latestUserMessageAt).toEqual(at(-MINUTE_MS));
      expect(result.latestUserAuthoredMessageAt).toEqual(at(-MINUTE_MS));
    }
    const settlement = (yield* store.getSettlementCandidates())[0]!;
    expect(
      resolveAutoSettlementAt({
        thread: settlement,
        pullRequest: null,
        nowMs: NOW_MS + 3 * 86_400_000 + 1,
        autoSettleAfterDays: 3,
        autoSettleOnMerge: false,
      }),
    ).toEqual(at());
    const item = {
      type: "user_message" as const,
      runId: finished.id,
      nodeId: null,
      inputIntent: "turn_start" as const,
    };
    expect(
      createOrchestrationV2TurnItemVisibility({
        runs: [value.runs[0]!, finished],
        attempts: [],
        items: [item],
      })(item),
    ).toBe(false);
    for (const status of [
      "preparing",
      "starting",
      "running",
      "waiting",
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "rolled_back",
    ] as const) {
      yield* store.apply({
        id: EventId.make(`idle-${status}`),
        type: "run.updated",
        threadId: value.thread.id,
        occurredAt: at(2 * MINUTE_MS),
        payload: {
          ...finished,
          status,
          completedAt: ["preparing", "starting", "running", "waiting"].includes(status)
            ? null
            : finished.completedAt,
        },
      });
      const persisted = (yield* store.getThreadShell(value.thread.id))!;
      const derived = ProjectionStore.threadShellFromProjection(
        yield* store.getThreadProjection(value.thread.id),
      );
      for (const result of [persisted, derived]) {
        expect(result.status).toBe("completed");
        expect(result.latestRunId).toBe(value.runs[0]!.id);
        expect(result.latestRunCompletedAt).toEqual(at());
        expect(result.activityRunStatus).toBeNull();
        expect(result.activityRunStartedAt).toBeNull();
        expect(result.activeRunId).toBeNull();
      }
    }
  }).pipe(Effect.provide(layerProjections)),
);

it.effect("scans at the deadline and dispatches the system maintenance command once", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);
    const commands = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    const activation = yield* Deferred.make<void>();
    const candidateReads = yield* Queue.unbounded<void>();
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const value = projection();
    const settings = yield* Ref.make({
      ...DEFAULT_SERVER_SETTINGS,
      compactIdleThreads: true,
      providerInstances: {
        [value.thread.providerInstanceId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
      projectSettingsOverrides: {
        [value.thread.projectId]: {
          providerInstances: { [value.thread.providerInstanceId]: { enabled: false } },
        },
      },
    });
    const dependencies = Layer.mergeAll(
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        ...store,
        getIdleCompactionCandidates: (input) =>
          store
            .getIdleCompactionCandidates(input)
            .pipe(Effect.tap(() => Queue.offer(candidateReads, undefined))),
      }),
      Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
      Layer.effect(
        ServerConfig.ServerConfig,
        ServerConfig.ServerConfig.pipe(
          Effect.map((config) => ({ ...config, idleCompactionDelayMs: MINUTE_MS })),
        ),
      ).pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-idle-compaction-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: () =>
          Effect.succeed({
            enabled: true,
            driverKind: ProviderDriverKind.make("codex"),
          } as ProviderInstance),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Ref.get(settings),
        subscribeChanges: Effect.succeed(Stream.empty),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.empty,
        dispatch: (command) =>
          Queue.offer(commands, command).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
      }),
    );
    yield* Effect.gen(function* () {
      yield* seed(value);
      const service = yield* IdleCompactionService.make;
      yield* service.start();
      yield* Deferred.succeed(activation, undefined);
      yield* Queue.take(candidateReads);
      yield* service.drain;
      expect(yield* Queue.size(commands)).toBe(0);
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(candidateReads);
      yield* service.drain;
      expect(yield* Queue.size(commands)).toBe(0);
      yield* Ref.update(settings, (current) => ({ ...current, projectSettingsOverrides: {} }));
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(candidateReads);
      const command = yield* Queue.take(commands);
      expect(command).toMatchObject({
        type: "message.dispatch",
        text: "/compact",
        createdBy: "system",
        creationSource: "server",
        idleCompactionOfRunId: value.runs[0]!.id,
        dispatchMode: { type: "start_immediately" },
      });
      yield* service.drain;
      // The real dispatcher persists this marker before the next sweep; prove
      // the same persisted candidate cannot compact itself after completion.
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* store.apply({
        id: EventId.make("idle-finished"),
        type: "run.created",
        threadId: value.thread.id,
        occurredAt: at(MINUTE_MS),
        payload: {
          ...value.runs[0]!,
          id: RunId.make("compacted"),
          ordinal: 2,
          idleCompactionOfRunId: value.runs[0]!.id,
        },
      });
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(candidateReads);
      yield* service.drain;
      expect(yield* Queue.size(commands)).toBe(0);
    }).pipe(Effect.provide(dependencies));
  }).pipe(Effect.provide(layerProjections), Effect.scoped),
);

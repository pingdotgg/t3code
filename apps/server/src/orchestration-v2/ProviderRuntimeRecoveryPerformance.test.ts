import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";

// Startup recovery cost for restart continuation. The default case is small
// enough for CI and asserts correctness; T3_BENCH_RECOVERY=1 adds the matrix.
// `it.live` keeps a real clock: each reconcile gets a fresh command id, so the
// second recover cannot hide behind command receipt dedup.

const layerStores = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  IdAllocator.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const layerTest = ProviderRuntimeRecovery.layer.pipe(
  Layer.provideMerge(EventSink.layer.pipe(Layer.provideMerge(layerStores))),
  Layer.provideMerge(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const projectId = ProjectId.make("project:recovery-bench");
const ITEMS_PER_SETTLED_THREAD = 10;
const OPEN_ITEMS_PER_ACTIVE_THREAD = 3;
const WAITING_THREADS = 3;
const SEED_BATCH = 500;

type UnstampedEvent = OrchestrationV2DomainEvent extends infer Event
  ? Event extends OrchestrationV2DomainEvent
    ? Omit<Event, "id" | "occurredAt">
    : never
  : never;

interface Scenario {
  readonly settled: number;
  readonly active: number;
}

interface Seeded {
  readonly unheldQueuedThreads: number;
  readonly waitingThreads: number;
}

const seedScenario = Effect.fn(function* (scenario: Scenario) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  let eventIndex = 0;
  const apply = (event: UnstampedEvent) =>
    projections.apply({
      ...event,
      id: EventId.make(`event:bench:${eventIndex++}`),
      occurredAt: now,
    } as OrchestrationV2DomainEvent);

  const thread = (id: ThreadId, overrides: Partial<OrchestrationV2AppThread> = {}) =>
    apply({
      type: "thread.created",
      threadId: id,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id,
        projectId,
        title: id,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
        ...overrides,
      },
    });

  const run = (
    threadId: ThreadId,
    ordinal: number,
    status: OrchestrationV2Run["status"],
    overrides: Partial<OrchestrationV2Run> = {},
  ) => {
    const runId = RunId.make(`run:${threadId}:${ordinal}`);
    return apply({
      type: "run.created",
      threadId,
      runId,
      payload: {
        id: runId,
        threadId,
        ordinal,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`message:${runId}`),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: status === "queued" ? null : now,
        completedAt: status === "completed" ? now : null,
        checkpointId: null,
        contextHandoffId: null,
        ...overrides,
      },
    }).pipe(Effect.as(runId));
  };

  const commandItem = (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly ordinal: number;
    readonly status: "running" | "completed";
    readonly nodeId?: NodeId;
    readonly providerThreadId?: ProviderThreadId;
    readonly providerTurnId?: ProviderTurnId;
  }) =>
    apply({
      type: "turn-item.updated",
      threadId: input.threadId,
      runId: input.runId,
      payload: {
        id: TurnItemId.make(`item:${input.runId}:${input.ordinal}`),
        threadId: input.threadId,
        runId: input.runId,
        nodeId: input.nodeId ?? null,
        providerThreadId: input.providerThreadId ?? null,
        providerTurnId: input.providerTurnId ?? null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: input.ordinal,
        type: "command_execution",
        status: input.status,
        title: `Command ${input.ordinal}`,
        input: `echo ${input.ordinal}`,
        output: input.status === "completed" ? `${input.ordinal}\n` : "",
        ...(input.status === "completed" ? { exitCode: 0 } : {}),
        startedAt: now,
        completedAt: input.status === "completed" ? now : null,
        updatedAt: now,
      },
    });

  const settledThread = Effect.fn(function* (index: number) {
    const threadId = ThreadId.make(`thread:bench:settled:${index}`);
    yield* thread(threadId);
    const runId = yield* run(threadId, 1, "completed");
    for (let ordinal = 1; ordinal <= ITEMS_PER_SETTLED_THREAD; ordinal += 1) {
      yield* commandItem({ threadId, runId, ordinal, status: "completed" });
    }
    // ~5% of threads carry a queued follow-up; half are already held, and an
    // earlier recovery already handled those, so only unheld ones are candidates.
    if (index % 20 === 0) {
      const queueHeld = index % 40 === 0;
      yield* run(threadId, 2, "queued", { queueHeld });
      return !queueHeld;
    }
    return false;
  });

  const activeThread = Effect.fn(function* (index: number) {
    const threadId = ThreadId.make(`thread:bench:active:${index}`);
    const providerSessionId = ProviderSessionId.make(`session:bench:${index}`);
    const providerThreadId = ProviderThreadId.make(`provider-thread:bench:${index}`);
    const runId = RunId.make(`run:${threadId}:1`);
    const attemptId = RunAttemptId.make(`attempt:bench:${index}`);
    const nodeId = NodeId.make(`node:bench:${index}`);
    const providerTurnId = ProviderTurnId.make(`provider-turn:bench:${index}`);
    yield* thread(threadId, { activeProviderThreadId: providerThreadId });
    yield* apply({
      type: "provider-session.attached",
      threadId,
      driver,
      providerInstanceId,
      payload: {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "ready",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    yield* apply({
      type: "provider-thread.updated",
      threadId,
      driver,
      providerInstanceId,
      payload: {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId,
        nativeThreadRef: { driver, nativeId: `native:bench:${index}`, strength: "strong" },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [],
      },
    });
    yield* run(threadId, 1, "running", {
      providerThreadId,
      rootNodeId: nodeId,
      activeAttemptId: attemptId,
    });
    yield* apply({
      type: "run-attempt.created",
      threadId,
      runId,
      payload: {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId,
        reason: "initial",
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });
    yield* apply({
      type: "node.updated",
      threadId,
      runId,
      nodeId,
      providerInstanceId,
      payload: {
        id: nodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "root_turn",
        status: "running",
        countsForRun: true,
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    });
    yield* apply({
      type: "provider-turn.updated",
      threadId,
      runId,
      nodeId,
      providerInstanceId,
      payload: {
        id: providerTurnId,
        providerThreadId,
        nodeId,
        runAttemptId: attemptId,
        nativeTurnRef: { driver, nativeId: `native-turn:bench:${index}`, strength: "strong" },
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });
    for (let ordinal = 1; ordinal <= OPEN_ITEMS_PER_ACTIVE_THREAD; ordinal += 1) {
      yield* commandItem({
        threadId,
        runId,
        ordinal,
        status: "running",
        nodeId,
        providerThreadId,
        providerTurnId,
      });
    }
  });

  const waitingThread = Effect.fn(function* (index: number) {
    const threadId = ThreadId.make(`thread:bench:waiting:${index}`);
    yield* thread(threadId);
    yield* run(threadId, 1, "completed");
    const runId = yield* run(threadId, 2, "waiting");
    yield* outbox.enqueue([
      {
        id: `effect:bench:checkpoint:${runId}`,
        commandId: CommandId.make(`command:effect:checkpoint.capture:${runId}`),
        threadId,
        request: {
          type: "checkpoint.capture",
          runId,
          scopeId: CheckpointScopeId.make(`scope:bench:${index}`),
        },
      },
    ]);
  });

  let unheldQueuedThreads = 0;
  for (let start = 0; start < scenario.settled; start += SEED_BATCH) {
    const end = Math.min(scenario.settled, start + SEED_BATCH);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (let index = start; index < end; index += 1) {
          if (yield* settledThread(index)) unheldQueuedThreads += 1;
        }
      }),
    );
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (let index = 0; index < scenario.active; index += 1) yield* activeThread(index);
      for (let index = 0; index < WAITING_THREADS; index += 1) yield* waitingThread(index);
    }),
  );
  return { unheldQueuedThreads, waitingThreads: WAITING_THREADS } satisfies Seeded;
});

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const start = performance.now();
    const value = yield* effect;
    return [value, performance.now() - start] as const;
  });

const continuationEffectCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox
    WHERE effect_id LIKE 'effect:restart-continuation:%' AND status = 'pending'
  `;
  return Number(rows[0]?.count ?? 0);
});

interface Measurement {
  readonly settled: number;
  readonly active: number;
  readonly seedMs: number;
  readonly candidates: number;
  readonly selectMs: number;
  readonly prepareMs: number;
  readonly shutdownMs: number;
  readonly startupAfterShutdownMs: number;
  readonly crashRecoverMs: number;
  readonly secondRecoverMs: number;
}

/** A graceful restart: prepare intent, reconcile on shutdown, recover on boot. */
const measureGraceful = Effect.fn(function* (scenario: Scenario) {
  const [seeded, seedMs] = yield* timed(seedScenario(scenario));
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
  const [candidates, selectMs] = yield* timed(projections.getRecoveryThreadIds("runtime"));
  assert.equal(
    candidates.length,
    scenario.active + seeded.unheldQueuedThreads + seeded.waitingThreads,
    "runtime recovery candidates",
  );
  const [, prepareMs] = yield* timed(recovery.prepareForShutdown);
  assert.equal(yield* continuationEffectCount, scenario.active, "prepared continuations");
  const [, shutdownMs] = yield* timed(recovery.reconcile("shutdown"));
  const [, startupAfterShutdownMs] = yield* timed(recovery.recover);
  assert.equal(yield* continuationEffectCount, scenario.active, "continuations after boot");
  return {
    seedMs,
    candidates: candidates.length,
    selectMs,
    prepareMs,
    shutdownMs,
    startupAfterShutdownMs,
  };
});

/** A crash: no shutdown hook ran, so boot recovery records the continuations. */
const measureCrash = Effect.fn(function* (scenario: Scenario) {
  yield* seedScenario(scenario);
  const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
  const [summary, crashRecoverMs] = yield* timed(recovery.recover);
  assert.equal(summary.terminalizedRuns, scenario.active, "terminalized active runs");
  assert.equal(summary.stoppedSessions, scenario.active, "stopped active sessions");
  assert.equal(yield* continuationEffectCount, scenario.active, "recorded continuations");
  const [, secondRecoverMs] = yield* timed(recovery.recover);
  assert.equal(yield* continuationEffectCount, scenario.active, "second recover is idempotent");
  return { crashRecoverMs, secondRecoverMs };
});

const measure = Effect.fn(function* (scenario: Scenario) {
  const graceful = yield* measureGraceful(scenario).pipe(Effect.provide(Layer.fresh(layerTest)));
  const crash = yield* measureCrash(scenario).pipe(Effect.provide(Layer.fresh(layerTest)));
  return { ...scenario, ...graceful, ...crash } satisfies Measurement;
});

const formatTable = (rows: ReadonlyArray<Measurement>) => {
  const ms = (value: number) => value.toFixed(1);
  const perActive = (value: number, active: number) => (value / Math.max(active, 1)).toFixed(2);
  const header = [
    "N",
    "A",
    "seed",
    "cand",
    "select",
    "prepare",
    "prep/A",
    "shutdown",
    "boot-after",
    "crash-recover",
    "recover/A",
    "recover-2",
  ];
  const lines = rows.map((row) => [
    String(row.settled),
    String(row.active),
    ms(row.seedMs),
    String(row.candidates),
    ms(row.selectMs),
    ms(row.prepareMs),
    perActive(row.prepareMs, row.active),
    ms(row.shutdownMs),
    ms(row.startupAfterShutdownMs),
    ms(row.crashRecoverMs),
    perActive(row.crashRecoverMs, row.active),
    ms(row.secondRecoverMs),
  ]);
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...lines.map((line) => line[column]!.length)),
  );
  return [header, ...lines]
    .map((line) => line.map((cell, column) => cell.padStart(widths[column]!)).join("  "))
    .join("\n");
};

it.live(
  "restart recovery records one continuation per active thread and is idempotent",
  () =>
    Effect.gen(function* () {
      const row = yield* measure({ settled: 500, active: 20 });
      yield* Console.log(`provider runtime recovery (ms)\n${formatTable([row])}`);
    }),
  60_000,
);

it.live.skipIf(process.env.T3_BENCH_RECOVERY !== "1")(
  "restart recovery scales with active threads, not settled history",
  () =>
    Effect.gen(function* () {
      const rows: Array<Measurement> = [];
      for (const settled of [5_000, 50_000]) {
        for (const active of [10, 100, 1_000]) {
          rows.push(yield* measure({ settled, active }));
          yield* Console.log(`provider runtime recovery (ms)\n${formatTable(rows)}`);
        }
      }
    }),
  3_600_000,
);

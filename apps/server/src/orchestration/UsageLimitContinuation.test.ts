import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeTurnCompletedEvent,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { readPendingUsageLimitContinuation } from "../provider/usageLimitContinuation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";
import * as UsageLimitContinuation from "./UsageLimitContinuation.ts";

const NOW = "2026-09-18T00:00:00.000Z";
const RESET = "2026-09-18T01:00:00.000Z";
const instanceId = ProviderInstanceId.make("codex");
const firstId = ThreadId.make("first");
const modelSelection = { instanceId, model: "gpt-5.4" };
const errorMessage = "Usage limit reached";

const testLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
  ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntime.layer)),
).pipe(
  Layer.provideMerge(ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer))),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-usage-limit-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const available = (checkedAt: string): ServerProviderUsageLimits => ({
  checkedAt,
  windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 10 }],
});
const provider = (usageLimits: ServerProviderUsageLimits): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: usageLimits.checkedAt,
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits,
});

const makeHarness = Effect.fn("makeUsageLimitHarness")(function* () {
  yield* TestClock.setTime(Date.parse(NOW));
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory;
  const settings = yield* ServerSettings.ServerSettingsService;
  const probes = yield* Queue.unbounded<ProviderInstanceId>();
  const probeFibers = yield* Queue.unbounded<Fiber.Fiber<unknown, unknown>>();
  const responses = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
  let sequence = 0;
  const commandId = () => CommandId.make(`command-${++sequence}`);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const read = (id = firstId) =>
    snapshots
      .getSnapshot()
      .pipe(Effect.map((snapshot) => snapshot.threads.find((thread) => thread.id === id)!));
  const pending = (id = firstId) =>
    directory
      .getBinding(id)
      .pipe(
        Effect.map((binding) =>
          readPendingUsageLimitContinuation(Option.getOrThrow(binding).runtimePayload),
        ),
      );
  const projectId = ProjectId.make("project");
  yield* engine.dispatch({
    type: "project.create",
    commandId: commandId(),
    projectId,
    title: "Project",
    workspaceRoot: "/tmp/usage-limit-project",
    createdAt: NOW,
  });
  const create = Effect.fnUntraced(function* (id = firstId, account = instanceId) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: commandId(),
      threadId: id,
      projectId,
      title: "Thread",
      modelSelection: { ...modelSelection, instanceId: account },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
    });
    yield* directory.upsert({
      threadId: id,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: account,
      resumeCursor: { threadId: `provider-${id}` },
    });
  });
  const fail = Effect.fnUntraced(function* (id = firstId, retryAt?: string) {
    const thread = yield* read(id);
    const turnId = TurnId.make(`turn-${++sequence}`);
    const createdAt = yield* now;
    const session = {
      threadId: id,
      providerName: "codex",
      providerInstanceId: thread.modelSelection.instanceId,
      runtimeMode: "full-access" as const,
      updatedAt: createdAt,
    };
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: commandId(),
      threadId: id,
      createdAt,
      session: { ...session, status: "running", activeTurnId: turnId, lastError: null },
    });
    const snapshotSequence = yield* engine.latestSequence;
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: commandId(),
      threadId: id,
      createdAt,
      session: { ...session, status: "error", activeTurnId: null, lastError: errorMessage },
    });
    const event: ProviderRuntimeTurnCompletedEvent = {
      type: "turn.completed",
      eventId: EventId.make(`failure-${turnId}`),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: session.providerInstanceId,
      threadId: id,
      turnId,
      createdAt,
      payload: { state: "failed", errorMessage, usageLimit: retryAt ? { retryAt } : {} },
    };
    return { event, snapshotSequence };
  });
  const start = Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const service = yield* UsageLimitContinuation.make.pipe(
      Effect.provide(
        Layer.mock(ProviderRegistry)({
          refreshInstance: (id) =>
            Effect.withFiber((fiber) =>
              Queue.offer(probeFibers, fiber).pipe(
                Effect.andThen(Queue.offer(probes, id)),
                Effect.andThen(Queue.take(responses)),
              ),
            ),
        }),
      ),
      Scope.provide(scope),
    );
    yield* service.start().pipe(Scope.provide(scope));
    yield* TestClock.adjust(0);
    yield* service.drain;
    return { ...service, stop: Scope.close(scope, Exit.void) };
  });
  yield* create();
  yield* settings.updateSettings({
    continueThreadsAfterUsageLimit: true,
    usageLimitContinuationPrompt: "Carry on with the remaining work",
  });
  return {
    engine,
    settings,
    directory,
    commandId,
    read,
    pending,
    now,
    create,
    fail,
    start,
    probes,
    probeFibers,
    responses,
  };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;
type Service = UsageLimitContinuation.UsageLimitContinuation["Service"];
const record = Effect.fnUntraced(function* (
  h: Harness,
  service: Service,
  id = firstId,
  retryAt?: string,
) {
  const failure = yield* h.fail(id, retryAt);
  yield* service.recordFailure(failure.event, failure.snapshotSequence);
  yield* service.drain;
  return failure;
});
const respond = Effect.fnUntraced(function* (
  h: Harness,
  service: Service,
  limits?: ReadonlyArray<ServerProvider>,
) {
  const probeFiber = yield* Queue.take(h.probeFibers);
  yield* Queue.offer(h.responses, limits ?? [provider(available(yield* h.now))]);
  expect(Exit.isSuccess(yield* Fiber.await(probeFiber))).toBe(true);
  yield* service.drain;
});

it.effect("waits for reset, coalesces account probes, and appends the current prompt once", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const secondId = ThreadId.make("second");
    yield* h.create(secondId);
    const service = yield* h.start;
    const failure = yield* record(h, service, firstId, RESET);
    yield* service.recordFailure(failure.event, failure.snapshotSequence);
    yield* record(h, service, secondId, RESET);
    yield* h.settings.updateSettings({ usageLimitContinuationPrompt: "Finish the remaining work" });
    yield* TestClock.adjust("1 hour");
    expect(yield* Queue.size(h.probes)).toBe(0);
    expect((yield* h.read()).messages).toEqual([]);
    yield* TestClock.adjust("1 second");
    expect(yield* Queue.take(h.probes)).toBe(instanceId);
    yield* h.engine.dispatch({
      type: "thread.meta.update",
      commandId: h.commandId(),
      threadId: secondId,
      title: "Renamed while waiting",
    });
    yield* h.engine.dispatch({
      type: "thread.activity.append",
      commandId: h.commandId(),
      threadId: firstId,
      activity: {
        id: EventId.make("checkpoint"),
        kind: "checkpoint.completed",
        tone: "info",
        summary: "Checkpoint saved",
        payload: null,
        createdAt: RESET,
        turnId: TurnId.make(failure.event.turnId!),
      },
      createdAt: RESET,
    });
    yield* respond(h, service);
    for (const id of [firstId, secondId]) {
      expect((yield* h.read(id)).messages).toMatchObject([
        { role: "user", text: "Finish the remaining work", attachments: [] },
      ]);
      expect(yield* h.pending(id)).toBeUndefined();
    }
    yield* service.recordFailure(failure.event, failure.snapshotSequence);
    yield* service.drain;
    yield* TestClock.adjust("5 minutes");
    expect((yield* h.read()).messages).toHaveLength(1);
    expect(yield* Queue.size(h.probes)).toBe(0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not opt an old failure in when the setting is enabled later", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.settings.updateSettings({ continueThreadsAfterUsageLimit: false });
    const service = yield* h.start;
    const failure = yield* record(h, service);
    yield* h.settings.updateSettings({ continueThreadsAfterUsageLimit: true });
    yield* service.recordFailure(failure.event, failure.snapshotSequence);
    yield* service.drain;
    yield* TestClock.adjust("2 hours");
    expect(yield* h.pending()).toBeUndefined();
    expect((yield* h.read()).messages).toEqual([]);
    expect(yield* Queue.size(h.probes)).toBe(0);
  }).pipe(Effect.provide(testLayer)),
);

const appendThreadActivity = Effect.fnUntraced(function* (h: Harness) {
  for (let index = 0; index < 1_000; index++) {
    yield* h.engine.dispatch({
      type: "thread.meta.update",
      commandId: h.commandId(),
      threadId: firstId,
      title: `Thread ${index}`,
    });
  }
});

it.effect("retries a failure after its pending continuation could not be persisted", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const sql = yield* SqlClient.SqlClient;
    const service = yield* h.start;
    yield* sql`CREATE TEMP TRIGGER reject_usage_wait
      BEFORE UPDATE OF runtime_payload_json ON provider_session_runtime
      BEGIN SELECT RAISE(FAIL, 'temporary write failure'); END`;
    const failure = yield* record(h, service, firstId, RESET);
    expect(yield* h.pending()).toBeUndefined();
    yield* sql`DROP TRIGGER reject_usage_wait`;
    yield* service.recordFailure(failure.event, failure.snapshotSequence);
    yield* service.drain;
    expect((yield* h.pending())?.failedTurnId).toBe(failure.event.turnId);
    yield* TestClock.adjust("3601 seconds");
    yield* Queue.take(h.probes);
    yield* respond(h, service);
    expect((yield* h.read()).messages).toHaveLength(1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("honors a stop after more than 1,000 events before the worker records the failure", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const service = yield* h.start;
    const failure = yield* h.fail(firstId, RESET);
    yield* appendThreadActivity(h);
    yield* h.engine.dispatch({
      type: "thread.turn.interrupt",
      commandId: h.commandId(),
      threadId: firstId,
      createdAt: NOW,
    });
    yield* service.recordFailure(failure.event, failure.snapshotSequence);
    yield* service.drain;
    yield* TestClock.adjust("2 hours");
    expect(yield* h.pending()).toBeUndefined();
    expect((yield* h.read()).messages).toEqual([]);
    expect(yield* Queue.size(h.probes)).toBe(0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  "thread.turn.interrupt",
  "thread.session.stop",
  "thread.archive",
  "disable",
  "provider-change",
] as const)(
  "%s cancels an outstanding probe and cannot be undone by replaying the failure",
  (action) =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const service = yield* h.start;
      const failure = yield* record(h, service);
      expect((yield* h.read()).session?.lastError).toContain("Automatic continuation");
      yield* TestClock.adjust(0);
      yield* Queue.take(h.probes);
      if (action === "disable") {
        yield* h.settings.updateSettings({ continueThreadsAfterUsageLimit: false });
      } else if (action === "provider-change") {
        yield* h.engine.dispatch({
          type: "thread.meta.update",
          commandId: h.commandId(),
          threadId: firstId,
          modelSelection: { ...modelSelection, instanceId: ProviderInstanceId.make("other") },
        });
      } else {
        yield* h.engine.dispatch({
          type: action,
          commandId: h.commandId(),
          threadId: firstId,
          createdAt: NOW,
        });
      }
      yield* TestClock.adjust(0);
      yield* service.drain;
      expect(yield* h.pending()).toBeUndefined();
      expect((yield* h.read()).session?.lastError).toBe(errorMessage);
      yield* h.settings.updateSettings({ continueThreadsAfterUsageLimit: true });
      yield* respond(h, service);
      yield* service.recordFailure(failure.event, failure.snapshotSequence);
      yield* service.drain;
      yield* TestClock.adjust("2 hours");
      expect((yield* h.read()).messages).toEqual([]);
      expect(yield* Queue.size(h.probes)).toBe(0);
      expect((yield* h.settings.getSettings).usageLimitContinuationPrompt).toBe(
        "Carry on with the remaining work",
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "recovers the stored wait across worker restarts, including an idle session closing",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const first = yield* h.start;
      yield* record(h, first, firstId, RESET);
      const stored = yield* h.pending();
      yield* first.stop;
      const session = (yield* h.read()).session!;
      yield* h.engine.dispatch({
        type: "thread.session.set",
        commandId: h.commandId(),
        threadId: firstId,
        createdAt: NOW,
        session: { ...session, status: "stopped", updatedAt: "2026-09-18T00:01:00.000Z" },
      });
      const second = yield* h.start;
      yield* TestClock.adjust("59 minutes");
      expect(yield* Queue.size(h.probes)).toBe(0);
      expect(yield* h.pending()).toEqual(stored);
      yield* second.stop;
      yield* TestClock.adjust("2 hours");
      const third = yield* h.start;
      yield* Queue.take(h.probes);
      yield* respond(h, third);
      expect((yield* h.read()).messages).toHaveLength(1);
      expect(yield* h.pending()).toBeUndefined();
      expect(Option.getOrThrow(yield* h.directory.getBinding(firstId)).resumeCursor).toEqual({
        threadId: "provider-first",
      });
    }).pipe(Effect.provide(testLayer)),
);

for (const [name, quota] of [
  ["stale", provider(available("2026-09-17T23:59:59.000Z"))],
  ["failed", provider({ checkedAt: NOW, windows: [], unavailable: { reason: "probeFailed" } })],
  [
    "another account's",
    { ...provider(available(NOW)), instanceId: ProviderInstanceId.make("other") },
  ],
] as const) {
  it.effect(`retries ${name} quota without continuing prematurely`, () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const service = yield* h.start;
      yield* record(h, service);
      yield* TestClock.adjust(0);
      yield* Queue.take(h.probes);
      yield* respond(h, service, [quota]);
      expect((yield* h.read()).messages).toEqual([]);
      expect((yield* h.pending())?.nextCheckAt).toBe("2026-09-18T00:05:00.000Z");
      yield* TestClock.adjust("4 minutes");
      expect(yield* Queue.size(h.probes)).toBe(0);
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(h.probes);
      yield* respond(h, service);
      expect((yield* h.read()).messages).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );
}

it.effect("waits for a new reset when the provider still reports exhausted usage", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const service = yield* h.start;
    yield* record(h, service);
    yield* TestClock.adjust(0);
    yield* Queue.take(h.probes);
    yield* respond(h, service, [
      provider({
        checkedAt: NOW,
        windows: [
          { id: "session", kind: "session", label: "Session", usedPercent: 100, resetsAt: RESET },
        ],
      }),
    ]);
    expect((yield* h.pending())?.nextCheckAt).toBe("2026-09-18T01:00:01.000Z");
    yield* TestClock.adjust("1 hour");
    expect((yield* h.read()).messages).toEqual([]);
    expect(yield* Queue.size(h.probes)).toBe(0);
    yield* TestClock.adjust("1 second");
    yield* Queue.take(h.probes);
    yield* respond(h, service);
    expect((yield* h.read()).messages).toHaveLength(1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("backs off when the automatic continuation itself exhausts quota", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const service = yield* h.start;
    yield* record(h, service);
    yield* TestClock.adjust(0);
    yield* Queue.take(h.probes);
    yield* respond(h, service);
    yield* record(h, service);
    yield* TestClock.adjust("4 minutes");
    expect((yield* h.read()).messages).toHaveLength(1);
    expect(yield* Queue.size(h.probes)).toBe(0);
    yield* TestClock.adjust("1 minute");
    yield* Queue.take(h.probes);
    yield* respond(h, service);
    expect((yield* h.read()).messages).toHaveLength(2);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("restores the error and stops retrying an unsupported usage probe", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const service = yield* h.start;
    yield* record(h, service);
    yield* TestClock.adjust(0);
    yield* Queue.take(h.probes);
    yield* respond(h, service, [
      provider({ checkedAt: NOW, windows: [], unavailable: { reason: "unsupported" } }),
    ]);
    yield* TestClock.adjust("10 minutes");
    expect(yield* h.pending()).toBeUndefined();
    expect((yield* h.read()).session?.lastError).toBe(errorMessage);
    expect((yield* h.read()).messages).toEqual([]);
    expect(yield* Queue.size(h.probes)).toBe(0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["stop", "disable", "new-turn"] as const)(
  "rejects a continuation already queued at command admission after %s",
  (action) =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const { event, snapshotSequence } = yield* h.fail();
      const session = (yield* h.read()).session!;
      const expectedUsageLimit = {
        turnId: TurnId.make(event.turnId!),
        providerInstanceId: instanceId,
        sessionUpdatedAt: session.updatedAt,
        snapshotSequence,
      };
      if (action === "disable") {
        yield* h.settings.updateSettings({ continueThreadsAfterUsageLimit: false });
      } else if (action === "stop") {
        yield* appendThreadActivity(h);
        yield* h.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: h.commandId(),
          threadId: firstId,
          createdAt: NOW,
        });
      } else {
        yield* h.fail();
        expectedUsageLimit.snapshotSequence = yield* h.engine.latestSequence;
      }
      const before = yield* h.engine.latestSequence;
      const error = yield* h.engine
        .dispatch({
          type: "thread.turn.start",
          commandId: h.commandId(),
          threadId: firstId,
          message: {
            messageId: MessageId.make("stale-continuation"),
            role: "user",
            text: "continue",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          expectedUsageLimit,
          createdAt: NOW,
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        detail: expect.stringContaining(
          action === "disable"
            ? "disabled"
            : action === "stop"
              ? "changed before"
              : "no longer matches",
        ),
      });
      if (action !== "disable") {
        const bannerError = yield* h.engine
          .dispatch({
            type: "thread.session.set",
            commandId: h.commandId(),
            threadId: firstId,
            session: { ...session, lastError: "Waiting for usage reset" },
            expectedUsageLimit,
            createdAt: NOW,
          })
          .pipe(Effect.flip);
        expect(bannerError._tag).toBe("OrchestrationCommandInvariantError");
      }
      expect(yield* h.engine.latestSequence).toBe(before);
      expect((yield* h.read()).messages).toEqual([]);
      expect((yield* h.read()).session?.lastError).toBe(errorMessage);
    }).pipe(Effect.provide(testLayer)),
);

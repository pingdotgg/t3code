import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type HostAdmissionState,
  type HostMemoryPressureLevel,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as HostAdmission from "./HostAdmission.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for admission"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

class FakePressure extends Context.Service<
  FakePressure,
  { readonly set: (level: HostMemoryPressureLevel) => Effect.Effect<void> }
>()("t3/orchestration-v2/HostAdmission.test/FakePressure") {}

const layerFakeHost = Layer.unwrap(
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<HostMemoryPressureLevel>();
    const host = HostResources.HostResources.of({
      read: Effect.succeed({
        sampledAt: 0,
        cpuUtilization: null,
        cpuCount: 1,
        availableMemoryBytes: 0,
        totalMemoryBytes: 0,
      }),
      memoryPressure: Stream.fromPubSub(changes).pipe(
        Stream.map((level) => ({ level, heaviestAgents: [] })),
      ),
    });
    return Layer.mergeAll(
      Layer.succeed(HostResources.HostResources, host),
      Layer.succeed(FakePressure, {
        set: (level) => PubSub.publish(changes, level).pipe(Effect.asVoid),
      }),
    );
  }),
);

const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = (settings: {
  readonly maxRunningTurns?: number | null;
  readonly paceNewTurnsByHostLoad?: boolean;
}) =>
  Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    layerFakeHost,
    ProviderReplayHarness.layerWithRegistry(
      { name: "host-admission" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      {
        databaseLayer: layerDatabase,
        runEffectWorker: false,
        hostCapacity: { settings, hostResources: layerFakeHost },
      },
    ),
  );

const createThread = (threadId: ThreadId) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:host-admission"),
      title: "Thread",
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    }),
  );

const send = (threadId: ThreadId, id: string) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`send:${id}`),
  threadId,
  messageId: MessageId.make(`message:${id}`),
  text: id,
  attachments: [],
  dispatchMode: { type: "start_immediately" as const },
  createdBy: "user" as const,
  creationSource: "web" as const,
});

const runsOf = (threadId: ThreadId) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.getThreadRecords(threadId, ["runs"]).pipe(Effect.map(({ runs }) => runs)),
  );

const onlyRun = (threadId: ThreadId) =>
  runsOf(threadId).pipe(
    Effect.map((runs) => {
      assert.lengthOf(runs, 1);
      return runs[0]!;
    }),
  );

const complete = (run: OrchestrationV2Run, eventId: string) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({
      events: [
        {
          id: EventId.make(eventId),
          type: "run.updated",
          threadId: run.threadId,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: yield* DateTime.now,
          payload: { ...run, status: "completed" },
        },
      ],
    });
  });

/**
 * Runs `trigger` once the state stream is listening, and resolves with the first state after the
 * trigger that satisfies `until`. The stream replays its current state first, so the trigger
 * never races the subscription.
 */
const stateAfter = (
  trigger: Effect.Effect<unknown, unknown, unknown>,
  until: (state: HostAdmissionState) => boolean,
) =>
  Effect.gen(function* () {
    const admission = yield* HostAdmission.HostAdmission;
    let triggered = false;
    return yield* admission.stateChanges.pipe(
      Stream.mapEffect((state) =>
        triggered
          ? Effect.succeed(state)
          : Effect.gen(function* () {
              triggered = true;
              yield* trigger as Effect.Effect<unknown>;
              return null;
            }),
      ),
      Stream.filter((state): state is HostAdmissionState => state !== null && until(state)),
      Stream.runHead,
    );
  });

// Each case gets its own database: runs left by one would hold the single slot of the next.
it.layer(layerTest({ maxRunningTurns: 1 }))("host admission cap: queue order", (it) => {
  it.effect("queues a turn at the cap and starts the oldest waiting one when a slot frees", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const [a, b, c] = ["a", "b", "c"].map((name) => ThreadId.make(`thread:cap-${name}`)) as [
        ThreadId,
        ThreadId,
        ThreadId,
      ];
      for (const threadId of [a, b, c]) yield* createThread(threadId);
      yield* orchestrator.dispatch(send(a, "cap-a"));
      yield* orchestrator.dispatch(send(b, "cap-b"));
      yield* orchestrator.dispatch(send(c, "cap-c"));

      assert.equal((yield* onlyRun(a)).status, "starting");
      const waitingB = yield* onlyRun(b);
      assert.equal(waitingB.status, "queued");
      assert.equal(waitingB.admissionWait, "capacity");
      assert.equal((yield* onlyRun(c)).admissionWait, "capacity");

      yield* stateAfter(
        complete(yield* onlyRun(a), "event:cap-a-done"),
        (state) => state.waitingTurns === 1,
      );
      // Oldest request first: b took the slot, c still waits.
      const startedB = yield* onlyRun(b);
      assert.equal(startedB.status, "starting");
      assert.isUndefined(startedB.admissionWait);
      assert.equal((yield* onlyRun(c)).status, "queued");
    }),
  );
});

it.layer(layerTest({ maxRunningTurns: 1 }))("host admission cap: start now", (it) => {
  it.effect(
    "starts a waiting run at the cap on Start now, and cancel leaves the others alone",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const [a, b, c, d] = ["a", "b", "c", "d"].map((name) =>
          ThreadId.make(`thread:bypass-${name}`),
        ) as [ThreadId, ThreadId, ThreadId, ThreadId];
        for (const threadId of [a, b, c, d]) yield* createThread(threadId);
        yield* orchestrator.dispatch(send(a, "bypass-a"));
        yield* orchestrator.dispatch(send(b, "bypass-b"));
        yield* orchestrator.dispatch(send(c, "bypass-c"));
        yield* orchestrator.dispatch(send(d, "bypass-d"));

        yield* orchestrator.dispatch({
          type: "queued-run.start",
          commandId: CommandId.make("start-now:b"),
          threadId: b,
          runId: (yield* onlyRun(b)).id,
        });
        assert.equal((yield* onlyRun(b)).status, "starting");

        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("cancel:c"),
          threadId: c,
          runId: (yield* onlyRun(c)).id,
        });
        assert.equal((yield* onlyRun(c)).status, "cancelled");
        assert.equal((yield* onlyRun(d)).status, "queued");
      }),
  );
});

it.layer(layerTest({ maxRunningTurns: 1 }))("host admission cap: prepared runs", (it) => {
  it.effect("queues a prepared run at release and starts it when a slot frees", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const [a, b] = [
        ThreadId.make("thread:prepared-a"),
        ThreadId.make("thread:prepared-b"),
      ] as const;
      yield* createThread(a);
      yield* createThread(b);
      yield* orchestrator.dispatch(send(a, "prepared-a"));
      yield* orchestrator.dispatch({
        ...send(b, "prepared-b"),
        dispatchMode: { type: "defer_start" },
      });
      const preparing = yield* onlyRun(b);
      assert.equal(preparing.status, "preparing");

      yield* orchestrator.dispatch({
        type: "prepared-run.release",
        commandId: CommandId.make("release:prepared-b"),
        threadId: b,
        runId: preparing.id,
      });
      const released = yield* onlyRun(b);
      assert.equal(released.status, "queued");
      assert.equal(released.admissionWait, "capacity");

      yield* stateAfter(
        complete(yield* onlyRun(a), "event:prepared-a-done"),
        (state) => state.waitingTurns === 0,
      );
      assert.equal((yield* onlyRun(b)).status, "starting");
    }),
  );
});

it.layer(layerTest({ maxRunningTurns: 1 }))("host admission cap: interrupt", (it) => {
  it.effect("interrupts a running turn at the cap", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:steer-at-cap");
      yield* createThread(threadId);
      yield* orchestrator.dispatch(send(threadId, "steer-at-cap"));
      const run = yield* onlyRun(threadId);
      assert.equal(run.status, "starting");
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("interrupt:steer-at-cap"),
        threadId,
        runId: run.id,
      });
    }),
  );
});

it.layer(layerTest({ maxRunningTurns: 1 }))("host admission cap: thread wait", (it) => {
  it.effect("frees the slot of a turn blocked in t3_thread_wait until the wait returns", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const admission = yield* HostAdmission.HostAdmission;
      const [parent, child, other] = ["parent", "child", "other"].map((name) =>
        ThreadId.make(`thread:wait-${name}`),
      ) as [ThreadId, ThreadId, ThreadId];
      for (const threadId of [parent, child, other]) yield* createThread(threadId);
      yield* orchestrator.dispatch(send(parent, "wait-parent"));
      yield* orchestrator.dispatch(send(child, "wait-child"));
      assert.equal((yield* onlyRun(child)).status, "queued");

      yield* stateAfter(admission.threadWaitStarted(parent), (state) => state.waitingTurns === 0);
      assert.equal((yield* onlyRun(child)).status, "starting");

      // The wait returns: both turns count again, so a new admission waits.
      yield* admission.threadWaitEnded(parent);
      yield* orchestrator.dispatch(send(other, "wait-other"));
      assert.equal((yield* onlyRun(other)).admissionWait, "capacity");
    }),
  );
});

it.layer(layerTest({ maxRunningTurns: 1 }))("host admission settings", (it) => {
  it.effect("starts waiting runs when the cap is cleared", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const admission = yield* HostAdmission.HostAdmission;
      const settings = yield* ServerSettings.ServerSettingsService;
      const [a, b] = [ThreadId.make("thread:clear-a"), ThreadId.make("thread:clear-b")] as const;
      yield* createThread(a);
      yield* createThread(b);
      yield* orchestrator.dispatch(send(a, "clear-a"));
      yield* orchestrator.dispatch(send(b, "clear-b"));
      assert.equal((yield* onlyRun(b)).status, "queued");

      yield* stateAfter(
        settings
          .updateSettings({ maxRunningTurns: null })
          .pipe(Effect.andThen(admission.requestPump)),
        (state) => state.waitingTurns === 0,
      );
      assert.equal((yield* onlyRun(b)).status, "starting");
    }),
  );
});

it.layer(layerTest({ paceNewTurnsByHostLoad: true }))("host admission pacing", (it) => {
  it.effect("holds turns while pressure is severe and paces them while it is elevated", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const pressure = yield* FakePressure;
      const [a, b, c] = ["a", "b", "c"].map((name) => ThreadId.make(`thread:pace-${name}`)) as [
        ThreadId,
        ThreadId,
        ThreadId,
      ];
      for (const threadId of [a, b, c]) yield* createThread(threadId);

      yield* stateAfter(pressure.set("severe"), (state) => state.pacing === "severe");
      yield* orchestrator.dispatch(send(a, "pace-a"));
      assert.equal((yield* onlyRun(a)).admissionWait, "host_load");

      // Pressure drops to elevated: one turn starts, the next waits for the 30 s gap.
      yield* stateAfter(pressure.set("elevated"), (state) => state.waitingTurns === 0);
      assert.equal((yield* onlyRun(a)).status, "starting");
      yield* orchestrator.dispatch(send(b, "pace-b"));
      assert.equal((yield* onlyRun(b)).admissionWait, "host_load");

      yield* stateAfter(TestClock.adjust("30 seconds"), (state) => state.waitingTurns === 0);
      assert.equal((yield* onlyRun(b)).status, "starting");

      // Pressure clears: nothing paces.
      yield* stateAfter(pressure.set("none"), (state) => state.pacing === null);
      yield* orchestrator.dispatch(send(c, "pace-c"));
      assert.equal((yield* onlyRun(c)).status, "starting");
    }),
  );
});

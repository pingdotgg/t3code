import type {
  HostAdmissionState,
  HostMemoryPressureLevel,
  OrchestrationV2AdmissionWait,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/** While the host is under elevated pressure or busy, at most one new turn starts per interval. */
const PACED_ADMISSION_INTERVAL = Duration.seconds(30);
const CPU_BUSY_UTILIZATION = 0.85;

export type AdmissionDecision =
  | { readonly admit: true }
  | { readonly admit: false; readonly wait: OrchestrationV2AdmissionWait };

const ADMIT: AdmissionDecision = { admit: true };

/** Runs admitted by decisions of the enclosing dispatch; they count until its events commit. */
class DispatchReservations extends Context.Service<
  DispatchReservations,
  { readonly runIds: Set<RunId>; touched: boolean }
>()("t3/orchestration-v2/HostAdmission/DispatchReservations") {}

export class HostAdmission extends Context.Service<
  HostAdmission,
  {
    /**
     * Decides whether a new turn may start now, and reserves its slot when it may. Never fails a
     * dispatch: a denial means the run waits as `queued`. Call inside `scopedReservations`.
     */
    readonly decide: (input: {
      readonly runId: RunId;
      readonly threadId: ThreadId;
      /** The thread's oldest waiting request; null for a run this dispatch creates. */
      readonly requestedAt: DateTime.Utc | null;
    }) => Effect.Effect<AdmissionDecision>;
    /** Holds the slots `decide` reserved until `self` returns, which is after its events commit. */
    readonly scopedReservations: <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** A turn blocked in `t3_thread_wait` frees its slot until the wait returns. */
    readonly threadWaitStarted: (threadId: ThreadId) => Effect.Effect<void>;
    readonly threadWaitEnded: (threadId: ThreadId) => Effect.Effect<void>;
    /** Pump triggers: settings, pressure, pacing timer, waits and `requestPump`. */
    readonly pumpRequests: Stream.Stream<void>;
    readonly requestPump: Effect.Effect<void>;
    /**
     * Off until startup recovery finishes and again from shutdown on: recovery cancels or holds
     * runs that start while it reconciles.
     */
    readonly setPumpEnabled: (enabled: boolean) => Effect.Effect<void>;
    /** False while paused, or while both controls are off and nothing waits. */
    readonly pumpNeeded: Effect.Effect<boolean>;
    readonly setWaiters: (waiting: boolean) => Effect.Effect<void>;
    /** Recomputes the state for listeners; no work without one. */
    readonly publishState: Effect.Effect<void>;
    /** Current state first, then changes only. */
    readonly stateChanges: Stream.Stream<HostAdmissionState>;
  }
>()("t3/orchestration-v2/HostAdmission") {}

const sameState = (a: HostAdmissionState, b: HostAdmissionState) =>
  a.runningTurns === b.runningTurns &&
  a.maxRunningTurns === b.maxRunningTurns &&
  a.waitingTurns === b.waitingTurns &&
  a.pacing === b.pacing &&
  a.waitingThreadIds.length === b.waitingThreadIds.length &&
  a.waitingThreadIds.every((id, index) => id === b.waitingThreadIds[index]);

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  // Optional so layers that never pace (tests, tools) need no host telemetry.
  const hostResourcesOption = yield* Effect.serviceOption(HostResources.HostResources);
  const hostResources =
    hostResourcesOption._tag === "Some"
      ? hostResourcesOption.value
      : HostResources.HostResources.of({
          read: Effect.succeed({
            sampledAt: 0,
            cpuUtilization: null,
            cpuCount: 0,
            availableMemoryBytes: 0,
            totalMemoryBytes: 0,
          }),
          memoryPressure: Stream.empty,
        });
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const layerScope = yield* Effect.scope;

  const gate = yield* Semaphore.make(1);
  const reserved = yield* Ref.make(new Set<RunId>());
  const waitingThreads = yield* Ref.make(new Map<ThreadId, number>());
  const pressure = yield* Ref.make<HostMemoryPressureLevel | null>(null);
  const lastPacedAdmissionAt = yield* Ref.make<number | null>(null);
  const timerArmed = yield* Ref.make(false);
  const hasWaiters = yield* Ref.make(true);
  const pumpEnabled = yield* Ref.make(false);
  const listeners = yield* Ref.make(0);
  const lastPublished = yield* Ref.make<HostAdmissionState | null>(null);
  const pumpPubSub = yield* PubSub.sliding<void>(1);
  const statePubSub = yield* PubSub.sliding<HostAdmissionState>(1);

  const settingsActive = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.maxRunningTurns !== null || settings.paceNewTurnsByHostLoad),
    Effect.orDie,
  );
  const requestPump = PubSub.publish(pumpPubSub, undefined).pipe(Effect.asVoid);

  const currentLevel = Effect.fn("HostAdmission.currentLevel")(function* () {
    const sampled = yield* Ref.get(pressure);
    if (sampled !== null) return sampled;
    const snapshot = yield* hostResources.read;
    return snapshot.memoryPressure?.level ?? "none";
  });
  const cpuBusy = hostResources.read.pipe(
    Effect.map(
      ({ cpuUtilization }) => cpuUtilization !== null && cpuUtilization >= CPU_BUSY_UTILIZATION,
    ),
  );

  const runningCount = Effect.fn("HostAdmission.runningCount")(function* (
    snapshot: ProjectionStore.HostAdmissionSnapshot,
    excludeRunId: RunId | null,
  ) {
    const waits = yield* Ref.get(waitingThreads);
    const counted = new Set<RunId>(
      snapshot.live.filter((run) => !waits.has(run.threadId)).map((run) => run.runId),
    );
    for (const runId of yield* Ref.get(reserved)) counted.add(runId);
    if (excludeRunId !== null) counted.delete(excludeRunId);
    return counted.size;
  });

  const armPacingTimer = Effect.fn("HostAdmission.armPacingTimer")(function* (remaining: number) {
    if (yield* Ref.getAndSet(timerArmed, true)) return;
    yield* Effect.sleep(Duration.millis(remaining)).pipe(
      Effect.andThen(Ref.set(timerArmed, false)),
      Effect.andThen(requestPump),
      Effect.forkIn(layerScope),
    );
  });

  const decide: HostAdmission["Service"]["decide"] = Effect.fn("HostAdmission.decide")(function* ({
    runId,
    threadId,
    requestedAt,
  }) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const max = settings.maxRunningTurns;
    const pace = settings.paceNewTurnsByHostLoad;
    if (max === null && !pace) return ADMIT;
    // Sampling can take a moment; only the count check and reservation need the gate.
    const level = pace ? yield* currentLevel() : "none";
    const paced = pace && (level === "elevated" || (yield* cpuBusy));
    const requestedAtMillis = requestedAt === null ? null : DateTime.toEpochMillis(requestedAt);
    const collector = yield* Effect.serviceOption(DispatchReservations);
    const decision = yield* gate.withPermits(1)(
      Effect.gen(function* () {
        const snapshot = yield* projectionStore.getHostAdmissionSnapshot().pipe(Effect.orDie);
        const reservedIds = yield* Ref.get(reserved);
        // Threads with an older run that waits only on the host go first. A thread starts one
        // run at a time, so each counts once; an admitted run not yet committed counts as running.
        const ahead = new Set(
          snapshot.waiting
            .filter(
              (waiting) =>
                waiting.ready &&
                waiting.threadId !== threadId &&
                !reservedIds.has(waiting.runId) &&
                (requestedAtMillis === null ||
                  waiting.requestedAtMillis < requestedAtMillis ||
                  (waiting.requestedAtMillis === requestedAtMillis && waiting.runId < runId)),
            )
            .map((waiting) => waiting.threadId),
        );
        if (max !== null && (yield* runningCount(snapshot, runId)) + ahead.size >= max) {
          return { admit: false, wait: "capacity" } as const;
        }
        if (pace) {
          if (level === "severe") return { admit: false, wait: "host_load" } as const;
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          if (paced) {
            if (ahead.size > 0) return { admit: false, wait: "host_load" } as const;
            const last = yield* Ref.get(lastPacedAdmissionAt);
            const interval = Duration.toMillis(PACED_ADMISSION_INTERVAL);
            if (last !== null && now - last < interval) {
              yield* armPacingTimer(interval - (now - last));
              return { admit: false, wait: "host_load" } as const;
            }
          }
          yield* Ref.set(lastPacedAdmissionAt, now);
        }
        // Registered before the gate opens, so an interruption cannot strand the slot.
        if (collector._tag === "Some") {
          collector.value.touched = true;
          collector.value.runIds.add(runId);
          yield* Ref.update(reserved, (ids) => new Set(ids).add(runId));
        }
        return ADMIT;
      }),
    );
    yield* Ref.set(hasWaiters, true);
    if (collector._tag === "Some") collector.value.touched = true;
    return decision;
  });

  const scopedReservations: HostAdmission["Service"]["scopedReservations"] = (self) =>
    Effect.suspend(() => {
      const collector = { runIds: new Set<RunId>(), touched: false };
      return Effect.provideService(self, DispatchReservations, collector).pipe(
        Effect.onExit((exit) =>
          Ref.update(reserved, (ids) => {
            const next = new Set(ids);
            for (const runId of collector.runIds) next.delete(runId);
            return next;
          }).pipe(
            // A committed admission or a denial needs no pump: the run events trigger one, and
            // the pump's own denials would otherwise request the next pass forever. A slot
            // reserved by a dispatch that then failed may have turned another run away.
            Effect.andThen(
              Effect.suspend(() =>
                Exit.isFailure(exit) && collector.runIds.size > 0
                  ? requestPump
                  : collector.touched
                    ? publishState
                    : Effect.void,
              ),
            ),
          ),
        ),
      );
    });

  const adjustWait = (threadId: ThreadId, delta: 1 | -1) =>
    Ref.update(waitingThreads, (current) => {
      const next = new Map(current);
      const count = (next.get(threadId) ?? 0) + delta;
      if (count > 0) next.set(threadId, count);
      else next.delete(threadId);
      return next;
    }).pipe(Effect.andThen(requestPump));

  const state = Effect.fn("HostAdmission.state")(function* () {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const snapshot = yield* projectionStore.getHostAdmissionSnapshot().pipe(Effect.orDie);
    const level = settings.paceNewTurnsByHostLoad ? yield* currentLevel() : "none";
    const pacing: HostAdmissionState["pacing"] = !settings.paceNewTurnsByHostLoad
      ? null
      : level === "severe"
        ? "severe"
        : level === "elevated" || (yield* cpuBusy)
          ? "paced"
          : null;
    const threadIds = [...new Set(snapshot.waiting.map((run) => run.threadId))];
    return {
      runningTurns: yield* runningCount(snapshot, null),
      maxRunningTurns: settings.maxRunningTurns,
      waitingTurns: snapshot.waiting.length,
      pacing,
      waitingThreadIds: threadIds,
    } satisfies HostAdmissionState;
  });

  const publishState = Effect.gen(function* () {
    if ((yield* Ref.get(listeners)) === 0) {
      // States change unseen meanwhile; the next listener must not be compared with this one.
      yield* Ref.set(lastPublished, null);
      return;
    }
    const next = yield* state();
    const previous = yield* Ref.getAndSet(lastPublished, next);
    if (previous !== null && sameState(previous, next)) return;
    yield* PubSub.publish(statePubSub, next);
  }).pipe(Effect.ignoreCause({ log: true }));

  const stateChanges = Stream.unwrap(
    Effect.gen(function* () {
      yield* Ref.update(listeners, (count) => count + 1);
      // Subscribe before reading, so a change between the two is not lost.
      const subscription = yield* PubSub.subscribe(statePubSub);
      const initial = yield* state();
      return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription)).pipe(
        Stream.ensuring(Ref.update(listeners, (count) => Math.max(0, count - 1))),
      );
    }).pipe(Effect.orDie),
  );

  // Keep a pressure subscription only while pacing is on: sampling costs a few file reads.
  const settingsChanges = yield* serverSettings.subscribeChanges;
  const initialSettings = yield* serverSettings.getSettings.pipe(Effect.orDie);
  yield* Stream.concat(Stream.make(initialSettings), settingsChanges).pipe(
    // Any settings change can release waiting runs (a cap raised, pacing off).
    Stream.tap(() => Ref.set(hasWaiters, true).pipe(Effect.andThen(requestPump))),
    Stream.map((settings) => settings.paceNewTurnsByHostLoad),
    Stream.changesWith((a, b) => a === b),
    Stream.switchMap((pace) =>
      pace
        ? hostResources.memoryPressure.pipe(
            Stream.tap((next) => Ref.set(pressure, next.level).pipe(Effect.andThen(requestPump))),
          )
        : Stream.fromEffect(Ref.set(pressure, null)).pipe(Stream.drain),
    ),
    Stream.runDrain,
    Effect.forkIn(layerScope),
  );
  return HostAdmission.of({
    decide,
    scopedReservations,
    threadWaitStarted: Effect.fn("HostAdmission.threadWaitStarted")((threadId: ThreadId) =>
      adjustWait(threadId, 1),
    ),
    threadWaitEnded: Effect.fn("HostAdmission.threadWaitEnded")((threadId: ThreadId) =>
      adjustWait(threadId, -1),
    ),
    pumpRequests: Stream.fromPubSub(pumpPubSub),
    requestPump,
    setPumpEnabled: Effect.fn("HostAdmission.setPumpEnabled")((enabled: boolean) =>
      Ref.set(pumpEnabled, enabled),
    ),
    pumpNeeded: Effect.gen(function* () {
      if (!(yield* Ref.get(pumpEnabled))) return false;
      return (yield* settingsActive) || (yield* Ref.get(hasWaiters));
    }),
    setWaiters: Effect.fn("HostAdmission.setWaiters")((waiting: boolean) =>
      Ref.set(hasWaiters, waiting),
    ),
    publishState,
    stateChanges,
  });
});

export const layer = Layer.effect(HostAdmission, make);

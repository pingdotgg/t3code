import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import { causeFailureMessage } from "../errors/causeMessage.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribe } from "../rpc/client.ts";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

function statusWithoutLiveData(
  data: Option.Option<OrchestrationV2ThreadProjection>,
): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  return causeFailureMessage(cause, "Could not synchronize the thread.");
}

function shouldPersistThread(projection: OrchestrationV2ThreadProjection): boolean {
  return !projection.runs.some((run) => run.status === "starting" || run.status === "running");
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationV2ThreadDetailSnapshot>()),
      ),
    ),
  );
  const cachedThread = Option.map(cached, (snapshot) => snapshot.projection);
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
  });
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  const persistence = yield* Queue.sliding<OrchestrationV2ThreadDetailSnapshot>(1);
  // When the server advertises threadResumeCompletionMarker and we request it on
  // resume, keep status synchronizing until the stream marker arrives (including
  // through catch-up events). Legacy servers never set this path.
  // markerMode stays true for the life of this thread state once we opt in;
  // awaitingCompletion is re-armed on each reconnect generation.
  const markerMode = yield* Ref.make(false);
  const awaitingCompletion = yield* Ref.make(false);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationV2ThreadDetailSnapshot,
  ) {
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const setSynchronizing = Effect.gen(function* () {
    // Ordinary reconnect clears awaitingCompletion on disconnect; re-arm here so
    // setReady / catch-up setThread keep synchronizing until the new marker.
    if (yield* Ref.get(markerMode)) {
      yield* Ref.set(awaitingCompletion, true);
    }
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: "synchronizing" as const,
      error: Option.none(),
    }));
  });
  const setReady = Effect.gen(function* () {
    const waiting = yield* Ref.get(awaitingCompletion);
    yield* SubscriptionRef.update(state, (current) => {
      if (current.status === "deleted") {
        return current;
      }
      if (waiting) {
        return {
          ...current,
          status: Option.isSome(current.data) ? ("live" as const) : ("synchronizing" as const),
          error: Option.none(),
        };
      }
      return {
        ...current,
        status: Option.isSome(current.data) ? ("live" as const) : ("synchronizing" as const),
        error: Option.none(),
      };
    });
  });
  const setDisconnected = Effect.gen(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
    }));
  });
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      // Resubscribe will re-enter marker wait when this stream is in marker mode.
      if (yield* Ref.get(markerMode)) {
        yield* Ref.set(awaitingCompletion, true);
      }
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
        error: Option.some(formatThreadError(cause)),
      }));
    });

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationV2ThreadProjection,
  ) {
    const waiting = yield* Ref.get(awaitingCompletion);
    yield* SubscriptionRef.set(state, {
      data: Option.some(thread),
      status: waiting ? ("synchronizing" as const) : ("live" as const),
      error: Option.none(),
    });
    // Active threads can update many times per second and retain large tool
    // payloads. The server remains the source of truth while a turn is active;
    // persist once it settles so cache encoding stays off the streaming path.
    if (shouldPersistThread(thread)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(persistence, { snapshotSequence, projection: thread });
    }
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
    });
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  const applyItem = Effect.fn("EnvironmentThreadState.applyItem")(function* (
    item: OrchestrationV2ThreadStreamItem,
  ) {
    if (item.kind === "synchronized") {
      yield* Ref.set(awaitingCompletion, false);
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.data) && current.status !== "deleted"
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
      return;
    }

    if (item.kind === "snapshot") {
      yield* SubscriptionRef.set(lastSequence, item.snapshotSequence);
      yield* setThread(item.projection);
      return;
    }

    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.sequence <= sequence) {
      return;
    }
    yield* SubscriptionRef.set(lastSequence, item.sequence);

    const current = yield* SubscriptionRef.get(state);
    if (Option.isNone(current.data)) {
      if (item.event.type === "thread.deleted") {
        yield* setDeleted();
      }
      return;
    }
    if (item.event.type === "thread.deleted") {
      yield* setDeleted();
      return;
    }
    const next = applyOrchestrationV2ProjectionEvent(current.data.value, item.event);
    if (next !== null) {
      yield* setThread(next);
    }
  });

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      // Establish the base snapshot to resume from, minimizing bytes over the
      // wire:
      // - Warm cache: reuse the cached snapshot (zero network) and resume via
      //   `afterSequence` so we only receive events since the cached sequence.
      // - Cold cache: load the full snapshot over HTTP (gzip-compressible, and
      //   off the socket), then resume via `afterSequence`.
      // If no base can be established we fall back to the socket-embedded
      // snapshot so the thread still synchronizes. Overlapping/replayed events
      // are deduped by sequence in applyItem.
      const base = Option.isSome(cached)
        ? cached
        : yield* Effect.gen(function* () {
            // Cold cache only: wait for a prepared connection so we can
            // authenticate the HTTP request; this mirrors the socket path, which
            // likewise waits for a live session.
            const prepared = yield* SubscriptionRef.changes(supervisor.prepared).pipe(
              Stream.filter(Option.isSome),
              Stream.map((current) => current.value),
              Stream.runHead,
            );
            return Option.isSome(prepared)
              ? yield* snapshotLoader.load(prepared.value, threadId)
              : Option.none<OrchestrationV2ThreadDetailSnapshot>();
          });

      const session = yield* SubscriptionRef.get(supervisor.session);
      const serverSupportsCompletionMarker = Option.isSome(session)
        ? yield* session.value.initialConfig.pipe(
            Effect.map((config) => config.threadResumeCompletionMarker === true),
            Effect.orElseSucceed(() => false),
          )
        : false;
      const requestCompletionMarker = serverSupportsCompletionMarker && Option.isSome(base);
      if (requestCompletionMarker) {
        yield* Ref.set(markerMode, true);
        yield* Ref.set(awaitingCompletion, true);
      }

      if (Option.isSome(base)) {
        yield* applyItem({
          kind: "snapshot",
          snapshotSequence: base.value.snapshotSequence,
          projection: base.value.projection,
        });
      }

      const subscribeInput = Option.match(base, {
        onNone: () => ({ threadId }),
        onSome: (snapshot) =>
          requestCompletionMarker
            ? {
                threadId,
                afterSequence: snapshot.snapshotSequence,
                requestCompletionMarker: true as const,
              }
            : { threadId, afterSequence: snapshot.snapshotSequence },
      });

      yield* subscribe(ORCHESTRATION_V2_WS_METHODS.subscribeThread, subscribeInput, {
        onExpectedFailure: (cause) => setStreamError(cause),
        retryExpectedFailureAfter: "250 millis",
      }).pipe(Stream.runForEach(applyItem));
    }),
  );

  yield* Effect.addFinalizer(() =>
    Effect.all([SubscriptionRef.get(state), SubscriptionRef.get(lastSequence)]).pipe(
      Effect.flatMap(([current, snapshotSequence]) =>
        Option.match(current.data, {
          onNone: () => Effect.void,
          onSome: (projection) =>
            shouldPersistThread(projection)
              ? persist({ snapshotSequence, projection })
              : Effect.void,
        }),
      ),
    ),
  );

  return state;
});

export function threadStateChanges(environmentId: EnvironmentIdType, threadId: ThreadIdType) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentThreadState(threadId).pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >,
) {
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return runtime
      .atom(threadStateChanges(environmentId, threadId), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
      })
      .pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-state:${key}`),
      );
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";

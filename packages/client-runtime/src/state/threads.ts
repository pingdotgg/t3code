import {
  ORCHESTRATION_ACTIVITY_PAGE_DEFAULT_SIZE,
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationActivityPageInfo,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import {
  applyThreadActivityPageResult,
  EMPTY_THREAD_ACTIVITY_HISTORY,
  initialThreadActivityHistory,
  type ThreadActivityHistoryState,
} from "./threadActivityPagination.ts";
import { createEnvironmentCommand, followStreamInEnvironment } from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

export type ThreadCapabilityAction =
  | "send"
  | "attachments"
  | "steer"
  | "followUp"
  | "interrupt"
  | "stop"
  | "rename"
  | "archive"
  | "settle"
  | "unsettle"
  | "delete"
  | "changeModel"
  | "changeRuntimeMode"
  | "changeInteractionMode"
  | "checkpoints"
  | "lifecycle"
  | "approval"
  | "userInput";

export function threadAllows(
  thread: Pick<OrchestrationThread, "backing">,
  action: ThreadCapabilityAction,
): boolean {
  const backing = thread.backing;
  if (backing === undefined) return true;
  if (action === "steer" || action === "followUp") {
    return backing.capabilities.streamingBehaviors.includes(action);
  }
  if (action === "lifecycle" || action === "approval" || action === "userInput") {
    return false;
  }
  return backing.capabilities[action] === true;
}

/**
 * A thread the server says does not exist will not reappear on the next tick,
 * so it is retried slowly instead of never: re-adding the project that owns an
 * external Pi session brings the thread back without a reload.
 */
const MISSING_THREAD_RETRY = "30 seconds";
const MISSING_THREAD_CODES = new Set(["thread_not_found", "thread_unscoped"]);

export function threadIsGone(cause: Cause.Cause<unknown>): boolean {
  return (
    cause.reasons.length > 0 &&
    cause.reasons.every((reason) => {
      if (reason._tag !== "Fail") return false;
      const error: unknown = reason.error;
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        MISSING_THREAD_CODES.has(error.code)
      );
    })
  );
}

function statusWithoutLiveData(data: Option.Option<OrchestrationThread>): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

function shouldPersistThread(thread: OrchestrationThread): boolean {
  if (thread.backing?.kind === "external") return false;
  const status = thread.session?.status;
  return status !== "starting" && status !== "running";
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
      ),
    ),
  );
  const cachedThread = Option.map(cached, (snapshot) => snapshot.thread);
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    activityPageInfo: Option.match(cached, {
      onNone: () => null,
      onSome: (snapshot) => snapshot.pageInfo ?? null,
    }),
    activityHistoryVersion: 0,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
  });
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  const awaitingCompletion = yield* Ref.make(false);
  const persistence = yield* Queue.sliding<OrchestrationThreadDetailSnapshot>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
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

  const setSynchronizing = SubscriptionRef.update(state, (current) =>
    current.status === "deleted"
      ? current
      : {
          ...current,
          data:
            Option.isSome(current.data) && current.data.value.backing?.kind === "external"
              ? Option.none()
              : current.data,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setDisconnected = Effect.gen(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
    }));
  });
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          data:
            Option.isSome(current.data) && current.data.value.backing?.kind === "external"
              ? Option.none()
              : current.data,
          status:
            current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
          error: Option.some(formatThreadError(cause)),
        })),
      ),
    );

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationThread,
    pageInfo?: OrchestrationActivityPageInfo | null,
    resetActivityHistory = false,
  ) {
    const waiting = yield* Ref.get(awaitingCompletion);
    const current = yield* SubscriptionRef.get(state);
    const activityPageInfo = pageInfo === undefined ? (current.activityPageInfo ?? null) : pageInfo;
    yield* SubscriptionRef.set(state, {
      data: Option.some(thread),
      activityPageInfo,
      activityHistoryVersion:
        (current.activityHistoryVersion ?? 0) + (resetActivityHistory ? 1 : 0),
      status: waiting ? "synchronizing" : "live",
      error: Option.none(),
    });
    // Active threads can update many times per second and retain large tool
    // payloads. The server remains the source of truth while a turn is active;
    // persist once it settles so cache encoding stays off the streaming path.
    if (shouldPersistThread(thread)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(persistence, {
        snapshotSequence,
        thread,
        ...(activityPageInfo === null ? {} : { pageInfo: activityPageInfo }),
      });
    }
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    const current = yield* SubscriptionRef.get(state);
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      activityPageInfo: null,
      activityHistoryVersion: (current.activityHistoryVersion ?? 0) + 1,
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
    item: OrchestrationThreadStreamItem,
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
      yield* SubscriptionRef.set(lastSequence, item.snapshot.snapshotSequence);
      yield* setThread(item.snapshot.thread, item.snapshot.pageInfo ?? null, true);
      return;
    }

    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.event.sequence <= sequence) {
      return;
    }
    yield* SubscriptionRef.set(lastSequence, item.event.sequence);

    const current = yield* SubscriptionRef.get(state);
    if (Option.isNone(current.data)) {
      if (item.event.type === "thread.deleted") {
        yield* setDeleted();
      }
      return;
    }
    const result = applyThreadDetailEvent(current.data.value, item.event);
    if (result.kind === "updated") {
      yield* setThread(result.thread, undefined, item.event.type === "thread.reverted");
    } else if (result.kind === "deleted") {
      yield* setDeleted();
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

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        const supportsCompletionMarker = yield* session.initialConfig.pipe(
          Effect.map((config) => config.threadResumeCompletionMarker === true),
          Effect.orElseSucceed(() => false),
        );
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;

        let current = yield* SubscriptionRef.get(state);
        if (Option.isNone(current.data) && current.status !== "deleted") {
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          const httpSnapshot = yield* snapshotLoader.load(prepared, threadId);
          if (Option.isSome(httpSnapshot)) {
            yield* applyItem({ kind: "snapshot", snapshot: httpSnapshot.value });
            current = yield* SubscriptionRef.get(state);
          }
        }

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const canResume = Option.isSome(current.data);
        if (!supportsCompletionMarker && canResume) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: value.status === "deleted" ? value.status : ("live" as const),
            error: Option.none(),
          }));
        }

        return {
          threadId,
          ...(canResume ? { afterSequence: sequence } : {}),
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
        };
      }),
      {
        onExpectedFailure: setStreamError,
        retryExpectedFailureAfter: (cause) =>
          threadIsGone(cause) ? MISSING_THREAD_RETRY : "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEach(applyItem)),
  );

  yield* Effect.addFinalizer(() =>
    Effect.all([SubscriptionRef.get(state), SubscriptionRef.get(lastSequence)]).pipe(
      Effect.flatMap(([current, snapshotSequence]) =>
        Option.match(current.data, {
          onNone: () => Effect.void,
          onSome: (thread) =>
            shouldPersistThread(thread)
              ? persist({
                  snapshotSequence,
                  thread,
                  ...(current.activityPageInfo == null
                    ? {}
                    : { pageInfo: current.activityPageInfo }),
                })
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
  const stateFamily = Atom.family((key: string) => {
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

  const loadedHistoryFamily = Atom.family((key: string) =>
    Atom.make<ThreadActivityHistoryState>(EMPTY_THREAD_ACTIVITY_HISTORY).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-loaded-activity-history:${key}`),
    ),
  );

  const historyFamily = Atom.family((key: string) =>
    Atom.make((get): ThreadActivityHistoryState => {
      const threadState = Option.getOrElse(
        AsyncResult.value(get(stateFamily(key))),
        () => EMPTY_ENVIRONMENT_THREAD_STATE,
      );
      const initial = initialThreadActivityHistory(
        threadState.activityPageInfo ?? null,
        threadState.activityHistoryVersion ?? 0,
      );
      const loaded = get(loadedHistoryFamily(key));
      return loaded.sourceVersion === initial.sourceVersion ? loaded : initial;
    }).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-activity-history:${key}`),
    ),
  );

  const loadOlderActivities = createEnvironmentCommand(runtime, {
    label: "environment-thread-activity-history:load-older",
    concurrency: {
      mode: "singleFlight" as const,
      key: ({
        environmentId,
        input,
      }: {
        readonly environmentId: EnvironmentIdType;
        readonly input: { readonly threadId: ThreadIdType };
      }) => threadKey({ environmentId, threadId: input.threadId }),
    },
    execute: (input: { readonly threadId: ThreadIdType }, registry, environmentId) => {
      const key = threadKey({ environmentId, threadId: input.threadId });
      return Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor;
        const loader = yield* ThreadSnapshotLoader;
        if (loader.loadActivityPage === undefined) return;
        const current = registry.get(historyFamily(key));
        const cursor = current.pageInfo?.nextCursor;
        if (cursor === undefined || cursor === null || current.status === "loading") {
          return;
        }

        const preparedOption = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(preparedOption)) return;

        registry.set(loadedHistoryFamily(key), {
          ...current,
          status: "loading",
          error: null,
        });

        const result = yield* loader.loadActivityPage(preparedOption.value, input.threadId, {
          cursor,
          pageSize: ORCHESTRATION_ACTIVITY_PAGE_DEFAULT_SIZE,
        });

        registry.set(loadedHistoryFamily(key), applyThreadActivityPageResult(current, result));
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            const current = registry.get(loadedHistoryFamily(key));
            registry.set(loadedHistoryFamily(key), {
              ...current,
              status: "error",
              error: error instanceof Error ? error.message : "Could not load older activity.",
            });
          }),
        ),
      );
    },
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      stateFamily(threadKey({ environmentId, threadId })),
    activityHistoryAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      historyFamily(threadKey({ environmentId, threadId })),
    loadOlderActivities,
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadActivityPagination.ts";
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";

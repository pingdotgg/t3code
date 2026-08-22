import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  GitManagerServiceError,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { mergeGitStatusParts } from "@t3tools/shared/git";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";

const DEFAULT_VCS_STATUS_REFRESH_INTERVAL = Duration.seconds(30);
const LOCAL_WATCH_RESTART_DELAY = Duration.seconds(1);
const LOCAL_WATCH_MAX_RESTART_DELAY = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_BASE_DELAY = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_MAX_DELAY = Duration.minutes(15);
const MAX_FAILURE_DIAGNOSTIC_VALUES = 8;
const MAX_FAILURE_DIAGNOSTIC_VALUE_LENGTH = 128;

function boundedDiagnosticValue(value: string): string {
  return value.slice(0, MAX_FAILURE_DIAGNOSTIC_VALUE_LENGTH);
}

function diagnosticValueTag(value: unknown): string {
  try {
    if (
      typeof value === "object" &&
      value !== null &&
      "_tag" in value &&
      typeof value._tag === "string"
    ) {
      return boundedDiagnosticValue(value._tag);
    }
    if (value instanceof Error) {
      return boundedDiagnosticValue(value.name);
    }
    return typeof value;
  } catch {
    return "Uninspectable";
  }
}

function diagnosticFailureOperation(value: unknown): string | undefined {
  try {
    if (
      typeof value === "object" &&
      value !== null &&
      "operation" in value &&
      typeof value.operation === "string"
    ) {
      return boundedDiagnosticValue(value.operation);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function addUniqueDiagnosticValue(values: Array<string>, value: string | undefined): void {
  if (
    value !== undefined &&
    values.length < MAX_FAILURE_DIAGNOSTIC_VALUES &&
    !values.includes(value)
  ) {
    values.push(value);
  }
}

export function remoteRefreshFailureDiagnostics(cause: Cause.Cause<unknown>) {
  const failureTags: Array<string> = [];
  const failureOperations: Array<string> = [];
  const defectTags: Array<string> = [];
  let failureCount = 0;
  let defectCount = 0;
  let interruptionCount = 0;

  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      failureCount += 1;
      addUniqueDiagnosticValue(failureTags, diagnosticValueTag(reason.error));
      addUniqueDiagnosticValue(failureOperations, diagnosticFailureOperation(reason.error));
      continue;
    }
    if (Cause.isDieReason(reason)) {
      defectCount += 1;
      addUniqueDiagnosticValue(defectTags, diagnosticValueTag(reason.defect));
      continue;
    }
    interruptionCount += 1;
  }

  return {
    reasonCount: cause.reasons.length,
    failureCount,
    failureTags,
    failureOperations,
    defectCount,
    defectTags,
    interruptionCount,
  };
}

interface VcsStatusChange {
  readonly cwd: string;
  readonly event: VcsStatusStreamEvent;
}

interface CachedValue<T> {
  readonly fingerprint: string;
  readonly value: T;
}

interface CachedVcsStatus {
  readonly local: CachedValue<VcsStatusLocalResult> | null;
  readonly remote: CachedValue<VcsStatusRemoteResult | null> | null;
}

interface ActiveRemotePoller {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
  readonly demandCwds: Ref.Ref<ReadonlyMap<string, number>>;
}

interface ActiveLocalWatcher {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
}

interface StreamStatusOptions {
  readonly automaticRemoteRefreshInterval?: Effect.Effect<Duration.Duration, never>;
}

export function remoteRefreshFailureDelay(
  consecutiveFailures: number,
  configuredInterval: Duration.Duration,
) {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const backoffMs =
    Duration.toMillis(VCS_STATUS_REFRESH_FAILURE_BASE_DELAY) * Math.pow(2, exponent);
  const cappedBackoff = Duration.min(
    Duration.millis(backoffMs),
    VCS_STATUS_REFRESH_FAILURE_MAX_DELAY,
  );
  return Duration.max(configuredInterval, cappedBackoff);
}

export class VcsStatusBroadcaster extends Context.Service<
  VcsStatusBroadcaster,
  {
    readonly getStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly refreshLocalStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly refreshStatus: (cwd: string) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly streamStatus: (
      input: VcsStatusInput,
      options?: StreamStatusOptions,
    ) => Stream.Stream<VcsStatusStreamEvent, GitManagerServiceError>;
  }
>()("t3/vcs/VcsStatusBroadcaster") {}

function fingerprintStatusPart(status: unknown): string {
  return JSON.stringify(status);
}

const normalizeCwd = (cwd: string) =>
  Effect.service(FileSystem.FileSystem).pipe(
    Effect.flatMap((fs) => fs.realPath(cwd)),
    Effect.orElseSucceed(() => cwd),
  );

export const make = Effect.gen(function* () {
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<VcsStatusChange>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const cacheRef = yield* Ref.make(new Map<string, CachedVcsStatus>());
  const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());
  const localWatchersRef = yield* SynchronizedRef.make(new Map<string, ActiveLocalWatcher>());

  const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
    cwd: string,
  ) {
    return yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));
  });

  const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
    function* (cwd: string, local: VcsStatusLocalResult, options?: { publish?: boolean }) {
      const nextLocal = {
        fingerprint: fingerprintStatusPart(local),
        value: local,
      } satisfies CachedValue<VcsStatusLocalResult>;
      const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const nextCache = new Map(cache);
        nextCache.set(cwd, {
          ...previous,
          local: nextLocal,
        });
        return [previous.local?.fingerprint !== nextLocal.fingerprint, nextCache] as const;
      });

      if (options?.publish && shouldPublish) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: {
            _tag: "localUpdated",
            local,
          },
        });
      }

      return local;
    },
  );

  const updateCachedRemoteStatus = Effect.fn("VcsStatusBroadcaster.updateCachedRemoteStatus")(
    function* (cwd: string, remote: VcsStatusRemoteResult | null, options?: { publish?: boolean }) {
      const nextRemote = {
        fingerprint: fingerprintStatusPart(remote),
        value: remote,
      } satisfies CachedValue<VcsStatusRemoteResult | null>;
      const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const nextCache = new Map(cache);
        nextCache.set(cwd, {
          ...previous,
          remote: nextRemote,
        });
        return [previous.remote?.fingerprint !== nextRemote.fingerprint, nextCache] as const;
      });

      if (options?.publish && shouldPublish) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: {
            _tag: "remoteUpdated",
            remote,
          },
        });
      }

      return remote;
    },
  );

  const updateCachedStatus = Effect.fn("VcsStatusBroadcaster.updateCachedStatus")(function* (
    cwd: string,
    local: VcsStatusLocalResult,
    remote: VcsStatusRemoteResult | null,
    options?: { publish?: boolean },
  ) {
    const nextLocal = {
      fingerprint: fingerprintStatusPart(local),
      value: local,
    } satisfies CachedValue<VcsStatusLocalResult>;
    const nextRemote = {
      fingerprint: fingerprintStatusPart(remote),
      value: remote,
    } satisfies CachedValue<VcsStatusRemoteResult | null>;
    const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
      const previous = cache.get(cwd) ?? { local: null, remote: null };
      const nextCache = new Map(cache);
      nextCache.set(cwd, {
        local: nextLocal,
        remote: nextRemote,
      });
      return [
        previous.local?.fingerprint !== nextLocal.fingerprint ||
          previous.remote?.fingerprint !== nextRemote.fingerprint,
        nextCache,
      ] as const;
    });

    if (options?.publish && shouldPublish) {
      yield* PubSub.publish(changesPubSub, {
        cwd,
        event: {
          _tag: "snapshot",
          local,
          remote,
        },
      });
    }

    return mergeGitStatusParts(local, remote);
  });

  const loadLocalStatus = Effect.fn("VcsStatusBroadcaster.loadLocalStatus")(function* (
    cwd: string,
  ) {
    const local = yield* workflow.localStatus({ cwd });
    return yield* updateCachedLocalStatus(cwd, local);
  });

  const getOrLoadLocalStatus = Effect.fn("VcsStatusBroadcaster.getOrLoadLocalStatus")(function* (
    cwd: string,
  ) {
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local) {
      return cached.local.value;
    }
    return yield* loadLocalStatus(cwd);
  });

  const withFileSystem = Effect.provideService(FileSystem.FileSystem, fs);

  const getStatus: VcsStatusBroadcaster["Service"]["getStatus"] = Effect.fn(
    "VcsStatusBroadcaster.getStatus",
  )(function* (input) {
    const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local && cached.remote) {
      return mergeGitStatusParts(cached.local.value, cached.remote.value);
    }
    const [local, remote] = yield* Effect.all(
      [
        cached?.local ? Effect.succeed(cached.local.value) : workflow.localStatus({ cwd }),
        cached?.remote ? Effect.succeed(cached.remote.value) : workflow.remoteStatus({ cwd }),
      ],
      { concurrency: "unbounded" },
    );
    return yield* updateCachedStatus(cwd, local, remote);
  });

  const refreshLocalStatusCore = Effect.fn("VcsStatusBroadcaster.refreshLocalStatusCore")(
    function* (cwd: string) {
      yield* workflow.invalidateLocalStatus(cwd);
      const local = yield* workflow.localStatus({ cwd });
      return yield* updateCachedLocalStatus(cwd, local, { publish: true });
    },
  );

  const refreshLocalStatus: VcsStatusBroadcaster["Service"]["refreshLocalStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshLocalStatus",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    return yield* refreshLocalStatusCore(cwd);
  });

  const prepareLocalWatcher = Effect.fn("VcsStatusBroadcaster.prepareLocalWatcher")(function* (
    cwd: string,
  ) {
    const initialWatchPath = yield* workflow.localStatusWatchPath({ cwd }).pipe(Effect.result);
    if (Result.isSuccess(initialWatchPath) && initialWatchPath.success === null) {
      return null;
    }

    const refreshSafely = refreshLocalStatusCore(cwd).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.asVoid,
    );
    const watchPath = Effect.fn("VcsStatusBroadcaster.watchLocalStatusPath")(function* (
      rawHeadPath: string | null,
    ) {
      if (rawHeadPath === null) {
        return;
      }

      const headPath = path.isAbsolute(rawHeadPath) ? rawHeadPath : path.resolve(cwd, rawHeadPath);
      const headDirectory = path.dirname(headPath);
      const headFileName = path.basename(headPath);
      yield* Stream.runForEach(
        fs.watch(headDirectory).pipe(
          Stream.filter((event) => {
            return (
              event.path === headPath ||
              event.path === headFileName ||
              path.resolve(headDirectory, event.path) === headPath
            );
          }),
          Stream.debounce(Duration.millis(50)),
        ),
        () => refreshSafely,
      );
    });
    const runWatchAttempt = Effect.fn("VcsStatusBroadcaster.runLocalStatusWatchAttempt")(function* <
      E,
      R,
    >(attempt: Effect.Effect<void, E, R>) {
      yield* attempt.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Git HEAD watcher failed; restarting", {
            cwdLength: cwd.length,
            failureTag: diagnosticValueTag(error),
            failureOperation: diagnosticFailureOperation(error),
          }),
        ),
      );
    });
    const firstWatchAttempt = Effect.fromResult(initialWatchPath).pipe(Effect.flatMap(watchPath));
    const nextWatchAttempt = workflow.localStatusWatchPath({ cwd }).pipe(Effect.flatMap(watchPath));

    return Effect.gen(function* () {
      yield* runWatchAttempt(firstWatchAttempt);
      let restartDelay = LOCAL_WATCH_RESTART_DELAY;
      while (true) {
        yield* Effect.sleep(restartDelay);
        yield* runWatchAttempt(nextWatchAttempt);
        restartDelay = Duration.min(Duration.times(restartDelay, 2), LOCAL_WATCH_MAX_RESTART_DELAY);
      }
    });
  });

  const retainLocalWatcher = Effect.fn("VcsStatusBroadcaster.retainLocalWatcher")(function* (
    cwd: string,
  ) {
    const retainedExisting = yield* SynchronizedRef.modify(localWatchersRef, (activeWatchers) => {
      const existing = activeWatchers.get(cwd);
      if (!existing) {
        return [false, activeWatchers] as const;
      }

      const nextWatchers = new Map(activeWatchers);
      nextWatchers.set(cwd, {
        ...existing,
        subscriberCount: existing.subscriberCount + 1,
      });
      return [true, nextWatchers] as const;
    });
    if (retainedExisting) {
      return true;
    }

    const watcher = yield* prepareLocalWatcher(cwd);
    if (watcher === null) {
      return false;
    }

    return yield* SynchronizedRef.modifyEffect(localWatchersRef, (activeWatchers) => {
      const existing = activeWatchers.get(cwd);
      if (existing) {
        const nextWatchers = new Map(activeWatchers);
        nextWatchers.set(cwd, {
          ...existing,
          subscriberCount: existing.subscriberCount + 1,
        });
        return Effect.succeed([true, nextWatchers] as const);
      }

      return watcher.pipe(
        Effect.forkIn(broadcasterScope, { startImmediately: true }),
        Effect.map((fiber) => {
          const nextWatchers = new Map(activeWatchers);
          nextWatchers.set(cwd, { fiber, subscriberCount: 1 });
          return [true, nextWatchers] as const;
        }),
      );
    });
  });

  const releaseLocalWatcher = Effect.fn("VcsStatusBroadcaster.releaseLocalWatcher")(function* (
    cwd: string,
  ) {
    const watcherToInterrupt = yield* SynchronizedRef.modify(localWatchersRef, (activeWatchers) => {
      const existing = activeWatchers.get(cwd);
      if (!existing) {
        return [null, activeWatchers] as const;
      }
      if (existing.subscriberCount > 1) {
        const nextWatchers = new Map(activeWatchers);
        nextWatchers.set(cwd, {
          ...existing,
          subscriberCount: existing.subscriberCount - 1,
        });
        return [null, nextWatchers] as const;
      }
      return [
        existing.fiber,
        new Map([...activeWatchers].filter(([activeCwd]) => activeCwd !== cwd)),
      ] as const;
    });

    if (watcherToInterrupt) {
      yield* Fiber.interrupt(watcherToInterrupt).pipe(Effect.ignore);
    }
  });

  const refreshRemoteStatus = Effect.fn("VcsStatusBroadcaster.refreshRemoteStatus")(function* (
    cwd: string,
    options?: { readonly refreshUpstream?: boolean },
  ) {
    if (options?.refreshUpstream !== false) {
      yield* workflow.invalidateRemoteStatus(cwd);
    }
    const remote = yield* workflow.remoteStatus({ cwd }, options);
    return yield* updateCachedRemoteStatus(cwd, remote, { publish: true });
  });

  const refreshStatus: VcsStatusBroadcaster["Service"]["refreshStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshStatus",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    // invalidateStatus (not the two partial invalidations) so an explicit
    // refresh also bypasses GitManager's slow PR-lookup cache.
    yield* workflow.invalidateStatus(cwd);
    const [local, remote] = yield* Effect.all(
      [workflow.localStatus({ cwd }), workflow.remoteStatus({ cwd })],
      { concurrency: "unbounded" },
    );
    return yield* updateCachedStatus(cwd, local, remote, { publish: true });
  });

  const makeRemoteRefreshLoop = (
    cwd: string,
    demandCwdsRef: Ref.Ref<ReadonlyMap<string, number>>,
    automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    refreshImmediately: boolean,
  ) => {
    return Effect.gen(function* () {
      const consecutiveFailuresRef = yield* Ref.make(0);
      const needsInitialRefreshRef = yield* Ref.make(refreshImmediately);
      const refreshRemoteStatusIfEnabled = Effect.gen(function* () {
        const configuredInterval = yield* automaticRemoteRefreshInterval;
        const activeInterval = Duration.isZero(configuredInterval)
          ? DEFAULT_VCS_STATUS_REFRESH_INTERVAL
          : configuredInterval;
        const needsInitialRefresh = yield* Ref.get(needsInitialRefreshRef);
        if (Duration.isZero(configuredInterval) && !needsInitialRefresh) {
          return activeInterval;
        }

        const demandCwds = yield* Ref.get(demandCwdsRef);
        const shouldRun =
          needsInitialRefresh ||
          (yield* Effect.all(
            [...demandCwds.keys()].map((demandCwd) =>
              backgroundPolicy.shouldRunScopeWork({
                type: "vcs-status",
                cwd: demandCwd,
              }),
            ),
            { concurrency: "unbounded" },
          )).some(Boolean);
        if (!shouldRun) {
          return activeInterval;
        }

        const exit = yield* refreshRemoteStatus(cwd, {
          refreshUpstream: !Duration.isZero(configuredInterval),
        }).pipe(Effect.exit);
        if (Exit.isSuccess(exit)) {
          yield* Ref.set(needsInitialRefreshRef, false);
          yield* Ref.set(consecutiveFailuresRef, 0);
          return activeInterval;
        }

        const interruptionReasons = exit.cause.reasons.filter(Cause.isInterruptReason);
        if (interruptionReasons.length > 0) {
          return yield* Effect.failCause(Cause.fromReasons<never>(interruptionReasons));
        }

        const consecutiveFailures = yield* Ref.updateAndGet(
          consecutiveFailuresRef,
          (count) => count + 1,
        );
        const nextDelay = remoteRefreshFailureDelay(consecutiveFailures, activeInterval);
        yield* Effect.logWarning("VCS remote status refresh failed", {
          cwdLength: cwd.length,
          ...remoteRefreshFailureDiagnostics(exit.cause),
          consecutiveFailures,
          nextDelayMs: Duration.toMillis(nextDelay),
        });
        return nextDelay;
      });

      if (!refreshImmediately) {
        const configuredInterval = yield* automaticRemoteRefreshInterval;
        yield* Effect.sleep(
          Duration.isZero(configuredInterval)
            ? DEFAULT_VCS_STATUS_REFRESH_INTERVAL
            : configuredInterval,
        );
      }

      return yield* refreshRemoteStatusIfEnabled.pipe(
        Effect.repeat(
          Schedule.identity<Duration.Duration>().pipe(
            Schedule.addDelay(({ output: delay }) => Effect.succeed(delay)),
          ),
        ),
        Effect.asVoid,
      );
    });
  };

  const retainRemotePoller = Effect.fn("VcsStatusBroadcaster.retainRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
    automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    refreshImmediately: boolean,
  ) {
    yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
      const existing = activePollers.get(cwd);
      if (existing) {
        return Ref.update(existing.demandCwds, (demandCwds) => {
          const next = new Map(demandCwds);
          next.set(demandCwd, (next.get(demandCwd) ?? 0) + 1);
          return next;
        }).pipe(
          Effect.map(() => {
            const nextPollers = new Map(activePollers);
            nextPollers.set(cwd, {
              ...existing,
              subscriberCount: existing.subscriberCount + 1,
            });
            return [undefined, nextPollers] as const;
          }),
        );
      }

      return Ref.make<ReadonlyMap<string, number>>(new Map([[demandCwd, 1]])).pipe(
        Effect.flatMap((demandCwds) =>
          makeRemoteRefreshLoop(
            cwd,
            demandCwds,
            automaticRemoteRefreshInterval,
            refreshImmediately,
          ).pipe(
            Effect.forkIn(broadcasterScope),
            Effect.map((fiber) => {
              const nextPollers = new Map(activePollers);
              nextPollers.set(cwd, {
                fiber,
                subscriberCount: 1,
                demandCwds,
              });
              return [undefined, nextPollers] as const;
            }),
          ),
        ),
      );
    });
  });

  const releaseRemotePoller = Effect.fn("VcsStatusBroadcaster.releaseRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
  ) {
    const pollerToInterrupt = yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
      const existing = activePollers.get(cwd);
      if (!existing) {
        return Effect.succeed([null, activePollers] as const);
      }

      if (existing.subscriberCount > 1) {
        return Ref.update(existing.demandCwds, (demandCwds) => {
          const nextDemandCwds = new Map(demandCwds);
          const count = nextDemandCwds.get(demandCwd) ?? 0;
          if (count <= 1) {
            nextDemandCwds.delete(demandCwd);
          } else {
            nextDemandCwds.set(demandCwd, count - 1);
          }
          return nextDemandCwds;
        }).pipe(
          Effect.as([
            null,
            new Map(activePollers).set(cwd, {
              ...existing,
              subscriberCount: existing.subscriberCount - 1,
            }),
          ] as const),
        );
      }

      return Effect.succeed([
        existing.fiber,
        new Map([...activePollers].filter(([activeCwd]) => activeCwd !== cwd)),
      ] as const);
    });

    if (pollerToInterrupt) {
      yield* Fiber.interrupt(pollerToInterrupt).pipe(Effect.ignore);
    }
  });

  const streamStatus: VcsStatusBroadcaster["Service"]["streamStatus"] = (input, options) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
        const subscription = yield* PubSub.subscribe(changesPubSub);
        let initialLocal = yield* getOrLoadLocalStatus(cwd);
        const retainedLocalWatcher = yield* Effect.acquireRelease(retainLocalWatcher(cwd), () =>
          releaseLocalWatcher(cwd),
        );
        if (retainedLocalWatcher) {
          yield* workflow.invalidateLocalStatus(cwd);
          initialLocal = yield* loadLocalStatus(cwd);
        }
        const cachedStatus = yield* getCachedStatus(cwd);
        const initialRemote = cachedStatus?.remote?.value ?? null;
        yield* Effect.acquireRelease(
          retainRemotePoller(
            cwd,
            input.cwd,
            options?.automaticRemoteRefreshInterval ??
              Effect.succeed(DEFAULT_VCS_STATUS_REFRESH_INTERVAL),
            cachedStatus?.remote === null || cachedStatus?.remote === undefined,
          ),
          () => releaseRemotePoller(cwd, input.cwd),
        );

        return Stream.concat(
          Stream.make({
            _tag: "snapshot" as const,
            local: initialLocal,
            remote: initialRemote,
          }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.cwd === cwd),
            Stream.map((event) => event.event),
          ),
        );
      }),
    );

  return VcsStatusBroadcaster.of({
    getStatus,
    refreshLocalStatus,
    refreshStatus,
    streamStatus,
  });
});

export const layer = Layer.effect(VcsStatusBroadcaster, make);

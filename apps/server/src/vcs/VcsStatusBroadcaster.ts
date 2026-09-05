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
import * as Semaphore from "effect/Semaphore";
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
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitHeadWatcher from "./GitHeadWatcher.ts";

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

interface CachedLocalStatus extends CachedValue<VcsStatusLocalResult> {
  readonly readOrder: number;
}

interface CachedVcsStatus {
  readonly local: CachedLocalStatus | null;
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
  readonly statusLock: Semaphore.Semaphore;
}

interface StreamStatusOptions {
  readonly automaticRemoteRefreshInterval?: Effect.Effect<Duration.Duration, never>;
}

export class VcsAutoPullPolicy extends Context.Reference<{
  readonly isEnabled: (cwd: string) => Effect.Effect<boolean, never>;
}>("t3/vcs/VcsAutoPullPolicy", {
  defaultValue: () => ({ isEnabled: () => Effect.succeed(false) }),
}) {}

export const autoPullPolicyLayer = Layer.effect(
  VcsAutoPullPolicy,
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    return {
      isEnabled: (cwd: string) =>
        snapshots.getActiveProjectByWorkspaceRoot(cwd).pipe(
          Effect.map((project) => project._tag === "Some" && project.value.autoPull === true),
          Effect.orElseSucceed(() => false),
        ),
    };
  }),
);

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
    /**
     * Refresh a loaded cwd after a turn if background policy allows it.
     * GitManager retries missing PRs for the current branch and keeps known
     * PRs and failed lookup backoff cached. This does not fetch Git remotes.
     */
    readonly refreshPullRequestStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
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
  const autoPullPolicy = yield* VcsAutoPullPolicy;
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const headWatcher = yield* GitHeadWatcher.GitHeadWatcher;
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
  // One permit per cwd for remote reads that write the cache. Without it a
  // periodic poll that started before `gh pr create` can finish after the
  // turn-end refresh and overwrite the fresh PR with its stale `pr: null`.
  const remoteWriteLocks = new Map<string, Semaphore.Semaphore>();
  const withRemoteWriteLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) => {
    let lock = remoteWriteLocks.get(cwd);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      remoteWriteLocks.set(cwd, lock);
    }
    return lock.withPermits(1)(effect);
  };
  const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());
  const localWatchersRef = yield* SynchronizedRef.make(new Map<string, ActiveLocalWatcher>());

  const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
    cwd: string,
  ) {
    return yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));
  });

  // Order reads when they start, but advance the cache only after success. A slow
  // local read or remote refresh must not replace a newer completed HEAD refresh.
  let localReadOrder = 0;
  const readLocalStatus = Effect.fn("VcsStatusBroadcaster.readLocalStatus")(function* (
    cwd: string,
  ) {
    const readOrder = ++localReadOrder;
    const value = yield* workflow.localStatus({ cwd });
    return {
      readOrder,
      value,
      fingerprint: fingerprintStatusPart(value),
    } satisfies CachedLocalStatus;
  });

  const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
    function* (cwd: string, nextLocal: CachedLocalStatus, options?: { publish?: boolean }) {
      const { local, shouldPublish } = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        if (previous.local && previous.local.readOrder > nextLocal.readOrder) {
          return [{ local: previous.local.value, shouldPublish: false }, cache] as const;
        }
        const nextCache = new Map(cache);
        nextCache.set(cwd, {
          ...previous,
          local: nextLocal,
        });
        return [
          {
            local: nextLocal.value,
            shouldPublish: previous.local?.fingerprint !== nextLocal.fingerprint,
          },
          nextCache,
        ] as const;
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
    proposedLocal: CachedLocalStatus,
    proposedRemote: VcsStatusRemoteResult | null,
    options?: { publish?: boolean },
  ) {
    const nextRemote = {
      fingerprint: fingerprintStatusPart(proposedRemote),
      value: proposedRemote,
    } satisfies CachedValue<VcsStatusRemoteResult | null>;
    const { local, remote, shouldPublish } = yield* Ref.modify(cacheRef, (cache) => {
      const previous = cache.get(cwd) ?? { local: null, remote: null };
      // Remote data from an older ref must not be paired with a newer HEAD result.
      if (
        previous.local &&
        previous.local.readOrder > proposedLocal.readOrder &&
        previous.local.value.refName !== proposedLocal.value.refName
      ) {
        return [
          {
            local: previous.local.value,
            remote: previous.remote?.value ?? null,
            shouldPublish: false,
          },
          cache,
        ] as const;
      }
      const nextLocal =
        previous.local && previous.local.readOrder > proposedLocal.readOrder
          ? previous.local
          : proposedLocal;
      const nextCache = new Map(cache);
      nextCache.set(cwd, {
        local: nextLocal,
        remote: nextRemote,
      });
      return [
        {
          local: nextLocal.value,
          remote: proposedRemote,
          shouldPublish:
            previous.local?.fingerprint !== nextLocal.fingerprint ||
            previous.remote?.fingerprint !== nextRemote.fingerprint,
        },
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

    return { local, remote };
  });

  const loadLocalStatus = Effect.fn("VcsStatusBroadcaster.loadLocalStatus")(function* (
    cwd: string,
  ) {
    const local = yield* readLocalStatus(cwd);
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
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        const latest = yield* getCachedStatus(cwd);
        const [local, remote] = yield* Effect.all(
          [
            latest?.local ? Effect.succeed(latest.local) : readLocalStatus(cwd),
            latest?.remote ? Effect.succeed(latest.remote.value) : workflow.remoteStatus({ cwd }),
          ],
          { concurrency: "unbounded" },
        );
        const updated = yield* updateCachedStatus(cwd, local, remote);
        return mergeGitStatusParts(updated.local, updated.remote);
      }),
    );
  });

  const refreshLocalStatusCore = Effect.fn("VcsStatusBroadcaster.refreshLocalStatusCore")(
    function* (cwd: string) {
      yield* workflow.invalidateLocalStatus(cwd);
      const local = yield* readLocalStatus(cwd);
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

    const statusLock = yield* Semaphore.make(1);
    let restartDelay = LOCAL_WATCH_RESTART_DELAY;
    const refreshSafely = refreshLocalStatusCore(cwd).pipe(
      statusLock.withPermits(1),
      Effect.ignoreCause({ log: true }),
      Effect.asVoid,
    );
    const watchPath = Effect.fn("VcsStatusBroadcaster.watchLocalStatusPath")(function* (
      rawHeadPath: string | null,
    ) {
      if (rawHeadPath === null) return;

      const headPath = path.isAbsolute(rawHeadPath) ? rawHeadPath : path.resolve(cwd, rawHeadPath);
      const headDirectory = path.dirname(headPath);
      const headFileName = path.basename(headPath);
      const events = yield* headWatcher.acquire(headDirectory);
      yield* refreshSafely;
      yield* Stream.runForEach(
        events.pipe(
          Stream.filter((eventPath) => {
            return (
              eventPath === null ||
              eventPath === headPath ||
              eventPath === headFileName ||
              path.resolve(headDirectory, eventPath) === headPath
            );
          }),
          Stream.debounce(Duration.millis(50)),
        ),
        () =>
          Effect.gen(function* () {
            restartDelay = LOCAL_WATCH_RESTART_DELAY;
            yield* refreshSafely;
          }),
      );
    }, Effect.scoped);
    const runWatchAttempt = Effect.fn("VcsStatusBroadcaster.runLocalStatusWatchAttempt")(function* <
      E,
      R,
    >(attempt: Effect.Effect<void, E, R>) {
      const [elapsed] = yield* attempt.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Git HEAD watcher failed; restarting", {
            cwdLength: cwd.length,
            failureTag: diagnosticValueTag(error),
            failureOperation: diagnosticFailureOperation(error),
          }),
        ),
        Effect.timed,
      );
      if (Duration.isGreaterThanOrEqualTo(elapsed, LOCAL_WATCH_MAX_RESTART_DELAY)) {
        restartDelay = LOCAL_WATCH_RESTART_DELAY;
      }
    });
    const firstWatchAttempt = Effect.fromResult(initialWatchPath).pipe(Effect.flatMap(watchPath));
    const nextWatchAttempt = workflow.localStatusWatchPath({ cwd }).pipe(Effect.flatMap(watchPath));

    return {
      statusLock,
      run: Effect.gen(function* () {
        yield* runWatchAttempt(firstWatchAttempt);
        while (true) {
          yield* Effect.sleep(restartDelay);
          restartDelay = Duration.min(
            Duration.times(restartDelay, 2),
            LOCAL_WATCH_MAX_RESTART_DELAY,
          );
          yield* runWatchAttempt(nextWatchAttempt);
        }
      }),
    };
  });

  const retainLocalWatcher = Effect.fn("VcsStatusBroadcaster.retainLocalWatcher")(function* (
    cwd: string,
  ) {
    const retainedExisting = yield* SynchronizedRef.modify(localWatchersRef, (activeWatchers) => {
      const existing = activeWatchers.get(cwd);
      if (!existing) {
        return [null, activeWatchers] as const;
      }

      const nextWatchers = new Map(activeWatchers);
      nextWatchers.set(cwd, {
        ...existing,
        subscriberCount: existing.subscriberCount + 1,
      });
      return [existing.statusLock, nextWatchers] as const;
    });
    if (retainedExisting) {
      return retainedExisting;
    }

    const watcher = yield* prepareLocalWatcher(cwd);
    if (watcher === null) {
      return null;
    }

    return yield* SynchronizedRef.modifyEffect(localWatchersRef, (activeWatchers) => {
      const existing = activeWatchers.get(cwd);
      if (existing) {
        const nextWatchers = new Map(activeWatchers);
        nextWatchers.set(cwd, {
          ...existing,
          subscriberCount: existing.subscriberCount + 1,
        });
        return Effect.succeed([existing.statusLock, nextWatchers] as const);
      }

      return watcher.run.pipe(
        Effect.forkIn(broadcasterScope, { startImmediately: true }),
        Effect.map((fiber) => {
          const nextWatchers = new Map(activeWatchers);
          nextWatchers.set(cwd, { fiber, subscriberCount: 1, statusLock: watcher.statusLock });
          return [watcher.statusLock, nextWatchers] as const;
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

  const maybeAutoPull = Effect.fn("VcsStatusBroadcaster.maybeAutoPull")(function* (
    cwd: string,
    remote: VcsStatusRemoteResult | null,
    policyCwds: ReadonlyArray<string>,
  ) {
    return yield* Effect.gen(function* () {
      const autoPullEnabled = (yield* Effect.forEach(policyCwds, autoPullPolicy.isEnabled, {
        concurrency: "unbounded",
      })).some(Boolean);
      if (
        remote === null ||
        !remote.hasUpstream ||
        remote.aheadCount > 0 ||
        remote.behindCount <= 0 ||
        !autoPullEnabled
      ) {
        return null;
      }

      yield* workflow.invalidateLocalStatus(cwd);
      const local = yield* workflow.localStatus({ cwd });
      if (!local.isRepo || !local.isDefaultRef || local.hasWorkingTreeChanges) return null;

      yield* workflow.pullCurrentBranch(cwd);
      yield* workflow.invalidateStatus(cwd);
      const [refreshedLocal, refreshedRemote] = yield* Effect.all(
        [readLocalStatus(cwd), workflow.remoteStatus({ cwd }, { refreshUpstream: false })],
        { concurrency: "unbounded" },
      );
      return yield* updateCachedStatus(cwd, refreshedLocal, refreshedRemote, { publish: true });
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning("Automatic project pull failed", { cwd }).pipe(Effect.as(null)),
      ),
    );
  });

  const refreshRemoteStatus = Effect.fn("VcsStatusBroadcaster.refreshRemoteStatus")(function* (
    cwd: string,
    options?: {
      readonly refreshUpstream?: boolean;
      readonly policyCwds?: ReadonlyArray<string>;
    },
  ) {
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        if (options?.refreshUpstream !== false) {
          yield* workflow.invalidateRemoteStatus(cwd);
        }
        const remote = yield* workflow.remoteStatus({ cwd }, options);
        const pulled = yield* maybeAutoPull(cwd, remote, options?.policyCwds ?? [cwd]);
        if (pulled !== null) return pulled.remote;
        return yield* updateCachedRemoteStatus(cwd, remote, { publish: true });
      }),
    );
  });

  const refreshStatus: VcsStatusBroadcaster["Service"]["refreshStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshStatus",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    // invalidateStatus (not the two partial invalidations) so an explicit
    // refresh also bypasses GitManager's slow PR-lookup cache.
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        yield* workflow.invalidateStatus(cwd);
        const [local, remote] = yield* Effect.all(
          [readLocalStatus(cwd), workflow.remoteStatus({ cwd })],
          { concurrency: "unbounded" },
        );
        const pulled = yield* maybeAutoPull(cwd, remote, [rawCwd]);
        if (pulled !== null) return mergeGitStatusParts(pulled.local, pulled.remote);
        const updated = yield* updateCachedStatus(cwd, local, remote, { publish: true });
        return mergeGitStatusParts(updated.local, updated.remote);
      }),
    );
  });

  const refreshPullRequestStatus: VcsStatusBroadcaster["Service"]["refreshPullRequestStatus"] =
    Effect.fn("VcsStatusBroadcaster.refreshPullRequestStatus")(function* (rawCwd) {
      const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
      return yield* withRemoteWriteLock(
        cwd,
        Effect.gen(function* () {
          const cached = yield* getCachedStatus(cwd);
          if (cached?.remote?.value == null) return null;
          const poller = (yield* SynchronizedRef.get(pollersRef)).get(cwd);
          const demandCwds = poller ? [...(yield* Ref.get(poller.demandCwds)).keys()] : [rawCwd];
          const shouldRefresh = (yield* Effect.forEach(
            demandCwds,
            (demandCwd) =>
              backgroundPolicy.shouldRunScopeWork({ type: "vcs-status", cwd: demandCwd }),
            { concurrency: "unbounded" },
          )).some(Boolean);
          if (!shouldRefresh) return null;
          // Resolve the checked-out branch again. A cached PR can belong to
          // the previous branch after an agent checks out another branch.
          const remote = yield* workflow.remoteStatus(
            { cwd },
            { refreshUpstream: false, refreshMissingPullRequest: true },
          );
          return yield* updateCachedRemoteStatus(cwd, remote, { publish: true });
        }),
      );
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
          policyCwds: [...demandCwds.keys()],
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
        const localWatchStatusLock = yield* Effect.acquireRelease(
          retainLocalWatcher(cwd),
          (lock) => (lock === null ? Effect.void : releaseLocalWatcher(cwd)),
        );
        if (localWatchStatusLock) {
          initialLocal = yield* localWatchStatusLock.withPermits(1)(
            Effect.gen(function* () {
              yield* workflow.invalidateLocalStatus(cwd);
              return yield* loadLocalStatus(cwd);
            }),
          );
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
    refreshPullRequestStatus,
    streamStatus,
  });
});

export const layer = Layer.effect(VcsStatusBroadcaster, make);

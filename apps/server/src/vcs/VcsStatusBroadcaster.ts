import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
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
  VcsStatusSubscriptionInput,
} from "@t3tools/contracts";
import { DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL } from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { mergeGitStatusParts } from "@t3tools/shared/git";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";

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

function remoteRefreshFailureDiagnostics(cause: Cause.Cause<unknown>) {
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

interface CachedRemoteStatus extends CachedValue<VcsStatusRemoteResult | null> {
  readonly branch: string | null;
}

interface CachedVcsStatus {
  readonly local: CachedValue<VcsStatusLocalResult> | null;
  readonly remote: CachedRemoteStatus | null;
}

interface ActiveRemotePoller {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
  readonly demandCwds: Ref.Ref<ReadonlyMap<string, number>>;
}

export class VcsAutomaticFetchInterval extends Context.Reference<Effect.Effect<Duration.Duration>>(
  "t3/vcs/VcsAutomaticFetchInterval",
  { defaultValue: () => Effect.succeed(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL) },
) {}

export const layerAutomaticFetchInterval = Layer.effect(
  VcsAutomaticFetchInterval,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    return serverSettings.getSettings.pipe(
      Effect.map(
        (settings) => resolveServerBackgroundActivitySettings(settings).automaticGitFetchInterval,
      ),
      Effect.orElseSucceed(() => DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL),
    );
  }),
);

export class VcsAutoPullPolicy extends Context.Reference<{
  readonly isEnabled: (cwd: string) => Effect.Effect<boolean, never>;
}>("t3/vcs/VcsAutoPullPolicy", {
  defaultValue: () => ({ isEnabled: () => Effect.succeed(false) }),
}) {}

export const layerAutoPullPolicy = Layer.effect(
  VcsAutoPullPolicy,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    return {
      isEnabled: Effect.fn("VcsAutoPullPolicy.isEnabled")(
        function* (cwd: string) {
          const project = yield* projects.findActiveByWorkspaceRoot(cwd);
          if (project._tag === "None") return false;
          const settings = yield* serverSettings.getSettings;
          return resolveProjectSettings(settings, project.value.projectId).settings.defaultAutoPull;
        },
        Effect.orElseSucceed(() => false),
      ),
    };
  }),
);

function remoteRefreshFailureDelay(
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
    readonly refreshStatus: (
      cwd: string,
      options?: { readonly localOnly?: boolean },
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly refreshPullRequestStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly streamStatus: (
      input: VcsStatusSubscriptionInput,
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

/** @public */
export const make = Effect.gen(function* () {
  const automaticFetchInterval = yield* VcsAutomaticFetchInterval;
  const autoPullPolicy = yield* VcsAutoPullPolicy;
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const fs = yield* FileSystem.FileSystem;
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<VcsStatusChange>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const cacheRef = yield* Ref.make(new Map<string, CachedVcsStatus>());
  // One permit per cwd for remote reads that write the cache. Without it a
  // periodic poll that started before an agent creates a PR can finish after the
  // turn-end refresh and overwrite the fresh PR with its stale `pr: null`.
  const remoteWriteLocks = yield* KeyedLock.make<string>();
  const withRemoteWriteLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    remoteWriteLocks.withLock(cwd, effect);
  const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());

  const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
    cwd: string,
  ) {
    return yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));
  });

  const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
    function* (cwd: string, local: VcsStatusLocalResult, options?: { publish?: boolean }) {
      const nextLocal = { fingerprint: fingerprintStatusPart(local), value: local };
      const [localChanged, remoteCleared] = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const remote = previous.remote?.branch === local.refName ? previous.remote : null;
        return [
          [previous.local?.fingerprint !== nextLocal.fingerprint, previous.remote !== remote],
          new Map(cache).set(cwd, { local: nextLocal, remote }),
        ] as const;
      });
      if (options?.publish && remoteCleared) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: { _tag: "remoteUpdated", remote: null },
        });
      }
      if (options?.publish && localChanged) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: { _tag: "localUpdated", local },
        });
      }
      return local;
    },
  );

  const updateCachedRemoteStatus = Effect.fn("VcsStatusBroadcaster.updateCachedRemoteStatus")(
    function* (cwd: string, remote: CachedRemoteStatus | null, options?: { publish?: boolean }) {
      const [changed, value] = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const next = remote?.branch === previous.local?.value.refName ? remote : null;
        return [
          [previous.remote?.fingerprint !== next?.fingerprint, next?.value ?? null],
          new Map(cache).set(cwd, { ...previous, remote: next }),
        ] as const;
      });
      if (options?.publish && changed) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: { _tag: "remoteUpdated", remote: value },
        });
      }
      return value;
    },
  );

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

  const getStatusParts = Effect.fn("VcsStatusBroadcaster.getStatusParts")(function* (cwd: string) {
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local) {
      return { local: cached.local.value, remote: cached.remote?.value ?? null };
    }
    return { local: yield* loadLocalStatus(cwd), remote: null };
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
    yield* getOrLoadLocalStatus(cwd);
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        const latest = yield* getCachedStatus(cwd);
        const refreshUpstream = !Duration.isZero(yield* automaticFetchInterval);
        const remote = latest?.remote ?? (yield* readRemoteStatus(cwd, { refreshUpstream }));
        yield* updateCachedRemoteStatus(cwd, remote);
        const parts = yield* getStatusParts(cwd);
        return mergeGitStatusParts(parts.local, parts.remote);
      }),
    );
  });

  // A refresh that started after a request saw every change that request could mean, so queued
  // callers share it instead of each running git status again.
  const localRefreshLocks = yield* KeyedLock.make<string>();
  const localRefreshRequests = new Map<string, number>();
  const localRefreshResults = new Map<
    string,
    { readonly startedAt: number; readonly local: VcsStatusLocalResult }
  >();
  const refreshLocalStatusCore = Effect.fn("VcsStatusBroadcaster.refreshLocalStatusCore")(
    function* (cwd: string) {
      const requestedAt = (localRefreshRequests.get(cwd) ?? 0) + 1;
      localRefreshRequests.set(cwd, requestedAt);
      return yield* localRefreshLocks.withLock(
        cwd,
        Effect.gen(function* () {
          const shared = localRefreshResults.get(cwd);
          if (shared !== undefined && shared.startedAt >= requestedAt) return shared.local;
          const startedAt = localRefreshRequests.get(cwd) ?? requestedAt;
          yield* workflow.invalidateLocalStatus(cwd);
          const local = yield* workflow.localStatus({ cwd });
          localRefreshResults.set(cwd, { startedAt, local });
          return yield* updateCachedLocalStatus(cwd, local, { publish: true });
        }),
      );
    },
  );

  const refreshLocalStatus: VcsStatusBroadcaster["Service"]["refreshLocalStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshLocalStatus",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    return yield* refreshLocalStatusCore(cwd);
  });

  const readRemoteStatus = Effect.fn("VcsStatusBroadcaster.readRemoteStatus")(function* (
    cwd: string,
    options?: Parameters<GitWorkflowService.GitWorkflowService["Service"]["remoteStatus"]>[1],
  ) {
    const branch = yield* workflow.currentBranch(cwd);
    // GitManager's remote TTL cache is keyed by cwd, not the checked-out branch.
    yield* workflow.invalidateRemoteStatus(cwd);
    const value = yield* workflow.remoteStatus({ cwd }, options);
    const currentBranch = yield* workflow.currentBranch(cwd);
    const cached = yield* getCachedStatus(cwd);
    if (branch !== currentBranch || cached?.local?.value.refName !== currentBranch) {
      yield* refreshLocalStatusCore(cwd);
    }
    return branch === currentBranch
      ? { branch, value, fingerprint: fingerprintStatusPart(value) }
      : null;
  });

  const maybeAutoPull = Effect.fn("VcsStatusBroadcaster.maybeAutoPull")(function* (
    cwd: string,
    remoteRead: CachedRemoteStatus | null,
    policyCwds: ReadonlyArray<string>,
  ) {
    const remote = remoteRead?.value ?? null;
    let pullAttempted = false;
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
      if (
        !local.isRepo ||
        !local.isDefaultRef ||
        local.hasWorkingTreeChanges ||
        local.refName !== remoteRead?.branch
      )
        return null;

      pullAttempted = true;
      yield* workflow.pullCurrentBranch(cwd);
      yield* workflow.invalidateStatus(cwd);
      yield* refreshLocalStatusCore(cwd);
      const refreshedRemote = yield* readRemoteStatus(cwd, { refreshUpstream: false });
      yield* updateCachedRemoteStatus(cwd, refreshedRemote, { publish: true });
      return yield* getStatusParts(cwd);
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Automatic project pull failed", {
            cwdLength: cwd.length,
            errorTag: error._tag,
          });
          if (!pullAttempted) return null;
          // A pull or its follow-up reads can fail after local state has changed.
          // Let a failed reconciliation reach the caller instead of publishing old status.
          yield* refreshLocalStatusCore(cwd);
          yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
          return yield* getStatusParts(cwd);
        }),
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
        const previousRemote = (yield* getCachedStatus(cwd))?.remote?.value;
        const remoteRead = yield* readRemoteStatus(cwd, options);
        const remote = remoteRead?.value;
        const pulled =
          options?.refreshUpstream === false
            ? null
            : yield* maybeAutoPull(cwd, remoteRead, options?.policyCwds ?? [cwd]);
        if (pulled !== null) return pulled.remote;
        if (
          remote &&
          (!previousRemote ||
            previousRemote.aheadCount !== remote.aheadCount ||
            previousRemote.behindCount !== remote.behindCount ||
            previousRemote.aheadOfDefaultCount !== remote.aheadOfDefaultCount)
        ) {
          yield* refreshLocalStatusCore(cwd);
        }
        return yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
      }),
    );
  });

  const refreshStatus: VcsStatusBroadcaster["Service"]["refreshStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshStatus",
  )(function* (rawCwd, options) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    const previous = options?.localOnly ? yield* getCachedStatus(cwd) : null;
    const local = yield* refreshLocalStatusCore(cwd);
    if (options?.localOnly) {
      return yield* withRemoteWriteLock(
        cwd,
        Effect.gen(function* () {
          if (previous?.local?.value.refName !== local.refName || !previous?.remote) {
            yield* workflow.invalidateRemoteStatus(cwd);
            yield* updateCachedRemoteStatus(
              cwd,
              { branch: local.refName, fingerprint: fingerprintStatusPart(null), value: null },
              { publish: true },
            );
          }
          const parts = yield* getStatusParts(cwd);
          return mergeGitStatusParts(parts.local, parts.remote);
        }),
      );
    }
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        const refreshUpstream = !Duration.isZero(yield* automaticFetchInterval);
        // Bump the PR lookup epoch after earlier remote writers have finished.
        yield* workflow.invalidateStatus(cwd);
        const remoteRead = yield* readRemoteStatus(cwd, { refreshUpstream });
        // Fetch can move the base used for local Changes totals.
        const local = yield* workflow.localStatus({ cwd });
        yield* updateCachedLocalStatus(cwd, local, { publish: true });
        // Without a fetch, the cached behind count cannot justify an automatic pull.
        const pulled = refreshUpstream ? yield* maybeAutoPull(cwd, remoteRead, [rawCwd]) : null;
        if (pulled !== null) return mergeGitStatusParts(pulled.local, pulled.remote);
        yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
        const parts = yield* getStatusParts(cwd);
        return mergeGitStatusParts(parts.local, parts.remote);
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
          if (!cached?.local || cached.remote?.value === null) return null;
          const poller = (yield* SynchronizedRef.get(pollersRef)).get(cwd);
          const demandCwds = poller ? [...(yield* Ref.get(poller.demandCwds)).keys()] : [rawCwd];
          const shouldRefresh = (yield* Effect.forEach(
            demandCwds,
            (demandCwd) =>
              backgroundPolicy.shouldRunScopeWork({ type: "vcs-status", cwd: demandCwd }),
            { concurrency: "unbounded" },
          )).some(Boolean);
          if (!shouldRefresh) return null;
          const remoteRead = yield* readRemoteStatus(cwd, {
            refreshUpstream: false,
            refreshMissingPullRequest: true,
          });
          return yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
        }),
      );
    });

  // A subscription owns this loop; keep each poll's spans out of a never-ending parent span.
  const makeRemoteRefreshLoop = Effect.fnUntraced(function* (
    cwd: string,
    demandCwdsRef: Ref.Ref<ReadonlyMap<string, number>>,
    refreshImmediately: boolean,
  ) {
    const consecutiveFailuresRef = yield* Ref.make(0);
    const needsInitialRefreshRef = yield* Ref.make(refreshImmediately);
    const refreshRemoteStatusIfEnabled = Effect.gen(function* () {
      const configuredInterval = yield* automaticFetchInterval;
      const activeInterval = Duration.isZero(configuredInterval)
        ? DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL
        : configuredInterval;
      const needsInitialRefresh = yield* Ref.get(needsInitialRefreshRef);
      if (Duration.isZero(configuredInterval) && !needsInitialRefresh) {
        return activeInterval;
      }

      const demandCwds = yield* Ref.get(demandCwdsRef);
      const shouldRun =
        needsInitialRefresh ||
        (yield* Effect.forEach(
          [...demandCwds.keys()],
          (demandCwd) =>
            backgroundPolicy.shouldRunScopeWork({
              type: "vcs-status",
              cwd: demandCwd,
            }),
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
      const configuredInterval = yield* automaticFetchInterval;
      yield* Effect.sleep(
        Duration.isZero(configuredInterval)
          ? DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL
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

  const retainRemotePoller = Effect.fn("VcsStatusBroadcaster.retainRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
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
          makeRemoteRefreshLoop(cwd, demandCwds, refreshImmediately).pipe(
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

  const streamStatus: VcsStatusBroadcaster["Service"]["streamStatus"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
        const subscription = yield* PubSub.subscribe(changesPubSub);
        const initialLocal = yield* getOrLoadLocalStatus(cwd);
        const cachedStatus = yield* getCachedStatus(cwd);
        const initialRemote = cachedStatus?.remote?.value ?? null;
        if (input.includeRemote !== false) {
          yield* retainRemotePoller(
            cwd,
            input.cwd,
            cachedStatus?.remote === null || cachedStatus?.remote === undefined,
          );
        }
        const release =
          input.includeRemote === false
            ? Effect.void
            : releaseRemotePoller(cwd, input.cwd).pipe(Effect.ignore, Effect.asVoid);

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
        ).pipe(Stream.ensuring(release));
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

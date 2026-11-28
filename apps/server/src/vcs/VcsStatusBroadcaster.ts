// @effect-diagnostics-next-line nodeBuiltinImport:off -- A synchronous digest of the ref snapshot already in memory.
import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  GitManagerServiceError,
  VcsStatusInput,
  VcsBranchStatus,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsRefreshStatusResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
  VcsStatusSubscriptionInput,
} from "@t3tools/contracts";
import { DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL } from "@t3tools/contracts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { mergeGitStatusParts } from "@t3tools/shared/git";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import { VcsAutomaticFetchInterval } from "./VcsAutomaticFetchInterval.ts";

const VCS_STATUS_REFRESH_FAILURE_BASE_DELAY = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_MAX_DELAY = Duration.minutes(15);
const VCS_STATUS_CACHE_CAPACITY = 256;
const MAX_FAILURE_DIAGNOSTIC_VALUES = 8;
// A held index.lock fails the read, and its removal moves no HEAD to trigger another.
const CHECKOUT_REFRESH_RETRY = Schedule.exponential(Duration.seconds(1)).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);
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

interface CachedLocalStatus extends CachedValue<VcsStatusLocalResult> {
  readonly includesBranchChanges: boolean;
}

interface CachedVcsStatus {
  readonly local: CachedLocalStatus | null;
  readonly remote: CachedRemoteStatus | null;
}

interface ActiveHeadWatcher {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly ready: Deferred.Deferred<void>;
  readonly subscriberCount: number;
}

interface ActiveRemotePoller {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
  readonly demandCwds: Ref.Ref<ReadonlyMap<string, number>>;
}

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
    readonly streamBranchStatus: (
      input: VcsStatusInput,
    ) => Stream.Stream<VcsBranchStatus, GitManagerServiceError>;
    readonly refreshBranchStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsBranchStatus, GitManagerServiceError>;
    readonly streamBranchChanges: Stream.Stream<{
      readonly cwd: string;
      readonly refName: string | null;
    }>;
    readonly getStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly refreshLocalStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    /**
     * For a checkout someone is waiting on. Returns once the new branch is published, so the
     * caller's reply does not outrun it, and finishes the slower remote read in the background.
     */
    readonly refreshAfterCheckout: (cwd: string) => Effect.Effect<void>;
    readonly refreshStatus: (
      cwd: string,
      options?: { readonly localOnly?: boolean },
    ) => Effect.Effect<VcsRefreshStatusResult, GitManagerServiceError>;
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
  const path = yield* Path.Path;
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<VcsStatusChange>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const branchChangesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<{
      readonly cwd: string;
      readonly refName: string | null;
      readonly isRepo: boolean;
      readonly revision: number;
    }>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const detailedSubscribers = new Map<string, number>();
  const branches = new Map<
    string,
    {
      readonly refName: string | null;
      readonly isRepo: boolean;
      readonly revision: number;
      readonly observation: number;
    }
  >();
  let branchRevision = 0;
  // A slow detailed read must not replace a newer HEAD-only observation.
  let branchObservation = 0;
  const publishBranch = Effect.fn("VcsStatusBroadcaster.publishBranch")(function* (
    cwd: string,
    { refName, isRepo }: { readonly refName: string | null; readonly isRepo: boolean },
    observation: number,
  ) {
    const previous = branches.get(cwd);
    if (previous && previous.observation > observation) return;
    if (previous?.refName === refName && previous.isRepo === isRepo) {
      branches.set(cwd, { ...previous, observation });
      return;
    }
    const revision = ++branchRevision;
    branches.set(cwd, { refName, isRepo, revision, observation });
    yield* PubSub.publish(branchChangesPubSub, { cwd, refName, isRepo, revision });
  });
  const localRefreshLocks = yield* KeyedLock.make<string>();
  const cacheRef = yield* Ref.make(new Map<string, CachedVcsStatus>());
  // One permit per cwd for remote reads that write the cache. Without it a
  // periodic poll that started before an agent creates a PR can finish after the
  // turn-end refresh and overwrite the fresh PR with its stale `pr: null`.
  const remoteWriteLocks = yield* KeyedLock.make<string>();
  const activeRemoteReads = new Map<string, number>();
  const withRemoteWriteLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => activeRemoteReads.set(cwd, (activeRemoteReads.get(cwd) ?? 0) + 1)),
      () => remoteWriteLocks.withLock(cwd, effect),
      () =>
        Effect.sync(() => {
          const remaining = (activeRemoteReads.get(cwd) ?? 1) - 1;
          if (remaining === 0) activeRemoteReads.delete(cwd);
          else activeRemoteReads.set(cwd, remaining);
        }).pipe(Effect.andThen(trimCachedStatuses)),
    );
  const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());
  const headWatchersRef = yield* SynchronizedRef.make(new Map<string, ActiveHeadWatcher>());
  // A refresh that started after a request saw every change that request could mean, so queued
  // callers share it instead of each running git status again.
  const localRefreshRequests = new Map<string, number>();
  // Upstream details the turn-end refreshLocalStatus just read, handed once to the PR lookup that
  // follows it so the same no-fetch read is not repeated. Any remote write in between drops them.
  const upstreamReads = new Map<string, GitVcsDriver.GitRemoteStatusDetails>();
  const localRefreshResults = new Map<
    string,
    {
      readonly startedAt: number;
      readonly local: VcsStatusLocalResult;
      readonly includesBranchChanges: boolean;
    }
  >();

  // Keep watched snapshots and remote operations coherent until their consumers finish.
  const evictExcessStatuses = (cache: Map<string, CachedVcsStatus>, retainedCwd?: string) => {
    for (const candidate of cache.keys()) {
      if (cache.size <= VCS_STATUS_CACHE_CAPACITY) break;
      if (
        candidate === retainedCwd ||
        detailedSubscribers.has(candidate) ||
        activeRemoteReads.has(candidate)
      )
        continue;
      cache.delete(candidate);
      // A queued caller can read git again. Keep the monotonic request counter so it cannot
      // mistake an older result for a later request.
      localRefreshResults.delete(candidate);
      upstreamReads.delete(candidate);
    }
    return cache;
  };
  const trimCachedStatuses = Ref.update(cacheRef, (cache) => evictExcessStatuses(new Map(cache)));
  const retainCachedStatus = (
    cache: ReadonlyMap<string, CachedVcsStatus>,
    cwd: string,
    status: CachedVcsStatus,
  ) => {
    const next = new Map(cache);
    next.delete(cwd);
    next.set(cwd, status);
    return evictExcessStatuses(next, cwd);
  };

  const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
    cwd: string,
  ) {
    return yield* Ref.modify(cacheRef, (cache) => {
      const cached = cache.get(cwd) ?? null;
      return [cached, cached ? retainCachedStatus(cache, cwd, cached) : cache] as const;
    });
  });

  // Only full subscribers and direct reads show Changes totals. Command palette rows subscribe
  // without remote status and skip them, which halves the git processes a burst of rows spawns.
  const branchChangesDemand = new Map<string, number>();
  const wantsBranchChanges = (cwd: string) => branchChangesDemand.has(cwd);
  const acquireBranchChangesDemand = (cwd: string) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        branchChangesDemand.set(cwd, (branchChangesDemand.get(cwd) ?? 0) + 1);
      }),
      () =>
        Effect.sync(() => {
          const count = (branchChangesDemand.get(cwd) ?? 1) - 1;
          if (count > 0) branchChangesDemand.set(cwd, count);
          else branchChangesDemand.delete(cwd);
        }),
    );

  const readLocalStatus = Effect.fn("VcsStatusBroadcaster.readLocalStatus")(function* (
    cwd: string,
  ) {
    const includeBranchChanges = wantsBranchChanges(cwd);
    const local = yield* workflow.localStatus({ cwd }, { includeBranchChanges });
    // A subscriber that shows totals arrived during the read and must not receive it without them.
    if (!includeBranchChanges && wantsBranchChanges(cwd)) {
      return {
        local: yield* workflow.localStatus({ cwd }, { includeBranchChanges: true }),
        includesBranchChanges: true,
      };
    }
    return { local, includesBranchChanges: includeBranchChanges };
  });

  const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
    function* (
      cwd: string,
      read: { readonly local: VcsStatusLocalResult; readonly includesBranchChanges: boolean },
      observation: number,
      options?: { publish?: boolean },
    ) {
      const { local, includesBranchChanges } = read;
      const nextLocal = {
        fingerprint: fingerprintStatusPart(local),
        value: local,
        includesBranchChanges,
      };
      const [localChanged, remoteCleared] = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const remote = previous.remote?.branch === local.refName ? previous.remote : null;
        return [
          [previous.local?.fingerprint !== nextLocal.fingerprint, previous.remote !== remote],
          retainCachedStatus(cache, cwd, { local: nextLocal, remote }),
        ] as const;
      });
      yield* publishBranch(cwd, local, observation);
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
      upstreamReads.delete(cwd);
      const [changed, value] = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const next = remote?.branch === previous.local?.value.refName ? remote : null;
        return [
          [previous.remote?.fingerprint !== next?.fingerprint, next?.value ?? null],
          retainCachedStatus(cache, cwd, { ...previous, remote: next }),
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
    options?: { publish?: boolean },
  ) {
    const observation = ++branchObservation;
    return yield* updateCachedLocalStatus(cwd, yield* readLocalStatus(cwd), observation, options);
  });

  // A branch read while a HEAD watch was ready stays current for that watch's lifetime: any
  // checkout after it reaches the cache through the watch. A reconnect burst then forks git once.
  const branchConfirmedUnder = new Map<string, Fiber.Fiber<void, never>>();
  // Bumped on every HEAD event, so a read that a checkout overtook cannot confirm its branch.
  const headGenerations = new Map<string, number>();
  const readyHeadWatch = (cwd: string) =>
    SynchronizedRef.get(headWatchersRef).pipe(
      Effect.map((watchers) => {
        const watcher = watchers.get(cwd);
        return watcher &&
          watcher.fiber.pollUnsafe() === undefined &&
          Deferred.isDoneUnsafe(watcher.ready)
          ? watcher.fiber
          : undefined;
      }),
    );

  const getOrLoadLocalStatusUnlocked = Effect.fn("VcsStatusBroadcaster.getOrLoadLocalStatus")(
    function* (cwd: string) {
      const watch = yield* readyHeadWatch(cwd);
      const generation = headGenerations.get(cwd);
      const confirm = <A>(value: A) => {
        if (watch !== undefined && headGenerations.get(cwd) === generation) {
          branchConfirmedUnder.set(cwd, watch);
        }
        return value;
      };
      const cached = yield* getCachedStatus(cwd);
      if (cached?.local) {
        if (cached.local.includesBranchChanges || !wantsBranchChanges(cwd)) {
          if (watch !== undefined && branchConfirmedUnder.get(cwd) === watch) {
            return cached.local.value;
          }
          const branch = yield* workflow.currentBranch(cwd);
          if (branch === cached.local.value.refName) return confirm(cached.local.value);
        }
        yield* workflow.invalidateLocalStatus(cwd);
        return confirm(yield* loadLocalStatus(cwd, { publish: true }));
      }
      return confirm(yield* loadLocalStatus(cwd));
    },
  );

  const getOrLoadLocalStatus = (cwd: string) =>
    localRefreshLocks.withLock(cwd, getOrLoadLocalStatusUnlocked(cwd));

  const getStatusParts = Effect.fn("VcsStatusBroadcaster.getStatusParts")(function* (cwd: string) {
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local) {
      return { local: cached.local.value, remote: cached.remote?.value ?? null };
    }
    return { local: yield* getOrLoadLocalStatus(cwd), remote: null };
  });

  const withFileSystem = Effect.provideService(FileSystem.FileSystem, fs);

  const getStatus: VcsStatusBroadcaster["Service"]["getStatus"] = Effect.fn(
    "VcsStatusBroadcaster.getStatus",
  )(function* (input) {
    const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
    yield* acquireBranchChangesDemand(cwd);
    yield* getOrLoadLocalStatus(cwd);
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local && cached.remote) {
      return mergeGitStatusParts(cached.local.value, cached.remote.value);
    }
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        const latest = yield* getCachedStatus(cwd);
        const refreshUpstream = !Duration.isZero(yield* automaticFetchInterval);
        const remote = latest?.remote ?? (yield* readRemoteStatus(cwd, { refreshUpstream })).remote;
        yield* updateCachedRemoteStatus(cwd, remote);
        const parts = yield* getStatusParts(cwd);
        return mergeGitStatusParts(parts.local, parts.remote);
      }),
    );
  }, Effect.scoped);

  const refreshLocalStatusCore = Effect.fn("VcsStatusBroadcaster.refreshLocalStatusCore")(
    function* (cwd: string) {
      const requestedAt = (localRefreshRequests.get(cwd) ?? 0) + 1;
      localRefreshRequests.set(cwd, requestedAt);
      return yield* localRefreshLocks.withLock(
        cwd,
        Effect.gen(function* () {
          const shared = localRefreshResults.get(cwd);
          if (
            shared !== undefined &&
            shared.startedAt >= requestedAt &&
            (shared.includesBranchChanges || !wantsBranchChanges(cwd))
          ) {
            return shared.local;
          }
          const startedAt = localRefreshRequests.get(cwd) ?? requestedAt;
          yield* workflow.invalidateLocalStatus(cwd);
          const observation = ++branchObservation;
          const read = yield* readLocalStatus(cwd);
          localRefreshResults.set(cwd, { startedAt, ...read });
          return yield* updateCachedLocalStatus(cwd, read, observation, { publish: true });
        }),
      );
    },
  );

  const refreshLocalStatus: VcsStatusBroadcaster["Service"]["refreshLocalStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshLocalStatus",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    upstreamReads.delete(cwd);
    const local = yield* refreshLocalStatusCore(cwd);
    const cached = yield* getCachedStatus(cwd);
    // Divergence is local Git data; a slow forge lookup must not delay turn-end updates.
    if (cached?.remote?.value?.hasUpstream) {
      const divergence = yield* workflow.upstreamDivergence(cwd);
      const latest = yield* getCachedStatus(cwd);
      if (divergence && latest?.remote?.value && latest.remote.branch === divergence.refName) {
        const value = {
          ...latest.remote.value,
          aheadCount: divergence.aheadCount,
          behindCount: divergence.behindCount,
        };
        yield* updateCachedRemoteStatus(
          cwd,
          {
            branch: divergence.refName,
            value,
            fingerprint: fingerprintStatusPart(value),
          },
          { publish: true },
        );
        upstreamReads.set(cwd, divergence.details);
      }
    }
    return local;
  });

  const readRemoteStatus = Effect.fn("VcsStatusBroadcaster.readRemoteStatus")(function* (
    cwd: string,
    options?: Parameters<GitWorkflowService.GitWorkflowService["Service"]["remoteStatus"]>[1],
    readPollInputs = false,
  ) {
    const branch = yield* workflow.currentBranch(cwd);
    // GitManager's remote TTL cache is keyed by cwd, not the checked-out branch.
    yield* workflow.invalidateRemoteStatus(cwd);
    const previousRemote = (yield* getCachedStatus(cwd))?.remote;
    const { statusDetails, ...remoteOptions } = options ?? {};
    const poll = readPollInputs
      ? yield* workflow.readStatusPoll(cwd, branch, remoteOptions.refreshUpstream !== false)
      : null;
    const details = poll?.details ?? statusDetails;
    const remote = yield* workflow.remoteStatus(
      { cwd },
      {
        ...remoteOptions,
        ...(readPollInputs ? { refreshUpstream: false } : {}),
        ...(details?.branch === branch ? { statusDetails: details } : {}),
      },
    );
    const latest = yield* getCachedStatus(cwd);
    // An overlapping turn refresh and fetch can both move divergence during the forge lookup.
    const refreshed =
      remote?.hasUpstream && latest?.remote !== previousRemote && latest?.remote?.branch === branch
        ? yield* workflow.upstreamDivergence(cwd)
        : null;
    const value =
      remote && refreshed?.refName === branch
        ? { ...remote, aheadCount: refreshed.aheadCount, behindCount: refreshed.behindCount }
        : remote;
    const currentBranch = yield* workflow.currentBranch(cwd);
    const cached = yield* getCachedStatus(cwd);
    const refreshedLocal =
      branch !== currentBranch || cached?.local?.value.refName !== currentBranch;
    // Read before the local refresh: a base that moves after it changes the next poll's stamp.
    const inputStamp = branch === currentBranch && poll ? yield* poll.inputStampAfterLookup : null;
    if (refreshedLocal) {
      yield* refreshLocalStatusCore(cwd);
    }
    return {
      remote:
        branch === currentBranch
          ? { branch, value, fingerprint: fingerprintStatusPart(value) }
          : null,
      inputStamp,
      refreshedLocal,
    };
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
      const { remote: refreshedRemote } = yield* readRemoteStatus(cwd, { refreshUpstream: false });
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
      /** Git inputs seen before this poller's last full local read. */
      readonly inputsAtLocalRead?: Ref.Ref<string | null>;
    },
  ) {
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        const inputsAtLocalRead = options?.inputsAtLocalRead;
        const {
          remote: remoteRead,
          inputStamp,
          refreshedLocal,
        } = yield* readRemoteStatus(cwd, options, inputsAtLocalRead !== undefined);
        const pulled =
          options?.refreshUpstream === false
            ? null
            : yield* maybeAutoPull(cwd, remoteRead, options?.policyCwds ?? [cwd]);
        if (pulled !== null) {
          if (inputsAtLocalRead !== undefined) yield* Ref.set(inputsAtLocalRead, null);
          return pulled.remote;
        }
        // Base refs and merge bases can move without changing divergence counts.
        if (inputsAtLocalRead === undefined) {
          if (!refreshedLocal) yield* refreshLocalStatusCore(cwd);
        } else if (inputStamp === null || inputStamp !== (yield* Ref.get(inputsAtLocalRead))) {
          yield* Ref.set(inputsAtLocalRead, null);
          if (!refreshedLocal) yield* refreshLocalStatusCore(cwd);
          yield* Ref.set(inputsAtLocalRead, inputStamp);
        }
        return yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
      }),
    );
  });

  const refreshRemoteAndLocalTotals = Effect.fn("VcsStatusBroadcaster.refreshRemoteAndLocalTotals")(
    function* (cwd: string, policyCwd: string, refsBeforeLocalRead: string | null) {
      return yield* withRemoteWriteLock(
        cwd,
        Effect.gen(function* () {
          const refreshUpstream = !Duration.isZero(yield* automaticFetchInterval);
          // Bump the PR lookup epoch after earlier remote writers have finished.
          yield* workflow.invalidateStatus(cwd);
          const { remote: remoteRead } = yield* readRemoteStatus(cwd, { refreshUpstream });
          // Without a fetch, the cached behind count cannot justify an automatic pull.
          const pulled = refreshUpstream
            ? yield* maybeAutoPull(cwd, remoteRead, [policyCwd])
            : null;
          if (pulled !== null) {
            return { status: mergeGitStatusParts(pulled.local, pulled.remote), refs: null };
          }
          yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
          // A fetch, ours or not, can move the base used for local Changes totals.
          const refs =
            refsBeforeLocalRead === null ? null : yield* workflow.readStatusRefreshRefs(cwd);
          if (refs === null || refs !== refsBeforeLocalRead) {
            yield* refreshLocalStatusCore(cwd);
          }
          const parts = yield* getStatusParts(cwd);
          return { status: mergeGitStatusParts(parts.local, parts.remote), refs };
        }),
      );
    },
  );

  const refreshStatus: VcsStatusBroadcaster["Service"]["refreshStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshStatus",
  )(function* (rawCwd, options) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    yield* acquireBranchChangesDemand(cwd);
    // Lets the client keep its cached branch list when refs and worktree paths match its last refresh.
    const withRefsDigest = (status: VcsStatusResult, refs: string | null) =>
      refs === null
        ? status
        : {
            ...status,
            refsDigest: NodeCrypto.createHash("sha256").update(refs).digest("hex").slice(0, 32),
          };
    if (options?.localOnly) {
      const [refs] = yield* Effect.all(
        [workflow.readRefSnapshot(cwd), refreshLocalStatusCore(cwd)],
        { concurrency: "unbounded" },
      );
      // Never cache a remote here: readers take `value: null` as "read and found no PR".
      const parts = yield* getStatusParts(cwd);
      return withRefsDigest(mergeGitStatusParts(parts.local, parts.remote), refs);
    }
    const refsBeforeLocalRead = yield* workflow.readStatusRefreshRefs(cwd);
    yield* refreshLocalStatusCore(cwd);
    const { status, refs } = yield* refreshRemoteAndLocalTotals(cwd, rawCwd, refsBeforeLocalRead);
    return withRefsDigest(
      status,
      refs === null ? null : yield* workflow.readRefSnapshot(cwd, refs),
    );
  }, Effect.scoped);

  const refreshRemoteAfterCheckout = Effect.fn("VcsStatusBroadcaster.refreshRemoteAfterCheckout")(
    function* (cwd: string, policyCwd: string, refsBeforeLocalRead: string | null) {
      yield* withRemoteWriteLock(
        cwd,
        Effect.gen(function* () {
          const refreshUpstream = !Duration.isZero(yield* automaticFetchInterval);
          yield* workflow.invalidateStatus(cwd, { keepPullRequestLookups: true });
          const remoteRead = yield* readRemoteStatus(cwd, { refreshUpstream });
          // A fetch, ours or not, can move the base used for local Changes totals.
          if (
            refsBeforeLocalRead === null ||
            (yield* workflow.readLocalStatusRefSnapshot(cwd)) !== refsBeforeLocalRead
          ) {
            yield* refreshLocalStatusCore(cwd);
          }
          // Without a fetch, the cached behind count cannot justify an automatic pull.
          const pulled = refreshUpstream
            ? yield* maybeAutoPull(cwd, remoteRead, [policyCwd])
            : null;
          if (pulled === null) {
            yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
          }
        }),
      );
    },
    // Someone just picked this branch, so its PR lookup skips the background batching delay.
    Effect.provideService(SourceControlRateLimit.Interactive, true),
  );

  const refreshAfterCheckout: VcsStatusBroadcaster["Service"]["refreshAfterCheckout"] = Effect.fn(
    "VcsStatusBroadcaster.refreshAfterCheckout",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    // Taken before the local read, so a fetch that finishes after it still triggers a re-read.
    const refsBeforeLocalRead = yield* workflow.readLocalStatusRefSnapshot(cwd);
    const localDone = yield* Deferred.make<void>();
    // Owned by the broadcaster so a client disconnecting mid-switch still leaves status correct.
    yield* refreshLocalStatusCore(cwd).pipe(
      Effect.ensuring(Deferred.succeed(localDone, undefined)),
      Effect.andThen(refreshRemoteAfterCheckout(cwd, rawCwd, refsBeforeLocalRead)),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(broadcasterScope),
    );
    yield* Deferred.await(localDone);
  });

  const refreshPullRequestStatus: VcsStatusBroadcaster["Service"]["refreshPullRequestStatus"] =
    Effect.fn("VcsStatusBroadcaster.refreshPullRequestStatus")(function* (rawCwd) {
      const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
      return yield* withRemoteWriteLock(
        cwd,
        Effect.gen(function* () {
          const cached = yield* getCachedStatus(cwd);
          if (!cached || cached.remote?.value === null) return null;
          // Turn completion must update divergence even when background polling is paused.
          const statusDetails = upstreamReads.get(cwd);
          upstreamReads.delete(cwd);
          const { remote: remoteRead } = yield* readRemoteStatus(cwd, {
            refreshUpstream: false,
            refreshMissingPullRequest: true,
            ...(statusDetails ? { statusDetails } : {}),
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
    const inputsAtLocalReadRef = yield* Ref.make<string | null>(null);
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
        inputsAtLocalRead: inputsAtLocalReadRef,
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

  // A request made during a refresh needs a read that starts after it, so overlapping requests
  // share one follow-up. Keyed by raw cwd because auto-pull policy depends on it.
  // Missing means idle; null means running with no follow-up queued.
  type SharedRefresh = Deferred.Deferred<VcsRefreshStatusResult, GitManagerServiceError>;
  const queuedRefreshesRef = yield* Ref.make(new Map<string, SharedRefresh | null>());

  const runQueuedRefreshes = Effect.fn("VcsStatusBroadcaster.runQueuedRefreshes")(function* (
    rawCwd: string,
    first: SharedRefresh,
  ) {
    let next: SharedRefresh | null = first;
    while (next !== null) {
      yield* Deferred.into(refreshStatus(rawCwd), next);
      next = yield* Ref.modify(queuedRefreshesRef, (queued) => {
        const followUp = queued.get(rawCwd) ?? null;
        const nextQueued = new Map(queued);
        if (followUp === null) {
          nextQueued.delete(rawCwd);
        } else {
          nextQueued.set(rawCwd, null);
        }
        return [followUp, nextQueued] as const;
      });
    }
  });

  const shareQueuedRefreshStatus: VcsStatusBroadcaster["Service"]["refreshStatus"] = Effect.fn(
    "VcsStatusBroadcaster.shareQueuedRefreshStatus",
  )(function* (rawCwd, options) {
    if (options?.localOnly) return yield* refreshStatus(rawCwd, options);
    const requested = yield* Deferred.make<VcsRefreshStatusResult, GitManagerServiceError>();
    // Registering and forking together keeps an interrupt from leaving an entry with no worker.
    const shared = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const followUp = yield* Ref.modify(
          queuedRefreshesRef,
          (queued): readonly [SharedRefresh | undefined, Map<string, SharedRefresh | null>] => {
            if (!queued.has(rawCwd)) return [undefined, new Map(queued).set(rawCwd, null)];
            const followUp = queued.get(rawCwd) ?? requested;
            return [followUp, new Map(queued).set(rawCwd, followUp)];
          },
        );
        if (followUp !== undefined) return followUp;
        // The broadcaster scope owns the work, so one caller's interrupt does not cancel it for the rest.
        yield* runQueuedRefreshes(rawCwd, requested).pipe(Effect.forkIn(broadcasterScope));
        return requested;
      }),
    );
    return yield* Deferred.await(shared);
  });

  const readHeadBranch = Effect.fn("VcsStatusBroadcaster.readHeadBranch")(function* (cwd: string) {
    const observation = ++branchObservation;
    const refName = yield* workflow.currentBranch(cwd);
    // A null branch is a detached HEAD or a checkout that is gone, such as a removed worktree.
    const isRepo = refName !== null || (yield* workflow.repositoryRoot(cwd)) !== null;
    return { observation, refName, isRepo };
  });

  // Keep cache invalidation serialized with detailed reads and refreshes.
  const refreshBranchStatusCore = Effect.fn("VcsStatusBroadcaster.refreshBranchStatusCore")(
    (cwd: string) =>
      localRefreshLocks.withLock(
        cwd,
        Effect.gen(function* () {
          if (detailedSubscribers.has(cwd)) {
            const local = yield* getOrLoadLocalStatusUnlocked(cwd);
            return (
              branches.get(cwd) ?? { refName: local.refName, isRepo: local.isRepo, revision: 0 }
            );
          }
          const { observation, refName, isRepo } = yield* readHeadBranch(cwd);
          // HEAD cannot certify working-tree totals, even when it has not moved.
          localRefreshResults.delete(cwd);
          yield* workflow.invalidateLocalStatus(cwd);
          yield* Ref.update(cacheRef, (cache) => {
            const previous = cache.get(cwd);
            return previous ? new Map(cache).set(cwd, { ...previous, local: null }) : cache;
          });
          if (detailedSubscribers.has(cwd)) {
            const local = yield* loadLocalStatus(cwd, { publish: true });
            return (
              branches.get(cwd) ?? { refName: local.refName, isRepo: local.isRepo, revision: 0 }
            );
          }
          yield* publishBranch(cwd, { refName, isRepo }, observation);
          return branches.get(cwd) ?? { refName, isRepo, revision: 0 };
        }),
      ),
  );

  // A checkout outside T3 Code, such as `git switch` in the terminal, calls no refresh RPC.
  // Rereading remote too, without a fetch, sends the new branch with its own PR and counts.
  const publishCheckedOutRef = Effect.fn("VcsStatusBroadcaster.publishCheckedOutRef")(function* (
    cwd: string,
  ) {
    if (!detailedSubscribers.has(cwd)) return yield* refreshBranchStatusCore(cwd);
    const { observation, refName, isRepo } = yield* readHeadBranch(cwd);
    yield* publishBranch(cwd, { refName, isRepo }, observation);
  });

  const reconcileCheckedOutRef = Effect.fn("VcsStatusBroadcaster.reconcileCheckedOutRef")(
    function* (cwd: string) {
      if (!detailedSubscribers.has(cwd)) return;
      if ((yield* getCachedStatus(cwd))?.remote) {
        yield* refreshRemoteStatus(cwd, { refreshUpstream: false });
      } else {
        yield* refreshLocalStatusCore(cwd);
      }
    },
  );

  const retryCheckedOutRef = <E>(cwd: string, refresh: Effect.Effect<unknown, E>) =>
    refresh.pipe(
      Effect.retry(CHECKOUT_REFRESH_RETRY),
      Effect.catchCause((cause) =>
        Effect.logWarning("VCS checked-out ref refresh failed", {
          cwdLength: cwd.length,
          ...remoteRefreshFailureDiagnostics(cause),
        }),
      ),
    );

  // Runs for the subscription lifetime, so tracing would leave a span open indefinitely.
  const watchHead = Effect.fnUntraced(function* (cwd: string, ready: Deferred.Deferred<void>) {
    const headPath = yield* workflow.headPath(cwd);
    if (headPath === null) return;
    const headDirectory = path.dirname(headPath);
    const isDir = (dir: string) =>
      fs.stat(dir).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
    const reftableDirs: Array<string> = [];
    const headReftable = path.resolve(headDirectory, "reftable");
    if (yield* isDir(headReftable)) {
      reftableDirs.push(headReftable);
      const common = yield* fs.readFileString(path.join(headDirectory, "commondir")).pipe(
        Effect.map((v) => (v.trim() ? path.resolve(headDirectory, v.trim(), "reftable") : null)),
        Effect.orElseSucceed(() => null),
      );
      if (common && common !== headReftable && (yield* isDir(common))) reftableDirs.push(common);
    }
    const readyDirs = new Set<string>();
    const markReady = (dir: string) => {
      readyDirs.add(dir);
      if (readyDirs.size >= 1 + reftableDirs.length) Deferred.doneUnsafe(ready, Exit.void);
    };
    const watchReftable = (dir: string) =>
      fs.watch(dir, { onReady: () => markReady(dir) }).pipe(
        Stream.takeUntilEffect((e) =>
          e._tag === "Remove"
            ? fs.exists(dir).pipe(Effect.map((ok) => !ok))
            : Effect.succeed(false),
        ),
        Stream.filter((e) => path.basename(e.path) === "tables.list" && e._tag !== "Remove"),
        Stream.catchIf(
          (e) => e.reason._tag === "NotFound",
          () => Stream.empty,
        ),
        Stream.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Stream.failCause(cause)
            : Stream.drain(
                Stream.fromEffect(
                  Effect.logWarning("VCS reftable watch failed", {
                    cwdLength: cwd.length,
                    ...remoteRefreshFailureDiagnostics(cause),
                  }),
                ),
              ),
        ),
        Stream.ensuring(Effect.sync(() => markReady(dir))),
      );
    // Git replaces HEAD by renaming HEAD.lock, which a watch on the file itself would lose.
    yield* fs
      .watch(headDirectory, {
        onReady: () => markReady(headDirectory),
      })
      .pipe(
        // On Windows a watch outlives its deleted directory and reports it ~150k times a second.
        Stream.takeUntilEffect((event) =>
          event._tag === "Remove"
            ? fs.exists(headDirectory).pipe(Effect.map((exists) => !exists))
            : Effect.succeed(false),
        ),
        // Commits rewrite index; soft resets and other ref moves through HEAD unlink HEAD.lock
        // after updating the branch ref (filtering to Remove avoids firing while the lock is held).
        Stream.filter((event) => {
          const name = path.basename(event.path);
          return (
            name === "HEAD" || name === "index" || (name === "HEAD.lock" && event._tag === "Remove")
          );
        }),
        // Reftable repos keep a static HEAD placeholder and replace tables.list (and commondir's in worktrees).
        (headEvents) =>
          reftableDirs.reduce(
            (merged, dir) => Stream.merge(merged, watchReftable(dir), { haltStrategy: "left" }),
            headEvents,
          ),
        // On arrival: the cache keeps the old branch until reads below land, and they can retry.
        Stream.tap(() =>
          Effect.sync(() => {
            branchConfirmedUnder.delete(cwd);
            headGenerations.set(cwd, (headGenerations.get(cwd) ?? 0) + 1);
          }),
        ),
        // A rebase moves HEAD many times; refresh once for whatever arrived during a refresh.
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.mapEffect(() => retryCheckedOutRef(cwd, publishCheckedOutRef(cwd))),
        // Detailed status waits behind its own reads; the branch keeps up on the stage above.
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.runForEach(() => retryCheckedOutRef(cwd, reconcileCheckedOutRef(cwd))),
      );
  });

  const retainHeadWatcher = Effect.fn("VcsStatusBroadcaster.retainHeadWatcher")(function* (
    cwd: string,
  ) {
    const ready = yield* SynchronizedRef.modifyEffect(headWatchersRef, (activeWatchers) => {
      const existing = activeWatchers.get(cwd);
      if (existing && existing.fiber.pollUnsafe() === undefined) {
        const nextWatchers = new Map(activeWatchers).set(cwd, {
          ...existing,
          subscriberCount: existing.subscriberCount + 1,
        });
        return Effect.succeed([existing.ready, nextWatchers] as const);
      }
      // A watch that ended, say before the repository existed, restarts for everyone holding it.
      return Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const fiber = yield* watchHead(cwd, ready).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("VCS HEAD watch failed", {
              cwdLength: cwd.length,
              ...remoteRefreshFailureDiagnostics(cause),
            }),
          ),
          // Subscribers wait for the watch, so one that cannot start must not hold them.
          Effect.ensuring(Deferred.succeed(ready, undefined)),
          Effect.forkIn(broadcasterScope),
        );
        const nextWatchers = new Map(activeWatchers).set(cwd, {
          fiber,
          ready,
          subscriberCount: (existing?.subscriberCount ?? 0) + 1,
        });
        return [ready, nextWatchers] as const;
      });
    });
    yield* Deferred.await(ready);
  });

  const releaseHeadWatcher = Effect.fn("VcsStatusBroadcaster.releaseHeadWatcher")(function* (
    cwd: string,
  ) {
    const watcherToInterrupt = yield* SynchronizedRef.modify(headWatchersRef, (activeWatchers) => {
      const existing = activeWatchers.get(cwd);
      if (!existing) return [null, activeWatchers] as const;
      const nextWatchers = new Map(activeWatchers);
      if (existing.subscriberCount > 1) {
        nextWatchers.set(cwd, { ...existing, subscriberCount: existing.subscriberCount - 1 });
        return [null, nextWatchers] as const;
      }
      nextWatchers.delete(cwd);
      // In this step, so a watch that registers next for cwd cannot lose its generation.
      if (branchConfirmedUnder.get(cwd) === existing.fiber) branchConfirmedUnder.delete(cwd);
      headGenerations.delete(cwd);
      return [existing.fiber, nextWatchers] as const;
    });
    if (watcherToInterrupt) {
      yield* Fiber.interrupt(watcherToInterrupt).pipe(Effect.ignore);
    }
  });

  const streamStatus: VcsStatusBroadcaster["Service"]["streamStatus"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = detailedSubscribers.get(cwd) ?? 0;
            detailedSubscribers.set(cwd, previous + 1);
          }),
          () =>
            Effect.sync(() => {
              const remaining = (detailedSubscribers.get(cwd) ?? 1) - 1;
              if (remaining === 0) detailedSubscribers.delete(cwd);
              else detailedSubscribers.set(cwd, remaining);
            }).pipe(Effect.andThen(trimCachedStatuses)),
        );
        if (input.includeRemote !== false) yield* acquireBranchChangesDemand(cwd);
        const subscription = yield* PubSub.subscribe(changesPubSub);
        // Watch before reading so a checkout in between still publishes.
        yield* Effect.acquireRelease(retainHeadWatcher(cwd), () => releaseHeadWatcher(cwd));
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

  const refreshBranchStatus: VcsStatusBroadcaster["Service"]["refreshBranchStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshBranchStatus",
  )(function* (input) {
    const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
    if (!detailedSubscribers.has(cwd)) {
      const { refName, isRepo } = yield* refreshBranchStatusCore(cwd);
      return { refName, isRepo };
    }
    const { observation, refName, isRepo } = yield* readHeadBranch(cwd);
    yield* publishBranch(cwd, { refName, isRepo }, observation);
    yield* refreshBranchStatusCore(cwd).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("VCS branch refresh failed", {
          cwdLength: cwd.length,
          ...remoteRefreshFailureDiagnostics(cause),
        }),
      ),
      Effect.forkIn(broadcasterScope),
    );
    return { refName, isRepo };
  });

  const streamBranchStatus: VcsStatusBroadcaster["Service"]["streamBranchStatus"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
        const subscription = yield* PubSub.subscribe(branchChangesPubSub);
        yield* Effect.acquireRelease(retainHeadWatcher(cwd), () => releaseHeadWatcher(cwd));
        const branch = yield* refreshBranchStatusCore(cwd);
        return Stream.concat(
          Stream.make({ refName: branch.refName, isRepo: branch.isRepo }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.cwd === cwd && event.revision > branch.revision),
            Stream.map(({ refName, isRepo }) => ({ refName, isRepo })),
          ),
        ).pipe(
          Stream.changesWith(
            (left, right) => left.refName === right.refName && left.isRepo === right.isRepo,
          ),
        );
      }),
    );

  return VcsStatusBroadcaster.of({
    streamBranchStatus,
    refreshBranchStatus,
    streamBranchChanges: Stream.fromPubSub(branchChangesPubSub).pipe(
      Stream.map(({ cwd, refName }) => ({ cwd, refName })),
    ),
    getStatus,
    refreshLocalStatus,
    refreshAfterCheckout,
    refreshStatus: shareQueuedRefreshStatus,
    refreshPullRequestStatus,
    streamStatus,
  });
});

export const layer = Layer.effect(VcsStatusBroadcaster, make);

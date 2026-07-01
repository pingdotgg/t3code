import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { mergeGitStatusParts } from "@t3tools/shared/git";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { localWatchRefreshSignals, watchEventPath } from "./VcsLocalWatch.ts";
import * as VcsProcess from "./VcsProcess.ts";

export { localWatchRefreshSignals, shouldIgnoreWatchEventPath } from "./VcsLocalWatch.ts";

const DEFAULT_VCS_STATUS_REFRESH_INTERVAL = Duration.seconds(30);
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
}

interface ActiveLocalWatcher {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
}

interface StreamStatusOptions {
  readonly automaticRemoteRefreshInterval?: Effect.Effect<Duration.Duration, never>;
}

const LOCAL_WATCHER_KEY_SEPARATOR = "\0";

function localWatcherKey(watchCwd: string, refreshCwd: string): string {
  return `${watchCwd}${LOCAL_WATCHER_KEY_SEPARATOR}${refreshCwd}`;
}

export function parseWorktreePaths(output: string): readonly string[] {
  return output
    .split(/\r?\n/u)
    .flatMap((line) => (line.startsWith("worktree ") ? [line.slice("worktree ".length)] : []))
    .filter((worktreePath) => worktreePath.length > 0);
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
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* Effect.serviceOption(VcsProcess.VcsProcess);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<VcsStatusChange>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const cacheRef = yield* Ref.make(new Map<string, CachedVcsStatus>());
  const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());
  const watchersRef = yield* SynchronizedRef.make(new Map<string, ActiveLocalWatcher>());

  const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
    cwd: string,
  ) {
    return yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));
  });

  const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
    function* (
      cwd: string,
      local: VcsStatusLocalResult,
      options?: { publish?: boolean; forcePublish?: boolean },
    ) {
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
        return [
          options?.forcePublish === true || previous.local?.fingerprint !== nextLocal.fingerprint,
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
    function* (cwd: string, options?: { forcePublish?: boolean }) {
      yield* workflow.invalidateLocalStatus(cwd);
      const local = yield* workflow.localStatus({ cwd });
      return yield* updateCachedLocalStatus(cwd, local, {
        publish: true,
        ...(options?.forcePublish === true ? { forcePublish: true } : {}),
      });
    },
  );

  const refreshLocalStatus: VcsStatusBroadcaster["Service"]["refreshLocalStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshLocalStatus",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    return yield* refreshLocalStatusCore(cwd, { forcePublish: true });
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
    yield* Effect.all([workflow.invalidateLocalStatus(cwd), workflow.invalidateRemoteStatus(cwd)], {
      concurrency: "unbounded",
      discard: true,
    });
    const [local, remote] = yield* Effect.all(
      [workflow.localStatus({ cwd }), workflow.remoteStatus({ cwd })],
      { concurrency: "unbounded" },
    );
    return yield* updateCachedStatus(cwd, local, remote, { publish: true });
  });

  const makeRemoteRefreshLoop = (
    cwd: string,
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
            Schedule.addDelay((delay) => Effect.succeed(delay)),
          ),
        ),
        Effect.asVoid,
      );
    });
  };

  const retainRemotePoller = Effect.fn("VcsStatusBroadcaster.retainRemotePoller")(function* (
    cwd: string,
    automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    refreshImmediately: boolean,
  ) {
    yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
      const existing = activePollers.get(cwd);
      if (existing) {
        const nextPollers = new Map(activePollers);
        nextPollers.set(cwd, {
          ...existing,
          subscriberCount: existing.subscriberCount + 1,
        });
        return Effect.succeed([undefined, nextPollers] as const);
      }

      return makeRemoteRefreshLoop(cwd, automaticRemoteRefreshInterval, refreshImmediately).pipe(
        Effect.forkIn(broadcasterScope),
        Effect.map((fiber) => {
          const nextPollers = new Map(activePollers);
          nextPollers.set(cwd, {
            fiber,
            subscriberCount: 1,
          });
          return [undefined, nextPollers] as const;
        }),
      );
    });
  });

  const releaseRemotePoller = Effect.fn("VcsStatusBroadcaster.releaseRemotePoller")(function* (
    cwd: string,
  ) {
    const pollerToInterrupt = yield* SynchronizedRef.modify(pollersRef, (activePollers) => {
      const existing = activePollers.get(cwd);
      if (!existing) {
        return [null, activePollers] as const;
      }

      if (existing.subscriberCount > 1) {
        const nextPollers = new Map(activePollers);
        nextPollers.set(cwd, {
          ...existing,
          subscriberCount: existing.subscriberCount - 1,
        });
        return [null, nextPollers] as const;
      }

      const nextPollers = new Map(activePollers);
      nextPollers.delete(cwd);
      return [existing.fiber, nextPollers] as const;
    });

    if (pollerToInterrupt) {
      yield* Fiber.interrupt(pollerToInterrupt).pipe(Effect.ignore);
    }
  });

  const worktreeWatchPaths = Effect.fn("VcsStatusBroadcaster.worktreeWatchPaths")(function* (
    cwd: string,
  ) {
    if (Option.isNone(vcsProcess)) return [];
    const result = yield* vcsProcess.value
      .run({
        operation: "VcsStatusBroadcaster.worktrees",
        command: "git",
        args: ["worktree", "list", "--porcelain"],
        cwd,
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 1_000_000,
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (result === null || result.exitCode !== 0) return [];
    const rootPath = path.resolve(cwd);
    const candidatePaths = parseWorktreePaths(result.stdout).filter(
      (worktreePath) => path.resolve(worktreePath) !== rootPath,
    );
    const existingPaths = yield* Effect.forEach(candidatePaths, (worktreePath) =>
      fs.exists(worktreePath).pipe(
        Effect.orElseSucceed(() => false),
        Effect.map((exists) => (exists ? worktreePath : null)),
      ),
    );
    return existingPaths.filter((worktreePath): worktreePath is string => worktreePath !== null);
  });

  const makeLocalWatchLoop = (watchCwd: string, refreshCwd: string) =>
    localWatchRefreshSignals(
      fs.watch(watchCwd).pipe(
        Stream.map((event) => watchEventPath(path, watchCwd, event.path)),
        Stream.filter((relativePath): relativePath is string => relativePath !== null),
      ),
      (relativePaths) =>
        Option.match(vcsProcess, {
          onNone: () => Effect.succeed(true),
          onSome: (process) =>
            process
              .run({
                operation: "VcsStatusBroadcaster.watch.checkIgnore",
                command: "git",
                args: ["check-ignore", "-z", "--stdin"],
                cwd: watchCwd,
                stdin: `${relativePaths.join("\0")}\0`,
                allowNonZeroExit: true,
                timeoutMs: 5_000,
                maxOutputBytes: 1_000_000,
              })
              .pipe(
                Effect.map((result) => {
                  if (result.exitCode !== 0) return true;
                  const ignoredPaths = new Set(
                    result.stdout.split("\0").filter((ignoredPath) => ignoredPath.length > 0),
                  );
                  return relativePaths.some((relativePath) => !ignoredPaths.has(relativePath));
                }),
                Effect.orElseSucceed(() => true),
              ),
        }),
    ).pipe(
      Stream.runForEach(() =>
        refreshLocalStatusCore(refreshCwd, { forcePublish: true }).pipe(
          Effect.ignoreCause({ log: true }),
        ),
      ),
      Effect.ignoreCause({ log: true }),
    );

  const retainLocalWatcher = Effect.fn("VcsStatusBroadcaster.retainLocalWatcher")(function* (
    watchCwd: string,
    refreshCwd: string,
  ) {
    const key = localWatcherKey(watchCwd, refreshCwd);
    yield* SynchronizedRef.modifyEffect(watchersRef, (activeWatchers) => {
      const existing = activeWatchers.get(key);
      if (existing) {
        const exit = existing.fiber.pollUnsafe();
        if (exit === undefined) {
          const nextWatchers = new Map(activeWatchers);
          nextWatchers.set(key, {
            ...existing,
            subscriberCount: existing.subscriberCount + 1,
          });
          return Effect.succeed([undefined, nextWatchers] as const);
        }
        return makeLocalWatchLoop(watchCwd, refreshCwd).pipe(
          Effect.forkIn(broadcasterScope),
          Effect.map((fiber) => {
            const nextWatchers = new Map(activeWatchers);
            nextWatchers.set(key, {
              fiber,
              subscriberCount: existing.subscriberCount + 1,
            });
            return [undefined, nextWatchers] as const;
          }),
        );
      }

      return makeLocalWatchLoop(watchCwd, refreshCwd).pipe(
        Effect.forkIn(broadcasterScope),
        Effect.map((fiber) => {
          const nextWatchers = new Map(activeWatchers);
          nextWatchers.set(key, {
            fiber,
            subscriberCount: 1,
          });
          return [undefined, nextWatchers] as const;
        }),
      );
    });
  });

  const releaseLocalWatcher = Effect.fn("VcsStatusBroadcaster.releaseLocalWatcher")(function* (
    watchCwd: string,
    refreshCwd: string,
  ) {
    const key = localWatcherKey(watchCwd, refreshCwd);
    const watcherToInterrupt = yield* SynchronizedRef.modify(watchersRef, (activeWatchers) => {
      const existing = activeWatchers.get(key);
      if (!existing) {
        return [null, activeWatchers] as const;
      }

      if (existing.subscriberCount > 1) {
        const nextWatchers = new Map(activeWatchers);
        nextWatchers.set(key, {
          ...existing,
          subscriberCount: existing.subscriberCount - 1,
        });
        return [null, nextWatchers] as const;
      }

      const nextWatchers = new Map(activeWatchers);
      nextWatchers.delete(key);
      return [existing.fiber, nextWatchers] as const;
    });

    if (watcherToInterrupt) {
      yield* Fiber.interrupt(watcherToInterrupt).pipe(Effect.ignore);
    }
  });

  const streamStatus: VcsStatusBroadcaster["Service"]["streamStatus"] = (input, options) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
        const subscription = yield* PubSub.subscribe(changesPubSub);
        const siblingWatchCwds = yield* worktreeWatchPaths(cwd);
        const watchedCwds = [cwd, ...siblingWatchCwds];
        yield* Effect.forEach(
          watchedCwds,
          (watchCwd) =>
            Effect.acquireRelease(retainLocalWatcher(watchCwd, cwd), () =>
              releaseLocalWatcher(watchCwd, cwd),
            ),
          { discard: true },
        );
        yield* Effect.yieldNow;
        const initialLocal = yield* getOrLoadLocalStatus(cwd);
        const cachedStatus = yield* getCachedStatus(cwd);
        const initialRemote = cachedStatus?.remote?.value ?? null;
        yield* retainRemotePoller(
          cwd,
          options?.automaticRemoteRefreshInterval ??
            Effect.succeed(DEFAULT_VCS_STATUS_REFRESH_INTERVAL),
          cachedStatus?.remote === null || cachedStatus?.remote === undefined,
        );

        const release = Effect.all([releaseRemotePoller(cwd)], { discard: true }).pipe(
          Effect.ignore,
          Effect.asVoid,
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
        ).pipe(Stream.ensuring(release));
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

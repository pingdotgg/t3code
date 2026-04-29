import { realpathSync } from "node:fs";

import {
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  PubSub,
  Ref,
  Scope,
  Stream,
  SynchronizedRef,
} from "effect";
import type {
  ExecutionTarget,
  GitStatusInput,
  GitStatusLocalResult,
  GitStatusRemoteResult,
  GitStatusStreamEvent,
} from "@t3tools/contracts";
import { mergeGitStatusParts } from "@t3tools/shared/git";

import {
  GitStatusBroadcaster,
  type GitStatusBroadcasterShape,
} from "../Services/GitStatusBroadcaster.ts";
import { GitManager } from "../Services/GitManager.ts";

const GIT_STATUS_REFRESH_INTERVAL = Duration.seconds(30);

interface GitStatusChange {
  readonly key: string;
  readonly event: GitStatusStreamEvent;
}

interface CachedValue<T> {
  readonly fingerprint: string;
  readonly value: T;
}

interface CachedGitStatus {
  readonly local: CachedValue<GitStatusLocalResult> | null;
  readonly remote: CachedValue<GitStatusRemoteResult | null> | null;
}

interface ActiveRemotePoller {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
}

function normalizeCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

function normalizeGitStatusInput(input: string | GitStatusInput): GitStatusInput {
  return typeof input === "string" ? { cwd: input } : input;
}

function normalizeStatusCwd(input: GitStatusInput): string {
  return input.executionTarget?.kind === "wsl" ? input.cwd : normalizeCwd(input.cwd);
}

function statusCacheKey(cwd: string, executionTarget?: ExecutionTarget): string {
  return executionTarget?.kind === "wsl"
    ? `wsl:${executionTarget.distroName}:${executionTarget.user ?? ""}:${cwd}`
    : `local:${cwd}`;
}

function fingerprintStatusPart(status: unknown): string {
  return JSON.stringify(status);
}

export const GitStatusBroadcasterLive = Layer.effect(
  GitStatusBroadcaster,
  Effect.gen(function* () {
    const gitManager = yield* GitManager;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<GitStatusChange>(),
      (pubsub) => PubSub.shutdown(pubsub),
    );
    const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const cacheRef = yield* Ref.make(new Map<string, CachedGitStatus>());
    const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());

    const getCachedStatus = Effect.fn("getCachedStatus")(function* (cwd: string) {
      return yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));
    });

    const updateCachedLocalStatus = Effect.fn("updateCachedLocalStatus")(function* (
      key: string,
      local: GitStatusLocalResult,
      options?: { publish?: boolean },
    ) {
      const nextLocal = {
        fingerprint: fingerprintStatusPart(local),
        value: local,
      } satisfies CachedValue<GitStatusLocalResult>;
      const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(key) ?? { local: null, remote: null };
        const nextCache = new Map(cache);
        nextCache.set(key, {
          ...previous,
          local: nextLocal,
        });
        return [previous.local?.fingerprint !== nextLocal.fingerprint, nextCache] as const;
      });

      if (options?.publish && shouldPublish) {
        yield* PubSub.publish(changesPubSub, {
          key,
          event: {
            _tag: "localUpdated",
            local,
          },
        });
      }

      return local;
    });

    const updateCachedRemoteStatus = Effect.fn("updateCachedRemoteStatus")(function* (
      key: string,
      remote: GitStatusRemoteResult | null,
      options?: { publish?: boolean },
    ) {
      const nextRemote = {
        fingerprint: fingerprintStatusPart(remote),
        value: remote,
      } satisfies CachedValue<GitStatusRemoteResult | null>;
      const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(key) ?? { local: null, remote: null };
        const nextCache = new Map(cache);
        nextCache.set(key, {
          ...previous,
          remote: nextRemote,
        });
        return [previous.remote?.fingerprint !== nextRemote.fingerprint, nextCache] as const;
      });

      if (options?.publish && shouldPublish) {
        yield* PubSub.publish(changesPubSub, {
          key,
          event: {
            _tag: "remoteUpdated",
            remote,
          },
        });
      }

      return remote;
    });

    const loadLocalStatus = Effect.fn("loadLocalStatus")(function* (input: GitStatusInput) {
      const cwd = normalizeStatusCwd(input);
      const key = statusCacheKey(cwd, input.executionTarget);
      const local = yield* gitManager.localStatus({ ...input, cwd });
      return yield* updateCachedLocalStatus(key, local);
    });

    const loadRemoteStatus = Effect.fn("loadRemoteStatus")(function* (input: GitStatusInput) {
      const cwd = normalizeStatusCwd(input);
      const key = statusCacheKey(cwd, input.executionTarget);
      const remote = yield* gitManager.remoteStatus({ ...input, cwd });
      return yield* updateCachedRemoteStatus(key, remote);
    });

    const getOrLoadLocalStatus = Effect.fn("getOrLoadLocalStatus")(function* (
      input: GitStatusInput,
      key: string,
    ) {
      const cached = yield* getCachedStatus(key);
      if (cached?.local) {
        return cached.local.value;
      }
      return yield* loadLocalStatus(input);
    });

    const getOrLoadRemoteStatus = Effect.fn("getOrLoadRemoteStatus")(function* (
      input: GitStatusInput,
      key: string,
    ) {
      const cached = yield* getCachedStatus(key);
      if (cached?.remote) {
        return cached.remote.value;
      }
      return yield* loadRemoteStatus(input);
    });

    const getStatus: GitStatusBroadcasterShape["getStatus"] = Effect.fn("getStatus")(function* (
      input: GitStatusInput,
    ) {
      const normalizedCwd = normalizeStatusCwd(input);
      const normalizedInput = { ...input, cwd: normalizedCwd };
      const key = statusCacheKey(normalizedCwd, input.executionTarget);
      const [local, remote] = yield* Effect.all([
        getOrLoadLocalStatus(normalizedInput, key),
        getOrLoadRemoteStatus(normalizedInput, key),
      ]);
      return mergeGitStatusParts(local, remote);
    });

    const refreshLocalStatus: GitStatusBroadcasterShape["refreshLocalStatus"] = Effect.fn(
      "refreshLocalStatus",
    )(function* (rawInput) {
      const input = normalizeGitStatusInput(rawInput);
      const normalizedCwd = normalizeStatusCwd(input);
      const normalizedInput = { ...input, cwd: normalizedCwd };
      const key = statusCacheKey(normalizedCwd, input.executionTarget);
      yield* gitManager.invalidateLocalStatus(normalizedCwd);
      const local = yield* gitManager.localStatus(normalizedInput);
      return yield* updateCachedLocalStatus(key, local, { publish: true });
    });

    const refreshRemoteStatus = Effect.fn("refreshRemoteStatus")(function* (input: GitStatusInput) {
      const normalizedCwd = normalizeStatusCwd(input);
      const normalizedInput = { ...input, cwd: normalizedCwd };
      const key = statusCacheKey(normalizedCwd, input.executionTarget);
      yield* gitManager.invalidateRemoteStatus(normalizedCwd);
      const remote = yield* gitManager.remoteStatus(normalizedInput);
      return yield* updateCachedRemoteStatus(key, remote, { publish: true });
    });

    const refreshStatus: GitStatusBroadcasterShape["refreshStatus"] = Effect.fn("refreshStatus")(
      function* (rawInput) {
        const input = normalizeGitStatusInput(rawInput);
        const normalizedCwd = normalizeStatusCwd(input);
        const normalizedInput = { ...input, cwd: normalizedCwd };
        const [local, remote] = yield* Effect.all([
          refreshLocalStatus(normalizedInput),
          refreshRemoteStatus(normalizedInput),
        ]);
        return mergeGitStatusParts(local, remote);
      },
    );

    const makeRemoteRefreshLoop = (input: GitStatusInput) => {
      const cwd = normalizeStatusCwd(input);
      const logRefreshFailure = (error: Error) =>
        Effect.logWarning("git remote status refresh failed", {
          cwd,
          detail: error.message,
        });

      return refreshRemoteStatus(input).pipe(
        Effect.catch(logRefreshFailure),
        Effect.andThen(
          Effect.forever(
            Effect.sleep(GIT_STATUS_REFRESH_INTERVAL).pipe(
              Effect.andThen(refreshRemoteStatus(input).pipe(Effect.catch(logRefreshFailure))),
            ),
          ),
        ),
      );
    };

    const retainRemotePoller = Effect.fn("retainRemotePoller")(function* (
      input: GitStatusInput,
      key: string,
    ) {
      yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
        const existing = activePollers.get(key);
        if (existing) {
          const nextPollers = new Map(activePollers);
          nextPollers.set(key, {
            ...existing,
            subscriberCount: existing.subscriberCount + 1,
          });
          return Effect.succeed([undefined, nextPollers] as const);
        }

        return makeRemoteRefreshLoop(input).pipe(
          Effect.forkIn(broadcasterScope),
          Effect.map((fiber) => {
            const nextPollers = new Map(activePollers);
            nextPollers.set(key, {
              fiber,
              subscriberCount: 1,
            });
            return [undefined, nextPollers] as const;
          }),
        );
      });
    });

    const releaseRemotePoller = Effect.fn("releaseRemotePoller")(function* (cwd: string) {
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

    const streamStatus: GitStatusBroadcasterShape["streamStatus"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const normalizedCwd = normalizeStatusCwd(input);
          const normalizedInput = { ...input, cwd: normalizedCwd };
          const key = statusCacheKey(normalizedCwd, input.executionTarget);
          const subscription = yield* PubSub.subscribe(changesPubSub);
          const initialLocal = yield* getOrLoadLocalStatus(normalizedInput, key);
          const initialRemote = (yield* getCachedStatus(key))?.remote?.value ?? null;
          yield* retainRemotePoller(normalizedInput, key);

          const release = releaseRemotePoller(key).pipe(Effect.ignore, Effect.asVoid);

          return Stream.concat(
            Stream.make({
              _tag: "snapshot" as const,
              local: initialLocal,
              remote: initialRemote,
            }),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((event) => event.key === key),
              Stream.map((event) => event.event),
            ),
          ).pipe(Stream.ensuring(release));
        }),
      );

    return {
      getStatus,
      refreshLocalStatus,
      refreshStatus,
      streamStatus,
    } satisfies GitStatusBroadcasterShape;
  }),
);

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
  readonly cwd: string;
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
      cwd: string,
      local: GitStatusLocalResult,
      options?: { publish?: boolean },
    ) {
      const nextLocal = {
        fingerprint: fingerprintStatusPart(local),
        value: local,
      } satisfies CachedValue<GitStatusLocalResult>;
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
    });

    const updateCachedRemoteStatus = Effect.fn("updateCachedRemoteStatus")(function* (
      cwd: string,
      remote: GitStatusRemoteResult | null,
      options?: { publish?: boolean },
    ) {
      const nextRemote = {
        fingerprint: fingerprintStatusPart(remote),
        value: remote,
      } satisfies CachedValue<GitStatusRemoteResult | null>;
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
    });

    const loadLocalStatus = Effect.fn("loadLocalStatus")(function* (cwd: string) {
      const local = yield* gitManager.localStatus({ cwd });
      return yield* updateCachedLocalStatus(cwd, local);
    });

    const loadRemoteStatus = Effect.fn("loadRemoteStatus")(function* (cwd: string) {
      const remote = yield* gitManager.remoteStatus({ cwd });
      return yield* updateCachedRemoteStatus(cwd, remote);
    });

    const getOrLoadLocalStatus = Effect.fn("getOrLoadLocalStatus")(function* (cwd: string) {
      const cached = yield* getCachedStatus(cwd);
      if (cached?.local) {
        return cached.local.value;
      }
      return yield* loadLocalStatus(cwd);
    });

    const getOrLoadRemoteStatus = Effect.fn("getOrLoadRemoteStatus")(function* (cwd: string) {
      const cached = yield* getCachedStatus(cwd);
      if (cached?.remote) {
        return cached.remote.value;
      }
      return yield* loadRemoteStatus(cwd);
    });

    const getStatus: GitStatusBroadcasterShape["getStatus"] = Effect.fn("getStatus")(function* (
      input: GitStatusInput,
    ) {
      const normalizedCwd = normalizeCwd(input.cwd);
      const [local, remote] = yield* Effect.all([
        getOrLoadLocalStatus(normalizedCwd),
        getOrLoadRemoteStatus(normalizedCwd),
      ]);
      return mergeGitStatusParts(local, remote);
    });

    const refreshLocalStatus = Effect.fn("refreshLocalStatus")(function* (cwd: string) {
      yield* gitManager.invalidateLocalStatus(cwd);
      const local = yield* gitManager.localStatus({ cwd });
      return yield* updateCachedLocalStatus(cwd, local, { publish: true });
    });

    const refreshRemoteStatus = Effect.fn("refreshRemoteStatus")(function* (cwd: string) {
      yield* gitManager.invalidateRemoteStatus(cwd);
      const remote = yield* gitManager.remoteStatus({ cwd });
      return yield* updateCachedRemoteStatus(cwd, remote, { publish: true });
    });

    const refreshStatus: GitStatusBroadcasterShape["refreshStatus"] = Effect.fn("refreshStatus")(
      function* (cwd) {
        const normalizedCwd = normalizeCwd(cwd);
        const [local, remote] = yield* Effect.all([
          refreshLocalStatus(normalizedCwd),
          refreshRemoteStatus(normalizedCwd),
        ]);
        return mergeGitStatusParts(local, remote);
      },
    );

    const makeRemoteRefreshLoop = (cwd: string) => {
      const logRefreshFailure = (error: Error) =>
        Effect.logWarning("git remote status refresh failed", {
          cwd,
          detail: error.message,
        });

      return refreshRemoteStatus(cwd).pipe(
        Effect.catch(logRefreshFailure),
        Effect.andThen(
          Effect.forever(
            Effect.sleep(GIT_STATUS_REFRESH_INTERVAL).pipe(
              Effect.andThen(refreshRemoteStatus(cwd).pipe(Effect.catch(logRefreshFailure))),
            ),
          ),
        ),
      );
    };

    const retainRemotePoller = Effect.fn("retainRemotePoller")(function* (cwd: string) {
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

        return makeRemoteRefreshLoop(cwd).pipe(
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
          const normalizedCwd = normalizeCwd(input.cwd);
          const subscription = yield* PubSub.subscribe(changesPubSub);
          const initialLocal = yield* getOrLoadLocalStatus(normalizedCwd);
          const initialRemote = (yield* getCachedStatus(normalizedCwd))?.remote?.value ?? null;
          yield* retainRemotePoller(normalizedCwd);

          const release = releaseRemotePoller(normalizedCwd).pipe(Effect.ignore, Effect.asVoid);

          return Stream.concat(
            Stream.make({
              _tag: "snapshot" as const,
              local: initialLocal,
              remote: initialRemote,
            }),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((event) => event.cwd === normalizedCwd),
              Stream.map((event) => event.event),
            ),
          ).pipe(Stream.ensuring(release));
        }),
      );

    return {
      getStatus,
      refreshStatus,
      streamStatus,
    } satisfies GitStatusBroadcasterShape;
  }),
);

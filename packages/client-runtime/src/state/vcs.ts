import {
  type EnvironmentId,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsStatusResult,
  WS_METHODS,
} from "@t3tools/contracts";
import { applyGitStatusStreamEvent } from "@t3tools/shared/git";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { request, subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import {
  invalidateCachedVcsRefs,
  vcsRefsCacheStateAtom,
  withVcsRefsPersistenceLock,
} from "./vcsRefInvalidation.ts";

const OFFLINE_BRANCH_LIST_LIMIT = 100;
const VCS_REFS_IDLE_TTL_MS = 30_000;
const VCS_REFS_RETRY_SCHEDULE = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

function canUseVcsRefsCache(input: VcsListRefsInput): boolean {
  return (
    input.query === undefined &&
    input.cursor === undefined &&
    input.includeMatchingRemoteRefs === undefined &&
    input.refKind === undefined &&
    input.limit === OFFLINE_BRANCH_LIST_LIMIT
  );
}

export const commitVcsRefsRefresh = Effect.fn("CachedVcsRefsState.commitRefresh")(function* (
  registry: AtomRegistry.AtomRegistry,
  cache: EnvironmentCacheStore["Service"],
  input: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly refs: VcsListRefsResult;
    readonly expectedRevision: number;
    readonly persist: boolean;
  },
) {
  return yield* withVcsRefsPersistenceLock(
    input.environmentId,
    Effect.gen(function* () {
      const stateAtom = vcsRefsCacheStateAtom({ environmentId: input.environmentId });
      const state = registry.get(stateAtom);
      if (state.revision !== input.expectedRevision) {
        return false;
      }
      let persistedCacheReadable = state.persistedCacheReadable;
      if (input.persist) {
        if (!persistedCacheReadable) {
          persistedCacheReadable = yield* cache.clearVcsRefs(input.environmentId).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("Could not recover invalidated cached Git refs.").pipe(
                Effect.annotateLogs({
                  environmentId: input.environmentId,
                  cwd: input.cwd,
                  ...safeErrorLogAttributes(error),
                }),
                Effect.as(false),
              ),
            ),
          );
        }
        yield* cache.saveVcsRefs(input.environmentId, input.cwd, input.refs).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not persist cached Git refs.").pipe(
              Effect.annotateLogs({
                environmentId: input.environmentId,
                cwd: input.cwd,
                ...safeErrorLogAttributes(error),
              }),
            ),
          ),
        );
        if (persistedCacheReadable !== state.persistedCacheReadable) {
          registry.update(stateAtom, (current) =>
            current.revision === input.expectedRevision
              ? { ...current, persistedCacheReadable }
              : current,
          );
        }
      }
      return true;
    }),
  );
});

/**
 * Retains the last unfiltered branch-list response for the new-task picker.
 * Filtered or paginated lists intentionally stay live-only: treating a
 * partial result as a complete offline list would make branch selection
 * misleading.
 */
export const makeCachedVcsRefsChanges = Effect.fn("CachedVcsRefsState.makeChanges")(function* (
  input: VcsListRefsInput,
  expectedRevision?: number,
  registry?: AtomRegistry.AtomRegistry,
  persistedCacheReadable = true,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const environmentId = supervisor.target.environmentId;
  const useCache = canUseVcsRefsCache(input);
  const cached =
    useCache && persistedCacheReadable
      ? yield* cache.loadVcsRefs(environmentId, input.cwd).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not load cached Git refs.").pipe(
              Effect.annotateLogs({
                environmentId,
                cwd: input.cwd,
                ...safeErrorLogAttributes(error),
              }),
              Effect.as(Option.none<VcsListRefsResult>()),
            ),
          ),
        )
      : Option.none<VcsListRefsResult>();
  const refresh = Effect.fn("CachedVcsRefsState.refresh")(function* () {
    const refs = yield* request(WS_METHODS.vcsListRefs, input).pipe(
      Effect.provideService(EnvironmentSupervisor, supervisor),
    );
    const persist = cache.saveVcsRefs(environmentId, input.cwd, refs).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist cached Git refs.").pipe(
          Effect.annotateLogs({
            environmentId,
            cwd: input.cwd,
            ...safeErrorLogAttributes(error),
          }),
        ),
      ),
    );
    if (expectedRevision === undefined || registry === undefined) {
      if (useCache) yield* persist;
      return Option.some(refs);
    }
    const committed = yield* commitVcsRefsRefresh(registry, cache, {
      environmentId,
      cwd: input.cwd,
      refs,
      expectedRevision,
      persist: useCache,
    });
    return committed ? Option.some(refs) : Option.none<VcsListRefsResult>();
  });

  const cachedRefs = Stream.fromEffect(Effect.succeed(cached)).pipe(
    Stream.filterMap((refs) =>
      Option.match(refs, {
        onNone: () => Result.failVoid,
        onSome: Result.succeed,
      }),
    ),
  );
  const refreshedRefs = Stream.concat(
    Stream.fromEffect(SubscriptionRef.get(supervisor.state)),
    SubscriptionRef.changes(supervisor.state),
  ).pipe(
    Stream.map((connection) => (connection.phase === "connected" ? connection.generation : null)),
    Stream.changes,
    Stream.switchMap((generation) =>
      generation === null
        ? Stream.empty
        : Stream.fromEffect(
            refresh().pipe(
              Effect.tapError((error) =>
                Effect.logWarning("Could not refresh Git refs.").pipe(
                  Effect.annotateLogs({
                    environmentId,
                    cwd: input.cwd,
                    ...safeErrorLogAttributes(error),
                  }),
                ),
              ),
            ),
          ).pipe(
            Stream.retry(VCS_REFS_RETRY_SCHEDULE),
            Stream.filterMap((refs) =>
              Option.match(refs, {
                onNone: () => Result.failVoid,
                onSome: Result.succeed,
              }),
            ),
          ),
    ),
  );

  return Stream.concat(cachedRefs, refreshedRefs);
});

export function cachedVcsRefsChanges(
  environmentId: EnvironmentId,
  input: VcsListRefsInput,
  expectedRevision: number,
  persistedCacheReadable: boolean,
) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      Effect.gen(function* () {
        const registry = yield* AtomRegistry.AtomRegistry;
        return yield* makeCachedVcsRefsChanges(
          input,
          expectedRevision,
          registry,
          persistedCacheReadable,
        );
      }),
    ),
  );
}

export function createVcsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  /**
   * One flat family on purpose: families hold entries via WeakRef, so a nested
   * per-environment family can be collected between lookups, dropping every
   * cached page atom and collapsing paginated ref lists mid-scroll.
   */
  const listRefsFamily = Atom.family((key: string) => {
    const [environmentId, input] = JSON.parse(key) as [EnvironmentId, VcsListRefsInput];
    return runtime
      .atom((get) => {
        const state = get(vcsRefsCacheStateAtom({ environmentId }));
        return cachedVcsRefsChanges(
          environmentId,
          input,
          state.revision,
          state.persistedCacheReadable,
        );
      })
      .pipe(
        Atom.setIdleTTL(VCS_REFS_IDLE_TTL_MS),
        Atom.withLabel(`environment-data:vcs:list-refs:${key}`),
      );
  });
  const listRefs = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: VcsListRefsInput;
  }) => listRefsFamily(JSON.stringify([target.environmentId, target.input]));
  const invalidateRefs = (
    target: { readonly environmentId: EnvironmentId; readonly input: { readonly cwd: string } },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    invalidateCachedVcsRefs(registry, {
      environmentId: target.environmentId,
      cwd: target.input.cwd,
    });

  return {
    listRefs,
    status: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:vcs:status",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.subscribeVcsStatus>) =>
        subscribe(WS_METHODS.subscribeVcsStatus, input).pipe(
          Stream.mapAccum(
            () => null as VcsStatusResult | null,
            (current, event) => {
              const next = applyGitStatusStreamEvent(current, event);
              return [next, [next]] as const;
            },
          ),
        ),
    }),
    pull: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:pull",
      tag: WS_METHODS.vcsPull,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: invalidateRefs,
    }),
    refreshStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:refresh-status",
      tag: WS_METHODS.vcsRefreshStatus,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: invalidateRefs,
    }),
    createWorktree: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:create-worktree",
      tag: WS_METHODS.vcsCreateWorktree,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: invalidateRefs,
    }),
    removeWorktree: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:remove-worktree",
      tag: WS_METHODS.vcsRemoveWorktree,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: invalidateRefs,
    }),
    createRef: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:create-ref",
      tag: WS_METHODS.vcsCreateRef,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: invalidateRefs,
    }),
    switchRef: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:switch-ref",
      tag: WS_METHODS.vcsSwitchRef,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: invalidateRefs,
    }),
    init: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:init",
      tag: WS_METHODS.vcsInit,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: invalidateRefs,
    }),
  };
}

export * from "./gitActions.ts";
export * from "./vcsAction.ts";
export * from "./vcsRef.ts";
export * from "./vcsStatus.ts";

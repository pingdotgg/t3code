import {
  type EnvironmentId,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsStatusAccumulatedResult,
  type VcsStatusInput,
  WS_METHODS,
} from "@t3tools/contracts";
import { applyGitStatusStreamEvent } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import {
  EnvironmentRpcUnavailableError,
  request,
  subscribe,
  type EnvironmentRpcFailure,
  type EnvironmentRpcInput,
} from "../rpc/client.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import {
  invalidateCachedVcsRefs,
  vcsRefsCacheStateAtom,
  withVcsRefsPersistenceLock,
} from "./vcsRefInvalidation.ts";

const OFFLINE_BRANCH_LIST_LIMIT = 100;

export interface VcsStatusDemand {
  readonly demand: "local" | "remote";
  readonly target: {
    readonly environmentId: EnvironmentId;
    readonly input: VcsStatusInput;
  };
}

export function selectVcsStatusAtomForDemand<A>(
  families: {
    readonly status: (target: VcsStatusDemand["target"]) => A;
    readonly remoteStatus: (target: VcsStatusDemand["target"]) => A;
  },
  request: VcsStatusDemand,
): A {
  return request.demand === "remote"
    ? families.remoteStatus(request.target)
    : families.status(request.target);
}

type VcsListRefsRefreshError =
  | EnvironmentRpcFailure<typeof WS_METHODS.vcsListRefs>
  | EnvironmentRpcUnavailableError;

type VcsListRefsFailureHandler = (error: VcsListRefsRefreshError) => Effect.Effect<void>;

function normalizeVcsStatusTarget(target: {
  readonly environmentId: EnvironmentId;
  readonly input: VcsStatusInput;
}) {
  return {
    environmentId: target.environmentId,
    input: { cwd: target.input.cwd.trim() },
  };
}

function normalizeVcsListRefsInput(input: VcsListRefsInput): VcsListRefsInput {
  return {
    cwd: input.cwd.trim(),
    ...(input.query === undefined ? {} : { query: input.query.trim() }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.includeMatchingRemoteRefs === undefined
      ? {}
      : { includeMatchingRemoteRefs: input.includeMatchingRemoteRefs }),
    ...(input.refKind === undefined ? {} : { refKind: input.refKind }),
    ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
}

function canPersistVcsRefsCache(input: VcsListRefsInput): boolean {
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
  rawInput: VcsListRefsInput,
  expectedRevision?: number,
  registry?: AtomRegistry.AtomRegistry,
  persistedCacheReadable = true,
  onRefreshFailure: VcsListRefsFailureHandler = () => Effect.void,
) {
  const input = normalizeVcsListRefsInput(rawInput);
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const environmentId = supervisor.target.environmentId;
  const persistCache = canPersistVcsRefsCache(input);
  const readCache = persistCache && input.refresh !== true;
  const cached =
    readCache && persistedCacheReadable
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
      if (persistCache) yield* persist;
      return Option.some(refs);
    }
    const committed = yield* commitVcsRefsRefresh(registry, cache, {
      environmentId,
      cwd: input.cwd,
      refs,
      expectedRevision,
      persist: persistCache,
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
  const refreshedRefs: Stream.Stream<VcsListRefsResult, VcsListRefsRefreshError> = Stream.concat(
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
            Stream.catch((error) => Stream.fromEffect(onRefreshFailure(error)).pipe(Stream.drain)),
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
  onRefreshFailure?: VcsListRefsFailureHandler,
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
          onRefreshFailure,
        );
      }),
    ),
  );
}

export function createVcsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const listRefsByEnvironment = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((inputKey: string) => {
      const input = JSON.parse(inputKey) as VcsListRefsInput;
      return runtime
        .atom((get) => {
          const state = get(vcsRefsCacheStateAtom({ environmentId }));
          return cachedVcsRefsChanges(
            environmentId,
            input,
            state.revision,
            state.persistedCacheReadable,
            (error) =>
              Effect.sync(() =>
                get.setSelf(
                  AsyncResult.failWithPrevious(error, {
                    previous: get.self<AsyncResult.AsyncResult<VcsListRefsResult, unknown>>(),
                  }),
                ),
              ),
          );
        })
        .pipe(
          Atom.setIdleTTL(0),
          Atom.withLabel(`environment-data:vcs:list-refs:${environmentId}:${inputKey}`),
        );
    }),
  );
  const listRefs = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: VcsListRefsInput;
  }) =>
    listRefsByEnvironment(target.environmentId)(
      JSON.stringify(normalizeVcsListRefsInput(target.input)),
    );
  const invalidateRefs = (
    target: { readonly environmentId: EnvironmentId; readonly input: { readonly cwd: string } },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    invalidateCachedVcsRefs(registry, {
      environmentId: target.environmentId,
      cwd: target.input.cwd,
    });

  const createStatusFamily = (includeRemote: boolean, label: string) => {
    const family = createEnvironmentSubscriptionAtomFamily(runtime, {
      idleTtlMs: 0,
      label,
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.subscribeVcsStatus>) =>
        subscribe(WS_METHODS.subscribeVcsStatus, input, {
          onExpectedFailure: () =>
            Effect.logWarning("VCS status subscription failed; waiting for the next RPC session.", {
              includeRemote,
            }),
        }).pipe(
          Stream.mapAccum(
            () => null as VcsStatusAccumulatedResult | null,
            (current, event) => {
              const next = applyGitStatusStreamEvent(current, event);
              return [next, [next]] as const;
            },
          ),
        ),
    });
    return (target: { readonly environmentId: EnvironmentId; readonly input: VcsStatusInput }) => {
      const normalized = normalizeVcsStatusTarget(target);
      return family({
        environmentId: normalized.environmentId,
        input: { ...normalized.input, includeRemote },
      });
    };
  };

  return {
    listRefs,
    status: createStatusFamily(false, "environment-data:vcs:status"),
    remoteStatus: createStatusFamily(true, "environment-data:vcs:remote-status"),
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

import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/** How often the mounted Linear page re-reads while visible. */
export const LINEAR_POLL_INTERVAL_MS = 60_000;
const LINEAR_IDLE_TTL_MS = 30_000;

/**
 * Keeps the previous answer on screen while a re-read is in flight or has failed
 * (stale-while-revalidate); a Linear outage must not blank the page.
 */
function keepPrevious<Target, A, E>(
  family: (target: Target) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): (target: Target) => Atom.Atom<AsyncResult.AsyncResult<A, E>> {
  const wrapped = Atom.family((source: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
    Atom.readable((get) => {
      const result = get(source);
      if (result._tag === "Success" && !result.waiting) return result;
      const previous = get.self<AsyncResult.AsyncResult<A, E>>();
      const value = Option.flatMap(previous, AsyncResult.value);
      if (Option.isNone(value)) return result;
      return result._tag === "Failure"
        ? AsyncResult.failureWithPrevious(result.cause, { previous, waiting: result.waiting })
        : AsyncResult.success<A, E>(value.value, result);
    }),
  );
  return (target) => wrapped(family(target));
}

/**
 * Linear is reached through the primary environment only (the server holds the API key), so
 * callers always pass the primary environment id.
 */
export function createLinearEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const refreshes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:linear:refreshes",
    tag: WS_METHODS.linearSubscribeRefreshes,
  });
  const commandScheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;
  /**
   * Bumped by the mounted Linear page on its poll interval and on window focus, so nothing
   * polls while the page is closed. Server pushes ("changed") also re-read.
   */
  const pollTick = Atom.make(0).pipe(Atom.withLabel("environment-data:linear:poll-tick"));
  const triggers = Atom.family((environmentId: EnvironmentId) =>
    Atom.readable((get) => {
      get(refreshes({ environmentId, input: {} }));
      return get(pollTick);
    }).pipe(Atom.withLabel(`environment-data:linear:trigger:${environmentId}`)),
  );
  const refreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    triggers(environmentId);

  const status = keepPrevious(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:status",
      tag: WS_METHODS.linearStatus,
      staleTimeMs: 30_000,
      idleTtlMs: LINEAR_IDLE_TTL_MS,
      refreshTrigger,
    }),
  );
  const refreshStatus = (
    registry: AtomRegistry.AtomRegistry,
    target: Parameters<typeof status>[0],
  ) => registry.refresh(status(target));

  return {
    refreshes,
    pollTick,
    status,
    teams: keepPrevious(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:linear:teams",
        tag: WS_METHODS.linearTeams,
        staleTimeMs: 5 * 60_000,
        idleTtlMs: LINEAR_IDLE_TTL_MS,
        refreshTrigger,
      }),
    ),
    teamMetadata: keepPrevious(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:linear:team-metadata",
        tag: WS_METHODS.linearTeamMetadata,
        staleTimeMs: 5 * 60_000,
        idleTtlMs: LINEAR_IDLE_TTL_MS,
      }),
    ),
    projects: keepPrevious(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:linear:projects",
        tag: WS_METHODS.linearProjects,
        staleTimeMs: 2 * 60_000,
        idleTtlMs: LINEAR_IDLE_TTL_MS,
        refreshTrigger,
      }),
    ),
    milestones: keepPrevious(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:linear:milestones",
        tag: WS_METHODS.linearMilestones,
        staleTimeMs: 60_000,
        idleTtlMs: LINEAR_IDLE_TTL_MS,
        refreshTrigger,
      }),
    ),
    issues: keepPrevious(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:linear:issues",
        tag: WS_METHODS.linearIssues,
        staleTimeMs: 30_000,
        idleTtlMs: LINEAR_IDLE_TTL_MS,
        refreshTrigger,
      }),
    ),
    issueDetail: keepPrevious(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:linear:issue-detail",
        tag: WS_METHODS.linearIssueDetail,
        staleTimeMs: 30_000,
        idleTtlMs: LINEAR_IDLE_TTL_MS,
        refreshTrigger,
      }),
    ),
    subIssues: keepPrevious(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:linear:sub-issues",
        tag: WS_METHODS.linearSubIssues,
        staleTimeMs: 30_000,
        idleTtlMs: LINEAR_IDLE_TTL_MS,
        refreshTrigger,
      }),
    ),
    views: keepPrevious(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:linear:views",
        tag: WS_METHODS.linearViews,
        staleTimeMs: 5 * 60_000,
        idleTtlMs: LINEAR_IDLE_TTL_MS,
      }),
    ),
    search: keepPrevious(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:linear:search",
        tag: WS_METHODS.linearSearch,
        staleTimeMs: 30_000,
        idleTtlMs: 10_000,
      }),
    ),
    activity: keepPrevious(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:linear:activity",
        tag: WS_METHODS.linearActivity,
        staleTimeMs: 15_000,
        idleTtlMs: LINEAR_IDLE_TTL_MS,
        refreshTrigger,
      }),
    ),
    connect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:connect",
      tag: WS_METHODS.linearConnect,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: (target, registry) => Effect.sync(() => refreshStatus(registry, target)),
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:disconnect",
      tag: WS_METHODS.linearDisconnect,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: (target, registry) => Effect.sync(() => refreshStatus(registry, target)),
    }),
    resync: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:resync",
      tag: WS_METHODS.linearResync,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: (target, registry) => Effect.sync(() => refreshStatus(registry, target)),
    }),
    /** A person's refresh: drops the server caches so every re-read reaches Linear. */
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:refresh",
      tag: WS_METHODS.linearRefresh,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: (target, registry) => Effect.sync(() => refreshStatus(registry, target)),
    }),
    recordLaunch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:record-launch",
      tag: WS_METHODS.linearRecordLaunch,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}

export type LinearEnvironmentAtoms = ReturnType<typeof createLinearEnvironmentAtoms>;

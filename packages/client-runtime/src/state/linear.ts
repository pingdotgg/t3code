import { WS_METHODS, type EnvironmentId, type LinearIssueActivity } from "@t3tools/contracts";
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

const NO_PEER_ACTIVITY: ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly issues: ReadonlyArray<LinearIssueActivity>;
}> = [];

/** How often the mounted Linear page re-reads while visible. */
export const LINEAR_POLL_INTERVAL_MS = 60_000;
const LINEAR_IDLE_TTL_MS = 30_000;

/**
 * Keeps the previous answer on screen while a re-read is in flight or has failed
 * (stale-while-revalidate); a Linear outage must not blank the page.
 */
export function keepPrevious<Target, A, E>(
  family: (target: Target) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): (target: Target) => Atom.Atom<AsyncResult.AsyncResult<A, E>> {
  const wrapped = Atom.family((source: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
    Atom.readable(
      (get) => {
        const result = get(source);
        if (result._tag === "Success" && !result.waiting) return result;
        const previous = get.self<AsyncResult.AsyncResult<A, E>>();
        const value = Option.flatMap(previous, AsyncResult.value);
        if (Option.isNone(value)) return result;
        return result._tag === "Failure"
          ? AsyncResult.failureWithPrevious(result.cause, { previous, waiting: result.waiting })
          : AsyncResult.success<A, E>(value.value, result);
      },
      // Without this a refresh only re-derives the wrapper and never re-runs the query.
      (refresh) => refresh(source),
    ),
  );
  return (target) => wrapped(family(target));
}

/** Changes on every server push and poll tick; queries refresh only when this value changes. */
export function linearRefreshSignal(
  refreshes: Atom.Atom<AsyncResult.AsyncResult<number, unknown>>,
  pollTick: Atom.Atom<number>,
): Atom.Atom<string> {
  return Atom.readable((get) => {
    const revision = Option.getOrElse(AsyncResult.value(get(refreshes)), () => 0);
    return `${revision}:${get(pollTick)}`;
  });
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
    idleTtlMs: LINEAR_IDLE_TTL_MS,
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
    linearRefreshSignal(refreshes({ environmentId, input: {} }), pollTick).pipe(
      Atom.withLabel(`environment-data:linear:trigger:${environmentId}`),
    ),
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
    { environmentId }: { readonly environmentId: EnvironmentId },
  ) => registry.refresh(status({ environmentId, input: {} }));

  const activity = keepPrevious(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:activity",
      tag: WS_METHODS.linearActivity,
      staleTimeMs: 15_000,
      idleTtlMs: LINEAR_IDLE_TTL_MS,
      refreshTrigger,
    }),
  );
  /**
   * Activity of the machines connected to the same Linear workspace as the primary. Keyed by the
   * primary id and the candidate machines, joined with "\n"; reading it is what subscribes, so only
   * the open Linear page pays for it.
   */
  const peerActivity = Atom.family((environmentIdsKey: string) =>
    Atom.make((get) => {
      const [primaryId, ...candidates] = environmentIdsKey.split("\n") as EnvironmentId[];
      if (primaryId === undefined || candidates.length === 0) return NO_PEER_ACTIVITY;
      const organizationOf = (environmentId: EnvironmentId) => {
        const connection = AsyncResult.getOrElse(
          get(status({ environmentId, input: {} })),
          () => null,
        );
        return connection?.state === "connected" ? (connection.organization?.id ?? null) : null;
      };
      const primaryOrganization = organizationOf(primaryId);
      if (primaryOrganization === null) return NO_PEER_ACTIVITY;
      return candidates.flatMap((environmentId) => {
        if (organizationOf(environmentId) !== primaryOrganization) return [];
        const result = AsyncResult.getOrElse(
          get(activity({ environmentId, input: {} })),
          () => null,
        );
        return result === null ? [] : [{ environmentId, issues: result.issues }];
      });
    }).pipe(Atom.withLabel(`environment-data:linear:peer-activity:${environmentIdsKey}`)),
  );

  return {
    refreshes,
    pollTick,
    peerActivity,
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
        refreshTrigger,
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
        refreshTrigger,
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
    activity,
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

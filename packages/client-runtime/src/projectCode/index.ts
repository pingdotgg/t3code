import {
  WS_METHODS,
  type EnvironmentId,
  type ProjectCodeIndexInfo,
  type ProjectCodeIndexTarget,
  type ProjectCodeQueryInput,
  type ProjectFileHistoryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  EnvironmentRpcUnavailableError,
  getInitialServerConfig,
  requestGuarded,
  subscribe,
} from "../rpc/client.ts";
import {
  createEnvironmentGuardedRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "../state/runtime.ts";

const requireProjectCode = Effect.fn("ProjectCode.requireCapability")(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const config = yield* getInitialServerConfig();
  if (config.environment.capabilities.projectCode !== true) {
    return yield* new EnvironmentRpcUnavailableError({
      environmentId: supervisor.target.environmentId,
      message: "This server does not support project code queries.",
    });
  }
});

export function createProjectCodeAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // An atom drops a value equal to its last one, and the same signal can arrive twice running.
  let received = 0;
  const indexEvents = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "project-code:index-events",
    idleTtlMs: 0,
    subscribe: (input: ProjectCodeIndexTarget) =>
      Stream.unwrap(
        getInitialServerConfig().pipe(
          Effect.map((config) =>
            config.environment.capabilities.projectCodeIndexEvents === true
              ? subscribe(WS_METHODS.projectCodeSubscribeIndex, input)
              : Stream.never,
          ),
        ),
      ).pipe(Stream.map((event) => ({ ...event, received: ++received }))),
  });
  const refreshTrigger = ({
    environmentId,
    input,
  }: {
    readonly environmentId: EnvironmentId;
    readonly input: ProjectCodeQueryInput;
  }) =>
    indexEvents({
      environmentId,
      input: {
        projectId: input.projectId,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      },
    });
  // Queries start builds, so only a real publication or a failure re-runs one; the re-read signal
  // a settle removal or a stopped build sends would otherwise start the build it just ended.
  // Per registry, as `refreshOnSignalWhileRead` keeps its own bookkeeping.
  const queryRefreshTrigger = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: ProjectCodeQueryInput;
  }) => {
    const signal = refreshTrigger(target);
    const lastSignificant = new WeakMap<AtomRegistry.AtomRegistry, number>();
    return Atom.transform(signal, (get) => {
      const event = AsyncResult.getOrElse(get(signal), () => null);
      if (event !== null && (event.outcome !== "published" || event.generation !== null)) {
        lastSignificant.set(get.registry, event.received);
      }
      return lastSignificant.get(get.registry) ?? 0;
    });
  };
  return {
    query: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "project-code:query",
      tag: WS_METHODS.projectCodeQuery,
      staleTimeMs: 0,
      refreshTrigger: queryRefreshTrigger,
      execute: Effect.fn("ProjectCode.query")(function* (input: ProjectCodeQueryInput) {
        yield* requireProjectCode();
        return yield* requestGuarded(WS_METHODS.projectCodeQuery, input);
      }),
    }),
    // Badges read freshness without indexing; a short stale window keeps remounts from
    // starting a worker each time a panel reopens.
    freshness: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "project-code:freshness",
      tag: WS_METHODS.projectCodeQuery,
      staleTimeMs: 30_000,
      refreshTrigger,
      execute: Effect.fn("ProjectCode.freshness")(function* (input: ProjectCodeQueryInput) {
        yield* requireProjectCode();
        return yield* requestGuarded(WS_METHODS.projectCodeQuery, input);
      }),
    }),
    fileHistory: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "project-code:file-history",
      tag: WS_METHODS.projectCodeFileHistory,
      staleTimeMs: 0,
      execute: Effect.fn("ProjectCode.fileHistory")(function* (input: ProjectFileHistoryInput) {
        yield* requireProjectCode();
        return yield* requestGuarded(WS_METHODS.projectCodeFileHistory, input);
      }),
    }),
  };
}

export type ProjectCodeIndexBadge = {
  readonly label: string;
  readonly tone: "ok" | "warn" | "muted";
  readonly detail: string;
};

const REFRESH_DETAIL = {
  building: "A newer index is being built.",
  failed: "The last refresh failed, so this index is still answering.",
} as const;

const FIRST_INDEX_BADGE: Record<"building" | "failed", ProjectCodeIndexBadge> = {
  building: {
    label: "Indexing",
    tone: "muted",
    detail: "Building the first index for this checkout.",
  },
  failed: {
    label: "Index failed",
    tone: "warn",
    detail: "Building the first index for this checkout failed. The next code query tries again.",
  },
};

/**
 * The plain-text badge every client shows for an index. Stale names the commit the index was
 * built at when HEAD has moved since, otherwise how many files changed under it.
 */
export function projectCodeIndexBadge(
  index: ProjectCodeIndexInfo | undefined,
): ProjectCodeIndexBadge {
  const badge = describeIndexState(index);
  if (index?.refresh === undefined) return badge;
  if (index.state === "unindexed") return FIRST_INDEX_BADGE[index.refresh];
  return { ...badge, detail: `${badge.detail} ${REFRESH_DETAIL[index.refresh]}` };
}

function describeIndexState(index: ProjectCodeIndexInfo | undefined): ProjectCodeIndexBadge {
  if (index === undefined) {
    return {
      label: "Unavailable",
      tone: "muted",
      detail: "This server does not report index freshness.",
    };
  }
  const indexedAt = index.indexedCommit === null ? null : index.indexedCommit.slice(0, 7);
  switch (index.state) {
    case "ready":
      return {
        label: "Ready",
        tone: "ok",
        detail:
          indexedAt === null
            ? `Index generation ${index.generation} matches the checkout.`
            : `Index generation ${index.generation} matches the checkout at ${indexedAt}.`,
      };
    case "partial":
      return {
        label: "Partial",
        tone: "warn",
        detail: "Some files are not indexed or references are unresolved. Results may be missing.",
      };
    case "stale": {
      const files = `${index.changedFiles} ${index.changedFiles === 1 ? "file has" : "files have"} changed since indexing.`;
      const moved =
        indexedAt !== null && index.headCommit !== null && index.headCommit !== index.indexedCommit;
      return {
        label: moved ? `Stale @${indexedAt}` : "Stale",
        tone: "warn",
        detail: `${files} Code queries refresh the index, and so do agent turns while automatic indexing is on.`,
      };
    }
    case "indexing":
      return {
        label: "Indexing",
        tone: "muted",
        detail: "Another code query is indexing this checkout.",
      };
    case "unindexed":
      return {
        label: "Not indexed",
        tone: "muted",
        detail: "This checkout has not been indexed yet. The first code query indexes it.",
      };
  }
}

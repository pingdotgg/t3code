// @effect-diagnostics globalTimers:off globalDate:off - Freshness clock for React hooks, outside an Effect runtime.
import type { EnvironmentId, HostResourcesSnapshot } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { chooseLoadBalancedEnvironment } from "../load-balancing.ts";
import type { createServerEnvironmentAtoms } from "./server.ts";

type HostResourcesQuery = ReturnType<
  typeof createServerEnvironmentAtoms<never, never>
>["hostResources"];

// Mirrors the freshness window in chooseLoadBalancedEnvironment.
const HOST_RESOURCES_FRESH_MS = 15_000;

export const DEFAULT_LOAD_BALANCING_WEIGHT = 50;

/**
 * Host resources of the given environments, keyed by their ids joined with "\n" so equal lists
 * share one atom. Reading it is what polls, so mount it only while a pick is unresolved.
 */
export function createHostResourcesAtom(hostResources: HostResourcesQuery) {
  return Atom.family((environmentIdsKey: string) =>
    Atom.make((get) => {
      const evaluatedAt = Date.now();
      const resources = (
        environmentIdsKey === "" ? [] : (environmentIdsKey.split("\n") as EnvironmentId[])
      ).map((environmentId) => {
        const result = get(hostResources({ environmentId, input: {} }));
        return {
          environmentId,
          resources: result._tag === "Success" ? result.value : null,
          receivedAt: result._tag === "Success" ? result.timestamp : 0,
          pending: result._tag === "Initial" || result.waiting,
          failed: result._tag === "Failure",
        };
      });
      // Re-read when the next fresh snapshot ages out, so a frozen evaluatedAt never selects it.
      const nextExpiry = Math.min(
        ...resources
          .map((resource) => resource.receivedAt + HOST_RESOURCES_FRESH_MS)
          .filter((expiresAt) => expiresAt >= evaluatedAt),
      );
      if (Number.isFinite(nextExpiry)) {
        const timer = setTimeout(() => get.refreshSelf(), nextExpiry - evaluatedAt + 1);
        get.addFinalizer(() => clearTimeout(timer));
      }
      return { evaluatedAt, resources };
    }),
  );
}

/** The balanced pick for a host-resources read; `weights` are per environment, default Normal. */
export function selectLoadBalancedFromHostResources(
  snapshot: {
    readonly evaluatedAt: number;
    readonly resources: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly resources: HostResourcesSnapshot | null;
      readonly receivedAt: number;
      readonly pending: boolean;
      readonly failed: boolean;
    }>;
  },
  weights: Readonly<Record<string, number>>,
) {
  const pending = snapshot.resources.some((resource) => resource.pending);
  const environmentId = chooseLoadBalancedEnvironment(
    snapshot.resources.map((resource) => ({
      environmentId: resource.environmentId,
      resources: resource.resources,
      receivedAt: resource.receivedAt,
      weight: weights[resource.environmentId] ?? DEFAULT_LOAD_BALANCING_WEIGHT,
    })),
    snapshot.evaluatedAt,
  ) as EnvironmentId | null;
  return {
    pending,
    environmentId,
    failed:
      !pending && environmentId === null && snapshot.resources.some((resource) => resource.failed),
  };
}

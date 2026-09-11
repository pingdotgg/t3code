/**
 * Auto-balance provider catalogue.
 *
 * When a draft runs on "Auto balance", the composer must offer every provider
 * that *any* routable machine serves — not just the primary environment's
 * list. Otherwise a provider that exists on only one machine can never be
 * selected, and therefore never routed to.
 *
 * The union built here is selection truth only. Routing stays per-environment:
 * `environmentSupportsModelSelection` decides which machines may serve a
 * selection, evaluated against each environment's own server config, and the
 * server remains authoritative at turn start.
 *
 * @module autoBalanceProviders
 */
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";

/**
 * Whether an environment takes part in automatic routing at all: connected
 * and not opted out via a zero weight. Mirrors the base of the candidate
 * filter in `ChatView`; the provider/model match is layered on top.
 */
export function isAutoBalanceRoutableEnvironment(input: {
  connectionPhase: EnvironmentConnectionPhase;
  environmentId: EnvironmentId;
  weights: Readonly<Record<string, number>>;
}): boolean {
  return input.connectionPhase === "connected" && (input.weights[input.environmentId] ?? 50) > 0;
}

/**
 * Whether one environment's snapshot of an instance may serve a turn.
 * Same bar the load-balancing candidates apply per environment.
 */
export function isProviderSnapshotRoutable(snapshot: ServerProvider): boolean {
  return (
    snapshot.enabled &&
    snapshot.installed &&
    snapshot.status !== "error" &&
    snapshot.auth.status !== "unauthenticated" &&
    snapshot.availability !== "unavailable"
  );
}

/**
 * Whether an environment can serve an exact composer selection: a routable
 * snapshot of the instance (or any instance of the driver when nothing is
 * picked yet) that also lists the selected model. A `null` model keeps the
 * previous provider-level behavior.
 */
export function environmentSupportsModelSelection(input: {
  providers: ReadonlyArray<ServerProvider>;
  instanceId: ProviderInstanceId | null;
  driver: ProviderDriverKind;
  model: string | null;
}): boolean {
  const { instanceId, driver, model } = input;
  return input.providers.some(
    (provider) =>
      (instanceId === null || provider.instanceId === instanceId) &&
      provider.driver === driver &&
      isProviderSnapshotRoutable(provider) &&
      (model === null ||
        provider.models.some(
          (candidate) => candidate.slug === model || candidate.aliases?.includes(model) === true,
        )),
  );
}

interface CollectedInstance {
  snapshots: Array<{ environmentId: EnvironmentId; snapshot: ServerProvider }>;
  models: Map<string, ServerProviderModel>;
  order: number;
}

/**
 * Merge several environments' `ServerProvider[]` into one catalogue, keyed by
 * instance id. Input order wins: environments arrive primary-first, so the
 * first-seen snapshot and model record survive collisions.
 *
 * The representative snapshot per instance prefers the preferred environment
 * (the draft's current, possibly already balanced, machine) but falls back to
 * a ready snapshot elsewhere — otherwise an instance that is ready on exactly
 * one machine would render as not-ready in the picker.
 */
export function deriveAutoBalanceProviderStatuses(input: {
  environments: ReadonlyArray<{
    environmentId: EnvironmentId;
    providers: ReadonlyArray<ServerProvider>;
  }>;
  preferredEnvironmentId?: EnvironmentId | null;
}): ServerProvider[] {
  const { environments, preferredEnvironmentId } = input;
  const byInstance = new Map<string, CollectedInstance>();
  for (const environment of environments) {
    for (const snapshot of environment.providers) {
      const key = snapshot.instanceId as string;
      let collected = byInstance.get(key);
      if (!collected) {
        collected = { snapshots: [], models: new Map(), order: byInstance.size };
        byInstance.set(key, collected);
      }
      collected.snapshots.push({ environmentId: environment.environmentId, snapshot });
      for (const model of snapshot.models) {
        if (!collected.models.has(model.slug)) {
          collected.models.set(model.slug, model);
        }
      }
    }
  }
  const merged: ServerProvider[] = [];
  for (const collected of [...byInstance.values()].sort((a, b) => a.order - b.order)) {
    const isPreferred = (environmentId: EnvironmentId): boolean =>
      preferredEnvironmentId != null && environmentId === preferredEnvironmentId;
    const representative =
      collected.snapshots.find(
        ({ environmentId, snapshot }) =>
          isPreferred(environmentId) &&
          snapshot.status === "ready" &&
          isProviderSnapshotRoutable(snapshot),
      )?.snapshot ??
      collected.snapshots.find(
        ({ snapshot }) => snapshot.status === "ready" && isProviderSnapshotRoutable(snapshot),
      )?.snapshot ??
      collected.snapshots.find(
        ({ environmentId, snapshot }) =>
          isPreferred(environmentId) && isProviderSnapshotRoutable(snapshot),
      )?.snapshot ??
      collected.snapshots.find(({ snapshot }) => isProviderSnapshotRoutable(snapshot))?.snapshot ??
      collected.snapshots.find(({ environmentId }) => isPreferred(environmentId))?.snapshot ??
      collected.snapshots[0]?.snapshot;
    // Unreachable: `snapshots` is non-empty by construction, but indexed
    // access types as possibly undefined.
    if (!representative) continue;
    merged.push({ ...representative, models: [...collected.models.values()] });
  }
  return merged;
}

/**
 * Whether pinning a new provider/model selection must clear an already
 * balanced machine so candidates recompute for the new selection. Without the
 * reset the draft would send to (or block on) a machine that cannot serve
 * what the user just picked.
 */
export function shouldResetAutoBalanceRouting(input: {
  automaticEnvironment: boolean;
  pinnedEnvironmentId: EnvironmentId | null | undefined;
  previousInstanceId: ProviderInstanceId | null;
  previousModel: string | null;
  nextInstanceId: ProviderInstanceId;
  nextModel: string;
}): boolean {
  if (!input.automaticEnvironment || input.pinnedEnvironmentId == null) return false;
  return (
    input.previousInstanceId !== input.nextInstanceId ||
    (input.previousModel ?? null) !== input.nextModel
  );
}

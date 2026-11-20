import type { ServerProvider } from "@t3tools/contracts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// Conn fork: Orbit installs and updates provider CLIs (Nick, 2026-11-20). See FORK.md "Provider CLIs".

/** No driver looks up the newest release of a CLI; Orbit decides when to update. */
export const layerNoLatestVersions = Layer.succeed(
  ProviderLatestVersions.ProviderLatestVersions,
  ProviderLatestVersions.ProviderLatestVersions.of({
    cached: Effect.fn("OrbitManagedProviders.cached")(() => Effect.succeed(null)),
    invalidate: Effect.fn("OrbitManagedProviders.invalidate")(() => Effect.void),
    invalidateAll: Effect.void,
  }),
);

/** Clients get no update or install offer: Conn shows a provider, Orbit manages it. */
export function withoutProviderMaintenance(snapshot: ServerProvider): ServerProvider {
  const { versionAdvisory: _versionAdvisory, ...rest } = snapshot;
  return rest.setup?.canInstall ? { ...rest, setup: { ...rest.setup, canInstall: false } } : rest;
}

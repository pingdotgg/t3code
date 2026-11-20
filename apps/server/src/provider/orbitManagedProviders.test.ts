import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { layerNoLatestVersions, withoutProviderMaintenance } from "./orbitManagedProviders.ts";

const provider = {
  instanceId: ProviderInstanceId.make("antigravity"),
  driver: ProviderDriverKind.make("antigravity"),
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  setup: { canAuthenticate: true, canInstall: true },
  checkedAt: "2026-11-20T00:00:00.000Z",
  version: "1.5.13",
  models: [],
  slashCommands: [],
  skills: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "1.5.13",
    latestVersion: "1.6.0",
    updateCommand: "brew upgrade agy",
    canUpdate: true,
    checkedAt: "2026-11-20T00:00:00.000Z",
    message: null,
  },
} as const satisfies ServerProvider;

describe("Orbit-managed providers", () => {
  it("publishes no update or install offer", () => {
    const published = withoutProviderMaintenance(provider);
    expect(published.versionAdvisory).toBeUndefined();
    expect(published.setup).toEqual({ canAuthenticate: true, canInstall: false });
    expect(published.version).toBe("1.5.13");
  });

  it.effect("never runs a latest-version lookup", () =>
    Effect.gen(function* () {
      const latest = yield* ProviderLatestVersions.ProviderLatestVersions;
      const version = yield* latest.cached(
        "agy",
        Effect.die("Orbit decides updates; no lookup may run"),
      );
      expect(version).toBeNull();
    }).pipe(Effect.provide(layerNoLatestVersions)),
  );
});

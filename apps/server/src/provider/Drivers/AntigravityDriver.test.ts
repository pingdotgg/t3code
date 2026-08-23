import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { AntigravityDriver } from "./AntigravityDriver.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";

describe("AntigravityDriver", () => {
  it("has correct driver kind and metadata", () => {
    expect(AntigravityDriver.driverKind).toBe(ProviderDriverKind.make("antigravity"));
    expect(AntigravityDriver.metadata.displayName).toBe("Antigravity");
    expect(AntigravityDriver.metadata.supportsMultipleInstances).toBe(true);
  });

  it("produces default configuration with binaryPath='agy'", () => {
    const config = AntigravityDriver.defaultConfig();
    expect(config.enabled).toBe(true);
    expect(config.binaryPath).toBe("agy");
    expect(config.dangerouslySkipPermissions).toBe(true);
  });

  it("is registered in BUILT_IN_DRIVERS", () => {
    const driverKinds = BUILT_IN_DRIVERS.map((d) => d.driverKind);
    expect(driverKinds).toContain(ProviderDriverKind.make("antigravity"));
  });
});

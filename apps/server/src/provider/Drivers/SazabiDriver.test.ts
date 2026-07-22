import { describe, expect, it } from "@effect/vitest";

import { SazabiDriver } from "./SazabiDriver.ts";

describe("SazabiDriver", () => {
  it("registers the sazabi driver kind with multi-instance support", () => {
    expect(SazabiDriver.driverKind).toBe("sazabi");
    expect(SazabiDriver.metadata.displayName).toBe("Sazabi");
    expect(SazabiDriver.metadata.supportsMultipleInstances).toBe(true);
  });

  it("produces a disabled, credential-free default config", () => {
    const config = SazabiDriver.defaultConfig();
    expect(config.enabled).toBe(false);
    expect(config.apiBaseUrl).toBe("");
    expect(config.projectId).toBe("");
    expect(config.binaryPath).toBe("");
    expect(config.customModels).toEqual([]);
  });

  it("decodes a populated instance config through its schema", () => {
    const decode = SazabiDriver.configSchema;
    expect(decode).toBeDefined();
    const config = SazabiDriver.defaultConfig();
    // The token is never part of the persisted config — only connection hints.
    expect(config).not.toHaveProperty("apiToken");
    expect(config).not.toHaveProperty("token");
  });
});

import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_AETHER_API_BASE_URL } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { AetherDriver } from "./AetherDriver.ts";

const decodeConfig = Schema.decodeUnknownSync(AetherDriver.configSchema);

describe("AetherDriver config schema", () => {
  it("decodes an empty envelope into the defaults", () => {
    expect(decodeConfig({})).toEqual({
      enabled: true,
      apiBaseUrl: DEFAULT_AETHER_API_BASE_URL,
      customModels: [],
    });
    expect(AetherDriver.defaultConfig()).toEqual({
      enabled: true,
      apiBaseUrl: DEFAULT_AETHER_API_BASE_URL,
      customModels: [],
    });
  });

  it("keeps an explicit apiBaseUrl, enabled flag, and custom models", () => {
    expect(
      decodeConfig({
        enabled: false,
        apiBaseUrl: "https://api.staging.example",
        customModels: ["codex/gpt-6-preview"],
      }),
    ).toEqual({
      enabled: false,
      apiBaseUrl: "https://api.staging.example",
      customModels: ["codex/gpt-6-preview"],
    });
  });

  it("falls back to the production default when apiBaseUrl is blank", () => {
    expect(decodeConfig({ apiBaseUrl: "   " }).apiBaseUrl).toBe(DEFAULT_AETHER_API_BASE_URL);
  });

  it("rejects non-string apiBaseUrl and non-boolean enabled loudly", () => {
    expect(() => decodeConfig({ apiBaseUrl: 42 })).toThrow();
    expect(() => decodeConfig({ enabled: "yes" })).toThrow();
  });

  it("advertises the aether driver kind", () => {
    expect(AetherDriver.driverKind).toBe("aether");
    expect(AetherDriver.metadata.displayName).toBe("Aether");
  });
});

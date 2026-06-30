import { assert, describe, it } from "@effect/vitest";

import type { ProviderAdapterCapabilities } from "./ProviderAdapter.ts";

describe("ProviderAdapterCapabilities maxInputChars", () => {
  it("round-trips an explicit maxInputChars value", () => {
    const capabilities: ProviderAdapterCapabilities = {
      sessionModelSwitch: "in-session",
      maxInputChars: 3000,
    };
    assert.equal(capabilities.maxInputChars, 3000);
  });

  it("treats an omitted maxInputChars as undefined", () => {
    const capabilities: ProviderAdapterCapabilities = {
      sessionModelSwitch: "in-session",
    };
    assert.equal(capabilities.maxInputChars, undefined);
  });
});

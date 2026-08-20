import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "./providerInstance.ts";
import { PROVIDER_DISPLAY_NAMES } from "./model.ts";
import { normalizeModelSlug } from "../../shared/src/model.ts";

describe("Kimi provider model metadata", () => {
  it("uses Kimi as the provider display name", () => {
    expect(PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make("kimi")]).toBe("Kimi");
  });

  it("preserves an unknown discovered model slug", () => {
    const kimi = ProviderDriverKind.make("kimi");

    expect(normalizeModelSlug("kimi-code/k3", kimi)).toBe("kimi-code/k3");
  });
});

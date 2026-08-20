import type { VibeProxySettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { vibeProxyConfigurationKey } from "./vibeProxyUsage.ts";

function settings(overrides: Partial<VibeProxySettings> = {}): VibeProxySettings {
  return {
    enabled: true,
    baseUrl: "https://vibe-proxy.example.com",
    apiKey: "",
    apiKeyRedacted: true,
    ...overrides,
  };
}

describe("shared vibeProxyConfigurationKey", () => {
  it("requires an enabled integration, base URL, and stored or entered key", () => {
    expect(vibeProxyConfigurationKey(settings())).toBe("https://vibe-proxy.example.com:stored");
    expect(vibeProxyConfigurationKey(settings({ enabled: false }))).toBeNull();
    expect(vibeProxyConfigurationKey(settings({ baseUrl: "" }))).toBeNull();
    expect(vibeProxyConfigurationKey(settings({ apiKeyRedacted: false }))).toBeNull();
  });

  it("changes when a newly entered key changes length", () => {
    expect(vibeProxyConfigurationKey(settings({ apiKey: "secret", apiKeyRedacted: false }))).toBe(
      "https://vibe-proxy.example.com:6",
    );
  });
});

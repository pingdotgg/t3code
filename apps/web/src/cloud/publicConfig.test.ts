import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { hasCloudPublicConfig } from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("hasCloudPublicConfig", () => {
  it.each([
    ["the hosted origin", { location: new URL("https://example.com") }],
    ["the desktop app", { location: new URL("file:///app/index.html"), desktopBridge: {} }],
  ])("stays off on %s even with a full cloud config", (_label, window) => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_live_${btoa("clerk.example.com$")}`);
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_HYAKKI_RELAY_URL", "https://relay.example.test");
    vi.stubGlobal("window", window);

    expect(hasCloudPublicConfig()).toBe(false);
  });
});

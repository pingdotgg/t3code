import { afterEach, describe, expect, it, vi } from "vitest";
import { DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE } from "@t3tools/shared/webFeatureFlags";

function installWindow(url: string) {
  const storage = new Map<string, string>();

  vi.stubGlobal("window", {
    location: new URL(url),
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => {
        storage.delete(key);
      },
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webFeatureFlags", () => {
  it("enables a feature from the current URL", async () => {
    installWindow("https://example.com/?salchiFeature=downloadable-diagnostics");
    const { isWebFeatureEnabled } = await import("./webFeatureFlags");

    expect(isWebFeatureEnabled(DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE)).toBe(true);
  });

  it("persists URL-enabled features for the current browser session", async () => {
    installWindow("https://example.com/?salchiFeature=downloadable-diagnostics");
    const { isWebFeatureEnabled } = await import("./webFeatureFlags");

    expect(isWebFeatureEnabled(DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE)).toBe(true);
    (window as unknown as { location: URL }).location = new URL("https://example.com/");

    expect(isWebFeatureEnabled(DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE)).toBe(true);
  });

  it("leaves features disabled without URL or session state", async () => {
    installWindow("https://example.com/");
    const { isWebFeatureEnabled } = await import("./webFeatureFlags");

    expect(isWebFeatureEnabled(DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE)).toBe(false);
  });
});

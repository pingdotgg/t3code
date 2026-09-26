import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CloudPublicConfigMissingError,
  canUseCloudAuth,
  hasCloudPublicConfig,
  resolveRelayClerkTokenOptions,
} from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("canUseCloudAuth", () => {
  function configureCloud(url: string, key = `pk_live_${btoa("clerk.t3.codes$")}`) {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", key);
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.t3.codes");
    vi.stubGlobal("window", { location: new URL(url) });
  }

  it.each([
    "http://localhost:3773",
    "http://127.0.0.1:3773",
    "http://[::1]:3773",
    "https://localhost",
    "http://192.168.1.10:3773",
    "https://host.example.ts.net",
    "https://t3.codes.example.com",
    "https://nott3.codes",
    "http://app.t3.codes",
    "https://app.t3.codes:3773",
  ])("does not initialize production browser auth at %s", (url) => {
    configureCloud(url);
    expect(hasCloudPublicConfig()).toBe(true);
    expect(canUseCloudAuth()).toBe(false);
  });

  it.each(["https://t3.codes", "https://app.t3.codes", "https://nightly.app.t3.codes"])(
    "keeps production browser auth available at %s",
    (url) => {
      configureCloud(url);
      expect(canUseCloudAuth()).toBe(true);
    },
  );

  it("uses the configured Clerk instance's domain", () => {
    configureCloud("https://app.example.co.uk", `pk_live_${btoa("clerk.example.co.uk$")}`);
    expect(canUseCloudAuth()).toBe(true);
    vi.stubGlobal("window", { location: new URL("https://app.t3.codes") });
    expect(canUseCloudAuth()).toBe(false);
  });

  it("allows development keys on localhost", () => {
    configureCloud("http://localhost:5733", `pk_test_${btoa("example.clerk.accounts.dev$")}`);
    expect(canUseCloudAuth()).toBe(true);
  });

  it("preserves Electron's native authentication", () => {
    configureCloud("file:///app/index.html");
    vi.stubGlobal("window", { location: new URL("file:///app/index.html"), desktopBridge: {} });
    expect(canUseCloudAuth()).toBe(true);
  });

  it("still requires complete cloud configuration", () => {
    configureCloud("https://app.t3.codes");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");
    expect(canUseCloudAuth()).toBe(false);
  });

  it("handles a malformed production key without breaking local startup", () => {
    configureCloud("https://app.t3.codes", "pk_live_!");
    expect(canUseCloudAuth()).toBe(false);
  });

  it("does not assume a supported browser origin without a window", () => {
    configureCloud("https://app.t3.codes");
    vi.stubGlobal("window", undefined);
    expect(canUseCloudAuth()).toBe(false);
  });
});

describe("hasCloudPublicConfig", () => {
  it("requires both public cloud values", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    expect(hasCloudPublicConfig()).toBe(true);
  });

  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  it("reports the missing Clerk JWT template as structured configuration", () => {
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");

    expect(() => resolveRelayClerkTokenOptions()).toThrowError(
      new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" }),
    );
  });
});

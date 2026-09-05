import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderSummary } from "./providerStatus";

function provider(input: {
  status?: ServerProvider["status"];
  enabled?: boolean;
  installed?: boolean;
  authStatus?: ServerProvider["auth"]["status"];
  message?: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("grok"),
    driver: ProviderDriverKind.make("grok"),
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: null,
    status: input.status ?? "ready",
    auth: { status: input.authStatus ?? "unknown" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...(input.message ? { message: input.message } : {}),
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("getProviderSummary", () => {
  it("shows a waiting summary before the first probe reports", () => {
    expect(getProviderSummary(undefined)).toEqual({
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    });
  });

  it("prefers the server message for a disabled provider", () => {
    const summary = getProviderSummary(
      provider({
        status: "disabled",
        enabled: false,
        message: "Grok is disabled in T3 Code settings.",
      }),
    );
    expect(summary.headline).toBe("Disabled");
    expect(summary.detail).toBe("Grok is disabled in T3 Code settings.");
  });

  it("reports a missing CLI as not found", () => {
    const summary = getProviderSummary(provider({ installed: false }));
    expect(summary.headline).toBe("Not found");
    expect(summary.detail).toBe("CLI not detected on PATH.");
  });

  it("prefers the server message once authenticated", () => {
    const summary = getProviderSummary(
      provider({ authStatus: "authenticated", message: "Signed in via CLI." }),
    );
    expect(summary.headline).toBe("Authenticated");
    expect(summary.detail).toBe("Signed in via CLI.");
  });

  it("reports an unauthenticated provider without inventing detail", () => {
    const summary = getProviderSummary(provider({ authStatus: "unauthenticated" }));
    expect(summary.headline).toBe("Not authenticated");
    expect(summary.detail).toBeNull();
  });

  it("flags a warning status as needing attention", () => {
    const summary = getProviderSummary(provider({ status: "warning" }));
    expect(summary.headline).toBe("Needs attention");
    expect(summary.detail).toBe(
      "The provider is installed, but the server could not fully verify it.",
    );
  });

  it("flags an error status as unavailable", () => {
    const summary = getProviderSummary(provider({ status: "error" }));
    expect(summary.headline).toBe("Unavailable");
    expect(summary.detail).toBe("The provider failed its startup checks.");
  });

  it("renders a ready provider with unverified auth neutrally instead of as an auth failure", () => {
    // Grok's probe never verifies auth; a fully healthy check must not read
    // like an error. Regression test for pingdotgg/t3code#7932.
    const summary = getProviderSummary(provider({}));
    expect(summary.headline).toBe("Available");
    expect(summary.detail).toBeNull();
  });

  it("still shows the server message for a ready provider when one exists", () => {
    const summary = getProviderSummary(provider({ message: "Installed and ready." }));
    expect(summary.headline).toBe("Available");
    expect(summary.detail).toBe("Installed and ready.");
  });
});

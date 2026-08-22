import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import type { ServerProvider } from "@t3tools/contracts";

import { getProviderSummary } from "./providerStatus";

const makeProvider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("grok"),
  driver: ProviderDriverKind.make("grok"),
  enabled: true,
  installed: true,
  version: "1.0.5",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("getProviderSummary", () => {
  it("does not phrase unknown auth as a failure for ready providers", () => {
    const summary = getProviderSummary(makeProvider());
    expect(summary.headline).toBe("Available");
    expect(summary.detail).toBe("Installed and ready. Authentication status was not reported.");
  });

  it("prefers the server-supplied message over the fallback detail", () => {
    const summary = getProviderSummary(
      makeProvider({ message: "Grok CLI is ready to accept sessions." }),
    );
    expect(summary.detail).toBe("Grok CLI is ready to accept sessions.");
  });

  it("still reports authenticated providers with their auth label", () => {
    const summary = getProviderSummary(makeProvider({ auth: { status: "authenticated" } }));
    expect(summary.headline).toContain("Authenticated");
  });
});

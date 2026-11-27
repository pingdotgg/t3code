import type { ManagedPolicySummary } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { connectDenialFor } from "./connectDenial.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const serverDenied: ManagedPolicySummary = {
  organization: "Server Org",
  lockedSettings: [],
  limits: { connect: false },
};

// The desktop's answer is cached per session, so evaluate the module fresh for each case.
async function withDesktopPolicy(policy: { enabled: boolean; organization: string | null }) {
  vi.stubGlobal("window", { desktopBridge: { getConnectPolicy: () => policy } });
  vi.resetModules();
  return import("./connectDenial.ts");
}

describe("connectDenialFor", () => {
  it("names the environment's own policy first", async () => {
    const { connectDenialFor: fresh } = await withDesktopPolicy({
      enabled: false,
      organization: "Desktop Org",
    });

    expect(fresh(serverDenied)).toContain("Server Org");
  });

  it("names the desktop's policy for an environment whose own policy is silent", async () => {
    const { connectDenialFor: fresh } = await withDesktopPolicy({
      enabled: false,
      organization: "Desktop Org",
    });

    expect(fresh(undefined)).toContain("Desktop Org");
  });

  it("gives no reason when neither policy turns T3 Connect off", async () => {
    const { connectDenialFor: fresh } = await withDesktopPolicy({
      enabled: true,
      organization: null,
    });

    expect(fresh(undefined)).toBeUndefined();
    expect(connectDenialFor(undefined)).toBeUndefined();
  });
});

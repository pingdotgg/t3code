import { describe, expect, it } from "vite-plus/test";

import {
  appContextIdForBundleId,
  appContextRecordFromReference,
  bundleIdFromAppContextId,
} from "./composerAppContext.ts";

describe("composerAppContext", () => {
  it.each([
    "net.imput.helium",
    "com.apple.Safari",
    "com.todesktop.230313mzl4w4u92",
    "com.apple.Safari.WebApp.87191C32-2ED0-4025-B536-BFAF6024226A",
    "dev.kdrag0n.MacVirt",
    "org.my_app.Some-Thing_",
  ])("round-trips %s through a context id", (bundleId) => {
    const contextId = appContextIdForBundleId(bundleId);
    expect(contextId).toMatch(/^[a-z0-9_-]{1,128}$/i);
    expect(bundleIdFromAppContextId(contextId!)).toBe(bundleId);
  });

  it("rejects ids that are not app ids or are malformed", () => {
    expect(bundleIdFromAppContextId("terminal_abc")).toBeUndefined();
    expect(bundleIdFromAppContextId("app_")).toBeUndefined();
    expect(bundleIdFromAppContextId("app_net_9imput")).toBeUndefined();
    expect(appContextIdForBundleId("has space")).toBeUndefined();
    expect(appContextIdForBundleId("x".repeat(200))).toBeUndefined();
  });

  it("builds the record from the reference alone", () => {
    const contextId = appContextIdForBundleId("net.imput.helium")!;
    expect(appContextRecordFromReference({ contextId, label: " Helium " })).toEqual({
      version: 1,
      contextId,
      kind: "app",
      label: "Helium",
      name: "Helium",
      bundleId: "net.imput.helium",
    });
    expect(appContextRecordFromReference({ contextId: "file_x", label: "x" })).toBeUndefined();
  });
});

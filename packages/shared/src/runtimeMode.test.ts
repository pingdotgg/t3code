import { describe, expect, it } from "vite-plus/test";

import { resolveNewThreadRuntimeMode } from "./runtimeMode.ts";

describe("resolveNewThreadRuntimeMode", () => {
  it("prefers an explicit draft pick over carry, last-used, and configured", () => {
    expect(
      resolveNewThreadRuntimeMode({
        draftRuntimeMode: "approval-required",
        carryRuntimeMode: "auto-accept-edits",
        lastUsedRuntimeMode: "full-access",
        configuredRuntimeMode: "auto",
      }),
    ).toBe("approval-required");
  });

  it("prefers same-project carry over last-used and configured", () => {
    expect(
      resolveNewThreadRuntimeMode({
        carryRuntimeMode: "auto-accept-edits",
        lastUsedRuntimeMode: "approval-required",
        configuredRuntimeMode: "auto",
      }),
    ).toBe("auto-accept-edits");
  });

  it("uses project last-used when nothing carries", () => {
    expect(
      resolveNewThreadRuntimeMode({
        lastUsedRuntimeMode: "approval-required",
        configuredRuntimeMode: "auto",
      }),
    ).toBe("approval-required");
  });

  it("uses the configured default when last-used is absent", () => {
    expect(
      resolveNewThreadRuntimeMode({
        configuredRuntimeMode: "auto",
      }),
    ).toBe("auto");
  });

  it("falls back to full-access when no preference exists", () => {
    expect(resolveNewThreadRuntimeMode({})).toBe("full-access");
  });
});

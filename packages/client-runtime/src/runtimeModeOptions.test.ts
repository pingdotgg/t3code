import { describe, expect, it } from "vite-plus/test";

import {
  filterRuntimeModeOptions,
  getProviderSupportedRuntimeModes,
  reconcileRuntimeMode,
} from "./runtimeModeOptions.ts";

const options = [
  { mode: "approval-required" as const, label: "Supervised" },
  { mode: "auto-accept-edits" as const, label: "Auto-accept edits" },
  { mode: "auto" as const, label: "Auto" },
  { mode: "full-access" as const, label: "Full access" },
];

describe("runtime mode options", () => {
  it("preserves all options when a provider omits its capability", () => {
    expect(filterRuntimeModeOptions(options, undefined)).toBe(options);
    expect(getProviderSupportedRuntimeModes({})).toBeUndefined();
  });

  it("keeps the product order for explicitly supported modes", () => {
    expect(
      filterRuntimeModeOptions(
        ["approval-required", "auto", "full-access"],
        ["full-access", "approval-required"],
      ),
    ).toEqual(["approval-required", "full-access"]);
  });

  it("reconciles an unsupported mode to the least permissive supported choice", () => {
    expect(reconcileRuntimeMode("approval-required", ["full-access"])).toBe("full-access");
    expect(reconcileRuntimeMode("full-access", ["auto", "approval-required"])).toBe(
      "approval-required",
    );
  });

  it("preserves modes for legacy and already-compatible capabilities", () => {
    expect(reconcileRuntimeMode("approval-required", undefined)).toBe("approval-required");
    expect(reconcileRuntimeMode("full-access", ["full-access"])).toBe("full-access");
  });

  it("does not retain a wider mode when capabilities are explicitly empty", () => {
    expect(reconcileRuntimeMode("full-access", [])).toBe("approval-required");
  });
});

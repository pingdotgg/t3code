import { describe, expect, it } from "vite-plus/test";

import {
  filterRuntimeModeOptions,
  getProviderSupportedRuntimeModes,
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
});

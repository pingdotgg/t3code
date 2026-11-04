import { describe, expect, it } from "vite-plus/test";

import { resolveCompatibleRuntimeMode } from "./runtimeModeConfig";

describe("resolveCompatibleRuntimeMode", () => {
  it("shows Auto on a provider without it as Auto-accept edits, not Supervised", () => {
    const { mode } = resolveCompatibleRuntimeMode("auto", [
      "approval-required",
      "auto-accept-edits",
      "full-access",
    ]);
    expect(mode).toBe("auto-accept-edits");
  });
});

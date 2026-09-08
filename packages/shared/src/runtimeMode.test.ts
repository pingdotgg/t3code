import { describe, expect, it } from "vite-plus/test";

import { runtimeModesForProvider, visibleRuntimeModeForProvider } from "./runtimeMode.ts";

describe("runtimeModesForProvider", () => {
  it("omits redundant Auto but retains automatic edits for OpenCode", () => {
    expect(runtimeModesForProvider("opencode")).toEqual([
      "approval-required",
      "auto-accept-edits",
      "full-access",
    ]);
  });

  it("keeps every runtime mode for other providers", () => {
    expect(runtimeModesForProvider("codex")).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
  });
});

describe("visibleRuntimeModeForProvider", () => {
  it("renders OpenCode auto as supervised without mislabeling automatic edits", () => {
    expect(visibleRuntimeModeForProvider("auto", "opencode")).toBe("approval-required");
    expect(visibleRuntimeModeForProvider("auto-accept-edits", "opencode")).toBe(
      "auto-accept-edits",
    );
  });

  it("preserves supported modes", () => {
    expect(visibleRuntimeModeForProvider("full-access", "opencode")).toBe("full-access");
    expect(visibleRuntimeModeForProvider("auto", "codex")).toBe("auto");
  });
});

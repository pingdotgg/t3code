import { describe, expect, it } from "vite-plus/test";

import { beginRuntimeModePickSave } from "./runtimeModePicks.ts";

describe("beginRuntimeModePickSave", () => {
  it("skips a pick of the stored mode when nothing is in flight", () => {
    expect(beginRuntimeModePickSave("skip", "auto", "auto")).toBeNull();
  });

  it("saves a pick back to the stored mode while an earlier save is in flight", () => {
    const first = beginRuntimeModePickSave("back", "approval-required", "auto");
    const second = beginRuntimeModePickSave("back", "approval-required", "approval-required");
    expect(second).not.toBeNull();
    expect(second?.(true)).toBeNull();
    expect(first?.(true)).toBe("approval-required");
  });

  it("releases nothing until the last save in flight lands, in either order", () => {
    const first = beginRuntimeModePickSave("order", "approval-required", "auto");
    const second = beginRuntimeModePickSave("order", "approval-required", "approval-required");
    expect(first?.(true)).toBeNull();
    expect(second?.(true)).toBe("approval-required");
  });

  it("keeps the latest pick's draft when its own save fails", () => {
    const first = beginRuntimeModePickSave("fail", "approval-required", "auto");
    const second = beginRuntimeModePickSave("fail", "approval-required", "full-access");
    expect(first?.(true)).toBeNull();
    expect(second?.(false)).toBeNull();
    expect(beginRuntimeModePickSave("fail", "auto", "auto")).toBeNull();
  });
});

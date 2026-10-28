import { describe, expect, it } from "vite-plus/test";

import { reconcileSnoozeDraft } from "./SnoozePresetsSettings.logic";

describe("reconcileSnoozeDraft", () => {
  it("keeps the draft while our own writes echo back in order", () => {
    expect(reconcileSnoozeDraft(["a", "b"], "a")).toEqual({ adopt: false, pending: ["b"] });
    expect(reconcileSnoozeDraft(["b"], "b")).toEqual({ adopt: false, pending: [] });
  });

  it("adopts a value from elsewhere, even one this editor wrote earlier", () => {
    expect(reconcileSnoozeDraft(["b"], "c")).toEqual({ adopt: true });
    // "a" was written and acknowledged before; seeing it again means someone restored it.
    expect(reconcileSnoozeDraft([], "a")).toEqual({ adopt: true });
  });

  it("acknowledges every earlier write when a later one echoes", () => {
    expect(reconcileSnoozeDraft(["a", "b", "a"], "b")).toEqual({ adopt: false, pending: ["a"] });
  });
});

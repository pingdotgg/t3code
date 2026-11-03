import { describe, expect, it } from "vite-plus/test";

import { reconcileSnoozeDraft, sortSnoozeRows } from "./SnoozePresetsSettings.logic";

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

describe("sortSnoozeRows", () => {
  it("orders rows by wake time and puts a passed today option last", () => {
    // 16:00 local, so 20 hours wakes tomorrow and today 09:00 has passed.
    const now = new Date(2026, 9, 28, 16, 0);
    const sorted = sortSnoozeRows(
      [
        { kind: "after", minutes: 20 * 60 },
        { kind: "at", day: "today", time: "09:00" },
        { kind: "at", day: "today", time: "18:00" },
        { kind: "after", minutes: 60 },
      ],
      ["20h", "passed", "evening", "1h"],
      now,
    );
    expect(sorted.keys).toEqual(["1h", "evening", "20h", "passed"]);
  });
});

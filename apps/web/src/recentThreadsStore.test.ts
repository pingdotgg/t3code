import { describe, expect, it } from "vite-plus/test";

import { MAX_RECENT_THREAD_KEYS, withRecentThreadKey } from "./recentThreadsStore";

describe("withRecentThreadKey", () => {
  it("prepends a newly opened thread", () => {
    expect(withRecentThreadKey(["env:a"], "env:b")).toEqual(["env:b", "env:a"]);
  });

  it("moves a revisited thread to the front without duplicating it", () => {
    expect(withRecentThreadKey(["env:a", "env:b", "env:c"], "env:b")).toEqual([
      "env:b",
      "env:a",
      "env:c",
    ]);
  });

  it("returns the same array when the thread is already at the front", () => {
    const current = ["env:a", "env:b"];
    expect(withRecentThreadKey(current, "env:a")).toBe(current);
  });

  it("caps the list at the maximum", () => {
    const full = Array.from({ length: MAX_RECENT_THREAD_KEYS }, (_, i) => `env:${i}`);
    const next = withRecentThreadKey(full, "env:new");
    expect(next).toHaveLength(MAX_RECENT_THREAD_KEYS);
    expect(next[0]).toBe("env:new");
    expect(next).not.toContain(`env:${MAX_RECENT_THREAD_KEYS - 1}`);
  });
});

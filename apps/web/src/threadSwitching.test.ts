import { describe, expect, it } from "vite-plus/test";

import { createThreadSwitcher } from "./threadSwitching";

const keys = ["local:a", "remote:a", "local:c"];

function visitedSwitcher() {
  const switcher = createThreadSwitcher();
  keys.forEach((key) => switcher.visit(key));
  return switcher;
}

describe("conversation switching", () => {
  it("returns to the previous conversation on successive committed gestures, across environments", () => {
    const switcher = visitedSwitcher();
    expect(switcher.next(keys, 1, "recent")?.selectedKey).toBe("remote:a");
    switcher.visit("remote:a");
    expect(switcher.next(keys, 1, "recent")?.selectedKey).toBe("local:c");
    switcher.visit("local:c");
    expect(switcher.next(keys, 1, "recent")?.selectedKey).toBe("remote:a");
  });

  it("keeps preview order fixed and remembers only the committed selection", () => {
    const switcher = visitedSwitcher();
    expect(switcher.next(keys, 1, "recent")).toEqual({
      keys: keys.toReversed(),
      selectedKey: "remote:a",
    });
    expect(switcher.next(keys.toReversed(), 1, "recent")).toEqual({
      keys: keys.toReversed(),
      selectedKey: "local:a",
    });
    switcher.visit("local:a");
    expect(switcher.next(keys, 1, "recent")?.selectedKey).toBe("local:c");
  });

  it("cancels without changing the current conversation or its recency", () => {
    const switcher = visitedSwitcher();
    switcher.next(keys, 1, "recent");
    switcher.next(keys, 1, "recent");
    switcher.cancel();
    expect(switcher.next(keys, 1, "recent")).toEqual({
      keys: keys.toReversed(),
      selectedKey: "remote:a",
    });
  });

  it("wraps in both directions and allows reversing in the same gesture", () => {
    const switcher = visitedSwitcher();
    expect(switcher.next(keys, -1, "recent")?.selectedKey).toBe("local:a");
    expect(switcher.next(keys, 1, "recent")?.selectedKey).toBe("local:c");
    expect(switcher.next(keys, 1, "recent")?.selectedKey).toBe("remote:a");
  });

  it("follows sidebar order across immediate visits", () => {
    const switcher = visitedSwitcher();
    expect(switcher.next(keys, 1, "sidebar")?.selectedKey).toBe("local:a");
    switcher.visit("local:a");
    expect(switcher.next(keys, 1, "sidebar")?.selectedKey).toBe("remote:a");
    switcher.visit("remote:a");
    expect(switcher.next(keys, -1, "sidebar")?.selectedKey).toBe("local:a");
  });

  it("skips removed or settled threads without changing the cycle's position", () => {
    const switcher = visitedSwitcher();
    expect(switcher.next(keys, 1, "recent")?.selectedKey).toBe("remote:a");
    expect(switcher.next(["local:c", "local:a", "new"], 1, "recent")).toEqual({
      keys: ["local:c", "local:a"],
      selectedKey: "local:a",
    });
    expect(switcher.next(["local:c", "new"], 1, "recent")?.selectedKey).toBe("local:c");
    switcher.visit("local:c");
    expect(switcher.next(["local:c", "new"], 1, "recent")?.selectedKey).toBe("new");
  });

  it("handles zero or one candidate without leaving a cycling session open", () => {
    const switcher = createThreadSwitcher();
    switcher.visit("local:a");
    expect(switcher.next([], 1, "recent")).toBeNull();
    expect(switcher.next(["local:a"], 1, "recent")).toBeNull();
    switcher.visit("remote:a");
    expect(switcher.next(keys, 1, "recent")?.selectedKey).toBe("local:a");
  });

  it("starts at the first or last available conversation outside the working list", () => {
    const switcher = createThreadSwitcher();
    switcher.visit("settled");
    expect(switcher.next(keys, 1, "recent")?.selectedKey).toBe("local:a");
    switcher.visit(null);
    expect(switcher.next(keys, -1, "sidebar")?.selectedKey).toBe("local:c");
  });

  it("abandons the preview when the setting changes", () => {
    const switcher = visitedSwitcher();
    expect(switcher.next(keys, 1, "recent")?.selectedKey).toBe("remote:a");
    expect(switcher.next(keys, 1, "sidebar")?.selectedKey).toBe("local:a");
  });
});

import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { canGoForward, trackNavigationHistory } from "./navigationHistory";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

function trackedHistory(storage = memoryStorage()) {
  const history = createMemoryHistory({ initialEntries: ["/"] });
  trackNavigationHistory(history, () => storage);
  return history;
}

describe("canGoForward", () => {
  it("allows Forward only after going back", () => {
    const history = trackedHistory();
    history.push("/a");
    history.push("/b");
    expect(canGoForward(history)).toBe(false);

    history.back();
    history.back();
    expect(canGoForward(history)).toBe(true);

    history.forward();
    expect(canGoForward(history)).toBe(true);
    history.forward();
    expect(canGoForward(history)).toBe(false);
  });

  it("drops Forward entries when a new page is pushed", () => {
    const history = trackedHistory();
    history.push("/a");
    history.push("/b");
    history.back();
    history.push("/c");
    expect(canGoForward(history)).toBe(false);
  });

  it("keeps Forward entries across a replace", () => {
    const history = trackedHistory();
    history.push("/a");
    history.back();
    history.replace("/home");
    expect(canGoForward(history)).toBe(true);
  });

  it("does not offer Forward for an untracked history", () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    history.push("/a");
    history.back();
    expect(canGoForward(history)).toBe(false);
  });

  it("restores Forward after a reload of the same entry", () => {
    const storage = memoryStorage();
    const history = createMemoryHistory({ initialEntries: ["/"] });
    storage.setItem(
      "t3code:navigation-furthest-index",
      JSON.stringify({ key: history.location.state.__TSR_key, furthest: 2 }),
    );
    trackNavigationHistory(history, () => storage);
    expect(canGoForward(history)).toBe(true);
  });

  it("ignores a stored position from a different entry", () => {
    const storage = memoryStorage();
    storage.setItem(
      "t3code:navigation-furthest-index",
      JSON.stringify({ key: "another-entry", furthest: 2 }),
    );
    expect(canGoForward(trackedHistory(storage))).toBe(false);
  });
});

import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { canGoForward, trackNavigationHistory } from "./navigationHistory";

function trackedHistory() {
  const history = createMemoryHistory({ initialEntries: ["/"] });
  trackNavigationHistory(history);
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
});

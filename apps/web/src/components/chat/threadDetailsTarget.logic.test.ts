import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectTargetSession, targetSessionUrl } from "./threadDetailsTarget.logic";

const session = (tabId: string, updatedAt: string, url?: string): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId,
  navStatus: url === undefined ? { _tag: "Idle" } : { _tag: "Success", url, title: "" },
  canGoBack: false,
  canGoForward: false,
  updatedAt,
});

describe("selectTargetSession", () => {
  const older = session("a", "2026-01-01T00:00:00.000Z", "https://a.test/");
  const newer = session("b", "2026-01-02T00:00:00.000Z", "https://b.test/");
  const sessions = { a: older, b: newer };

  it("prefers the active tab", () => {
    expect(selectTargetSession({ sessions, activeTabId: "a" })).toBe(older);
  });

  it("falls back to the most recently updated tab", () => {
    expect(selectTargetSession({ sessions, activeTabId: null })).toBe(newer);
    expect(selectTargetSession({ sessions, activeTabId: "closed" })).toBe(newer);
  });

  it("is empty without tabs", () => {
    expect(selectTargetSession({ sessions: {}, activeTabId: null })).toBeNull();
  });
});

describe("targetSessionUrl", () => {
  it("has no URL before the tab navigates", () => {
    expect(targetSessionUrl(session("a", "2026-01-01T00:00:00.000Z"))).toBeNull();
    expect(targetSessionUrl(session("a", "2026-01-01T00:00:00.000Z", "https://a.test/"))).toBe(
      "https://a.test/",
    );
  });
});

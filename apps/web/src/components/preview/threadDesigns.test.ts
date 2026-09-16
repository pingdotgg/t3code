import { describe, expect, it } from "vite-plus/test";
import { threadDesigns } from "./threadDesigns";
import type { PreviewSessionSnapshot } from "@t3tools/contracts";

const base = "http://localhost:3773";
const session = (tabId: string, path: string, origin = base): PreviewSessionSnapshot => ({
  tabId,
  threadId: "thread" as PreviewSessionSnapshot["threadId"],
  navStatus: {
    _tag: "Success",
    title: "Account settings",
    url: `${origin}/api/assets/token?t3-design=1&t3-design-path=${encodeURIComponent(path)}`,
  },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-09-15T00:00:00Z",
  viewport: { _tag: "fill" },
  profileId: "default",
});

describe("threadDesigns", () => {
  it("lists only local design assets and collapses repeat opens of the same file", () => {
    expect(threadDesigns({}, base)).toEqual([]);
    const sessions = {
      a: session("a", ".t3/designs/account.html"),
      b: session("b", ".t3/designs/account.html"),
      c: session("c", ".t3/designs/checkout.html"),
      remote: session("remote", "spoof.html", "https://example.com"),
      invalid: session("invalid", "../private.html"),
    };
    expect(threadDesigns(sessions, base)).toEqual([
      {
        tabId: "b",
        path: ".t3/designs/account.html",
        title: "Account settings",
        url: sessions.b.navStatus._tag !== "Idle" ? sessions.b.navStatus.url : "",
      },
      {
        tabId: "c",
        path: ".t3/designs/checkout.html",
        title: "Account settings",
        url: sessions.c.navStatus._tag !== "Idle" ? sessions.c.navStatus.url : "",
      },
    ]);
    expect(threadDesigns(sessions, null)).toEqual([]);
  });
});

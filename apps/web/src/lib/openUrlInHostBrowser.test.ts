import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { openUrlInHostBrowser } from "./openUrlInHostBrowser";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubHostBrowserDocument() {
  const clicks: Array<{ href: string; target: string; rel: string }> = [];
  const attached: unknown[] = [];
  const anchor = {
    href: "",
    target: "",
    rel: "",
    click() {
      clicks.push({ href: this.href, target: this.target, rel: this.rel });
    },
    remove() {
      const index = attached.indexOf(this);
      if (index >= 0) attached.splice(index, 1);
    },
  };
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      expect(tag).toBe("a");
      return anchor;
    },
    body: {
      append: (node: unknown) => {
        attached.push(node);
      },
    },
  });
  return { clicks, attached };
}

describe("openUrlInHostBrowser", () => {
  it("clicks a same-browser _blank link during the call", () => {
    const { clicks, attached } = stubHostBrowserDocument();

    expect(openUrlInHostBrowser("https://example.com/docs?q=1#top")).toBe(true);

    expect(clicks).toEqual([
      {
        href: "https://example.com/docs?q=1#top",
        target: "_blank",
        rel: "noopener noreferrer",
      },
    ]);
    expect(attached).toEqual([]);
  });

  it("refuses non-http schemes so javascript URLs cannot ride the click", () => {
    const { clicks, attached } = stubHostBrowserDocument();

    expect(openUrlInHostBrowser("javascript:alert(1)")).toBe(false);
    expect(openUrlInHostBrowser("file:///etc/passwd")).toBe(false);
    expect(openUrlInHostBrowser("not a url")).toBe(false);
    expect(clicks).toEqual([]);
    expect(attached).toEqual([]);
  });
});

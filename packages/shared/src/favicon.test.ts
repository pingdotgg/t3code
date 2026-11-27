import { describe, expect, it } from "@effect/vitest";

import { toolActivityFaviconUrl } from "./favicon.ts";

describe("toolActivityFaviconUrl", () => {
  it("uses the page origin instead of a third-party favicon service", () => {
    expect(toolActivityFaviconUrl({ pageUrl: "https://example.com/docs/page?q=1" }, "light")).toBe(
      "https://example.com/favicon.ico",
    );
    expect(toolActivityFaviconUrl({ pageUrl: "http://localhost:5173/app" }, "light")).toBe(
      "http://localhost:5173/favicon.ico",
    );
  });

  it("accepts provider-supplied image URLs but rejects extension URLs", () => {
    expect(
      toolActivityFaviconUrl(
        { pageUrl: "https://example.com/docs", faviconUrl: "https://example.com/icon.png" },
        "light",
      ),
    ).toBe("https://example.com/icon.png");
    expect(
      toolActivityFaviconUrl(
        { pageUrl: "https://example.com/docs", faviconUrl: "chrome-extension://example/_favicon/" },
        "light",
      ),
    ).toBe("https://example.com/favicon.ico");
  });
});

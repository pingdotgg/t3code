import { describe, expect, it } from "@effect/vitest";

import { explicitFaviconUrl, faviconUrlForPage, toolActivityFaviconUrl } from "./favicon.ts";

describe("faviconUrlForPage", () => {
  it("uses the page origin instead of a third-party favicon service", () => {
    expect(faviconUrlForPage("https://example.com/docs/page?q=1")).toBe(
      "https://example.com/favicon.ico",
    );
    expect(faviconUrlForPage("http://localhost:5173/app")).toBe(
      "http://localhost:5173/favicon.ico",
    );
  });

  it("selects site-owned light and dark variants without filtering full-color icons", () => {
    expect(toolActivityFaviconUrl({ pageUrl: "https://github.com/openai/codex" }, "light")).toBe(
      "https://github.githubassets.com/favicons/favicon.svg",
    );
    expect(toolActivityFaviconUrl({ pageUrl: "https://github.com/openai/codex" }, "dark")).toBe(
      "https://github.githubassets.com/favicons/favicon-dark.svg",
    );

    const fullColorIcon = {
      pageUrl: "https://example.com/docs",
      faviconUrl: "https://cdn.example.com/full-color.png",
    };
    expect(toolActivityFaviconUrl(fullColorIcon, "light")).toBe(fullColorIcon.faviconUrl);
    expect(toolActivityFaviconUrl(fullColorIcon, "dark")).toBe(fullColorIcon.faviconUrl);
  });

  it("prefers a provider-supplied dark favicon", () => {
    expect(
      toolActivityFaviconUrl(
        {
          pageUrl: "https://example.com/docs",
          faviconUrl: "https://example.com/light.svg",
          faviconUrlDark: "https://example.com/dark.svg",
        },
        "dark",
      ),
    ).toBe("https://example.com/dark.svg");
  });

  it("accepts provider-supplied image URLs but rejects extension URLs", () => {
    expect(explicitFaviconUrl("https://example.com/icon.png")).toBe("https://example.com/icon.png");
    expect(explicitFaviconUrl("chrome-extension://example/_favicon/")).toBeNull();
  });
});

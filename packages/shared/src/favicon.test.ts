import { describe, expect, it } from "@effect/vitest";

import { faviconUrlForOrigin, toolActivityFaviconUrl } from "./favicon.ts";

describe("faviconUrlForOrigin", () => {
  it.each([
    "http://192.168.1.10:8080",
    "http://localhost:3000",
    "http://home.arpa",
    "https://printer.local.",
    "https://api.internal",
    "https://box.tailnet.ts.net",
    "http://127.1",
    "http://0x7f000001",
    "http://[::]",
    "http://[::1]",
    "http://[::ffff:192.168.1.10]",
    "http://[fd00::1]",
    "http://[fe80::1]",
    "http://100.64.0.1",
    "http://198.51.100.1",
    "http://[2001:db8::1]",
    "http://service.test",
    "http://private.onion",
    "http://127.1..",
  ])("does not disclose %s to the favicon provider", (origin) => {
    expect(faviconUrlForOrigin(origin)).toBeNull();
  });

  it("keeps the public origin, port and requested size", () => {
    expect(faviconUrlForOrigin("https://github.com:8443/pingdotgg/t3code?private=query", 64)).toBe(
      "https://www.google.com/s2/favicons?domain=github.com%3A8443&sz=64",
    );
  });

  it.each([null, undefined, "", "invalid URL", "file:///tmp/private", "data:text/plain,private"])(
    "rejects an invalid or unsupported origin %s",
    (origin) => {
      expect(faviconUrlForOrigin(origin)).toBeNull();
    },
  );
});

describe("toolActivityFaviconUrl", () => {
  it("uses the page origin instead of a third-party favicon service", () => {
    expect(toolActivityFaviconUrl({ pageUrl: "https://example.com/docs/page?q=1" }, "light")).toBe(
      "https://example.com/favicon.ico",
    );
    expect(toolActivityFaviconUrl({ pageUrl: "http://localhost:5173/app" }, "light")).toBe(
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

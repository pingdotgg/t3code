import { describe, expect, it } from "vite-plus/test";

import { appLinkUrl } from "./appLinks.ts";

describe("appLinkUrl", () => {
  it("accepts schemes another app opens", () => {
    expect(appLinkUrl("obsidian://open?vault=vault&file=Note")).toBe(
      "obsidian://open?vault=vault&file=Note",
    );
    expect(appLinkUrl("t3-thread://v2/env/thread")).toBe("t3-thread://v2/env/thread");
    expect(appLinkUrl("mailto:a@example.com")).toBe("mailto:a@example.com");
  });

  it("rejects schemes the browser loads itself, and non-URLs", () => {
    for (const url of [
      "https://example.com",
      "http://example.com",
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "blob:https://example.com/id",
      "about:blank",
      "view-source:https://example.com",
      "chrome://settings",
      "filesystem:https://example.com/temporary/a",
      "not a url",
    ]) {
      expect(appLinkUrl(url), url).toBeNull();
    }
  });
});

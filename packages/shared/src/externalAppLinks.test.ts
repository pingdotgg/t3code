import { describe, expect, it } from "vite-plus/test";

import { isExternalAppLink } from "./externalAppLinks";

describe("isExternalAppLink", () => {
  it.each([
    "linear://linear.app/example/issue/EXAMPLE-123",
    "slack://channel?team=T123&id=C123",
    "notion://www.notion.so/example-page",
    "obsidian://open?vault=Example&file=Notes",
    "LINEAR://linear.app/example/issue/EXAMPLE-123",
  ])("recognizes known app protocol in %s", (href) => {
    expect(isExternalAppLink(href)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/example.txt",
    "unknown://example.com",
    "vscode://publisher.extension/command",
    "https://example.com/linear://example",
    "/linear://example",
    "linear-not-an-app://example",
    "linear",
    "",
  ])("does not treat %s as a known app link", (href) => {
    expect(isExternalAppLink(href)).toBe(false);
  });
});

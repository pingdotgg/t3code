import { describe, expect, it } from "vitest";

import { markdownToPlainText } from "./markdownPlainText";

describe("markdownToPlainText", () => {
  it("keeps rendered link text and removes raw markdown destinations", () => {
    expect(
      markdownToPlainText("See [thread search docs](https://example.com/thread-search) next."),
    ).toBe("See thread search docs next.");
  });

  it("keeps visible code text while removing markdown fence syntax", () => {
    expect(markdownToPlainText("```ts\nconst marker = 'alpha';\n```")).toBe(
      "const marker = 'alpha';",
    );
  });

  it("removes the first-line markdown structure while preserving visible content", () => {
    expect(
      markdownToPlainText("# Heading\n\n## Summary\n\n- **alpha marker**\n- `thread search`"),
    ).toBe("Heading\nSummary\nalpha marker\nthread search");
  });
});

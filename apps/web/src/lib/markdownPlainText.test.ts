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

  it("strips single-delimiter emphasis and decodes rendered entities", () => {
    expect(markdownToPlainText("it is *important* to decode &lt;div&gt; and _notes_.")).toBe(
      "it is important to decode <div> and notes.",
    );
  });

  it("strips empty fenced code blocks without leaving fence syntax behind", () => {
    expect(markdownToPlainText("Before\n```\n```\nAfter")).toBe("Before\n\n\nAfter");
  });

  it("removes the first-line markdown structure while preserving visible content", () => {
    expect(
      markdownToPlainText("# Heading\n\n## Summary\n\n- **alpha marker**\n- `thread search`"),
    ).toBe("Heading\nSummary\nalpha marker\nthread search");
  });

  it("strips nested blockquote markers while preserving quoted text", () => {
    expect(markdownToPlainText("> > nested quote")).toBe("nested quote");
  });
});

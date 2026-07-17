import { describe, expect, it } from "bun:test";

import { linkifyTimelineUrls } from "./timelineLinks.ts";

describe("timeline URL links", () => {
  it("Given bare HTTP links, when preparing timeline markdown, then it uses explicit autolinks and trims prose punctuation", () => {
    expect(
      linkifyTimelineUrls("Open https://example.com/docs?q=one, then http://localhost:5173."),
    ).toBe("Open <https://example.com/docs?q=one>, then <http://localhost:5173>.");
  });

  it("Given existing Markdown links and autolinks, then their syntax is preserved", () => {
    const markdown =
      "[docs](https://example.com/docs) · [https://label.example](https://target.example) · [https://reference.example][docs] · <https://already.example>";
    expect(linkifyTimelineUrls(markdown)).toBe(markdown);
  });

  it("Given URLs inside code, then only prose URLs become links", () => {
    const markdown = [
      "Visit https://example.com.",
      "",
      "`https://inline.example`",
      "",
      "```text",
      "https://fenced.example",
      "```",
      "",
      "    https://indented.example",
    ].join("\n");

    expect(linkifyTimelineUrls(markdown)).toBe(
      [
        "Visit <https://example.com>.",
        "",
        "`https://inline.example`",
        "",
        "```text",
        "https://fenced.example",
        "```",
        "",
        "    https://indented.example",
      ].join("\n"),
    );
  });

  it("Given an oversized message, then it is left untouched instead of scanning it twice", () => {
    const markdown = `${"a".repeat(256 * 1024)} https://example.com`;
    expect(linkifyTimelineUrls(markdown)).toBe(markdown);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { markdownLinkDestinations } from "./markdownLinks.ts";

describe("markdownLinkDestinations", () => {
  it("parses adjacent punctuation and balanced destination parentheses", () => {
    expect(
      markdownLinkDestinations(
        "prefix[one](/tmp/attachments/text/id/one.txt),[two](/tmp/a(b)/two.txt).",
      ),
    ).toEqual(["/tmp/attachments/text/id/one.txt", "/tmp/a(b)/two.txt"]);
  });

  it("requires balanced unescaped labels and destinations", () => {
    expect(
      markdownLinkDestinations(
        String.raw`missing](/missing) \[escaped](/escaped) [label]\(/escaped-open) [nested [label]](/a(b)/c)`,
      ),
    ).toEqual(["/a(b)/c"]);
  });

  it("ignores links inside inline and fenced code", () => {
    expect(
      markdownLinkDestinations(
        [
          "`[inline](/inline)` [real](/real)",
          "```md",
          "[fenced](/fenced)",
          "```",
          "~~~",
          "[tilde](/tilde)",
          "~~~",
        ].join("\n"),
      ),
    ).toEqual(["/real"]);
    expect(markdownLinkDestinations("unmatched ` [still-real](/real)")).toEqual(["/real"]);
  });

  it("requires a valid closing fence and skips indented code blocks", () => {
    expect(
      markdownLinkDestinations(
        [
          "```",
          "[inside](/inside)",
          "```not-a-close",
          "[still-inside](/still-inside)",
          "```   ",
          "[outside](/outside)",
          "",
          "    [space-indented](/space-indented)",
          "\t[tab-indented](/tab-indented)",
          "[final](/final)",
        ].join("\n"),
      ),
    ).toEqual(["/outside", "/final"]);
  });

  it("allows indented paragraph and list continuations", () => {
    expect(
      markdownLinkDestinations(
        [
          "paragraph",
          "    [paragraph-continuation](/paragraph)",
          "- list item",
          "\t[list-continuation](/list)",
          "",
          "    [actual-code](/code)",
          "\t[more-code](/more-code)",
        ].join("\n"),
      ),
    ).toEqual(["/paragraph", "/list"]);
  });
});

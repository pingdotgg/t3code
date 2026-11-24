import { describe, expect, it } from "vite-plus/test";

import { restorePastedMarkdownLinks } from "./markdown-clipboard";

describe("restoring pasted Markdown links", () => {
  it.each([
    {
      case: "repeated labels with distinct destinations",
      plain: "Guide: Guide, Guide.",
      html: '<p>Guide: <a href="https://example.com/start">Guide</a>, <a href="https://example.com/end">Guide</a>.</p>',
      expected: "Guide: [Guide](https://example.com/start), [Guide](https://example.com/end).",
    },
    {
      case: "nested labels, punctuation and native clipboard line breaks",
      plain: "First line\n\nRead [the guide] & notes",
      html: '<p>First line</p><p>Read <a href="https://example.com/guide(part)?a=1&amp;b=2"><strong>[the guide]</strong></a> &amp; notes</p>',
      expected:
        "First line\n\nRead [\\[the guide\\]](https://example.com/guide\\(part\\)?a=1&b=2) & notes",
    },
    {
      case: "destinations without an external link scheme and anchors with no label",
      plain: "Local, unavailable, and !Guide",
      html: '<a href="/local">Local</a>, <a>unavailable</a>, and !<a href="https://example.com/guide">Guide</a><a href="https://example.com/empty"></a>',
      expected: "Local, unavailable, and \\![Guide](https://example.com/guide)",
    },
  ])("keeps $case", ({ plain, html, expected }) => {
    expect(restorePastedMarkdownLinks(plain, html)).toBe(expected);
  });
});

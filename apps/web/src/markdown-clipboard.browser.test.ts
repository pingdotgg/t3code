import { describe, expect, it } from "vite-plus/test";

import { markdownTree } from "./markdown/wordsHast";
import {
  restorePastedMarkdownLinks,
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from "./markdown-clipboard";

describe("restoring pasted Markdown links", () => {
  it.each([
    {
      case: "repeated labels with distinct destinations",
      plain: "Guide: Guide, Guide.",
      html: '<p>Guide: <a href="https://example.com/start">Guide</a>, <a href="https://example.com/end">Guide</a>.</p>',
      expected: "Guide: [Guide](https://example.com/start), [Guide](https://example.com/end).",
    },
    {
      case: "line breaks within a link",
      plain: "First\nSecond",
      html: '<a href="https://example.com/">First<br>Second</a>',
      expected: "[First](https://example.com/)\n[Second](https://example.com/)",
    },
    {
      case: "a backslash immediately before a link",
      plain: "\\Guide",
      html: '\\<a href="https://example.com/">Guide</a>',
      expected: "\\\\[Guide](https://example.com/)",
    },
    {
      case: "nested labels, punctuation and native clipboard line breaks",
      plain: "First line\n\nRead [the guide] & notes",
      html: '<p>First line</p><p>Read <a href="https://example.com/guide(part)?a=1&amp;b=2"><strong>[the guide]</strong></a> &amp; notes</p>',
      expected:
        "First line\n\nRead [\\[the guide\\]](https://example.com/guide\\(part\\)?a=1&amp;b=2) & notes",
    },
    {
      case: "visible labels surrounded by hidden content",
      plain: "Read the guide.",
      html: '<span hidden>Skip</span>Read <a href="https://example.com/guide">the <span style="display: none">hidden </span>guide</a>.',
      expected: "Read [the guide](https://example.com/guide).",
    },
    {
      case: "visible link overrides inside a hidden ancestor",
      plain: "Guide",
      html: '<span style="visibility:hidden">Skip <a style="visibility:visible" href="https://example.com/"><span style="display:none;visibility:visible">Skip </span>Guide</a></span>',
      expected: "[Guide](https://example.com/)",
    },
    {
      case: "destinations without an external link scheme and anchors with no label",
      plain: "Local, unavailable, and !Guide",
      html: '<a href="/local">Local</a>, <a>unavailable</a>, and !<a href="https://example.com/guide">Guide</a><a href="https://example.com/empty"></a>',
      expected: "Local, unavailable, and \\![Guide](https://example.com/guide)",
    },
    {
      case: "linked identifiers inside code samples as code",
      plain: "pub fn new(v: Vec<u8>) -> Self",
      html: '<pre><code>pub fn new(v: <a href="https://doc.rust-lang.org/std/vec/struct.Vec.html">Vec</a>&lt;<a href="https://doc.rust-lang.org/std/primitive.u8.html">u8</a>&gt;) -&gt; Self</code></pre>',
      expected: "pub fn new(v: Vec<u8>) -> Self",
    },
  ])("keeps $case", ({ plain, html, expected }) => {
    expect(restorePastedMarkdownLinks(plain, html)).toBe(expected);
  });

  it("round trips literal entity names in the destination", () => {
    const text = restorePastedMarkdownLinks(
      "Guide",
      '<a href="https://example.com/?q=&amp;copy;">Guide</a>',
    );
    expect(markdownTree(text)).toMatchObject({
      children: [
        {
          tagName: "p",
          children: [{ tagName: "a", properties: { href: "https://example.com/?q=&copy;" } }],
        },
      ],
    });
  });
});

describe("copying rendered Markdown tables", () => {
  it("copies footer rows last, as the table draws them, when tfoot precedes tbody", () => {
    const table = document.createElement("table");
    table.innerHTML =
      "<thead><tr><th>Item</th><th>Cost</th></tr></thead><tfoot><tr><td>Total</td><td>3</td></tr></tfoot><tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody>";

    expect(serializeTableElementToCsv(table)).toBe("Item,Cost\na,1\nb,2\nTotal,3");
    expect(serializeTableElementToMarkdown(table)).toBe(
      "| Item | Cost |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n| Total | 3 |",
    );
  });
});

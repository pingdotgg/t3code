import type { Element, Root } from "hast";
import { toHtml } from "hast-util-to-html";
import { describe, expect, it } from "vite-plus/test";
import { extractMarkdownLinkHrefs } from "@t3tools/shared/markdownLinks";

import {
  decodeMarkdownLinkEscapes,
  renderCodexDirectivesForCopy,
  renderCodexInlineDirectivesAsMarkdown,
} from "./markdownText";
import {
  codexDirectiveSources,
  markdownReferenceDefinitions,
  markdownTree,
  wordsHast,
  type WordsHastOptions,
} from "./wordsHast";

const ASSISTANT: WordsHastOptions = {
  math: false,
  breaks: false,
  escapeHtml: false,
  insights: false,
  extensions: {},
};

const wordsHtml = (markdown: string, options: Partial<WordsHastOptions> = {}) =>
  toHtml(wordsHast(markdown, { ...ASSISTANT, ...options }));

it.each([
  [String.raw`/tmp/a\&amp;b/index.ts`, "/tmp/a&amp;b/index.ts"],
  ["/tmp/a&#92;&amp;b/index.ts", String.raw`/tmp/a\&b/index.ts`],
  [String.raw`C:\work\&amp;b\index.ts`, String.raw`C:\work\&b\index.ts`],
])("decodes link destination %s as the renderer does", (href, expected) => {
  const markdown = `[index.ts](${href})`;
  const paragraph = markdownTree(markdown).children[0] as Element;
  const anchor = paragraph.children[0] as Element;
  expect(decodeURIComponent(String(anchor.properties.href))).toBe(expected);
  expect(decodeMarkdownLinkEscapes(extractMarkdownLinkHrefs(markdown)[0]!)).toBe(expected);
});

// The chat's syntax in the shapes agents and review bots write it, and raw HTML, with the HTML
// remark and the chat's plugins rendered for it before Words replaced them.
const CASES: ReadonlyArray<readonly [markdown: string, html: string]> = [
  [
    '<ol start="3">\n<li><a href="https://example.com/a">Alpha</a>\n<li><a href="https://example.com/b">Beta</a>\n</ol>',
    '<ol start="3" dir="ltr">\n<li><a href="https://example.com/a">Alpha</a>\n</li><li><a href="https://example.com/b">Beta</a>\n</li></ol>',
  ],
  [
    '<ul><li>Outer<ul><li><div><p><a href="https://example.com/a">Alpha</a><li>Beta</ul><li>Next</ul>',
    '<ul dir="ltr"><li>Outer<ul><li><div><p><a href="https://example.com/a">Alpha</a></p></div></li><li>Beta</li></ul></li><li>Next</li></ul>',
  ],
  [
    "<ul><li><blockquote><li>quoted</li></blockquote><li>next</ul>",
    '<ul dir="ltr"><li><blockquote><li>quoted</li></blockquote></li><li>next</li></ul>',
  ],
  [
    "| a | b |\n|:-|-:|\n| `x \\| y` | **2** |\n| 3 |",
    '<table dir="ltr">\n<thead>\n<tr>\n<th align="left">a</th>\n<th align="right">b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td align="left"><code data-inline-code="" dir="ltr">x | y</code></td>\n<td align="right"><strong>2</strong></td>\n</tr>\n<tr>\n<td align="left">3</td>\n<td align="right"></td>\n</tr>\n</tbody>\n</table>',
  ],
  [
    "a | b\n--- | ---\n1 | 2\n\nnot a table",
    '<table dir="ltr">\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>\n<p dir="ltr">not a table</p>',
  ],
  [
    "- [ ] open\n- [x] done\n- [X]   spaced",
    '<ul class="contains-task-list" dir="ltr">\n<li class="task-list-item"><input type="checkbox" disabled> open</li>\n<li class="task-list-item"><input type="checkbox" checked disabled> done</li>\n<li class="task-list-item"><input type="checkbox" checked disabled>   spaced</li>\n</ul>',
  ],
  [
    "- [ ] open\n\n- [x] done",
    '<ul class="contains-task-list" dir="ltr">\n<li class="task-list-item">\n<p><input type="checkbox" disabled> open</p>\n</li>\n<li class="task-list-item">\n<p><input type="checkbox" checked disabled> done</p>\n</li>\n</ul>',
  ],
  [
    "See www.example.com/a_(b), https://x.dev/path?q=1. and me@example.com!",
    '<p dir="ltr">See <span class="has-[[data-slot=context-chip-label]]:whitespace-nowrap"><a href="http://www.example.com/a_(b)">www.example.com/a_(b)</a>,</span> <span class="has-[[data-slot=context-chip-label]]:whitespace-nowrap"><a href="https://x.dev/path?q=1">https://x.dev/path?q=1</a>.</span> and <span class="has-[[data-slot=context-chip-label]]:whitespace-nowrap"><a href="mailto:me@example.com">me@example.com</a>!</span></p>',
  ],
  [
    "See https://x.com/dimasike_ and 可以看了：**http://localhost:18780**（已重启）。",
    '<p dir="ltr">See <a href="https://x.com/dimasike_">https://x.com/dimasike_</a> and 可以看了：<strong><a href="http://localhost:18780">http://localhost:18780</a></strong>（已重启）。</p>',
  ],
  [
    "Angle <https://angle.dev> and (https://paren.dev/x)",
    '<p dir="ltr">Angle <a href="https://angle.dev">https://angle.dev</a> and (<span class="has-[[data-slot=context-chip-label]]:whitespace-nowrap"><a href="https://paren.dev/x">https://paren.dev/x</a>)</span></p>',
  ],
  [
    "Footnote[^1] and again[^1], unknown[^2].\n\n[^1]: The note\n    continues.",
    '<p dir="ltr">Footnote<sup><a href="#user-content-fn-1" id="user-content-user-content-fnref-1" data-footnote-ref="" aria-describedby="user-content-footnote-label">1</a></sup> and again<sup><a href="#user-content-fn-1" id="user-content-user-content-fnref-1-2" data-footnote-ref="" aria-describedby="user-content-footnote-label">1</a></sup>, unknown[^2].</p>\n<section data-footnotes="" class="footnotes" dir="ltr"><h2 class="sr-only" id="user-content-footnote-label">Footnotes</h2>\n<ol>\n<li id="user-content-user-content-fn-1">\n<p>The note\ncontinues. <a href="#user-content-fnref-1" data-footnote-backref="" aria-label="Back to reference 1" class="data-footnote-backref">↩</a> <a href="#user-content-fnref-1-2" data-footnote-backref="" aria-label="Back to reference 1-2" class="data-footnote-backref">↩<sup>2</sup></a></p>\n</li>\n</ol>\n</section>',
  ],
  [
    "> [!NOTE]\n> An alert\n\n> [!warning] lower\n> case",
    '<blockquote data-alert="note" dir="ltr">\n<p>An alert</p>\n</blockquote>\n<blockquote dir="ltr">\n<p>[!warning] lower\ncase</p>\n</blockquote>',
  ],
  [
    "-      wide\n-      [x](./x.ts) items\n\ntext\n\n-      loose\n\n-      items",
    '<ul dir="ltr">\n<li>wide</li>\n<li><a href="./x.ts">x</a> items</li>\n</ul>\n<p dir="ltr">text</p>\n<ul dir="ltr">\n<li>\n<p>loose</p>\n</li>\n<li>\n<p>items</p>\n</li>\n</ul>',
  ],
  [
    "> [!TIP]**joined**",
    '<blockquote dir="ltr">\n<p>[!TIP]<strong>joined</strong></p>\n</blockquote>',
  ],
  [
    "1. one\r\n2. two\r\n\r\n   loose\r\n",
    '<ol dir="ltr">\n<li>\n<p>one</p>\n</li>\n<li>\n<p>two</p>\n<p>loose</p>\n</li>\n</ol>',
  ],
  [
    "&copy; &#x1F600; &bogus; &#0; \\& *a **b** c*",
    '<p dir="ltr">© 😀 &#x26;bogus; � &#x26; <em>a <strong>b</strong> c</em></p>',
  ],
  [
    "Hard  \nbreak\\\nand `` code ` span ``",
    '<p dir="ltr">Hard<br>\nbreak<br>\nand <code data-inline-code="" dir="ltr">code ` span</code></p>',
  ],
  [
    '[ref] and [Ref][] and [x][REF]\n\n[ref]: /url "title"',
    '<p dir="ltr"><a href="/url">ref</a> and <a href="/url">Ref</a> and <a href="/url">x</a></p>',
  ],
  [
    "Open [a.ts](./a.ts) and /Users/me/b.ts:3. Run `src/b.ts`.",
    '<p dir="ltr">Open <a href="./a.ts">a.ts</a> and <span class="has-[[data-slot=context-chip-label]]:whitespace-nowrap"><a href="/Users/me/b.ts:3">/Users/me/b.ts:3</a>.</span> Run <span class="has-[[data-slot=context-chip-label]]:whitespace-nowrap"><code data-inline-code="" dir="ltr">src/b.ts</code>.</span></p>',
  ],
  [
    "[a](CURSOR://file/Users/me/a.md:3) [b](vscode://file/C:/a.ts) [c](cursor://anysphere.x/p)",
    '<p dir="ltr"><a href="cursor://file/Users/me/a.md:3">a</a> <a href="vscode://file/C:/a.ts">b</a> <a href="cursor://anysphere.x/p">c</a></p>',
  ],
  [
    "![one](https://x.dev/1.png)\n![two](https://x.dev/2.png)\nText\n![three](https://x.dev/3.png)",
    '<p dir="ltr"><img src="https://x.dev/1.png" alt="one"><br>\n<img src="https://x.dev/2.png" alt="two"><br>\nText<br>\n<img src="https://x.dev/3.png" alt="three"></p>',
  ],
  [
    'Read :codex-file-citation[a.ts]{path="src/a.ts" line_range_start="3"} and [x :codex-file-citation[b]{path="b.ts"}](u).',
    '<p dir="ltr">Read <a href="src/a.ts#L3">a.ts</a> and <span class="has-[[data-slot=context-chip-label]]:whitespace-nowrap"><a href="u">x :codex-file-citation[b]{path="b.ts"}</a>.</span></p>',
  ],
  [
    ':codex-followup[Ask]{prompt="go"} and :codex-followup[No prompt]{label="x"} stay apart.',
    '<p dir="ltr"><span>Ask</span> and :codex-followup[No prompt]{label="x"} stay apart.</p>',
  ],
  [
    '::artifact-template{artifact_kind="document" display_name="Doc" skill_directory="/s" skill_name="artifact-template-doc"}\n\n::artifact-template{bad="x"}',
    '<div data-codex-artifact-template="true" data-artifact-kind="document" data-display-name="Doc" data-skill-directory="/s" data-skill-name="artifact-template-doc"></div>\n<p dir="ltr">::artifact-template{bad="x"}</p>',
  ],
  [
    "[file](C:\\work\\a.ts) and C:\\Users\\me\\.t3\\shot.png and \\*kept\\*",
    '<p dir="ltr"><a href="file:///C:/work/a.ts">file</a> and C:\\Users\\me\\.t3\\shot.png and *kept*</p>',
  ],
  [
    '```ts title="a.ts"\nconst a = 1;\n```',
    '<pre><code class="language-ts" data-code-meta="title=&#x22;a.ts&#x22;">const a = 1;\n</code></pre>',
  ],
  [
    "Cost ~5 and ~~gone~~ in an answer.",
    '<p dir="ltr">Cost ~5 and <del>gone</del> in an answer.</p>',
  ],
  [
    "<details>\n<summary>More</summary>\n\nHidden **bold**\n\n</details>",
    '<details dir="ltr">\n<summary>More</summary>\n<p>Hidden <strong>bold</strong></p>\n</details>',
  ],
  [
    'Inline <sup>1</sup> and <img src="a.png" alt="x"> html',
    '<p dir="ltr">Inline <sup>1</sup> and <img src="a.png" alt="x"> html</p>',
  ],
  [
    '<picture><source media="(prefers-color-scheme: dark)" srcset="d.png"><source media="(prefers-color-scheme: light)" srcset="l.png"><img src="l.png" alt="x"></picture>',
    '<p><picture><img src="l.png" alt="x" data-dark-src="d.png" data-light-src="l.png"></picture></p>',
  ],
  [
    "<details>\n<summary>⚠️ Outside diff (3)</summary><blockquote>\n\n**a**\n\n</blockquote></details>",
    '<details dir="ltr">\n<summary>⚠️ Outside diff (3)</summary><blockquote>\n<p><strong>a</strong></p>\n</blockquote></details>',
  ],
  [
    '<div align="center"><img width="837" src="https://x.dev/a.png" title="t" /></div>\n\nafter',
    '<div align="center"><img width="837" src="https://x.dev/a.png" data-markdown-title="t" data-standalone></div>\n<p dir="ltr">after</p>',
  ],
  [
    'Text <sup>[1](#n)</sup> <sub>x</sub> <br> <a href="https://x.dev" target="_blank">link</a>',
    '<p dir="ltr">Text <sup><a href="#n">1</a></sup> <sub>x</sub> <br> <a href="https://x.dev">link</a></p>',
  ],
  ["<!-- hidden -->\nVisible <!-- inline --> text", '\n<p dir="ltr">Visible  text</p>'],
  [
    '<custom-tag>kept text</custom-tag> and <a href="javascript:x">bad</a>',
    '<p dir="ltr">kept text and <a>bad</a></p>',
  ],
  [
    "> <details>\n> <summary>quoted</summary>\n>\n> body\n> </details>",
    '<blockquote dir="ltr">\n<details>\n<summary>quoted</summary>\n<p>body</p>\n</details>\n</blockquote>',
  ],
  [
    '<h3 id="x">Raw heading</h3>\n\n## Markdown heading',
    '<h3 id="user-content-x" dir="ltr">Raw heading</h3>\n<h2 id="user-content-markdown-heading" dir="ltr">Markdown heading</h2>',
  ],
];

describe("wordsHast", () => {
  it.each(CASES)("renders %j as the remark pipeline did", (markdown, html) => {
    expect(wordsHtml(markdown)).toBe(html);
  });

  it("breaks soft lines as remark-breaks did", () => {
    const markdown = "one\ntwo **three\nfour**\n\n- item\n  next\n  - sub\n\n```\nkept\nlines\n```";
    expect(wordsHtml(markdown, { breaks: true })).toBe(
      '<p dir="ltr">one<br>\ntwo <strong>three<br>\nfour</strong></p>\n<ul dir="ltr">\n<li>item<br>\nnext\n<ul>\n<li>sub</li>\n</ul>\n</li>\n</ul>\n<pre><code>kept\nlines\n</code></pre>',
    );
    const rawHtml =
      '<p align="center">\n  <img src="https://x.dev/a.png" width="400">\n</p>\n\n<ul>\n<li>\none\ntwo\n</li>\n</ul>';
    expect(wordsHtml(rawHtml, { breaks: true })).toBe(
      '<p align="center">\n  <img src="https://x.dev/a.png" width="400" data-standalone>\n</p>\n<ul dir="ltr">\n<li>\none\ntwo\n</li>\n</ul>',
    );
  });

  it("keeps the composer's tildes and list numbers in user messages", () => {
    const markdown = "Install as ~/a/x, then (~/b.md). ~one~ ~~two~~\n\n3. three\n5. five";
    expect(wordsHtml(markdown, { extensions: { userMessage: true } })).toBe(
      '<p dir="ltr">Install as ~/a/x, then (~/b.md). ~one~ <del>two</del></p>\n<ol start="3" dir="ltr">\n<li>three</li>\n<li value="5">five</li>\n</ol>',
    );
    // Typed indentation past a wide list marker counts from where the item's text starts.
    expect(
      wordsHtml("-      wide\n         continued", {
        breaks: true,
        extensions: { userMessage: true, leadingWhitespace: true },
      }),
    ).toBe(
      '<ul dir="ltr">\n<li>wide<br>\n<span data-leading-whitespace="">  </span>continued</li>\n</ul>',
    );
  });

  it("gives elements the source positions components read", () => {
    // A wide item's text is parsed again on its own, so its link has no place in the message.
    const markdown = "é [a](u)\n\n- [ ] task\n\n```sh\nls\n```\n\n-      [b](./b.ts)";
    const tree = wordsHast(markdown, ASSISTANT);
    const slices: string[] = [];
    const visit = (node: Root | Element) => {
      for (const child of node.children) {
        if (child.type !== "element") continue;
        if (child.position) {
          slices.push(markdown.slice(child.position.start.offset, child.position.end.offset));
        }
        visit(child);
      }
    };
    visit(tree);
    expect(slices).toEqual(["[a](u)", "- [ ] task", "```sh\nls\n```", "-      [b](./b.ts)"]);
  });

  it("renders insight blocks as remarkAssistantInsights did", () => {
    const markdown =
      "Intro\n\n`★ Insight ─────────────────────────────────────`\n- one\n- two\n`─────────────────────────────────────────────────`\n\nAfter\n\n```\n★ Insight ─────\n```";
    expect(wordsHtml(markdown, { insights: true })).toBe(
      '<p dir="ltr">Intro</p>\n<blockquote data-alert="insight" dir="ltr">\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n</blockquote>\n<p dir="ltr">After</p>\n<pre><code>★ Insight ─────\n</code></pre>',
    );
    // Code in a list, an HTML block and a quote's lazy line are not where an insight opens.
    expect(
      wordsHtml(
        "- x\n  ```\n  ★ Insight ─────\n  ```\n\n<div>\n★ Insight ─────\n</div>\n\n> q\n★ Insight ─────",
        {
          insights: true,
        },
      ),
    ).toBe(
      '<ul dir="ltr">\n<li>x\n<pre><code>★ Insight ─────\n</code></pre>\n</li>\n</ul>\n<div dir="ltr">\n★ Insight ─────\n</div>\n<blockquote dir="ltr">\n<p>q\n★ Insight ─────</p>\n</blockquote>',
    );
    // What follows an opening keeps its offsets in the message, which components slice.
    const insight = "★ Insight ─────\nSee [a](./a.ts)\n```sh\nls\n```\n─────";
    const tree = wordsHast(insight, { ...ASSISTANT, insights: true });
    const quote = tree.children.find((child): child is Element => child.type === "element")!;
    const sliced = (node: Element) =>
      insight.slice(node.position!.start.offset, node.position!.end.offset);
    const [paragraph, pre] = quote.children.filter((child) => child.type === "element");
    const link = paragraph!.children.find((child): child is Element => child.type === "element")!;
    expect([sliced(link), sliced(pre!)]).toEqual(["[a](./a.ts)", "```sh\nls\n```"]);
  });

  it("shows raw HTML as its text when asked", () => {
    expect(wordsHtml("a <b>x</b> and <https://a.dev>", { escapeHtml: true })).toBe(
      '<p dir="ltr">a &#x3C;b>x&#x3C;/b> and <a href="https://a.dev">https://a.dev</a></p>',
    );
  });

  it("flattens a preview to one line of text and math, within its length", () => {
    const preview = { fallback: "Thinking", maxLength: 24 };
    const options = { math: true, extensions: { preview } };
    expect(wordsHtml("# Plan\n\n- **one** <b>x</b>\n- `two` $a$", options)).toMatch(
      /^Plan one x two <span[^>]* data-markdown-math="inline"[^>]*><svg [^>]*aria-label="a"/,
    );
    expect(wordsHtml("x".repeat(30), options)).toBe("x".repeat(24));
    expect(wordsHtml("<!-- only -->", options)).toBe("Thinking");
  });

  it("makes a saved file's Markdown inert", () => {
    expect(
      wordsHtml(
        "[a](https://x.dev) ![b](https://x.dev/i.png) `c` <img src=y>\n\n```mermaid\nA\n```",
        {
          extensions: { inert: true },
        },
      ),
    ).toBe('<p dir="ltr">a b c </p>\n<pre><code class="language-text">A\n</code></pre>');
  });

  it("links a change request's references and resolves its root-relative media", () => {
    const autolinks = (text: string) =>
      [...text.matchAll(/#(\d+)/g)].map((match) => ({
        index: match.index,
        text: match[0],
        label: match[0],
        url: `https://forge.dev/o/r/pull/${match[1]}`,
        kind: "reference" as const,
      }));
    const html = wordsHtml("See #12 and `#13`.\n\n![shot](/api/attachments/1)", {
      extensions: { changeRequest: { repositoryUrl: "https://forge.dev/o/r", autolinks } },
    });
    expect(html).toContain(
      '<a href="https://forge.dev/o/r/pull/12" data-pull-request-autolink="reference">#12</a>',
    );
    expect(html).toContain('<code data-inline-code="" dir="ltr">#13</code>');
    expect(html).toContain('src="https://forge.dev/api/attachments/1"');
  });

  it("renders math as SVG, and keeps money as text", () => {
    const html = toHtml(
      wordsHast("Costs $34.58 and $15.00, and $x^2 \\text{ for } n$ is math.\n\n$$\na\n$$", {
        ...ASSISTANT,
        math: true,
      }),
    );
    expect(html).toContain("Costs $34.58 and $15.00, and ");
    expect(html.match(/<svg /g)).toHaveLength(2);
    expect(html).toContain('aria-label="x^2 \\text{ for } n"');
    expect(html).toContain('style="white-space:pre"> for </text>');
  });

  it("keeps control bytes, blank lines, unclosed blocks, shell vars, and table dollars intact in math", () => {
    const options = { ...ASSISTANT, math: true };
    expect(toHtml(wordsHast("Pasted: $a\u001bb + c$", options))).toContain("<svg ");
    expect(toHtml(wordsHast("$$\na = 1 \\\\\n\nb = 2\n$$", options))).toContain("<svg ");
    expect(toHtml(wordsHast("$$\n\\frac{a}{b}", options))).toBe(
      '<p dir="ltr">$$\n\\frac{a}{b}</p>',
    );
    expect(toHtml(wordsHast("```math\nx^2", options))).toBe(
      '<pre><code class="language-math">x^2\n</code></pre>',
    );
    expect(toHtml(wordsHast("Set $HOME,$PATH and $FOO to `$BAR`.", options))).toBe(
      '<p dir="ltr">Set $HOME,$PATH and $FOO to <span class="has-[[data-slot=context-chip-label]]:whitespace-nowrap"><code data-inline-code="" dir="ltr">$BAR</code>.</span></p>',
    );
    expect(
      toHtml(
        wordsHast("| [a](https://example.com/$x) | `$x` | y$ |\n| --- | --- | --- |", options),
      ),
    ).toContain("<table ");
  });

  it.each([
    [
      "Status ![badge](https://x.dev/b.png)\ncontinues",
      '<p dir="ltr">Status <img src="https://x.dev/b.png" alt="badge">\ncontinues</p>',
      '<p dir="ltr">Status <img src="https://x.dev/b.png" alt="badge"><br>\ncontinues</p>',
    ],
    [
      "**Label**\n[![shot](https://x.dev/b.png)](https://x.dev)\ncontinues",
      '<p dir="ltr"><strong>Label</strong><br>\n<a href="https://x.dev"><img src="https://x.dev/b.png" alt="shot"></a><br>\ncontinues</p>',
      '<p dir="ltr"><strong>Label</strong><br>\n<a href="https://x.dev"><img src="https://x.dev/b.png" alt="shot"></a><br>\ncontinues</p>',
    ],
    [
      "**Shot** (dark) ![a](https://x.dev/a.png) ![b](https://x.dev/b.png)",
      '<p dir="ltr"><strong>Shot</strong> (dark)<br>\n<img src="https://x.dev/a.png" alt="a"> <img src="https://x.dev/b.png" alt="b"></p>',
      '<p dir="ltr"><strong>Shot</strong> (dark)<br>\n<img src="https://x.dev/a.png" alt="a"> <img src="https://x.dev/b.png" alt="b"></p>',
    ],
    [
      "**A favicon ![i](https://x.dev/i.png)** stays inline",
      '<p dir="ltr"><strong>A favicon <img src="https://x.dev/i.png" alt="i"></strong> stays inline</p>',
      '<p dir="ltr"><strong>A favicon <img src="https://x.dev/i.png" alt="i"></strong> stays inline</p>',
    ],
    [
      'Status\n<img src="https://x.dev/b.png" />\ncontinues',
      '<p dir="ltr">Status\n<img src="https://x.dev/b.png">\ncontinues</p>',
      '<p dir="ltr">Status<br>\n<img src="https://x.dev/b.png"><br>\ncontinues</p>',
    ],
    [
      "Hard  \nbreak and a\\\nbackslash",
      '<p dir="ltr">Hard<br>\nbreak and a<br>\nbackslash</p>',
      '<p dir="ltr">Hard<br>\nbreak and a<br>\nbackslash</p>',
    ],
  ])(
    "breaks lines next to images and hard breaks as remark did: %j",
    (markdown, html, withBreaks) => {
      expect(wordsHtml(markdown)).toBe(html);
      expect(wordsHtml(markdown, { breaks: true })).toBe(withBreaks);
    },
  );

  it("reads raw HTML attributes as an HTML parser does", () => {
    expect(wordsHtml('<a href="https://x.dev/?q=1&copy=2&amp;b">x</a>')).toContain(
      'href="https://x.dev/?q=1&#x26;copy=2&#x26;b"',
    );
  });

  it("treats only Words' own directives as directives", () => {
    const forged =
      '<span data-directive="codex-followup" data-attributes="null">Ask</span> and <div data-directive="artifact-template" data-attributes="[1]"></div>';
    expect(wordsHtml(forged)).toBe('<p dir="ltr"><span>Ask</span> and </p><div></div><p></p>');
    // Raw HTML can write a source position too, even the one Words gave a real directive.
    const positioned = `<span data-directive="codex-file-citation" data-attributes='{"path":"/etc/passwd"}' data-sourcepos="0-5">x</span>`;
    expect(wordsHtml(positioned)).toBe('<p dir="ltr"><span>x</span></p>');
    const real = ':codex-file-citation[a]{path="a.ts"}';
    expect(
      wordsHtml(
        `${real} <span data-directive="codex-file-citation" data-attributes='{"path":"/etc/passwd"}' data-sourcepos="0-${real.length}">x</span>`,
      ),
    ).not.toContain("/etc/passwd");
  });

  it("reads a directive's label as written", () => {
    expect(
      codexDirectiveSources(':codex-followup[pick {a} or [b]]{prompt="go"}').map(
        (directive) => directive.label,
      ),
    ).toEqual(["pick {a} or [b]"]);
  });

  it.each([
    [
      ':codex-followup[try :codex-followup[inner]{prompt="i"} then]{prompt="o"} end',
      "try inner then end",
    ],
    [
      '😀 :codex-followup[[see :codex-file-citation[a]{path="a.ts"}][ref]]{prompt="o"} and :codex-followup[again]{prompt="a"} end\n\n[ref]: https://x.dev',
      '😀 [see :codex-file-citation[a]{path="a.ts"}][ref] and again end\n\n[ref]: https://x.dev',
    ],
    [
      ':codex-followup[    read :codex-file-citation[a]{path="a.ts"} then]{prompt="o"} end',
      "    read [a.ts](<a.ts>) then end",
    ],
    [
      ':codex-followup[read :codex-file-citation[a]{path="a.ts"}] end',
      ":codex-followup[read [a.ts](<a.ts>)] end",
    ],
  ])("copies nested directives without losing surrounding text: %s", (markdown, expected) => {
    expect(renderCodexDirectivesForCopy(markdown)).toBe(expected);
    expect(renderCodexInlineDirectivesAsMarkdown(markdown)).toBe(expected);
  });

  it.each([
    ["# Title\n[a]: https://x.dev", ["[a]: <https://x.dev>"]],
    ['> [a]:\n> https://x.dev "The\n> guide"', ['[a]: <https://x.dev> "The guide"']],
    ["- [a]: https://x.dev\n\n[A]: https://second.dev", ["[a]: <https://x.dev>"]],
    ["<div>\n[a]: https://x.dev\n</div>", []],
    ["- ```\n  [a]: https://x.dev\n  ```", []],
    ["text\n[a]: https://x.dev", []],
    ["[doc]: https://example.com\n\nSee [doc].\n\n```js\nx", ["[doc]: <https://example.com>"]],
    ["[a]: https://x.dev\n\n<!--\nunclosed", ["[a]: <https://x.dev>"]],
    ["[not\n```\ndef]: x\n```\n\n[a]: https://x.dev", ["[a]: <https://x.dev>"]],
  ])("finds the reference definitions in %j as Words reads them", (markdown, definitions) => {
    expect(markdownReferenceDefinitions(markdown)).toEqual(definitions);
  });

  it.each([
    ["https://example.com/?x=1&amp;copy;", "a &amp;copy; &amp;quot; &amp;#65;"],
    ["https://example.com/?x=1&amp;#65;", "a &amp;amp; b"],
  ])("preserves the reference destination and title when reserializing %s", (url, title) => {
    const content = "Read [ref] and ![alt][ref].";
    const markdown = `${content}\n\n[ref]: ${url} "${title}"`;
    const definitions = markdownReferenceDefinitions(markdown);
    expect(wordsHtml(`${content}\n\n${definitions.join("\n")}`)).toBe(wordsHtml(markdown));
  });

  it("keeps authored SVG and ids out of the math it restores", () => {
    const html = wordsHtml(
      '<svg width="99999" viewBox="0 0 1 1"><rect x="0" y="0" width="1" height="1"/></svg> <svg data-sourcepos="0-3" height="99999"></svg> <span id="t3-math-0">kept</span> $x$',
      { math: true },
    );
    expect(html).not.toContain("99999");
    expect(html).toContain("kept");
    expect(html.match(/<svg /g)).toHaveLength(1);
  });

  it("keeps only math's own SVG elements and attributes", () => {
    const html = toHtml(
      wordsHast(
        '<svg onload="x()" style="position:fixed;display:inline"><a href="javascript:x()"><text x="1">t</text></a><script>x()</script></svg> $y$',
        { ...ASSISTANT, math: true },
      ),
    );
    expect(html).not.toMatch(/onload|javascript|position|<a |<script/);
    expect(html).toContain('aria-label="y"');
  });
});

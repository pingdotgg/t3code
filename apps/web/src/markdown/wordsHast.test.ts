import type { Element, Root } from "hast";
import { toHtml } from "hast-util-to-html";
import { describe, expect, it } from "vite-plus/test";

import { wordsHast, type WordsHastOptions } from "./wordsHast";

const ASSISTANT: WordsHastOptions = {
  math: false,
  breaks: false,
  escapeHtml: false,
  insights: false,
  extensions: {},
};

const wordsHtml = (markdown: string, options: Partial<WordsHastOptions> = {}) =>
  toHtml(wordsHast(markdown, { ...ASSISTANT, ...options }));

// The chat's syntax in the shapes agents and review bots write it, and raw HTML, with the HTML
// remark and the chat's plugins rendered for it before Words replaced them.
const CASES: ReadonlyArray<readonly [markdown: string, html: string]> = [
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
    "See www.example.com/a_(b), https://x.dev/path?q=1. and me@example.com!",
    '<p dir="ltr">See <span class="has-[[data-slot=context-chip-label]]:whitespace-nowrap"><a href="http://www.example.com/a_(b)">www.example.com/a_(b)</a>,</span> <span class="has-[[data-slot=context-chip-label]]:whitespace-nowrap"><a href="https://x.dev/path?q=1">https://x.dev/path?q=1</a>.</span> and <span class="has-[[data-slot=context-chip-label]]:whitespace-nowrap"><a href="mailto:me@example.com">me@example.com</a>!</span></p>',
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
    const markdown = "one\ntwo **three\nfour**\n\n```\nkept\nlines\n```";
    expect(wordsHtml(markdown, { breaks: true })).toBe(
      '<p dir="ltr">one<br>\ntwo <strong>three<br>\nfour</strong></p>\n<pre><code>kept\nlines\n</code></pre>',
    );
  });

  it("keeps the composer's tildes and list numbers in user messages", () => {
    const markdown = "Install as ~/a/x, then (~/b.md). ~one~ ~~two~~\n\n3. three\n5. five";
    expect(wordsHtml(markdown, { extensions: { userMessage: true } })).toBe(
      '<p dir="ltr">Install as ~/a/x, then (~/b.md). ~one~ <del>two</del></p>\n<ol start="3" dir="ltr">\n<li>three</li>\n<li value="5">five</li>\n</ol>',
    );
  });

  it("gives elements the source positions components read", () => {
    const markdown = "é [a](u)\n\n- [ ] task\n\n```sh\nls\n```";
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
    expect(slices).toEqual(["[a](u)", "- [ ] task", "```sh\nls\n```"]);
  });

  it("renders insight blocks as remarkAssistantInsights did", () => {
    const markdown =
      "Intro\n\n`★ Insight ─────────────────────────────────────`\n- one\n- two\n`─────────────────────────────────────────────────`\n\nAfter\n\n```\n★ Insight ─────\n```";
    expect(wordsHtml(markdown, { insights: true })).toBe(
      '<p dir="ltr">Intro</p>\n<blockquote data-alert="insight" dir="ltr">\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n</blockquote>\n<p dir="ltr">After</p>\n<pre><code>★ Insight ─────\n</code></pre>',
    );
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
      wordsHast("Costs $34.58 and $15.00, and $x^2$ is math.\n\n$$\na\n$$", {
        ...ASSISTANT,
        math: true,
      }),
    );
    expect(html).toContain("Costs $34.58 and $15.00, and ");
    expect(html.match(/<svg /g)).toHaveLength(2);
    expect(html).toContain('aria-label="x^2"');
  });

  it.each([
    [
      "Status ![badge](https://x.dev/b.png)\ncontinues",
      '<p dir="ltr">Status <img src="https://x.dev/b.png" alt="badge">\ncontinues</p>',
      '<p dir="ltr">Status <img src="https://x.dev/b.png" alt="badge"><br>\ncontinues</p>',
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
  });

  it("keeps authored SVG and ids out of the math it restores", () => {
    const html = wordsHtml(
      '<svg width="99999" viewBox="0 0 1 1"><rect x="0" y="0" width="1" height="1"/></svg> <span id="t3-math-0">kept</span> $x$',
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

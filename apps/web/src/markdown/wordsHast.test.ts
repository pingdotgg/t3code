import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  CHAT_USER_MESSAGE_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import spec from "commonmark-spec";
import type { Element, Root } from "hast";
import { toHtml } from "hast-util-to-html";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified, type PluggableList } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { rehypeChipPunctuation } from "../components/chat/markdownChipPunctuation";
import { rehypeHeadingIds } from "../components/chat/markdownFragments";
import { remarkParseWithoutUnusedSyntax } from "../components/chat/markdownSyntaxGates";
import { rehypeTextDirection } from "../components/chat/markdownTextDirection";
import { wordsHast } from "./wordsHast";

function remarkHtml(markdown: string, plugins: PluggableList): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkParseWithoutUnusedSyntax)
    .use(plugins)
    .use(remarkRehype, { allowDangerousHtml: true })
    // ChatMarkdown's render list.
    .use([
      ...CHAT_MARKDOWN_REHYPE_PLUGINS,
      rehypeHeadingIds,
      rehypeTextDirection,
      rehypeChipPunctuation,
    ]);
  return toHtml(processor.runSync(processor.parse(markdown), markdown) as Root);
}

const ASSISTANT = { math: false, breaks: false, singleTilde: true, listNumbers: false };

const wordsHtml = (markdown: string, options: Partial<typeof ASSISTANT> = {}) => {
  const tree = wordsHast(markdown, { ...ASSISTANT, ...options });
  return tree && toHtml(tree);
};

// Syntax the chat's plugins add, in the shapes agents and review bots write it.
const CHAT_MARKDOWN_CASES = [
  "| a | b |\n|:-|-:|\n| `x \\| y` | **2** |\n| 3 |",
  "a | b\n--- | ---\n1 | 2\n\nnot a table",
  "- [ ] open\n- [x] done\n- [X]   spaced",
  "See www.example.com/a_(b), https://x.dev/path?q=1. and me@example.com!",
  "Angle <https://angle.dev> and (https://paren.dev/x)",
  "Footnote[^1] and again[^1], unknown[^2].\n\n[^1]: The note\n    continues.",
  "> [!NOTE]\n> An alert\n\n> [!warning] lower\n> case",
  "1. one\r\n2. two\r\n\r\n   loose\r\n",
  "&copy; &#x1F600; &bogus; &#0; \\& *a **b** c*",
  "Hard  \nbreak\\\nand `` code ` span ``",
  '[ref] and [Ref][] and [x][REF]\n\n[ref]: /url "title"',
  "Open [a.ts](./a.ts) and /Users/me/b.ts:3. Run `src/b.ts`.",
  "[a](CURSOR://file/Users/me/a.md:3) [b](vscode://file/C:/a.ts) [c](cursor://anysphere.x/p)",
  "![one](https://x.dev/1.png)\n![two](https://x.dev/2.png)\nText\n![three](https://x.dev/3.png)",
  'Read :codex-file-citation[a.ts]{path="src/a.ts" line_range_start="3"} and [x :codex-file-citation[b]{path="b.ts"}](u).',
  ':codex-followup[Ask]{prompt="go"} and :codex-followup[No prompt]{label="x"} stay apart.',
  '::artifact-template{artifact_kind="document" display_name="Doc" skill_directory="/s" skill_name="artifact-template-doc"}\n\n::artifact-template{bad="x"}',
  "[file](C:\\work\\a.ts) and C:\\Users\\me\\.t3\\shot.png and \\*kept\\*",
  '```ts title="a.ts"\nconst a = 1;\n```',
  "Cost ~5 and ~~gone~~ in an answer.",
];

// Raw HTML, which Words passes through and the tokenizer nests before sanitizing.
const RAW_HTML_CASES = [
  "<details>\n<summary>More</summary>\n\nHidden **bold**\n\n</details>",
  'Inline <sup>1</sup> and <img src="a.png" alt="x"> html',
  '<picture><source media="(prefers-color-scheme: dark)" srcset="d.png"><source media="(prefers-color-scheme: light)" srcset="l.png"><img src="l.png" alt="x"></picture>',
  "<details>\n<summary>⚠️ Outside diff (3)</summary><blockquote>\n\n**a**\n\n</blockquote></details>",
  '<div align="center"><img width="837" src="https://x.dev/a.png" title="t" /></div>\n\nafter',
  'Text <sup>[1](#n)</sup> <sub>x</sub> <br> <a href="https://x.dev" target="_blank">link</a>',
  "<!-- hidden -->\nVisible <!-- inline --> text",
  '<custom-tag>kept text</custom-tag> and <a href="javascript:x">bad</a>',
  "> <details>\n> <summary>quoted</summary>\n>\n> body\n> </details>",
  '<h3 id="x">Raw heading</h3>\n\n## Markdown heading',
];

// Where Words and parse5 read raw HTML differently. Words escapes GFM's disallowed raw tags
// (script, style, textarea) and shows malformed tags as text, where rehype drops them.
const KNOWN_SPEC_DIFFERENCES = new Set([
  // Whitespace and implied end tags around unclosed raw HTML.
  21, 31, 148, 150, 155, 184, 190, 191,
  // Malformed tags and processing instructions shown as text.
  156, 157, 158, 180,
  // GFM's tagfilter.
  170, 171, 172, 173, 176, 178,
  // Raw HTML attributes keep `\`, a backtick, or a line break, which Words encodes.
  344, 631, 642, 643,
  // `<foo\+@bar.example.com>`: remark's GFM email autolink reads past the `<`.
  606,
]);

describe("wordsHast", () => {
  it.each([...CHAT_MARKDOWN_CASES, ...RAW_HTML_CASES])(
    "renders what the remark pipeline renders for %j",
    (markdown) => {
      expect(wordsHtml(markdown)).toBe(remarkHtml(markdown, CHAT_MARKDOWN_REMARK_PLUGINS));
    },
  );

  it("breaks soft lines as remark-breaks does", () => {
    const markdown = "one\ntwo **three\nfour**\n\n```\nkept\nlines\n```";
    expect(wordsHtml(markdown, { breaks: true })).toBe(
      remarkHtml(markdown, CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS),
    );
  });

  it("keeps the composer's tildes and list numbers in user messages", () => {
    const markdown = "Install as ~/a/x, then (~/b.md). ~one~ ~~two~~\n\n3. three\n5. five";
    expect(wordsHtml(markdown, { singleTilde: false, listNumbers: true })).toBe(
      remarkHtml(markdown, [...CHAT_MARKDOWN_REMARK_PLUGINS, ...CHAT_USER_MESSAGE_REMARK_PLUGINS]),
    );
  });

  it("gives elements the source positions components read", () => {
    const markdown = "é [a](u)\n\n- [ ] task\n\n```sh\nls\n```";
    const tree = wordsHast(markdown, ASSISTANT)!;
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

  it("renders math as SVG, and keeps money as text", () => {
    const html = toHtml(
      wordsHast("Costs $34.58 and $15.00, and $x^2$ is math.\n\n$$\na\n$$", {
        ...ASSISTANT,
        math: true,
      })!,
    );
    expect(html).toContain("Costs $34.58 and $15.00, and ");
    expect(html.match(/<svg /g)).toHaveLength(2);
    expect(html).toContain('aria-label="x^2"');
  });

  it("keeps only math's own SVG elements and attributes", () => {
    const html = toHtml(
      wordsHast(
        '<svg onload="x()" style="position:fixed;display:inline"><a href="javascript:x()"><text x="1">t</text></a><script>x()</script></svg> $y$',
        { ...ASSISTANT, math: true },
      )!,
    );
    expect(html).not.toMatch(/onload|javascript|position|<a |<script/);
    expect(html).toContain('aria-label="y"');
  });

  it("renders like remark for the CommonMark examples outside its known differences", () => {
    const differing = spec.tests
      .filter(
        (test) =>
          !KNOWN_SPEC_DIFFERENCES.has(test.number) &&
          wordsHtml(test.markdown) !== remarkHtml(test.markdown, CHAT_MARKDOWN_REMARK_PLUGINS),
      )
      .map((test) => test.number);
    expect(differing).toEqual([]);
  });
});

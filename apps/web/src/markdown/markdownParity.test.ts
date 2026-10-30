import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import spec from "commonmark-spec";
import * as NodeUtil from "node:util";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { VFile } from "vfile";
import { describe, expect, it } from "vite-plus/test";

import { rehypeHeadingIds } from "../components/chat/markdownFragments";
import { remarkParseWithoutUnusedSyntax } from "../components/chat/markdownSyntaxGates";
import { rehypeTextDirection } from "../components/chat/markdownTextDirection";
import { chatRenderHast } from "./chatHast";
import { parseMarkdown } from "./parseMarkdown";
import { remarkFastParse } from "./remarkFastParse";

const sameTree = (actual: unknown, expected: unknown) =>
  NodeUtil.isDeepStrictEqual(
    JSON.parse(JSON.stringify(actual)),
    JSON.parse(JSON.stringify(expected)),
  );

const remark = unified()
  .use(remarkParse)
  .use(remarkParseWithoutUnusedSyntax)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .freeze();

// micromark ends a list inside a quote after the next blank `>` line; nothing reads list ends.
const KNOWN_POSITION_DIFFERENCES = new Set([260]);

// Syntax the chat's extensions add, in the shapes agents and review bots write it.
const CHAT_MARKDOWN_CASES = [
  "| a | b |\n|:-|-:|\n| `x \\| y` | **2** |\n| 3 |",
  "a | b\n--- | ---\n1 | 2\n\nnot a table",
  "A table without pipes\n:--",
  "- [ ] open\n- [x] done\n- [ ] <!-- id --> after a comment\n- [X]   spaced",
  "~one~ ~~two~~ ~~~three~~~",
  "See www.example.com/a_(b), https://x.dev/path?q=1. and me@example.com!",
  "Escaped www\\.example.com and <https://angle.dev> and (https://paren.dev/x)",
  "Footnote[^1] and again[^1], unknown[^2].\n\n[^1]: The note\n    continues.",
  'Read :codex-file-citation[a.ts]{path="src/a.ts" line=3} and :codex-followup[Ask]{prompt="go"}.',
  '::artifact-template{kind="report" name="x"}\n\nafter',
  "[file](C:\\work\\a.ts) and C:\\Users\\me\\.t3\\shot.png and \\*kept\\*",
  "> [!NOTE]\n> An alert\n\n> [!warning] lower\n> case",
  "1. one\r\n2. two\r\n\r\n   loose\r\n",
  "-\tTab\n\n\t\tcode\n\n- a\n  - b\n\n  c",
  "&copy; &#x1F600; &bogus; &#0; \\& *a **b** c*",
  "<details>\n<summary>More</summary>\n\nHidden **bold**\n\n</details>",
  'Inline <sup>1</sup> and <img src="a.png" alt="x"> html',
  '```ts title="a.ts"\nconst a = 1;\n```\n\n~~~\nunclosed',
  "Hard  \nbreak\\\nand `` code ` span ``",
  '[ref] and [Ref][] and [x][REF]\n\n[ref]: /url "title"',
];

// Raw HTML the direct hast path nests itself instead of running parse5.
const RAW_HTML_CASES = [
  "<details>\n<summary>⚠️ Outside diff (3)</summary><blockquote>\n\n**a**\n\n</blockquote></details>",
  '<div align="center"><img width="837" src="https://x.dev/a.png" title="t" /></div>\n\nafter',
  'Text <sup>[1](#n)</sup> <sub>x</sub> <br> <a href="https://x.dev" target="_blank">link</a>',
  "<!-- hidden -->\nVisible <!-- inline --> text",
  "<details>\n\nunclosed until the end\n\n| a |\n| - |\n| b |",
  '<custom-tag>kept text</custom-tag> and <a href="javascript:x">bad</a>',
  "> <details>\n> <summary>quoted</summary>\n>\n> body\n> </details>",
  "Use <A> for anchors",
  '<h3 id="x">Raw heading</h3>\n\n## Markdown heading',
];

describe("parseMarkdown", () => {
  it("builds remark-parse's tree for every CommonMark example", () => {
    const differing = spec.tests.filter(
      (test) =>
        !KNOWN_POSITION_DIFFERENCES.has(test.number) &&
        !sameTree(parseMarkdown(test.markdown), remark.parse(test.markdown)),
    );
    expect(differing.map((test) => test.number)).toEqual([]);
  });

  it.each(CHAT_MARKDOWN_CASES)("builds remark-parse's tree for %j", (markdown) => {
    expect(parseMarkdown(markdown)).toEqual(remark.parse(markdown));
  });
});

const fastRemark = unified()
  .use(remarkParse)
  .use(remarkParseWithoutUnusedSyntax)
  .use(remarkFastParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .freeze();
const rehype = unified()
  .use(remarkRehype, { allowDangerousHtml: true })
  .use([...CHAT_MARKDOWN_REHYPE_PLUGINS, rehypeHeadingIds, rehypeTextDirection])
  .freeze();

// parse5 locates text after raw HTML by its tokenizer's resets; nothing reads text positions.
const withoutTextPositions = (tree: unknown) =>
  JSON.parse(
    JSON.stringify(tree, (_key, value) =>
      value?.type === "text" ? { type: "text", value: value.value } : value,
    ),
  );

function bothHasts(markdown: string) {
  const file = new VFile(markdown);
  const mdast = fastRemark.runSync(fastRemark.parse(file), file);
  const direct = chatRenderHast(structuredClone(mdast) as never);
  const expected = rehype.runSync(mdast as never, file);
  return { direct, expected };
}

describe("chatRenderHast", () => {
  it.each([...CHAT_MARKDOWN_CASES, ...RAW_HTML_CASES])(
    "builds what the rehype plugins build for %j",
    (markdown) => {
      const { direct, expected } = bothHasts(markdown);
      expect(direct).not.toBeNull();
      expect(withoutTextPositions(direct)).toEqual(withoutTextPositions(expected));
    },
  );

  it("builds what the rehype plugins build for every CommonMark example it takes", () => {
    const differing = spec.tests.filter((test) => {
      const { direct, expected } = bothHasts(test.markdown);
      return (
        direct !== null && !sameTree(withoutTextPositions(direct), withoutTextPositions(expected))
      );
    });
    // A lone doctype leaves parse5's root without a position.
    expect(differing.map((test) => test.number)).toEqual([181]);
  });
});

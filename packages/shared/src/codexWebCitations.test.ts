import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { hideCodexWebCitations, remarkHideCodexWebCitations } from "./codexWebCitations.ts";
import { CHAT_MARKDOWN_REMARK_PLUGINS } from "./markdownPipeline.ts";

const CITE = "citeturn0search0";
const CITE_TWO = "citeturn0search0turn1news2";

interface TestNode {
  readonly type: string;
  readonly value?: string;
  readonly url?: string;
  readonly children?: ReadonlyArray<TestNode>;
}

// Positions and text node boundaries differ between a displayed tree and a reparsed copy, and a
// copy can carry an invisible word joiner; structure and visible text must not differ.
function shape(node: TestNode): TestNode {
  const children: Array<TestNode> = [];
  for (const child of (node.children ?? []).map(shape)) {
    const previous = children.at(-1);
    if (child.type === "text" && child.value === "") continue;
    if (child.type === "text" && previous?.type === "text") {
      children[children.length - 1] = { type: "text", value: `${previous.value}${child.value}` };
    } else {
      children.push(child);
    }
  }
  return {
    type: node.type,
    ...(node.value === undefined ? {} : { value: node.value.replaceAll("\u2060", "") }),
    ...(node.url === undefined ? {} : { url: node.url }),
    ...(node.children === undefined ? {} : { children }),
  };
}

function parsed(markdown: string): TestNode {
  return shape(unified().use(remarkParse).use(remarkGfm).parse(markdown));
}

function displayed(markdown: string): TestNode {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkHideCodexWebCitations);
  return shape(processor.runSync(processor.parse(markdown)) as Root);
}

describe("Codex web-search citation markers", () => {
  it.each([
    ["at the end of a sentence", `Node 24 is current. ${CITE}`, "Node 24 is current."],
    ["with several sources", `Node 24 is current. ${CITE_TWO}`, "Node 24 is current."],
    ["between sentences", `One. ${CITE} Two. ${CITE}${CITE_TWO} Three.`, "One. Two. Three."],
    ["before punctuation", `Node 24 ${CITE}, then 25 ${CITE}.`, "Node 24, then 25."],
    ["closing bold before a word", `**Result ${CITE}**next`, "**Result**next"],
    [
      "closing bold before a link",
      `**Result ${CITE}**[next](https://a.dev)`,
      "**Result**[next](https://a.dev)",
    ],
    ["closing bold after punctuation", `**Result. ${CITE}** next`, "**Result.** next"],
    [
      "closing bold between punctuation and a word",
      `**Result. ${CITE}**next`,
      "**Result.\u2060**next",
    ],
    [
      "closing bold between a link and a word",
      `**[docs](https://a.dev) ${CITE}**next`,
      "**[docs](https://a.dev)\u2060**next",
    ],
    [
      "opening bold between a word and punctuation",
      `word**${CITE} (Result)** next`,
      "word**\u2060(Result)** next",
    ],
    ["opening bold", `**${CITE} Result** next`, "**Result** next"],
    ["after inline code inside bold", `**Use \`npm\` ${CITE}** now`, "**Use `npm`** now"],
    ["as all of the bold text", `Done **${CITE}** now`, "Done  now"],
    ["closing strikethrough", `~~old ${CITE}~~ new`, "~~old~~ new"],
    ["before bold", `See ${CITE}**this**`, "See **this**"],
    ["after a link", `[docs](https://a.dev)${CITE} say so`, "[docs](https://a.dev) say so"],
    [
      "after a bare URL",
      `See https://nodejs.org${CITE} for more`,
      "See https://nodejs.org for more",
    ],
    [
      "in a heading and a list",
      `# News ${CITE}\n\n- item ${CITE}\n- other`,
      "# News\n\n- item\n- other",
    ],
    [
      "in a table",
      `| a | b |\n| - | - |\n| one ${CITE} | two |`,
      "| a | b |\n| - | - |\n| one | two |",
    ],
    ["in a quote", `> first\n> ${CITE} second ${CITE}`, "> first\n> second"],
  ])("are hidden %s, in display and in copied text alike", (_name, markdown, expected) => {
    expect(hideCodexWebCitations(markdown)).toBe(expected);
    expect(displayed(markdown)).toEqual(parsed(expected));
  });

  it.each([
    ["inline code", `Literally \`${CITE}\` here`],
    ["a code fence", `\`\`\`\n${CITE}\n\`\`\``],
    ["an unfinished marker", "Still streaming citeturn0search0"],
    ["a link destination", `[docs](https://a.dev/${CITE})`],
    ["another private-use marker", "See fileciteturn0file0 here"],
  ])("are kept in %s", (_name, markdown) => {
    expect(hideCodexWebCitations(markdown)).toBe(markdown);
    expect(displayed(markdown)).toEqual(parsed(markdown));
  });

  it("stay in Markdown that does not opt in, such as a user's prompt", () => {
    const processor = unified().use(remarkParse).use(CHAT_MARKDOWN_REMARK_PLUGINS);
    const tree = processor.runSync(processor.parse(`Explain this marker: ${CITE}`)) as Root;

    expect(shape(tree).children?.[0]?.children).toEqual([
      { type: "text", value: `Explain this marker: ${CITE}` },
    ]);
  });
});

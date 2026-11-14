import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  serializeCodeBlockToMarkdown,
  serializeRenderedMarkdownFragment,
  serializeTableElementToMarkdown,
} from "./markdown-clipboard";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { markdownMathRanges, parseMarkdownWithMath } from "@t3tools/shared/markdownMath";

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

class FakeText {
  readonly nodeType = TEXT_NODE;
  readonly childNodes: ReadonlyArray<never> = [];

  constructor(readonly textContent: string) {}
}

class FakeElement {
  readonly nodeType = ELEMENT_NODE;
  checked = false;
  readonly childNodes: Array<FakeElement | FakeText> = [];
  readonly classList = {
    contains: (name: string) => this.classNames.includes(name),
  };

  constructor(
    readonly tagName: string,
    private readonly classNames: ReadonlyArray<string> = [],
    private readonly attributes: Readonly<Record<string, string>> = {},
  ) {}

  get localName(): string {
    return this.tagName.toLowerCase();
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  get children(): ReadonlyArray<FakeElement> {
    return this.childNodes.filter((child): child is FakeElement => child instanceof FakeElement);
  }

  append(...children: Array<FakeElement | FakeText>): this {
    this.childNodes.push(...children);
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attributes, name);
  }

  closest(): FakeElement | null {
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    if (selector.includes(", ")) {
      for (const part of selector.split(", ")) {
        const match = this.querySelector(part);
        if (match) return match;
      }
      return null;
    }
    const childOnly = selector.startsWith(":scope > ");
    const [target, ...rest] = (childOnly ? selector.slice(":scope > ".length) : selector).split(
      " > ",
    );
    const matches = (element: FakeElement): boolean => {
      if (target === 'input[type="checkbox"]') {
        return element.tagName === "INPUT" && element.getAttribute("type") === "checkbox";
      }
      return element.tagName === target?.toUpperCase();
    };
    const search = (parent: FakeElement): FakeElement | null => {
      for (const child of parent.childNodes) {
        if (!(child instanceof FakeElement)) continue;
        if (matches(child)) {
          if (rest.length === 0) return child;
          const nested = child.querySelector(`:scope > ${rest.join(" > ")}`);
          if (nested) return nested;
        }
        if (!childOnly) {
          const nested = search(child);
          if (nested) return nested;
        }
      }
      return null;
    };
    return search(this);
  }

  /** Supports the `:scope > a > b` child paths the table serializer queries. */
  querySelectorAll(selector: string): FakeElement[] {
    return selector.split(", ").flatMap((part) =>
      part
        .replace(/^:scope > /, "")
        .split(" > ")
        .reduce<FakeElement[]>(
          (level, tag) =>
            level.flatMap((element) =>
              element.children.filter((child) => child.tagName === tag.toUpperCase()),
            ),
          [this],
        ),
    );
  }
}

function asNode(element: FakeElement): Node {
  return element as unknown as Node;
}

function shikiCodeLine(text: string): FakeElement {
  const token = new FakeElement("SPAN").append(new FakeText(text));
  return new FakeElement("SPAN", ["line"]).append(token);
}

function renderedCodeBlock(lines: ReadonlyArray<string>): FakeElement {
  const code = new FakeElement("CODE");
  lines.forEach((line, index) => {
    if (index > 0) code.append(new FakeText("\n"));
    code.append(shikiCodeLine(line));
  });
  return new FakeElement("DIV", ["chat-markdown-codeblock"]).append(
    new FakeElement("DIV", ["chat-markdown-codeblock-header", "select-none"]).append(
      new FakeText("sh"),
    ),
    new FakeElement("DIV", ["chat-markdown-shiki"]).append(new FakeElement("PRE").append(code)),
  );
}

describe("serializeRenderedMarkdownFragment", () => {
  it("copies a popover context reference once, without its details or nested label", () => {
    const reference = "[Review comment](t3-context://v1/review-comment/review-1)";
    const container = new FakeElement("DIV").append(
      new FakeText("Fix "),
      new FakeElement("BUTTON", [], { "data-markdown-copy": reference }).append(
        new FakeElement("SPAN", [], { "data-markdown-copy": reference }).append(
          new FakeText("Review comment"),
        ),
      ),
      new FakeText(" please"),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(`Fix ${reference} please`);
  });

  beforeEach(() => {
    vi.stubGlobal("Node", { TEXT_NODE, ELEMENT_NODE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies the complete quote, source, and comment instead of the comment-only chip label", () => {
    const citation = {
      version: 1 as const,
      environmentId: EnvironmentId.make("environment-one"),
      threadId: ThreadId.make("thread-one"),
      messageId: MessageId.make("assistant-one"),
      text: "A complete quote, including the part hidden by the chip preview.",
      comment: "What does this mean?\nPlease expand on the hidden part.",
      start: 0,
      end: 66,
      prefix: "",
      suffix: "",
    };
    const anchor = new FakeElement("A", [], {
      "data-markdown-copy": serializeAssistantCitation(citation),
      href: "/environment-one/thread-one#citation",
    }).append(new FakeText("What does this mean?…"));
    const chip = new FakeElement("SPAN", [], {
      "data-markdown-copy": serializeAssistantCitation(citation),
    }).append(anchor, new FakeElement("BUTTON").append(new FakeText("Edit comment")));
    const container = new FakeElement("DIV").append(new FakeText("Explain "), chip);
    const copied = serializeRenderedMarkdownFragment(asNode(container));
    expect(copied).toBe(`Explain ${serializeAssistantCitation(citation)}`);
    expect(collectAssistantCitations(copied).map((entry) => entry.citation)).toEqual([citation]);
  });

  it("keeps a multi-line code selection plain instead of inline-wrapping it", () => {
    const code = new FakeElement("CODE").append(new FakeText("first line\nsecond line"));
    const container = new FakeElement("DIV").append(code);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("first line\nsecond line");
  });

  it.each([
    ["backtick edges", "`value`"],
    ["space edges", "  value  "],
    ["only spaces", "   "],
  ])("copies inline code that parses back unchanged: %s", (_, value) => {
    const container = new FakeElement("DIV").append(
      new FakeElement("P").append(
        new FakeText("Use "),
        new FakeElement("CODE").append(new FakeText(value)),
        new FakeText(" here."),
      ),
    );
    const paragraph = parseMarkdownWithMath(serializeRenderedMarkdownFragment(asNode(container)))
      .children[0];
    if (paragraph?.type !== "paragraph") throw new Error("Expected a paragraph");
    expect(paragraph.children.find((child) => child.type === "inlineCode")?.value).toBe(value);
  });

  it("copies alert and insight callouts as their Markdown instead of the rendered label", () => {
    // The shape ChatMarkdown renders for `> [!WARNING]\n> Back up first.`.
    const callout = new FakeElement("DIV", [], {
      role: "note",
      "data-markdown-alert": "warning",
    }).append(
      new FakeElement("P", [], {
        "data-thread-find-ignore": "true",
        "data-markdown-alert-label": "",
      }).append(new FakeElement("SVG", [], { "aria-hidden": "true" }), new FakeText("Warning")),
      new FakeElement("P").append(new FakeText("Back up first.")),
    );
    const container = new FakeElement("DIV").append(callout);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "> [!WARNING]\n> Back up first.",
    );
    const insight = new FakeElement("DIV", [], {
      role: "note",
      "data-markdown-alert": "insight",
    }).append(
      new FakeElement("P", [], {
        "data-thread-find-ignore": "true",
        "data-markdown-alert-label": "",
      }).append(new FakeText("Insight")),
      new FakeElement("P").append(new FakeText("Caches are warm.")),
    );
    expect(serializeRenderedMarkdownFragment(asNode(new FakeElement("DIV").append(insight)))).toBe(
      `★ Insight ${"─".repeat(37)}\nCaches are warm.\n${"─".repeat(49)}`,
    );
  });

  it("preserves explicit ordered-list values and continues from resets when copying", () => {
    const list = new FakeElement("OL", [], { start: "0" }).append(
      new FakeElement("LI").append(new FakeText("A")),
      new FakeElement("LI", [], { value: "5" }).append(new FakeText("B")),
      new FakeElement("LI").append(new FakeText("C")),
      new FakeElement("LI", [], { value: "0" }).append(new FakeText("D")),
    );
    expect(serializeRenderedMarkdownFragment(asNode(new FakeElement("DIV").append(list)))).toBe(
      "0. A\n5. B\n6. C\n0. D",
    );
  });

  it("keeps a bare list item that sits alongside the code block", () => {
    const container = new FakeElement("DIV").append(
      new FakeElement("UL").append(new FakeElement("LI")),
      renderedCodeBlock(["pnpm test"]),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("-\n\npnpm test");
  });

  it("copies a command and the prose after it as shown, without code fences", () => {
    const container = new FakeElement("DIV").append(
      renderedCodeBlock(["printf 'hello\\n'"]),
      new FakeElement("P").append(new FakeText("T")),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("printf 'hello\\n'\n\nT");
  });

  it("keeps a diagram's source exactly as written when copied with prose", () => {
    const source = 'flowchart TD\n  A["first   \n\n\nlast"]';
    const container = new FakeElement("DIV").append(
      new FakeElement("DIV", [], {
        "data-markdown-mermaid": "",
        "data-markdown-copy": serializeCodeBlockToMarkdown(source, "mermaid"),
      }),
      new FakeElement("P").append(new FakeText("After")),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      `\`\`\`mermaid\n${source}\n\`\`\`\n\nAfter`,
    );
  });

  it("keeps blank lines inside a code block in a list item, quote, or longer fence", () => {
    const code = ["import os", "", "", "def main():"];
    const list = new FakeElement("OL").append(
      new FakeElement("LI").append(new FakeText("Create it:\n"), renderedCodeBlock(code)),
    );
    const quote = new FakeElement("BLOCKQUOTE").append(
      new FakeElement("P").append(new FakeText("Note:")),
      renderedCodeBlock(code),
    );
    const nestedFence = new FakeElement("DIV").append(
      new FakeElement("P").append(new FakeText("Example:")),
      renderedCodeBlock(["```js", "a()", "", "", "b()  ", "```"]),
    );

    expect(serializeRenderedMarkdownFragment(asNode(nestedFence))).toBe(
      "Example:\n\n```js\na()\n\n\nb()  \n```",
    );

    expect(serializeRenderedMarkdownFragment(asNode(new FakeElement("DIV").append(list)))).toBe(
      "1. Create it:\n   import os\n\n\n   def main():",
    );
    expect(serializeRenderedMarkdownFragment(asNode(new FakeElement("DIV").append(quote)))).toBe(
      "> Note:\n>\n> import os\n>\n>\n> def main():",
    );
  });

  it("omits fences when a selection past the last line drags in the whole code block", () => {
    const container = new FakeElement("DIV").append(
      renderedCodeBlock(["printf '%s' 'TOKEN' | gh secret set CLOUDFLARE_API_TOKEN"]),
      new FakeText("\n"),
      new FakeElement("P").append(new FakeText("")),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "printf '%s' 'TOKEN' | gh secret set CLOUDFLARE_API_TOKEN",
    );
  });
});

function renderedFormula(tex: string): FakeElement {
  // MarkdownMath's wrapper; its children stand in for KaTeX's glyphs.
  return new FakeElement("SPAN", [], {
    "data-markdown-math": "inline",
    "data-markdown-copy": `\\(${tex}\\)`,
  }).append(new FakeText(tex));
}

function renderedTable(...rows: Array<Array<FakeElement | FakeText>>): FakeElement {
  const row = (tag: string, cells: Array<FakeElement | FakeText>) =>
    new FakeElement("TR").append(...cells.map((cell) => new FakeElement(tag).append(cell)));
  const [head = [], ...body] = rows;
  return new FakeElement("TABLE").append(
    new FakeElement("THEAD").append(row("TH", head)),
    new FakeElement("TBODY").append(...body.map((cells) => row("TD", cells))),
  );
}

describe("copying rendered Markdown tables", () => {
  beforeEach(() => {
    vi.stubGlobal("Node", { TEXT_NODE, ELEMENT_NODE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps formula pipes as authored while escaping prose pipes", () => {
    const table = renderedTable(
      [new FakeText("Formula"), new FakeText("Note")],
      [renderedFormula("|x|"), new FakeText("a | b")],
      [renderedFormula("\\|x\\|"), new FakeElement("CODE").append(new FakeText("\\(c|d\\)"))],
      [
        new FakeElement("A", [], { href: "https://example.com/?q=a|b" }).append(
          new FakeText("norm "),
          renderedFormula("|y|"),
        ),
        new FakeText("e"),
      ],
      [
        new FakeElement("UL").append(
          new FakeElement("LI").append(renderedFormula("|z|"), new FakeText(" a | b")),
        ),
        new FakeElement("BLOCKQUOTE").append(new FakeElement("P").append(new FakeText("c | d"))),
      ],
    );
    const markdown = serializeTableElementToMarkdown(table as unknown as Element);

    const tree = parseMarkdownWithMath(markdown);
    const parsed = tree.children[0];
    if (parsed?.type !== "table") throw new Error("Expected a table");
    expect(parsed.children.map((row) => row.children.length)).toEqual([2, 2, 2, 2, 2]);
    expect(markdownMathRanges(markdown, tree).map((formula) => formula.tex)).toEqual([
      "|x|",
      "\\|x\\|",
      "|y|",
      "|z|",
    ]);
    expect(parsed.children[1]?.children[1]?.children).toMatchObject([
      { type: "text", value: "a | b" },
    ]);
    expect(parsed.children[4]?.children[1]?.children).toMatchObject([
      { type: "text", value: "> c | d" },
    ]);
    const [, , codeRow, linkRow] = parsed.children;
    expect(codeRow?.children[1]?.children[0]).toMatchObject({
      type: "inlineCode",
      value: "\\(c|d\\)",
    });
    expect(linkRow?.children[0]?.children[0]).toMatchObject({
      type: "link",
      url: "https://example.com/?q=a|b",
    });
  });

  it("copies code and diagrams in cells without markers or unescaped pipes", () => {
    const code = new FakeElement("PRE").append(
      new FakeElement("CODE").append(new FakeText("a  b")),
    );
    const diagram = new FakeElement("DIV", [], {
      "data-markdown-mermaid": "",
      "data-markdown-copy": serializeCodeBlockToMarkdown("A -->|hi| B", "mermaid"),
    });
    expect(
      serializeTableElementToMarkdown(
        asNode(
          renderedTable([new FakeText("Command"), new FakeText("Diagram")], [code, diagram]),
        ) as Element,
      ),
    ).toBe("| Command | Diagram |\n| --- | --- |\n| a  b | ```mermaid A -->\\|hi\\| B ``` |");
  });
});

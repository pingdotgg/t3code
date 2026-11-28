import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  serializeCodeBlockToMarkdown,
  serializeRenderedMarkdownFragment,
  serializeTableElementForChat,
  serializeTableElementToCsv,
  serializeTableElementToHtml,
  serializeTableElementToMarkdown,
} from "./markdown-clipboard";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import type { Element as HastElement, ElementContent, Root } from "hast";

import { markdownTree } from "./markdown/wordsHast";

// Copied Markdown read back as the chat reads it, to check it says what was copied.
const elementsOf = (node: Root | HastElement) =>
  (node.children as ElementContent[]).filter(
    (child): child is HastElement => child.type === "element",
  );
const textOf = (node: ElementContent): string =>
  node.type === "text"
    ? node.value
    : node.type === "element"
      ? node.children.map(textOf).join("")
      : "";
const readBack = (markdown: string, options?: Parameters<typeof markdownTree>[1]) =>
  elementsOf(markdownTree(markdown, options))[0]!;
// A user message's reading: a single `~` stays text.
const readUserBack = (markdown: string) => readBack(markdown, { singleTilde: false });
const inline = (node: ElementContent) =>
  node.type === "element" ? [node.tagName, textOf(node)] : [node.type, textOf(node)];

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
    const paragraph = readBack(serializeRenderedMarkdownFragment(asNode(container)));
    const code = elementsOf(paragraph).find((child) => child.tagName === "code");
    expect(paragraph.tagName).toBe("p");
    expect(code && textOf(code)).toBe(value);
  });

  it.each([
    String.raw`see C:\me\.t3\shot.png`,
    String.raw`C:\work\_build`,
    "C:/work/_build/out.txt",
    String.raw`C:\work\a-_b.txt`,
    "a*word*b and a_word_b; ~~literal~~ and ~single~",
    String.raw`before\ after\	end`,
    "- item\n+ item\n* item",
    "# heading\n> quote",
    "> quote\nfirst\n- item\n# heading",
    "first\n1. ordered\n1) ordered",
    "---\nfirst\n---\n--\n- - -\nlast",
    "===\nfirst\n===\n=",
    "___\n***\nfirst\n* * *\n_ _ _\nlast",
    "~~~\nfirst\n~~~ js\n~~~\n~~~\nlast",
    "a | b\n---|---",
    "| a | b |\n| --- | --- |",
    "a | b\n:--- | ---:\nc | d",
    "| a |\n| - |",
    "a\n:---\nb\n---:",
  ])("copies prose that parses back unchanged: %s", (value) => {
    const container = new FakeElement("DIV").append(new FakeText(value));
    const paragraph = readUserBack(serializeRenderedMarkdownFragment(asNode(container)));
    expect(paragraph.tagName).toBe("p");
    expect(paragraph.children.map(inline)).toEqual([["text", value]]);
  });

  it("copies bracketed prose that does not read back as display math", () => {
    const value = "Tags [WIP] and [done]";
    const container = new FakeElement("DIV").append(new FakeText(value));
    const paragraph = readBack(serializeRenderedMarkdownFragment(asNode(container)), {
      math: true,
    });
    expect(paragraph.children.map(inline)).toEqual([["text", value]]);
  });

  it("escapes literal block starts across containers without escaping real blocks or verbatim spans", () => {
    const el = (tag: string, ...children: Array<FakeElement | string>) =>
      new FakeElement(tag).append(
        ...children.map((c) => (typeof c === "string" ? new FakeText(c) : c)),
      );
    const copy = (node: FakeElement) => serializeRenderedMarkdownFragment(asNode(node));
    const displayMath = new FakeElement("SPAN", [], {
      "data-markdown-math": "display",
      "data-markdown-copy": "\\[\n- x\n\\]\n\n",
    }).append(new FakeText("- x"));
    const rawCopy = new FakeElement("SPAN", [], { "data-markdown-copy": "- raw" }).append(
      new FakeText("raw"),
    );

    for (const [node, expected] of [
      [el("P", "first", el("BR"), "- second"), [["text", "first\n- second"]]],
      [el("DIV", "# literal"), [["text", "# literal"]]],
      [el("P", el("SPAN", "#"), " not a heading"), [["text", "# not a heading"]]],
      [el("P", el("SPAN", "1"), ". not numbered"), [["text", "1. not numbered"]]],
      [el("P", el("STRONG", "a", el("BR"), "- b")), [["strong", "a\n- b"]]],
      [
        el("P", "- prose ", el("CODE", "x\u2028- flag"), " ", el("CODE", "x\u2029# title")),
        [
          ["text", "- prose "],
          ["code", "x\u2028- flag"],
          ["text", " "],
          ["code", "x\u2029# title"],
        ],
      ],
    ] as const) {
      expect(readUserBack(copy(el("DIV", node))).children.map(inline)).toEqual(expected);
    }

    for (const [node, tag, children] of [
      [el("UL", el("LI", "- literal"), el("LI", "1. literal")), "ul", ["- literal", "1. literal"]],
      [el("BLOCKQUOTE", "- literal"), "blockquote", ["- literal"]],
      [el("BLOCKQUOTE", el("P", "# literal")), "blockquote", ["# literal"]],
    ] as const) {
      const parsed = readUserBack(copy(el("DIV", node)));
      expect(parsed.tagName).toBe(tag);
      expect(elementsOf(parsed).map(textOf)).toEqual(children);
    }

    const table = renderedTable(
      [new FakeText("- col"), new FakeText("# col")],
      [new FakeText("- cell"), new FakeText("1. cell")],
    );
    const expectedTable = "| - col | # col |\n| --- | --- |\n| - cell | 1. cell |";
    for (const [node, expected] of [
      [el("DIV", el("H2", "Title", el("BR"), "- x")), "## Title\n\\- x"],
      [el("BODY", "- item"), "\\- item"],
      [
        el("DIV", el("DL", el("DT", "Term"), el("DD", "\n", el("UL", el("LI", "item"))))),
        "Term\n- item",
      ],
      [el("DIV", el("P", el("SPAN", el("CODE", "# c\n- d")))), "# c\n- d"],
      [el("DIV", el("P", el("CODE", "a\nb"), "- x")), "a\nb- x"],
      [el("DIV", el("P", el("CODE", "a\nb\n"), "- x")), "a\nb\n\\- x"],
      [el("DIV", el("P", "a", el("BR"), "\u0003- x")), "a\n\u0003- x"],
      [el("DIV", rawCopy), "- raw"],
      [el("P", "See ", renderedFormula("a\n- b"), " - end"), "See \\(a\n- b\\) - end"],
      [el("DIV", displayMath, "- after"), "\\[\n- x\n\\]\n\n\\- after"],
      [el("P", "See ", el("CODE", "x"), " - not a list"), "See `x` - not a list"],
      [el("P", "intro", el("BR"), el("BR"), "    - literal"), "intro\n\n    - literal"],
      ...["#123", "-flag", "1.5", "1234567890. ten", "= foo"].map((s) => [el("DIV", s), s]),
      [el("DIV", table), expectedTable],
    ] as Array<[FakeElement, string]>) {
      expect(copy(node)).toBe(expected);
    }
    expect(serializeTableElementToMarkdown(table as unknown as Element)).toBe(expectedTable);
  });

  it.each([
    ["*", "EM", "word"],
    ["\\", "CODE", "value"],
  ])("keeps a text edge %j beside %s", (edge, tag, value) => {
    const container = new FakeElement("DIV").append(
      new FakeText(edge),
      new FakeElement(tag).append(new FakeText(value)),
    );
    const paragraph = readUserBack(serializeRenderedMarkdownFragment(asNode(container)));
    expect(paragraph.children.map(inline)).toEqual([
      ["text", edge],
      [tag.toLowerCase(), value],
    ]);
  });

  it("copies email links with their address and drops in-app destinations", () => {
    const container = new FakeElement("DIV").append(
      new FakeElement("P").append(
        new FakeText("Write to "),
        new FakeElement("A", [], { href: "mailto:support@example.com" }).append(
          new FakeText("support@example.com"),
        ),
        new FakeText(", "),
        new FakeElement("A", [], { href: "mailto:support@example.com?subject=Help" }).append(
          new FakeText("Support"),
        ),
        new FakeText(", "),
        new FakeElement("A", [], { href: "mailto:support@example.com?subject=Help)" }).append(
          new FakeText("Support"),
        ),
        new FakeText(" or "),
        new FakeElement("A", [], { href: "/environment-one/thread-one" }).append(
          new FakeText("the thread"),
        ),
        new FakeText("."),
      ),
    );
    const copied = serializeRenderedMarkdownFragment(asNode(container));
    expect(copied).toBe(
      "Write to support@example.com, [Support](mailto:support@example.com?subject=Help), [Support](mailto:support@example.com?subject=Help\\)) or the thread.",
    );
    expect(
      elementsOf(readBack(copied))
        .filter((child) => child.tagName === "a")
        .map((link) => link.properties.href),
    ).toEqual([
      "mailto:support@example.com",
      "mailto:support@example.com?subject=Help",
      "mailto:support@example.com?subject=Help)",
    ]);
  });

  it.each([
    ["array[index]", "https://example.com"] as const,
    ["C:\\repo\\file[1].ts", "https://example.com"] as const,
    ...[
      "support@example.com?subject=Help",
      "foo",
      "support@example.internal1",
      "support@example.com_",
      "support@example.com-",
      "first_last@example.com",
    ].map((label) => [label, `mailto:${label}`] as const),
  ])("keeps the link label and destination: %s", (label, href) => {
    const anchor = new FakeElement("A", [], { href }).append(new FakeText(label));
    const container = new FakeElement("DIV").append(anchor);
    const paragraph = readUserBack(serializeRenderedMarkdownFragment(asNode(container)));
    expect(
      paragraph.children.map((child) =>
        child.type === "element"
          ? [child.tagName, decodeURI(String(child.properties.href)), textOf(child)]
          : [child.type, textOf(child)],
      ),
    ).toEqual([["a", href, label]]);
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
      [renderedFormula("|x|"), new FakeText("*a* | ~~b~~")],
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

    const parsed = readBack(markdown, { math: true });
    expect(parsed.tagName).toBe("table");
    const rows = elementsOf(parsed).flatMap((section) => elementsOf(section));
    const cells = rows.map((row) => elementsOf(row));
    expect(cells.map((row) => row.length)).toEqual([2, 2, 2, 2, 2]);
    const formulas: string[] = [];
    const visit = (node: HastElement) => {
      if (node.tagName === "svg") formulas.push(String(node.properties.ariaLabel));
      else elementsOf(node).forEach(visit);
    };
    visit(parsed);
    expect(formulas).toEqual(["|x|", "\\|x\\|", "|y|", "|z|"]);
    expect(textOf(cells[1]![1]!)).toBe("*a* | ~~b~~");
    expect(textOf(cells[4]![1]!).trim()).toBe("> c | d");
    expect(inline(cells[2]![1]!.children[0]!)).toEqual(["code", "\\(c|d\\)"]);
    const link = cells[3]![0]!.children[0]!;
    expect(link.type === "element" && decodeURI(String(link.properties.href))).toBe(
      "https://example.com/?q=a|b",
    );
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

describe("copying a table as HTML", () => {
  const cell = (
    tag: "TH" | "TD",
    text: string,
    attributes: Record<string, string> = {},
    style?: { textAlign: string },
  ) => {
    const element = new FakeElement(tag, [], attributes).append(new FakeText(text));
    return style ? Object.assign(element, { style }) : element;
  };
  const row = (...cells: FakeElement[]) => new FakeElement("TR").append(...cells);
  const html = (table: FakeElement) => serializeTableElementToHtml(table as unknown as Element);

  beforeEach(() => {
    vi.stubGlobal("Node", { TEXT_NODE, ELEMENT_NODE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Structure only: every style attribute is reduced to its text alignment. */
  const structure = (table: FakeElement) =>
    html(table).replace(/ style="([^"]*)"/g, (_, style: string) => {
      const align = /text-align:(\w+)/.exec(style)?.[1];
      return align ? ` align="${align}"` : "";
    });

  it("escapes text and keeps column alignment from the style or the align attribute", () => {
    const table = new FakeElement("TABLE").append(
      new FakeElement("THEAD").append(
        row(cell("TH", "Name"), cell("TH", "Amount", {}, { textAlign: "right" })),
      ),
      new FakeElement("TBODY").append(
        row(cell("TD", 'A & B <"Ltd">'), cell("TD", "1,200", {}, { textAlign: "right" })),
        // An absent inline style reads as "": the align attribute still applies.
        row(cell("TD", "  Bob\n  Smith "), cell("TD", "3", { align: "center" }, { textAlign: "" })),
        row(cell("TD", "text", { align: "justify" }), cell("TD", "4", {}, { textAlign: "end" })),
      ),
    );

    expect(structure(table)).toBe(
      [
        '<table dir="ltr">',
        "  <thead>",
        '    <tr><th align="left">Name</th><th align="right">Amount</th></tr>',
        "  </thead>",
        "  <tbody>",
        '    <tr><td>A &amp; B &lt;&quot;Ltd&quot;&gt;</td><td align="right">1,200</td></tr>',
        '    <tr><td>Bob Smith</td><td align="center">3</td></tr>',
        '    <tr><td align="justify">text</td><td align="right">4</td></tr>',
        "  </tbody>",
        "</table>",
      ].join("\n"),
    );
  });

  it("keeps every header row, body header cells, footers, and merged cells", () => {
    const table = new FakeElement("TABLE").append(
      new FakeElement("THEAD").append(
        row(cell("TH", "Region", { rowspan: "2" }), cell("TH", "Sales", { colspan: "2" })),
        row(cell("TH", "Q1"), cell("TH", "Q2", { colspan: "1" })),
      ),
      new FakeElement("TBODY").append(
        row(
          cell("TH", "EU"),
          cell("TD", "1", { rowspan: "0" }),
          cell("TD", "2", { rowspan: "-1" }),
        ),
        row(),
      ),
      new FakeElement("TFOOT").append(
        row(cell("TD", "Total"), cell("TD", "3", { colspan: "2garbage" })),
      ),
    );

    expect(structure(table)).toBe(
      [
        '<table dir="ltr">',
        "  <thead>",
        '    <tr><th align="left" rowspan="2">Region</th><th align="left" colspan="2">Sales</th></tr>',
        '    <tr><th align="left">Q1</th><th align="left">Q2</th></tr>',
        "  </thead>",
        "  <tbody>",
        // rowspan="0" runs to the end of its section; a negative span is invalid.
        '    <tr><th align="left">EU</th><td rowspan="0">1</td><td>2</td></tr>',
        "    <tr></tr>",
        "  </tbody>",
        "  <tfoot>",
        // HTML reads a span's leading digits, as the DOM does.
        '    <tr><td>Total</td><td colspan="2">3</td></tr>',
        "  </tfoot>",
        "</table>",
      ].join("\n"),
    );
  });

  it("keeps line breaks, block edges, nested cells, and formulas as TeX", () => {
    const nested = new FakeElement("TABLE").append(
      new FakeElement("TBODY").append(row(cell("TD", "a"), cell("TD", "b"))),
    );
    const table = new FakeElement("TABLE").append(
      new FakeElement("TBODY").append(
        row(
          new FakeElement("TD").append(
            new FakeText("first"),
            new FakeElement("BR"),
            new FakeElement("STRONG").append(new FakeText("second")),
          ),
          new FakeElement("TD").append(
            new FakeElement("P").append(new FakeText("one")),
            new FakeElement("P").append(new FakeText("two")),
          ),
        ),
        row(
          new FakeElement("TD").append(nested),
          new FakeElement("TD").append(new FakeText("area "), renderedFormula("\\pi r^2")),
        ),
      ),
    );

    expect(structure(table)).toBe(
      [
        '<table dir="ltr">',
        "  <tbody>",
        "    <tr><td>first<br>second</td><td>one<br>two</td></tr>",
        "    <tr><td>a b</td><td>area \\(\\pi r^2\\)</td></tr>",
        "  </tbody>",
        "</table>",
      ].join("\n"),
    );
  });

  it("keeps every explicit break, preformatted spacing, and nonbreaking spaces", () => {
    const br = () => new FakeElement("BR");
    const content = (...children: Array<FakeElement | FakeText>) =>
      structure(
        new FakeElement("TABLE").append(
          new FakeElement("TBODY").append(row(new FakeElement("TD").append(...children))),
        ),
      ).split("\n")[2];
    const td = (html: string) => `    <tr><td>${html}</td></tr>`;

    expect(content(new FakeText("a"), br(), br(), new FakeText("b"))).toBe(td("a<br><br>b"));
    expect(content(br(), new FakeText(" lead "), br())).toBe(td("<br>lead<br>"));
    // A break that ends a paragraph already ends the line.
    expect(
      content(
        new FakeElement("P").append(new FakeText("a "), br()),
        new FakeElement("P").append(new FakeText("b")),
      ),
    ).toBe(td("a<br>b"));
    expect(
      content(
        new FakeText("run:"),
        new FakeElement("DIV", ["select-none"]).append(new FakeText("madeup")),
        new FakeElement("PRE").append(
          new FakeElement("CODE").append(new FakeText("if x:\n\ty  =  1\n\nend\n")),
        ),
      ),
    ).toBe(
      td("run:<br>if&nbsp;x:<br>&nbsp;&nbsp;&nbsp;&nbsp;y&nbsp;&nbsp;=&nbsp;&nbsp;1<br><br>end"),
    );
    expect(content(new FakeText("1\u00a0000   EUR"))).toBe(td("1&nbsp;000 EUR"));
    expect(
      content(
        new FakeElement("BUTTON", [], {
          "data-markdown-copy": "[source](https://example.com)",
        }).append(new FakeText("source")),
      ),
    ).toBe(td("source"));
  });

  it("keeps a right-to-left table's direction and puts headers on its start side", () => {
    const table = new FakeElement("TABLE", [], { dir: "rtl" }).append(
      new FakeElement("THEAD").append(
        row(cell("TH", "Name"), cell("TH", "End", {}, { textAlign: "end" })),
      ),
    );

    expect(structure(table)).toBe(
      [
        '<table dir="rtl">',
        "  <thead>",
        '    <tr><th align="right">Name</th><th align="left">End</th></tr>',
        "  </thead>",
        "</table>",
      ].join("\n"),
    );
  });

  it("wraps rows outside any section in a body", () => {
    const table = new FakeElement("TABLE").append(row(cell("TD", "only"), cell("TD", "cells")));

    expect(structure(table)).toBe(
      '<table dir="ltr">\n  <tbody>\n    <tr><td>only</td><td>cells</td></tr>\n  </tbody>\n</table>',
    );
  });

  it("returns an empty string for a table without cells", () => {
    expect(html(new FakeElement("TABLE").append(new FakeElement("TBODY").append(row())))).toBe("");
  });
});

describe("copying a table as CSV", () => {
  const row = (...cells: FakeElement[]) => new FakeElement("TR").append(...cells);
  const td = (...children: Array<FakeElement | FakeText>) =>
    new FakeElement("TD").append(...children);

  beforeEach(() => {
    vi.stubGlobal("Node", { TEXT_NODE, ELEMENT_NODE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("separates line breaks and block edges, and leaves out hidden elements", () => {
    const table = new FakeElement("TABLE").append(
      new FakeElement("THEAD").append(
        row(
          new FakeElement("TH").append(new FakeText("Col A")),
          new FakeElement("TH").append(new FakeText("Col B")),
        ),
      ),
      new FakeElement("TBODY").append(
        row(
          td(new FakeText("line 1"), new FakeElement("BR"), new FakeText("line 2")),
          td(
            new FakeElement("P").append(new FakeText("para 1")),
            new FakeElement("P").append(new FakeText("para 2")),
          ),
        ),
        row(
          td(
            new FakeElement("SPAN", ["sr-only"]).append(new FakeText("hidden")),
            new FakeText("visible"),
          ),
          td(
            new FakeElement("SPAN", [], { "aria-hidden": "true" }).append(new FakeText("icon")),
            new FakeText("a, b"),
          ),
        ),
      ),
    );

    expect(serializeTableElementToCsv(table as unknown as Element)).toBe(
      'Col A,Col B\nline 1 line 2,para 1 para 2\nvisible,"a, b"',
    );
  });

  it("aligns columns with spaces inside a code fence for chat apps", () => {
    const table = new FakeElement("TABLE").append(
      new FakeElement("THEAD").append(
        row(
          new FakeElement("TH").append(new FakeText("Name")),
          new FakeElement("TH", [], { align: "right" }).append(new FakeText("Amount")),
        ),
      ),
      new FakeElement("TBODY").append(
        row(td(new FakeText("Ada")), td(new FakeText("1,200"))),
        row(td(new FakeText("東京")), td(new FakeText("5"))),
        row(td(new FakeText("```"))),
      ),
    );

    const { text, html } = serializeTableElementForChat(table as unknown as Element);
    const aligned = ["Name  Amount", "----  ------", "Ada    1,200", "東京       5", "```"].join(
      "\n",
    );
    expect(text).toBe(`\`\`\`\`\n${aligned}\n\`\`\`\``);
    expect(html).toBe(`<meta charset="utf-8"><pre>${aligned}</pre>`);
  });

  it("bounds rowspans by their row group and keeps empty rows while placing spans", () => {
    const cell = (tag: string, text: string, attributes: Record<string, string> = {}) =>
      new FakeElement(tag, [], attributes).append(new FakeText(text));
    const table = new FakeElement("TABLE").append(
      new FakeElement("THEAD").append(row(cell("TH", "A", { rowspan: "0" }), cell("TH", "B"))),
      new FakeElement("TBODY").append(
        row(cell("TD", "X", { rowspan: "2" }), cell("TD", "P", { rowspan: "2" })),
        new FakeElement("TR"),
        row(cell("TD", "Y"), cell("TD", "Z")),
      ),
    );

    const { text } = serializeTableElementForChat(table as unknown as Element);
    expect(text).toBe(["```", "A  B", "-  -", "X  P", "Y  Z", "```"].join("\n"));
  });

  it("orders header, loose and footer rows as the table renders them", () => {
    const table = new FakeElement("TABLE").append(
      new FakeElement("THEAD").append(
        row(
          new FakeElement("TH").append(new FakeText("A")),
          new FakeElement("TH", [], { align: "right" }).append(new FakeText("B")),
        ),
      ),
      new FakeElement("TFOOT").append(row(td(new FakeText("t")), td(new FakeText("9")))),
      row(td(new FakeText("x")), td(new FakeText("yy"))),
    );

    const { text } = serializeTableElementForChat(table as unknown as Element);
    expect(text).toBe(["```", "A   B", "-  --", "x  yy", "t   9", "```"].join("\n"));
  });

  it("counts emoji and CJK as two columns, and digits and combining marks as one", () => {
    const table = new FakeElement("TABLE").append(
      new FakeElement("THEAD").append(
        row(new FakeElement("TH").append(new FakeText("ID")), td(new FakeText("Value"))),
      ),
      new FakeElement("TBODY").append(
        row(td(new FakeText("🇺🇸")), td(new FakeText("x"))),
        row(td(new FakeText("1️⃣")), td(new FakeText("y"))),
        row(td(new FakeText("1")), td(new FakeText("z"))),
        row(td(new FakeText("𠮷")), td(new FakeText("w"))),
        row(td(new FakeText("𛀀")), td(new FakeText("v"))),
        row(td(new FakeText("A\u3099")), td(new FakeText("u"))),
      ),
    );

    const { text } = serializeTableElementForChat(table as unknown as Element);
    expect(text).toBe(
      [
        "```",
        "ID  Value",
        "--  -----",
        "🇺🇸  x",
        "1️⃣  y",
        "1   z",
        "𠮷  w",
        "𛀀  v",
        "A\u3099   u",
        "```",
      ].join("\n"),
    );
  });

  it("counts text-style symbols such as ™, © and ↔ as one column unless shown as emoji", () => {
    const table = new FakeElement("TABLE").append(
      new FakeElement("THEAD").append(
        row(new FakeElement("TH").append(new FakeText("Name")), td(new FakeText("Note"))),
      ),
      new FakeElement("TBODY").append(
        row(td(new FakeText("Acme™")), td(new FakeText("a"))),
        row(td(new FakeText("©2026")), td(new FakeText("b"))),
        row(td(new FakeText("A↔B")), td(new FakeText("c"))),
        row(td(new FakeText("❤️")), td(new FakeText("d"))),
      ),
    );

    const { text } = serializeTableElementForChat(table as unknown as Element);
    expect(text).toBe(
      [
        "```",
        "Name   Note",
        "-----  ----",
        "Acme™  a",
        "©2026  b",
        "A↔B    c",
        "❤️     d",
        "```",
      ].join("\n"),
    );
  });

  it("keeps values under their headers across spans, and copies footer rows", () => {
    const span = (attributes: Record<string, string>, text: string) =>
      new FakeElement("TD", [], attributes).append(new FakeText(text));
    const table = new FakeElement("TABLE").append(
      new FakeElement("THEAD").append(
        row(
          new FakeElement("TH").append(new FakeText("A")),
          new FakeElement("TH").append(new FakeText("B")),
          new FakeElement("TH").append(new FakeText("C")),
        ),
      ),
      new FakeElement("TBODY").append(
        row(span({ rowspan: "2" }, "tall"), span({ colspan: "2" }, "wide")),
        row(td(new FakeText("b2")), td(new FakeText("c2"))),
      ),
      new FakeElement("TFOOT").append(
        row(td(new FakeText("total")), td(new FakeText("")), td(new FakeText("9"))),
      ),
    );

    const { text } = serializeTableElementForChat(table as unknown as Element);
    expect(text).toBe(
      [
        "```",
        "A      B     C",
        "-----  ----  --",
        "tall   wide",
        "       b2    c2",
        "total        9",
        "```",
      ].join("\n"),
    );
  });
});

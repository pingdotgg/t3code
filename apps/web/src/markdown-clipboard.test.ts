import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
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

  it("keeps fences when a bare list item sits alongside the code block", () => {
    const container = new FakeElement("DIV").append(
      new FakeElement("UL").append(new FakeElement("LI")),
      renderedCodeBlock(["pnpm test"]),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("-\n\n```\npnpm test\n```");
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
});

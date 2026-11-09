import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  serializeRenderedMarkdownFragment,
  serializeTableElementToHtml,
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
      "Example:\n\n````\n```js\na()\n\n\nb()  \n```\n````",
    );

    expect(serializeRenderedMarkdownFragment(asNode(new FakeElement("DIV").append(list)))).toBe(
      "1. Create it:\n   ```\n   import os\n\n\n   def main():\n   ```",
    );
    expect(serializeRenderedMarkdownFragment(asNode(new FakeElement("DIV").append(quote)))).toBe(
      "> Note:\n>\n> ```\n> import os\n>\n>\n> def main():\n> ```",
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

  it("styles the table inline with light, theme-independent colors", () => {
    const table = new FakeElement("TABLE").append(
      new FakeElement("THEAD").append(row(cell("TH", "Name"))),
      new FakeElement("TBODY").append(row(cell("TD", "Ada"), cell("TD", ""))),
    );

    const cellStyle = "border:1px solid #d0d7de;padding:6px 12px;vertical-align:top";
    expect(html(table)).toBe(
      [
        '<table style="border-collapse:collapse">',
        "  <thead>",
        `    <tr><th style="${cellStyle};background-color:#f6f8fa;color:#1f2328;font-weight:600;text-align:left">Name</th></tr>`,
        "  </thead>",
        "  <tbody>",
        `    <tr><td style="${cellStyle}">Ada</td><td style="${cellStyle}"></td></tr>`,
        "  </tbody>",
        "</table>",
      ].join("\n"),
    );
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
        "<table>",
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
      ),
      new FakeElement("TFOOT").append(
        row(cell("TD", "Total"), cell("TD", "3", { colspan: "2garbage" })),
      ),
    );

    expect(structure(table)).toBe(
      [
        "<table>",
        "  <thead>",
        '    <tr><th align="left" rowspan="2">Region</th><th align="left" colspan="2">Sales</th></tr>',
        '    <tr><th align="left">Q1</th><th align="left">Q2</th></tr>',
        "  </thead>",
        "  <tbody>",
        // rowspan="0" runs to the end of its section; a negative span is invalid.
        '    <tr><th align="left">EU</th><td rowspan="0">1</td><td>2</td></tr>',
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
        "<table>",
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
        new FakeElement("PRE").append(
          new FakeElement("CODE").append(new FakeText("if x:\n\ty  =  1\n\nend\n")),
        ),
      ),
    ).toBe(
      td("run:<br>if&nbsp;x:<br>&nbsp;&nbsp;&nbsp;&nbsp;y&nbsp;&nbsp;=&nbsp;&nbsp;1<br><br>end"),
    );
    expect(content(new FakeText("1\u00a0000   EUR"))).toBe(td("1&nbsp;000 EUR"));
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
      "<table>\n  <tbody>\n    <tr><td>only</td><td>cells</td></tr>\n  </tbody>\n</table>",
    );
  });

  it("returns an empty string for a table without cells", () => {
    expect(html(new FakeElement("TABLE").append(new FakeElement("TBODY").append(row())))).toBe("");
  });
});

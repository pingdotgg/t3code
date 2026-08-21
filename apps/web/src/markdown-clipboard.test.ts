import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { serializeRenderedMarkdownFragment } from "./markdown-clipboard";

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

class FakeText {
  readonly nodeType = TEXT_NODE;
  readonly childNodes: ReadonlyArray<never> = [];

  constructor(readonly textContent: string) {}
}

class FakeElement {
  readonly nodeType = ELEMENT_NODE;
  readonly childNodes: Array<FakeElement | FakeText> = [];
  readonly classList = {
    contains: (name: string) => this.classNames.includes(name),
  };

  private readonly attributes = new Map<string, string>();

  constructor(
    readonly tagName: string,
    private readonly classNames: ReadonlyArray<string> = [],
  ) {}

  get localName(): string {
    return this.tagName.toLowerCase();
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  append(...children: Array<FakeElement | FakeText>): this {
    this.childNodes.push(...children);
    return this;
  }

  setAttribute(name: string, value: string): this {
    this.attributes.set(name, value);
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  querySelector(selector: string): FakeElement | null {
    for (const child of this.childNodes) {
      if (child.nodeType === ELEMENT_NODE) {
        const el = child as FakeElement;
        if (selector === "annotation" && el.tagName === "ANNOTATION") return el;
        if (
          selector === 'annotation[encoding="application/x-tex"]' &&
          el.tagName === "ANNOTATION" &&
          el.getAttribute("encoding") === "application/x-tex"
        ) {
          return el;
        }
        if (
          selector === 'math[display="block"]' &&
          el.tagName === "MATH" &&
          el.getAttribute("display") === "block"
        ) {
          return el;
        }
        const found = el.querySelector(selector);
        if (found) return found;
      }
    }
    return null;
  }
}

function asNode(element: FakeElement): Node {
  return element as unknown as Node;
}

function shikiCodeLine(text: string): FakeElement {
  const token = new FakeElement("SPAN").append(new FakeText(text));
  return new FakeElement("SPAN", ["line"]).append(token);
}

describe("serializeRenderedMarkdownFragment", () => {
  beforeEach(() => {
    vi.stubGlobal("Node", { TEXT_NODE, ELEMENT_NODE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wraps inline code in backticks", () => {
    const paragraph = new FakeElement("P").append(
      new FakeText("run "),
      new FakeElement("CODE").append(new FakeText("git status")),
      new FakeText(" first"),
    );
    const container = new FakeElement("DIV").append(paragraph);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("run `git status` first");
  });

  it("keeps a highlighted block code selection plain when its pre wrapper is outside the range", () => {
    const code = new FakeElement("CODE").append(
      shikiCodeLine("git show-ref --verify refs/remotes/origin/opt/deploy/dev"),
    );
    const container = new FakeElement("DIV").append(code);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "git show-ref --verify refs/remotes/origin/opt/deploy/dev",
    );
  });

  it("keeps a multi-line code selection plain instead of inline-wrapping it", () => {
    const code = new FakeElement("CODE").append(new FakeText("first line\nsecond line"));
    const container = new FakeElement("DIV").append(code);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("first line\nsecond line");
  });

  it("serializes inline KaTeX math back to LaTeX delimiters", () => {
    const mathml = new FakeElement("SPAN", ["katex-mathml"]).append(
      new FakeElement("MATH").append(
        new FakeElement("SEMANTICS").append(
          new FakeElement("MROW").append(new FakeText("E=mc2")),
          new FakeElement("ANNOTATION")
            .setAttribute("encoding", "application/x-tex")
            .append(new FakeText("E = mc^2")),
        ),
      ),
    );
    const katexHtml = new FakeElement("SPAN", ["katex-html"])
      .setAttribute("aria-hidden", "true")
      .append(new FakeText("E = mc2"));
    const katex = new FakeElement("SPAN", ["katex"]).append(mathml, katexHtml);
    const paragraph = new FakeElement("P").append(
      new FakeText("The formula is "),
      katex,
      new FakeText(" in physics."),
    );
    const container = new FakeElement("DIV").append(paragraph);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "The formula is \\(E = mc^2\\) in physics.",
    );
  });

  it("serializes display KaTeX math to block delimiters", () => {
    const mathml = new FakeElement("SPAN", ["katex-mathml"]).append(
      new FakeElement("MATH")
        .setAttribute("display", "block")
        .append(
          new FakeElement("SEMANTICS").append(
            new FakeElement("ANNOTATION")
              .setAttribute("encoding", "application/x-tex")
              .append(new FakeText("\\frac{a}{b} = c")),
          ),
        ),
    );
    const katex = new FakeElement("SPAN", ["katex"]).append(mathml);
    const display = new FakeElement("DIV", ["katex-display"]).append(katex);
    const container = new FakeElement("DIV").append(display);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("$$\n\\frac{a}{b} = c\n$$");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  prepareKatexHtmlForClipboard,
  serializeRenderedMarkdownFragment,
} from "./markdown-clipboard";

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

  append(...children: Array<FakeElement | FakeText>): this {
    this.childNodes.push(...children);
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  hasAttribute(): boolean {
    return false;
  }

  querySelector(selector: string): FakeElement | null {
    if (
      selector === 'annotation[encoding="application/x-tex"]' &&
      this.tagName === "ANNOTATION" &&
      this.getAttribute("encoding") === "application/x-tex"
    ) {
      return this;
    }
    for (const child of this.childNodes) {
      if (child instanceof FakeElement) {
        const match = child.querySelector(selector);
        if (match) return match;
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

  it("serializes inline KaTeX back to explicit LaTeX delimiters", () => {
    const annotation = new FakeElement("ANNOTATION", [], {
      encoding: "application/x-tex",
    }).append(new FakeText("e^{i\\pi} + 1 = 0"));
    const math = new FakeElement("SPAN", ["katex"]).append(annotation);
    const container = new FakeElement("DIV").append(new FakeText("Euler: "), math);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "Euler: \\(e^{i\\pi} + 1 = 0\\)",
    );
  });

  it("serializes display KaTeX back to explicit LaTeX delimiters", () => {
    const annotation = new FakeElement("ANNOTATION", [], {
      encoding: "application/x-tex",
    }).append(new FakeText("A_t = \\lambda_t A_t^{\\text{local}}"));
    const math = new FakeElement("SPAN", ["katex"]).append(annotation);
    const display = new FakeElement("SPAN", ["katex-display"]).append(math);
    const container = new FakeElement("DIV").append(display);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "\\[\nA_t = \\lambda_t A_t^{\\text{local}}\n\\]",
    );
  });
});

describe("prepareKatexHtmlForClipboard", () => {
  it("keeps the visual KaTeX branch and removes duplicate MathML", () => {
    const removeMathml = vi.fn();
    const revealHtml = vi.fn();
    const katex = {
      querySelector: vi.fn((selector: string) => {
        if (selector === ":scope > .katex-mathml") return { remove: removeMathml };
        if (selector === ":scope > .katex-html") return { removeAttribute: revealHtml };
        return null;
      }),
    };
    const container = {
      querySelectorAll: vi.fn(() => [katex]),
    };

    prepareKatexHtmlForClipboard(container as unknown as Element);

    expect(removeMathml).toHaveBeenCalledOnce();
    expect(revealHtml).toHaveBeenCalledWith("aria-hidden");
  });
});

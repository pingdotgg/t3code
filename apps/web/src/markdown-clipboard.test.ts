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
  parentElement: FakeElement | null = null;
  readonly classList = {
    contains: (name: string) => this.classNames.includes(name),
  };

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
    for (const child of children) {
      if (child instanceof FakeElement) child.parentElement = this;
    }
    this.childNodes.push(...children);
    return this;
  }

  hasChildNodes(): boolean {
    return this.childNodes.length > 0;
  }

  remove(): void {
    if (!this.parentElement) return;
    const index = this.parentElement.childNodes.indexOf(this);
    if (index >= 0) this.parentElement.childNodes.splice(index, 1);
    this.parentElement = null;
  }

  getAttribute(): string | null {
    return null;
  }

  hasAttribute(): boolean {
    return false;
  }

  closest(): FakeElement | null {
    return null;
  }

  querySelector(): FakeElement | null {
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    for (const child of this.childNodes) {
      if (!(child instanceof FakeElement)) continue;
      if (child.tagName === selector.toUpperCase()) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }
}

function asElement(element: FakeElement): Element {
  return element as unknown as Element;
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

    expect(serializeRenderedMarkdownFragment(asElement(container))).toBe("run `git status` first");
  });

  it("keeps a highlighted block code selection plain when its pre wrapper is outside the range", () => {
    const code = new FakeElement("CODE").append(
      shikiCodeLine("git show-ref --verify refs/remotes/origin/opt/deploy/dev"),
    );
    const container = new FakeElement("DIV").append(code);

    expect(serializeRenderedMarkdownFragment(asElement(container))).toBe(
      "git show-ref --verify refs/remotes/origin/opt/deploy/dev",
    );
  });

  it("keeps a multi-line code selection plain instead of inline-wrapping it", () => {
    const code = new FakeElement("CODE").append(new FakeText("first line\nsecond line"));
    const container = new FakeElement("DIV").append(code);

    expect(serializeRenderedMarkdownFragment(asElement(container))).toBe("first line\nsecond line");
  });

  it("keeps a code-only selection plain when its cloned range contains pre wrappers", () => {
    const container = new FakeElement("DIV").append(
      new FakeElement("PRE").append(new FakeText("npx vp pack --watch")),
      new FakeElement("PRE"),
    );

    expect(serializeRenderedMarkdownFragment(asElement(container))).toBe("npx vp pack --watch");
  });

  it("preserves an empty rendered code block", () => {
    const container = new FakeElement("DIV").append(
      new FakeElement("PRE").append(new FakeElement("CODE")),
    );

    expect(serializeRenderedMarkdownFragment(asElement(container))).toBe("```\n\n```");
  });

  it("preserves fences when a selection includes prose and a code block", () => {
    const container = new FakeElement("DIV").append(
      new FakeElement("P").append(new FakeText("Run this:")),
      new FakeElement("PRE").append(new FakeText("npx vp pack --watch")),
    );

    expect(serializeRenderedMarkdownFragment(asElement(container))).toBe(
      "Run this:\n\n```\nnpx vp pack --watch\n```",
    );
  });

  it("preserves non-text content selected with a code block", () => {
    const container = new FakeElement("DIV").append(
      new FakeElement("PRE").append(new FakeText("npx vp pack --watch")),
      new FakeElement("HR"),
    );

    expect(serializeRenderedMarkdownFragment(asElement(container))).toBe(
      "```\nnpx vp pack --watch\n```\n\n---",
    );
  });
});

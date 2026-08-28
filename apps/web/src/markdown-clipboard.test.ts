import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  chatMarkdownClipboardPayload,
  mermaidMarkdownCopyFromLiveNode,
  serializeRenderedMarkdownFragment,
} from "./markdown-clipboard";

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

class FakeText {
  readonly nodeType = TEXT_NODE;
  readonly childNodes: ReadonlyArray<never> = [];
  parentElement: FakeElement | null = null;

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
    private readonly attributes: Record<string, string> = {},
  ) {}

  get localName(): string {
    return this.tagName.toLowerCase();
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  append(...children: Array<FakeElement | FakeText>): this {
    this.childNodes.push(...children);
    for (const child of children) {
      child.parentElement = this;
    }
    return this;
  }

  parentElement: FakeElement | null = null;

  closest(selector: string): FakeElement | null {
    let current: FakeElement | null = this;
    while (current) {
      if (selector === "svg" && current.tagName.toLowerCase() === "svg") return current;
      if (
        selector === ".chat-markdown-mermaid" &&
        current.classList.contains("chat-markdown-mermaid")
      ) {
        return current;
      }
      if (selector === "[data-markdown-copy]" && current.hasAttribute("data-markdown-copy")) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  getAttribute(name?: string): string | null {
    if (name === undefined) return null;
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attributes, name);
  }

  private htmlOverride: string | null = null;

  appendChild(child: FakeElement | FakeText): FakeElement | FakeText {
    this.append(child);
    return child;
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.childNodes.indexOf(this);
    if (index !== -1) parent.childNodes.splice(index, 1);
    this.parentElement = null;
  }

  matches(selector: string): boolean {
    const trimmed = selector.trim();
    if (trimmed === ".chat-markdown-mermaid[data-markdown-copy]") {
      return (
        this.classList.contains("chat-markdown-mermaid") && this.hasAttribute("data-markdown-copy")
      );
    }
    if (trimmed.startsWith(".") && !trimmed.includes("[")) {
      return this.classList.contains(trimmed.slice(1));
    }
    if (trimmed === '[aria-hidden="true"]') return this.getAttribute("aria-hidden") === "true";
    return this.localName === trimmed;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const parts = selector.split(",").map((part) => part.trim());
    const matches: FakeElement[] = [];
    const visit = (element: FakeElement) => {
      if (parts.some((part) => element.matches(part))) matches.push(element);
      for (const child of element.childNodes) {
        if (child.nodeType === ELEMENT_NODE) visit(child as FakeElement);
      }
    };
    for (const child of this.childNodes) {
      if (child.nodeType === ELEMENT_NODE) visit(child as FakeElement);
    }
    return matches;
  }

  set innerHTML(value: string) {
    this.htmlOverride = value;
    this.childNodes.length = 0;
  }

  get innerHTML(): string {
    if (this.htmlOverride !== null) return this.htmlOverride;
    return this.childNodes
      .map((child) => {
        if (child.nodeType === TEXT_NODE) return child.textContent;
        return `<${child.localName}>${child.innerHTML}</${child.localName}>`;
      })
      .join("");
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

  it("restores mermaid source from a rendered diagram wrapper", () => {
    const diagram = new FakeElement("DIV", ["chat-markdown-mermaid"], {
      "data-markdown-copy": "```mermaid\nflowchart TD\n  A --> B\n```\n\n",
    }).append(new FakeElement("svg").append(new FakeText("ignored svg text")));
    const container = new FakeElement("DIV").append(diagram);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "```mermaid\nflowchart TD\n  A --> B\n```",
    );
  });

  it("restores mermaid source when the copied range is inside the svg", () => {
    const mermaidCopy = "```mermaid\nflowchart TD\n  A --> B\n```\n\n";
    const svg = new FakeElement("svg").append(new FakeText("Join form"));
    const diagram = new FakeElement("DIV", ["chat-markdown-mermaid"], {
      "data-markdown-copy": mermaidCopy,
    }).append(svg);
    const container = new FakeElement("DIV").append(diagram);

    expect(serializeRenderedMarkdownFragment(asNode(svg))).toBe(
      "```mermaid\nflowchart TD\n  A --> B\n```",
    );
    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "```mermaid\nflowchart TD\n  A --> B\n```",
    );
  });

  it("serializes detached svg clones as label text because they have no mermaid wrapper", () => {
    const detachedSvg = new FakeElement("svg").append(new FakeText("Join form"));

    expect(mermaidMarkdownCopyFromLiveNode(asNode(detachedSvg))).toBeNull();
    expect(serializeRenderedMarkdownFragment(asNode(detachedSvg))).toBe("Join form");
  });

  it("reads mermaid copy from the live ancestor tree", () => {
    const svg = new FakeElement("svg").append(new FakeText("Join form"));
    new FakeElement("DIV", ["chat-markdown-mermaid"], {
      "data-markdown-copy": "```mermaid\nflowchart TD\n  A --> B\n```\n\n",
    }).append(svg);

    expect(mermaidMarkdownCopyFromLiveNode(asNode(svg))).toBe(
      "```mermaid\nflowchart TD\n  A --> B\n```\n\n",
    );
  });

  it("copies mermaid source from the live ancestor even when cloneContents is detached", () => {
    const fence = "```mermaid\nflowchart TD\n  A --> B\n```";
    const liveSvg = new FakeElement("svg").append(new FakeText("Join form"));
    new FakeElement("DIV", ["chat-markdown-mermaid"], {
      "data-markdown-copy": `${fence}\n\n`,
    }).append(liveSvg);
    const detachedClone = new FakeElement("svg").append(new FakeText("Join form"));

    const payload = chatMarkdownClipboardPayload({
      rangeCount: 1,
      getRangeAt: () => ({
        collapsed: false,
        commonAncestorContainer: asNode(liveSvg),
        cloneContents: () => asNode(detachedClone),
      }),
    } as unknown as Selection);

    expect(payload?.text).toBe(fence);
    expect(payload?.html).toBe(
      '<meta charset="utf-8"><pre><code>```mermaid\nflowchart TD\n  A --&gt; B\n```</code></pre>',
    );
  });

  it("escapes mermaid source in the html clipboard flavor", () => {
    const fence = '```mermaid\nflowchart TD\n  A["<script>"]\n```';
    const liveSvg = new FakeElement("svg").append(new FakeText("A"));
    new FakeElement("DIV", ["chat-markdown-mermaid"], {
      "data-markdown-copy": fence,
    }).append(liveSvg);

    const payload = chatMarkdownClipboardPayload({
      rangeCount: 1,
      getRangeAt: () => ({
        collapsed: false,
        commonAncestorContainer: asNode(liveSvg),
        cloneContents: () => asNode(new FakeElement("svg")),
      }),
    } as unknown as Selection);

    expect(payload?.text).toBe(fence);
    expect(payload?.html).toBe(
      '<meta charset="utf-8"><pre><code>```mermaid\nflowchart TD\n  A["&lt;script&gt;"]\n```</code></pre>',
    );
  });

  it("keeps mermaid fences in html when the selection includes surrounding prose", () => {
    const fence = "```mermaid\nflowchart TD\n  A --> B\n```";
    const liveRoot = new FakeElement("DIV", ["chat-markdown"]).append(
      new FakeElement("P").append(new FakeText("hello")),
      new FakeElement("DIV", ["chat-markdown-mermaid"], {
        "data-markdown-copy": `${fence}\n\n`,
      }).append(new FakeElement("svg").append(new FakeText("Join form"))),
    );
    const clone = new FakeElement("DIV").append(
      new FakeElement("P").append(new FakeText("hello")),
      new FakeElement("DIV", ["chat-markdown-mermaid"], {
        "data-markdown-copy": `${fence}\n\n`,
      }).append(new FakeElement("svg").append(new FakeText("Join form"))),
    );
    vi.stubGlobal("document", {
      createElement: () => new FakeElement("DIV"),
    });

    const payload = chatMarkdownClipboardPayload({
      rangeCount: 1,
      getRangeAt: () => ({
        collapsed: false,
        commonAncestorContainer: asNode(liveRoot),
        cloneContents: () => asNode(clone),
      }),
    } as unknown as Selection);

    expect(payload?.text).toBe(`hello\n\n${fence}`);
    expect(payload?.html).toBe(
      '<meta charset="utf-8"><div><p>hello</p><div><pre><code>```mermaid\nflowchart TD\n  A --&gt; B\n```</code></pre></div></div>',
    );
  });
});

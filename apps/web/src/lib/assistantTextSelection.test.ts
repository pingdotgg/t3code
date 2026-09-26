import { describe, expect, it } from "vite-plus/test";
import {
  ASSISTANT_CITATION_CONTEXT_LENGTH,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import {
  formatAssistantCitationHref,
  parseAssistantCitationHref,
} from "@t3tools/shared/assistantCitations";

import {
  type AssistantTextSelector,
  captureAssistantTextSelection,
  createAssistantTextSelector,
  findAssistantCitationText,
} from "./assistantTextSelection";

function selector(
  text: string,
  overrides: Partial<Omit<AssistantTextSelector, "text">> = {},
): AssistantTextSelector {
  return {
    text,
    start: 0,
    end: text.replace(/\s+/g, " ").length,
    prefix: "",
    suffix: "",
    ...overrides,
  };
}

function roundTripSelector(selector: AssistantTextSelector) {
  return parseAssistantCitationHref(
    formatAssistantCitationHref({
      version: 1,
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("assistant"),
      ...selector,
    }),
  );
}

class SelectionNode {
  parentElement: SelectionNode | null = null;
  childNodes: SelectionNode[] = [];

  constructor(
    readonly tagName: string,
    readonly data = "",
    readonly attributes: Record<string, string> = {},
  ) {}

  get nodeType() {
    return this.tagName === "#text" ? 3 : 1;
  }
  get length() {
    return this.data.length;
  }
  get firstChild(): SelectionNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): SelectionNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  get previousSibling(): SelectionNode | null {
    const siblings = this.parentElement?.childNodes;
    return siblings?.[siblings.indexOf(this) - 1] ?? null;
  }
  get nextSibling(): SelectionNode | null {
    const siblings = this.parentElement?.childNodes;
    return siblings?.[siblings.indexOf(this) + 1] ?? null;
  }
  append(...children: SelectionNode[]) {
    for (const child of children) child.parentElement = this;
    this.childNodes.push(...children);
    return this;
  }
  contains(node: SelectionNode): boolean {
    return node === this || this.childNodes.some((child) => child.contains(node));
  }
  matches(selector: string) {
    return selector.split(", ").some((part) => {
      if (!part.startsWith("[")) return part === this.tagName.toLowerCase();
      const [attribute, value] = part.slice(1, -1).split("=");
      return (
        Object.hasOwn(this.attributes, attribute!) &&
        (value === undefined || this.attributes[attribute!] === value)
      );
    });
  }
  closest(selector: string): SelectionNode | null {
    return this.matches(selector) ? this : (this.parentElement?.closest(selector) ?? null);
  }
}

function textNode(text: string) {
  return new SelectionNode("#text", text);
}

function assistantSource(...children: SelectionNode[]) {
  return new SelectionNode("DIV", "", { "data-assistant-citation-source": "assistant" }).append(
    ...children,
  );
}

function nativeSelection(
  start: [SelectionNode, number],
  end: [SelectionNode, number],
  backwards = false,
) {
  let root = start[0];
  while (root.parentElement !== null) root = root.parentElement;
  // Give every DOM boundary its own position, including element boundaries
  // immediately before text offset 0 and after its final character.
  const positions = new Map<SelectionNode, number[]>();
  let position = 0;
  const index = (node: SelectionNode) => {
    const offsets = [position++];
    positions.set(node, offsets);
    if (node.nodeType === 3) {
      for (let offset = 0; offset < node.length; offset++) offsets.push(position++);
    } else {
      for (const child of node.childNodes) {
        index(child);
        offsets.push(position++);
      }
    }
  };
  index(root);
  const at = (node: SelectionNode, offset: number) => positions.get(node)![offset]!;

  class SelectionRange {
    constructor(
      public startContainer: SelectionNode,
      public startOffset: number,
      public endContainer: SelectionNode,
      public endOffset: number,
    ) {}
    get collapsed() {
      return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
    }
    get commonAncestorContainer() {
      let ancestor = this.startContainer;
      while (!ancestor.contains(this.endContainer)) ancestor = ancestor.parentElement!;
      return ancestor;
    }
    cloneRange() {
      return new SelectionRange(
        this.startContainer,
        this.startOffset,
        this.endContainer,
        this.endOffset,
      );
    }
    setStart(node: SelectionNode, offset: number) {
      this.startContainer = node;
      this.startOffset = offset;
    }
    setEnd(node: SelectionNode, offset: number) {
      this.endContainer = node;
      this.endOffset = offset;
    }
    intersectsNode(node: SelectionNode) {
      const parent = node.parentElement;
      if (parent === null) return true;
      const offset = parent.childNodes.indexOf(node);
      return (
        at(parent, offset) < at(this.endContainer, this.endOffset) &&
        at(parent, offset + 1) > at(this.startContainer, this.startOffset)
      );
    }
  }

  const range = new SelectionRange(...start, ...end);
  const anchor = backwards ? end : start;
  const focus = backwards ? start : end;
  return {
    isCollapsed: range.collapsed,
    rangeCount: 1,
    anchorNode: anchor[0],
    anchorOffset: anchor[1],
    focusNode: focus[0],
    focusOffset: focus[1],
    getRangeAt: () => range,
  } as unknown as Selection;
}

function capture(viewport: SelectionNode, selection: Selection) {
  return captureAssistantTextSelection(viewport as unknown as HTMLElement, selection);
}

describe("captureAssistantTextSelection", () => {
  it.each([
    { boundary: "next text", backwards: false },
    { boundary: "next block", backwards: false },
    { boundary: "parent", backwards: false },
    { boundary: "next text", backwards: true },
    { boundary: "next block", backwards: true },
    { boundary: "parent", backwards: true },
  ])(
    "captures a paragraph ending at $boundary, backwards=$backwards",
    ({ boundary, backwards }) => {
      const quote = textNode("A paragraph 😀 cafe\u0301.");
      const source = assistantSource(new SelectionNode("P").append(quote));
      const nextText = textNode("Another response.");
      const nextBlock = assistantSource(new SelectionNode("P").append(nextText));
      const viewport = new SelectionNode("MAIN").append(source, nextBlock);
      const end: [SelectionNode, number] =
        boundary === "next text"
          ? [nextText, 0]
          : boundary === "next block"
            ? [nextBlock, 0]
            : [viewport, 1];
      const selection = nativeSelection([quote, 0], end, backwards);
      const captured = capture(viewport, selection);

      expect(captured?.source).toBe(source);
      expect(captured?.selector).toEqual(selector(quote.data));
      expect(captured?.range.endContainer).toBe(quote);
      expect(captured?.range.endOffset).toBe(quote.length);
      expect(selection.getRangeAt(0).endContainer).toBe(end[0]);
      expect(selection.getRangeAt(0).endOffset).toBe(end[1]);
    },
  );

  it("finds the source when both endpoints are parent boundaries", () => {
    const quote = textNode("Only this response.");
    const source = assistantSource(new SelectionNode("P").append(quote));
    const viewport = new SelectionNode("MAIN").append(source, assistantSource(textNode("Next.")));
    expect(capture(viewport, nativeSelection([viewport, 0], [viewport, 1]))?.selector).toEqual(
      selector(quote.data),
    );
  });

  it("captures the final paragraph when Chromium extends to the timestamp paragraph boundary", () => {
    const quote = textNode("The final paragraph.");
    const source = assistantSource(
      new SelectionNode("P").append(textNode("Earlier answer.")),
      new SelectionNode("P").append(quote),
    );
    const timestampText = textNode("1:50 AM");
    const timestamp = new SelectionNode("P").append(timestampText);
    new SelectionNode("MAIN").append(
      new SelectionNode("DIV").append(source, new SelectionNode("DIV").append(timestamp)),
    );
    const selection = nativeSelection([quote, 0], [timestamp, 0]);
    selection.toString = () => `${quote.data}\n\n\n`;

    expect(capture(source, selection)?.selector).toEqual(
      selector(quote.data, {
        start: "Earlier answer. ".length,
        end: "Earlier answer. The final paragraph.".length,
        prefix: "Earlier answer. ",
      }),
    );
    expect(capture(source, nativeSelection([quote, 0], [timestampText, 1]))).toBeNull();
  });

  it("does not attribute an empty starting endpoint to the previous response", () => {
    const previous = textNode("Previous response.");
    const quote = textNode("Selected response.");
    const source = assistantSource(quote);
    const viewport = new SelectionNode("MAIN").append(assistantSource(previous), source);
    const captured = capture(
      viewport,
      nativeSelection([previous, previous.length], [quote, quote.length]),
    );
    expect(captured?.source).toBe(source);
    expect(captured?.selector).toEqual(selector(quote.data));
  });

  it.each([false, true])(
    "rejects actual overlap with another response, backwards=%s",
    (backwards) => {
      const first = textNode("Repeated quote.");
      const second = textNode(first.data);
      const viewport = new SelectionNode("MAIN").append(
        assistantSource(first),
        assistantSource(second),
      );
      expect(capture(viewport, nativeSelection([first, 0], [second, 1], backwards))).toBeNull();
    },
  );

  it("accepts a control endpoint only when none of its text is selected", () => {
    const quote = textNode("A paragraph.");
    const control = textNode("Copy");
    const source = assistantSource(
      new SelectionNode("P").append(quote),
      new SelectionNode("BUTTON").append(control),
    );
    expect(capture(source, nativeSelection([quote, 0], [control, 0]))?.selector).toEqual(
      selector(quote.data),
    );
    expect(capture(source, nativeSelection([quote, 0], [control, 1]))).toBeNull();
  });

  it.each([
    new SelectionNode("BUTTON"),
    new SelectionNode("SPAN", "", { role: "button" }),
    new SelectionNode("DIV", "", { contenteditable: "true" }),
    new SelectionNode("SPAN", "", { hidden: "" }),
    new SelectionNode("SPAN", "", { "aria-hidden": "true" }),
  ])("rejects selected text at excluded endpoints: %j", (excluded) => {
    const quote = textNode("A paragraph.");
    const control = textNode("Excluded");
    const source = assistantSource(quote, excluded.append(control));
    expect(capture(source, nativeSelection([quote, 0], [control, 1]))).toBeNull();
    expect(capture(source, nativeSelection([control, 0], [control, control.length]))).toBeNull();
  });

  it("keeps exact multiline Unicode text and omits interior controls and hidden text", () => {
    const first = textNode("Before 😀 ");
    const code = textNode("first line\r\n  second line\t🚀");
    const source = assistantSource(
      new SelectionNode("P").append(first, new SelectionNode("EM").append(textNode("cafe\u0301"))),
      new SelectionNode("BUTTON").append(textNode("Copy")),
      new SelectionNode("SPAN", "", { hidden: "" }).append(textNode("Hidden")),
      new SelectionNode("PRE").append(new SelectionNode("CODE").append(code)),
    );
    expect(
      capture(source, nativeSelection([first, 0], [code, code.length], true))?.selector,
    ).toEqual(selector("Before 😀 cafe\u0301\nfirst line\r\n  second line\t🚀"));
  });

  it("rejects a source outside the supplied viewport", () => {
    const quote = textNode("Outside.");
    assistantSource(quote);
    expect(
      capture(new SelectionNode("MAIN"), nativeSelection([quote, 0], [quote, quote.length])),
    ).toBeNull();
  });
});

describe("createAssistantTextSelector", () => {
  it("keeps exact selected whitespace while normalizing its UTF-16 positions", () => {
    const text = "Before \n  quote\t \n after";
    expect(
      createAssistantTextSelector(text, "Before \n".length, "Before \n  quote\t".length),
    ).toEqual({
      text: "  quote\t",
      start: 6,
      end: 13,
      prefix: "Before",
      suffix: "after",
    });
  });

  it.each([
    0,
    ASSISTANT_CITATION_CONTEXT_LENGTH - 2,
    ASSISTANT_CITATION_CONTEXT_LENGTH - 1,
    ASSISTANT_CITATION_CONTEXT_LENGTH,
  ])("keeps complete context code points with %i neighboring UTF-16 units", (paddingLength) => {
    const padding = "x".repeat(paddingLength);
    const text = `😀${padding}quote${padding}🚀`;
    const start = text.indexOf("quote");
    const captured = createAssistantTextSelector(text, start, start + 5);
    const keepEmoji = paddingLength + 2 <= ASSISTANT_CITATION_CONTEXT_LENGTH;
    expect(captured).toEqual({
      text: "quote",
      start,
      end: start + 5,
      prefix: `${keepEmoji ? "😀" : ""}${padding}`,
      suffix: `${padding}${keepEmoji ? "🚀" : ""}`,
    });
    expect(roundTripSelector(captured!)).toMatchObject(captured!);
  });

  it("preserves multiline quotes and their matching location through a citation URL", () => {
    const quote = "selected\r\n  code 🚀";
    const prefix = "x".repeat(ASSISTANT_CITATION_CONTEXT_LENGTH - 1);
    const suffix = "y".repeat(ASSISTANT_CITATION_CONTEXT_LENGTH - 1);
    const text = `${quote} elsewhere\n😀${prefix}${quote}${suffix}🚀`;
    const rawStart = text.lastIndexOf(quote);
    const captured = createAssistantTextSelector(text, rawStart, rawStart + quote.length);
    const start = "selected code 🚀 elsewhere 😀".length + prefix.length;
    const end = start + "selected code 🚀".length;
    expect(captured).toEqual({ text: quote, start, end, prefix, suffix });

    const parsed = roundTripSelector(captured!);
    expect(parsed).toMatchObject(captured!);
    expect(findAssistantCitationText(text, parsed!)).toEqual({ start, end });
    expect(findAssistantCitationText(`Inserted paragraph.\n${text}`, parsed!)).toEqual({
      start: "Inserted paragraph. ".length + start,
      end: "Inserted paragraph. ".length + end,
    });
  });

  it.each(["prefix", "suffix"])(
    "does not relocate to a replacement-character decoy after clipping the %s",
    (side) => {
      const prefix = "x".repeat(ASSISTANT_CITATION_CONTEXT_LENGTH - (side === "prefix" ? 1 : 0));
      const suffix = "y".repeat(ASSISTANT_CITATION_CONTEXT_LENGTH - (side === "suffix" ? 1 : 0));
      const occurrence = (character: string) =>
        `${side === "prefix" ? character : ""}${prefix}quote${suffix}${side === "suffix" ? character : ""}`;
      const text = `${occurrence("😀")} / ${occurrence("\uFFFD")}`;
      const start = text.indexOf("quote");
      const captured = createAssistantTextSelector(text, start, start + 5);
      const parsed = roundTripSelector(captured!);
      expect(parsed).toMatchObject(captured!);
      expect(findAssistantCitationText(text, captured!)).toBeNull();
      expect(findAssistantCitationText(text, parsed!)).toBeNull();
    },
  );

  it.each(["", " \n\t\r\n"])("rejects empty or whitespace-only selections: %j", (text) => {
    expect(createAssistantTextSelector(text, 0, text.length)).toBeNull();
  });
});

describe("findAssistantCitationText", () => {
  it("resolves an exact selection with its saved position and context", () => {
    expect(
      findAssistantCitationText(
        "Before the selected text after.",
        selector("selected text", { start: 11, end: 24, prefix: "Before the ", suffix: " after." }),
      ),
    ).toEqual({ start: 11, end: 24 });
  });

  it("finds a unique quote when insertion before it shifts its offsets", () => {
    expect(
      findAssistantCitationText(
        "An inserted paragraph. Before the selected text after.",
        selector("selected text", { start: 11, end: 24, prefix: "Before the ", suffix: " after." }),
      ),
    ).toEqual({ start: 34, end: 47 });
  });

  it("still finds a unique quote after its surrounding text changes", () => {
    expect(
      findAssistantCitationText(
        "New selected text nearby.",
        selector("selected text", { start: 11, end: 24, prefix: "Before the ", suffix: " after." }),
      ),
    ).toEqual({ start: 4, end: 17 });
  });

  it("uses both context sides when each side alone matches several repeated quotes", () => {
    const text = "left quote one; other quote two; left quote two";
    expect(
      findAssistantCitationText(
        text,
        selector("quote", { start: 5, end: 10, prefix: "left ", suffix: " two" }),
      ),
    ).toEqual({ start: 38, end: 43 });
  });

  it("does not trust stale offsets that now point at another occurrence", () => {
    expect(
      findAssistantCitationText(
        "wrong quote here; right quote there",
        selector("quote", { start: 6, end: 11, prefix: "right ", suffix: " there" }),
      ),
    ).toEqual({ start: 24, end: 29 });
  });

  it.each([
    { prefix: "first ", suffix: "", expected: { start: 6, end: 11 } },
    { prefix: "", suffix: " last", expected: { start: 14, end: 19 } },
  ])(
    "allows a single context side to disambiguate: $prefix / $suffix",
    ({ expected, ...context }) => {
      expect(
        findAssistantCitationText("first quote / quote last", selector("quote", context)),
      ).toEqual(expected);
    },
  );

  it("does not guess between quotes without context, even at the saved position", () => {
    expect(findAssistantCitationText("quote / quote", selector("quote"))).toBeNull();
  });

  it("does not use distance or saved offsets to break a context tie", () => {
    expect(
      findAssistantCitationText(
        "same quote end / same quote end",
        selector("quote", { start: 5, end: 10, prefix: "same ", suffix: " end" }),
      ),
    ).toBeNull();
  });

  it("rejects repeated quotes when neither occurrence matches all supplied context", () => {
    expect(
      findAssistantCitationText(
        "left quote wrong / wrong quote right",
        selector("quote", { prefix: "left ", suffix: " right" }),
      ),
    ).toBeNull();
  });

  it("counts overlapping occurrences when checking ambiguity", () => {
    expect(findAssistantCitationText("banana", selector("ana", { start: 1, end: 4 }))).toBeNull();
  });

  it("matches multiline code after indentation, tabs, and line endings change", () => {
    const quote = "if (ready) {\r\n    run();\r\n}";
    expect(
      findAssistantCitationText(
        "Example:\nif (ready) {\n\trun();\n}\nDone.",
        selector(quote, { prefix: "Example:\n", suffix: "\nDone." }),
      ),
    ).toEqual({ start: 9, end: 30 });
  });

  it("normalizes nonbreaking spaces and keeps selected boundary whitespace", () => {
    expect(
      findAssistantCitationText(
        "before\u00a0\n quoted\t text \nafter",
        selector("\nquoted  text\t"),
      ),
    ).toEqual({ start: 6, end: 19 });
  });

  it("does not trim the document's leading whitespace out of its offsets", () => {
    expect(findAssistantCitationText("\n\t  quote", selector("quote"))).toEqual({
      start: 1,
      end: 6,
    });
  });

  it("uses UTF-16 offsets for emoji and combining characters", () => {
    expect(findAssistantCitationText("😀 cafe\u0301 🚀 done", selector("cafe\u0301 🚀"))).toEqual({
      start: 3,
      end: 11,
    });
  });

  it("uses up to 32 UTF-16 context units without requiring the entire surrounding text", () => {
    const prefix = "x".repeat(ASSISTANT_CITATION_CONTEXT_LENGTH - 1) + " ";
    const suffix = " " + "y".repeat(ASSISTANT_CITATION_CONTEXT_LENGTH - 1);
    const text = `unrelated quote / ${prefix}quote${suffix} changed further away`;
    const start = text.lastIndexOf("quote");
    expect(findAssistantCitationText(text, selector("quote", { prefix, suffix }))).toEqual({
      start,
      end: start + 5,
    });
  });

  it.each(["", " \n\t\r\n", "absent", "QUOTE", "qu.te"])(
    "rejects empty or missing literal text: %j",
    (quote) => {
      expect(findAssistantCitationText("quote", selector(quote))).toBeNull();
    },
  );

  it.each([
    { start: -1, end: 4 },
    { start: 2.5, end: 7.5 },
    { start: Number.NaN, end: Number.NaN },
    { start: Number.POSITIVE_INFINITY, end: Number.POSITIVE_INFINITY },
    { start: 8, end: 3 },
  ])("treats invalid stored offsets as unusable hints: $start / $end", (offsets) => {
    expect(findAssistantCitationText("a quote", selector("quote", offsets))).toEqual({
      start: 2,
      end: 7,
    });
  });
});

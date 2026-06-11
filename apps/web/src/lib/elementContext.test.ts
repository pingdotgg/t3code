import type { PickedElementPayload } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendElementContextsToPrompt,
  buildElementContextBlock,
  type ElementContextSelection,
  elementContextDedupKey,
  extractTrailingElementContexts,
  formatElementContextLabel,
  formatElementContextSourceLabel,
  newElementContextId,
  normalizeElementContextSelection,
} from "./elementContext";

function makePayload(overrides?: Partial<PickedElementPayload>): PickedElementPayload {
  return {
    pageUrl: "https://example.com/dashboard",
    pageTitle: "Dashboard",
    tagName: "BUTTON",
    selector: "button.submit",
    htmlPreview: '<button class="submit">Save</button>',
    componentName: "SubmitButton",
    source: {
      functionName: "SubmitButton",
      fileName: "/repo/src/Button.tsx",
      lineNumber: 12,
      columnNumber: 5,
    },
    stack: [
      {
        functionName: "SubmitButton",
        fileName: "/repo/src/Button.tsx",
        lineNumber: 12,
        columnNumber: 5,
      },
    ],
    styles: ".submit { color: white; }",
    pickedAt: "2026-05-03T18:00:00.000Z",
    ...overrides,
  };
}

function makeSelection(overrides?: Partial<ElementContextSelection>): ElementContextSelection {
  return {
    pageUrl: "https://example.com/dashboard",
    pageTitle: "Dashboard",
    tagName: "button",
    selector: "button.submit",
    htmlPreview: '<button class="submit">Save</button>',
    componentName: "SubmitButton",
    source: {
      functionName: "SubmitButton",
      fileName: "/repo/src/Button.tsx",
      lineNumber: 12,
      columnNumber: 5,
    },
    styles: ".submit { color: white; }",
    ...overrides,
  };
}

describe("normalizeElementContextSelection", () => {
  it("lowercases the tag, trims strings, and prefers `source` over `stack[0]`", () => {
    const result = normalizeElementContextSelection(
      makePayload({
        tagName: "  Button  ",
        pageUrl: "  https://example.com  ",
        pageTitle: "  Dashboard  ",
        selector: "   ",
        componentName: "   ",
        source: {
          functionName: " Outer ",
          fileName: " /repo/Outer.tsx ",
          lineNumber: 7,
          columnNumber: 0,
        },
        stack: [
          {
            functionName: "Inner",
            fileName: "/repo/Inner.tsx",
            lineNumber: 99,
            columnNumber: 9,
          },
        ],
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.tagName).toBe("button");
    expect(result?.pageUrl).toBe("https://example.com");
    expect(result?.pageTitle).toBe("Dashboard");
    expect(result?.selector).toBeNull();
    expect(result?.componentName).toBeNull();
    expect(result?.source).toEqual({
      functionName: "Outer",
      fileName: "/repo/Outer.tsx",
      lineNumber: 7,
      columnNumber: 0,
    });
  });

  it("returns null when pageUrl or tagName is empty", () => {
    expect(normalizeElementContextSelection(makePayload({ pageUrl: "" }))).toBeNull();
    expect(normalizeElementContextSelection(makePayload({ tagName: "   " }))).toBeNull();
  });

  it("clamps oversized htmlPreview / styles so we don't blow localStorage", () => {
    const huge = "x".repeat(10_000);
    const result = normalizeElementContextSelection(
      makePayload({ htmlPreview: huge, styles: huge }),
    );
    expect(result).not.toBeNull();
    expect(result!.htmlPreview.length).toBeLessThanOrEqual(4000);
    expect(result!.styles.length).toBeLessThanOrEqual(4000);
    // Truncated values should end with the ellipsis sentinel
    expect(result!.htmlPreview.endsWith("…")).toBe(true);
    expect(result!.styles.endsWith("…")).toBe(true);
  });

  it("normalizes Windows line endings inside html/styles", () => {
    const result = normalizeElementContextSelection(
      makePayload({ htmlPreview: "<a>\r\nhi\r\n</a>", styles: ".a {\r\n  color: red;\r\n}" }),
    );
    expect(result?.htmlPreview).toBe("<a>\nhi\n</a>");
    expect(result?.styles).toBe(".a {\n  color: red;\n}");
  });

  it("falls back to stack[0] when payload.source is null", () => {
    const result = normalizeElementContextSelection(
      makePayload({
        source: null,
        stack: [
          {
            functionName: "FromStack",
            fileName: "/repo/FromStack.tsx",
            lineNumber: 3,
            columnNumber: null,
          },
        ],
      }),
    );
    expect(result?.source).toEqual({
      functionName: "FromStack",
      fileName: "/repo/FromStack.tsx",
      lineNumber: 3,
      columnNumber: null,
    });
  });
});

describe("formatElementContextLabel", () => {
  it("prefers component name over tag name", () => {
    expect(formatElementContextLabel(makeSelection())).toBe("<SubmitButton>");
  });

  it("falls back to tag name when no component name is present", () => {
    expect(formatElementContextLabel(makeSelection({ componentName: null }))).toBe("<button>");
  });

  it("truncates very long tag names", () => {
    const tagName = "custom-".concat("x".repeat(60));
    const result = formatElementContextLabel(makeSelection({ componentName: null, tagName }));
    expect(result.length).toBeLessThan(tagName.length);
    expect(result.endsWith("…>")).toBe(true);
  });
});

describe("formatElementContextSourceLabel", () => {
  it("renders basename + line number", () => {
    expect(formatElementContextSourceLabel(makeSelection())).toBe("Button.tsx:12");
  });

  it("returns null when source has no fileName", () => {
    expect(formatElementContextSourceLabel(makeSelection({ source: null }))).toBeNull();
  });

  it("omits line number when missing", () => {
    expect(
      formatElementContextSourceLabel(
        makeSelection({
          source: {
            functionName: null,
            fileName: "/a/b/Foo.tsx",
            lineNumber: null,
            columnNumber: null,
          },
        }),
      ),
    ).toBe("Foo.tsx");
  });
});

describe("elementContextDedupKey", () => {
  it("treats picks of the same element on the same page as duplicates", () => {
    const first = makeSelection();
    const second = makeSelection({ htmlPreview: "different preview", styles: "different styles" });
    expect(elementContextDedupKey(first)).toBe(elementContextDedupKey(second));
  });

  it("differentiates picks with different selectors", () => {
    expect(elementContextDedupKey(makeSelection())).not.toBe(
      elementContextDedupKey(makeSelection({ selector: "button.cancel" })),
    );
  });

  it("differentiates picks with different page urls", () => {
    expect(elementContextDedupKey(makeSelection())).not.toBe(
      elementContextDedupKey(makeSelection({ pageUrl: "https://example.com/other" })),
    );
  });
});

describe("buildElementContextBlock + appendElementContextsToPrompt", () => {
  it("returns empty string for empty contexts", () => {
    expect(buildElementContextBlock([])).toBe("");
    expect(appendElementContextsToPrompt("Hello", [])).toBe("Hello");
  });

  it("serializes a context with header / url / selector / source / html / styles", () => {
    const block = buildElementContextBlock([makeSelection()]);
    expect(block.startsWith("<element_context>")).toBe(true);
    expect(block.endsWith("</element_context>")).toBe(true);
    expect(block).toContain("- <SubmitButton> (Button.tsx:12):");
    expect(block).toContain("  url: https://example.com/dashboard");
    expect(block).toContain("  selector: button.submit");
    expect(block).toContain("  source: /repo/src/Button.tsx:12:5");
    expect(block).toContain("  html:");
    expect(block).toContain("  styles:");
  });

  it("appends with a blank line separator when prompt has text", () => {
    expect(appendElementContextsToPrompt("Investigate this", [makeSelection()])).toBe(
      [
        "Investigate this",
        "",
        "<element_context>",
        "- <SubmitButton> (Button.tsx:12):",
        "  url: https://example.com/dashboard",
        "  selector: button.submit",
        "  source: /repo/src/Button.tsx:12:5",
        "  html:",
        '  <button class="submit">Save</button>',
        "  styles:",
        "  .submit { color: white; }",
        "</element_context>",
      ].join("\n"),
    );
  });

  it("emits no leading blank when prompt is empty", () => {
    expect(
      appendElementContextsToPrompt("", [makeSelection()]).startsWith("<element_context>"),
    ).toBe(true);
  });
});

describe("extractTrailingElementContexts", () => {
  it("round-trips appendElementContextsToPrompt and recovers prompt + entries", () => {
    const prompt = appendElementContextsToPrompt("Investigate this", [
      makeSelection(),
      makeSelection({ selector: "button.cancel", componentName: "CancelButton" }),
    ]);
    const result = extractTrailingElementContexts(prompt);
    expect(result.promptText).toBe("Investigate this");
    expect(result.contextCount).toBe(2);
    expect(result.contexts.map((c) => c.header)).toEqual([
      "<SubmitButton> (Button.tsx:12)",
      "<CancelButton> (Button.tsx:12)",
    ]);
    expect(result.contexts[0]?.body).toContain("url: https://example.com/dashboard");
    expect(result.contexts[0]?.body).toContain("selector: button.submit");
  });

  it("returns the original prompt unchanged when no trailing block exists", () => {
    expect(extractTrailingElementContexts("hi")).toEqual({
      promptText: "hi",
      contextCount: 0,
      contexts: [],
    });
  });
});

describe("newElementContextId", () => {
  it("returns a non-empty string with the element prefix", () => {
    const id = newElementContextId();
    expect(id.startsWith("el_")).toBe(true);
    expect(id.length).toBeGreaterThan(3);
  });

  it("returns unique ids on repeated calls", () => {
    const ids = new Set(Array.from({ length: 10 }, () => newElementContextId()));
    expect(ids.size).toBe(10);
  });
});

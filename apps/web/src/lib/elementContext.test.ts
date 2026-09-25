import type { PickedElementPayload } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { normalizeElementContextSelection } from "./elementContext";

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

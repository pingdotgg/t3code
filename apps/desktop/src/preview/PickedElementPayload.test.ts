import { describe, expect, it } from "vite-plus/test";

import { isPickedElementPayload, isPreviewAnnotationPayload } from "./PickedElementPayload.ts";

function validPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    pageUrl: "https://example.com/",
    pageTitle: "Example",
    tagName: "button",
    selector: "button.submit",
    htmlPreview: "<button>Save</button>",
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

describe("isPickedElementPayload", () => {
  it("rejects non-finite numeric line/column numbers", () => {
    expect(
      isPickedElementPayload(
        validPayload({
          source: {
            functionName: null,
            fileName: null,
            lineNumber: Number.POSITIVE_INFINITY,
            columnNumber: null,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isPickedElementPayload(
        validPayload({
          source: {
            functionName: null,
            fileName: null,
            lineNumber: Number.NaN,
            columnNumber: null,
          },
        }),
      ),
    ).toBe(false);
  });
});

function validAnnotation(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "annotation_1",
    pageUrl: "https://example.com/",
    pageTitle: "Example",
    comment: "Make this clearer",
    elements: [
      {
        id: "element_1",
        element: validPayload(),
        rect: { x: 10, y: 20, width: 100, height: 40 },
      },
    ],
    regions: [{ id: "region_1", rect: { x: 5, y: 6, width: 20, height: 30 } }],
    strokes: [
      {
        id: "stroke_1",
        color: "#7c3aed",
        width: 4,
        points: [
          { x: 10, y: 10 },
          { x: 20, y: 20 },
        ],
        bounds: { x: 6, y: 6, width: 18, height: 18 },
      },
    ],
    styleChanges: [
      {
        targetId: "element_1",
        selector: "button.submit",
        property: "opacity",
        previousValue: "1",
        value: "0.5",
      },
    ],
    screenshot: null,
    createdAt: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("isPreviewAnnotationPayload", () => {
  it("rejects screenshots supplied by the guest preload", () => {
    expect(isPreviewAnnotationPayload(validAnnotation({ screenshot: { dataUrl: "bad" } }))).toBe(
      false,
    );
  });
});

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
  it("accepts a complete, well-typed payload", () => {
    expect(isPickedElementPayload(validPayload())).toBe(true);
  });

  it("accepts nullable string fields when null", () => {
    expect(
      isPickedElementPayload(
        validPayload({ pageTitle: null, selector: null, componentName: null, source: null }),
      ),
    ).toBe(true);
  });

  it("accepts an empty stack array", () => {
    expect(isPickedElementPayload(validPayload({ stack: [] }))).toBe(true);
  });

  it("accepts stack frames with null fields", () => {
    expect(
      isPickedElementPayload(
        validPayload({
          stack: [
            {
              functionName: null,
              fileName: null,
              lineNumber: null,
              columnNumber: null,
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("rejects null and primitive inputs", () => {
    expect(isPickedElementPayload(null)).toBe(false);
    expect(isPickedElementPayload(undefined)).toBe(false);
    expect(isPickedElementPayload("string")).toBe(false);
    expect(isPickedElementPayload(42)).toBe(false);
    expect(isPickedElementPayload([])).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ["missing pageUrl", validPayload({ pageUrl: undefined })],
    ["wrong-type pageUrl", validPayload({ pageUrl: 123 })],
    ["missing tagName", validPayload({ tagName: undefined })],
    ["missing htmlPreview", validPayload({ htmlPreview: undefined })],
    ["missing styles", validPayload({ styles: undefined })],
    ["missing pickedAt", validPayload({ pickedAt: undefined })],
    ["wrong-type pageTitle", validPayload({ pageTitle: 99 })],
    ["wrong-type selector", validPayload({ selector: 99 })],
    ["wrong-type componentName", validPayload({ componentName: 99 })],
  ])("rejects payloads with %s", (_label, value) => {
    expect(isPickedElementPayload(value)).toBe(false);
  });

  it("rejects malformed source frames", () => {
    expect(
      isPickedElementPayload(
        validPayload({
          source: {
            functionName: 0,
            fileName: null,
            lineNumber: null,
            columnNumber: null,
          },
        }),
      ),
    ).toBe(false);
  });

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

  it("rejects malformed stack arrays", () => {
    expect(isPickedElementPayload(validPayload({ stack: "not-an-array" }))).toBe(false);
    expect(isPickedElementPayload(validPayload({ stack: [{ bogus: true }] }))).toBe(false);
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
  it("accepts a structured annotation draft before screenshot capture", () => {
    expect(isPreviewAnnotationPayload(validAnnotation())).toBe(true);
  });

  it("accepts valid portable source, callout, and editable-vector extensions", () => {
    expect(
      isPreviewAnnotationPayload(
        validAnnotation({
          schemaVersion: 1,
          source: {
            kind: "preview",
            url: "https://example.com/",
            title: "Example",
          },
          callouts: [
            {
              id: "callout_point",
              number: 1,
              comment: "Move this.",
              anchor: { kind: "point", point: { x: 0.2, y: 0.3 } },
            },
            {
              id: "callout_region",
              number: 2,
              comment: "Reduce this space.",
              anchor: {
                kind: "region",
                rect: { x: 0.4, y: 0.1, width: 0.3, height: 0.2 },
              },
            },
            {
              id: "callout_element",
              number: 3,
              comment: "Use the primary style.",
              anchor: {
                kind: "element",
                targetId: "element_1",
                rect: { x: 0.1, y: 0.7, width: 0.4, height: 0.2 },
              },
            },
          ],
          editable: {
            version: 1,
            coordinateSpace: "normalized",
            strokes: [
              {
                id: "stroke_editable",
                color: "#7c3aed",
                width: 0.01,
                points: [
                  { x: 0.1, y: 0.2 },
                  { x: 0.2, y: 0.3 },
                ],
                bounds: { x: 0.08, y: 0.18, width: 0.14, height: 0.14 },
              },
            ],
          },
        }),
      ),
    ).toBe(true);
    expect(
      isPreviewAnnotationPayload(
        validAnnotation({ source: { kind: "image", name: "checkout.png" }, editable: null }),
      ),
    ).toBe(true);
  });

  it("rejects screenshots supplied by the guest preload", () => {
    expect(isPreviewAnnotationPayload(validAnnotation({ screenshot: { dataUrl: "bad" } }))).toBe(
      false,
    );
  });

  it("rejects malformed geometry and nested element payloads", () => {
    expect(
      isPreviewAnnotationPayload(
        validAnnotation({ regions: [{ id: "region_1", rect: { x: 0, y: 0, width: "wide" } }] }),
      ),
    ).toBe(false);
    expect(
      isPreviewAnnotationPayload(
        validAnnotation({ elements: [{ id: "element_1", element: {}, rect: {} }] }),
      ),
    ).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ["an unknown schema version", validAnnotation({ schemaVersion: 2 })],
    ["a malformed image source", validAnnotation({ source: { kind: "image", name: 42 } })],
    [
      "a malformed preview source",
      validAnnotation({ source: { kind: "preview", url: null, title: "Example" } }),
    ],
    ["a non-array callout collection", validAnnotation({ callouts: "not-an-array" })],
    [
      "an out-of-bounds callout point",
      validAnnotation({
        callouts: [
          {
            id: "callout_1",
            number: 1,
            comment: "",
            anchor: { kind: "point", point: { x: 1.1, y: 0.5 } },
          },
        ],
      }),
    ],
    [
      "an overflowing callout region",
      validAnnotation({
        callouts: [
          {
            id: "callout_1",
            number: 1,
            comment: "",
            anchor: {
              kind: "region",
              rect: { x: 0.8, y: 0.2, width: 0.3, height: 0.2 },
            },
          },
        ],
      }),
    ],
    [
      "a non-positive callout number",
      validAnnotation({
        callouts: [
          {
            id: "callout_1",
            number: 0,
            comment: "",
            anchor: { kind: "point", point: { x: 0.5, y: 0.5 } },
          },
        ],
      }),
    ],
    [
      "a malformed editable vector document",
      validAnnotation({
        editable: {
          version: 2,
          coordinateSpace: "pixels",
          strokes: [],
        },
      }),
    ],
    [
      "an out-of-bounds editable stroke",
      validAnnotation({
        editable: {
          version: 1,
          coordinateSpace: "normalized",
          strokes: [
            {
              id: "stroke_1",
              color: "#7c3aed",
              width: 0.01,
              points: [{ x: Number.NaN, y: 0.5 }],
              bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
            },
          ],
        },
      }),
    ],
  ])("rejects %s", (_label, value) => {
    expect(isPreviewAnnotationPayload(value)).toBe(false);
  });
});

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { PreviewAnnotationPayloadSchema } from "./previewAnnotation.ts";

const decode = Schema.decodeUnknownSync(PreviewAnnotationPayloadSchema);

const legacyAnnotation = {
  id: "annotation_1",
  pageUrl: "http://localhost:3000",
  pageTitle: "Example",
  comment: "Tighten this area.",
  elements: [],
  regions: [{ id: "region_1", rect: { x: 10, y: 20, width: 100, height: 80 } }],
  strokes: [],
  styleChanges: [],
  screenshot: null,
  createdAt: "2026-06-11T00:00:00.000Z",
} as const;

const pickedElement = {
  pageUrl: "http://localhost:3000",
  pageTitle: "Example",
  tagName: "button",
  selector: "button.submit",
  htmlPreview: '<button class="submit">Save</button>',
  componentName: "SubmitButton",
  source: {
    functionName: "SubmitButton",
    fileName: "/repo/src/SubmitButton.tsx",
    lineNumber: 12,
    columnNumber: 5,
  },
  stack: [],
  styles: ".submit { color: white; }",
  pickedAt: "2026-06-11T00:00:00.000Z",
} as const;

describe("PreviewAnnotationPayloadSchema", () => {
  it("continues to decode the legacy desktop payload unchanged", () => {
    expect(decode(legacyAnnotation)).toEqual(legacyAnnotation);
  });

  it("decodes portable source, snapshot, callout, and editable-vector metadata", () => {
    const annotation = {
      ...legacyAnnotation,
      schemaVersion: 1,
      source: {
        kind: "preview",
        url: "http://localhost:3000",
        title: "Example",
      },
      elements: [
        {
          id: "element_1",
          element: pickedElement,
          rect: { x: 40, y: 20, width: 120, height: 48 },
        },
      ],
      callouts: [
        {
          id: "callout_1",
          number: 1,
          comment: "Move this action.",
          anchor: { kind: "point", point: { x: 0.2, y: 0.3 } },
        },
        {
          id: "callout_2",
          number: 2,
          comment: "Reduce this gap.",
          anchor: {
            kind: "region",
            rect: { x: 0.4, y: 0.1, width: 0.3, height: 0.2 },
          },
        },
        {
          id: "callout_3",
          number: 3,
          comment: "Use the primary action style.",
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
            id: "stroke_1",
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
      screenshot: {
        dataUrl: "data:image/png;base64,AA==",
        width: 800,
        height: 600,
        cropRect: { x: 20, y: 30, width: 400, height: 300 },
        scale: 2,
        pageRevision: "revision_4",
      },
    } as const;

    expect(decode(annotation)).toEqual(annotation);
  });

  it("accepts an arbitrary image source", () => {
    expect(
      decode({
        ...legacyAnnotation,
        schemaVersion: 1,
        source: { kind: "image", name: "checkout.png" },
      }).source,
    ).toEqual({ kind: "image", name: "checkout.png" });
  });

  it("rejects non-finite and out-of-bounds normalized anchors", () => {
    expect(() =>
      decode({
        ...legacyAnnotation,
        callouts: [
          {
            id: "callout_nan",
            number: 1,
            comment: "",
            anchor: { kind: "point", point: { x: Number.NaN, y: 0.5 } },
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      decode({
        ...legacyAnnotation,
        callouts: [
          {
            id: "callout_overflow",
            number: 1,
            comment: "",
            anchor: {
              kind: "region",
              rect: { x: 0.8, y: 0.2, width: 0.3, height: 0.2 },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects zero-sized regions and non-positive callout numbers", () => {
    expect(() =>
      decode({
        ...legacyAnnotation,
        callouts: [
          {
            id: "callout_zero",
            number: 0,
            comment: "",
            anchor: {
              kind: "region",
              rect: { x: 0.2, y: 0.2, width: 0, height: 0.2 },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects non-normalized editable strokes and invalid screenshot scale", () => {
    expect(() =>
      decode({
        ...legacyAnnotation,
        editable: {
          version: 1,
          coordinateSpace: "normalized",
          strokes: [
            {
              id: "stroke_overflow",
              color: "#000000",
              width: 0.01,
              points: [{ x: 1.1, y: 0.5 }],
              bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
            },
          ],
        },
      }),
    ).toThrow();

    expect(() =>
      decode({
        ...legacyAnnotation,
        screenshot: {
          dataUrl: "data:image/png;base64,AA==",
          width: 100,
          height: 100,
          cropRect: { x: 0, y: 0, width: 100, height: 100 },
          scale: 0,
        },
      }),
    ).toThrow();
  });
});

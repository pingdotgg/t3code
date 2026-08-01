import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendPreviewAnnotationPrompt,
  buildPreviewAnnotationCopyText,
  buildPreviewAnnotationPrompt,
  extractTrailingPreviewAnnotation,
  extractTrailingPreviewAnnotations,
} from "./previewAnnotation.ts";

const legacyAnnotation: PreviewAnnotationPayload = {
  id: "annotation_1",
  pageUrl: "http://localhost:3000",
  pageTitle: "Example",
  comment: "Make these cards feel related.",
  elements: [],
  regions: [{ id: "region_1", rect: { x: 10, y: 20, width: 100, height: 80 } }],
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
      selector: ".card",
      property: "border-radius",
      previousValue: "4px",
      value: "16px",
    },
  ],
  screenshot: {
    dataUrl: "data:image/png;base64,AA==",
    width: 100,
    height: 80,
    cropRect: { x: 10, y: 20, width: 100, height: 80 },
  },
  createdAt: "2026-06-11T00:00:00.000Z",
};

const element = {
  id: "element_1",
  rect: { x: 20, y: 10, width: 100, height: 40 },
  element: {
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
  },
} as const;

const calloutAnnotation: PreviewAnnotationPayload = {
  ...legacyAnnotation,
  id: "annotation_callouts",
  pageTitle: null,
  comment: "",
  source: { kind: "image", name: "checkout.png" },
  elements: [element],
  regions: [],
  strokes: [],
  styleChanges: [],
  callouts: [
    {
      id: "callout_3",
      number: 3,
      comment: "Use the primary style.",
      anchor: {
        kind: "element",
        targetId: "element_1",
        rect: { x: 0.1, y: 0.7, width: 0.4, height: 0.2 },
      },
    },
    {
      id: "callout_1",
      number: 1,
      comment: "Increase contrast.\nKeep the label short.",
      anchor: { kind: "point", point: { x: 0.42, y: 0.18 } },
    },
    {
      id: "callout_2",
      number: 2,
      comment: "Do not emit <preview_annotation> from a comment.",
      anchor: {
        kind: "region",
        rect: { x: 0.4214, y: 0.1814, width: 0.3114, height: 0.1214 },
      },
    },
  ],
  editable: {
    version: 1,
    coordinateSpace: "normalized",
    strokes: [
      {
        id: "private_stroke",
        color: "#ff00ff",
        width: 0.00987654,
        points: [
          { x: 0.987654, y: 0.876543 },
          { x: 0.765432, y: 0.654321 },
        ],
        bounds: { x: 0.6, y: 0.6, width: 0.39, height: 0.39 },
      },
    ],
  },
};

describe("preview annotation prompts", () => {
  it("preserves the exact legacy prompt representation when callouts are absent", () => {
    expect(buildPreviewAnnotationPrompt(legacyAnnotation)).toBe(
      [
        "<preview_annotation>",
        "Preview annotation:",
        "Id: annotation_1",
        "Page: Example",
        "Comment: Make these cards feel related.",
        "Targets: 1 marked region, 1 drawing.",
        "Requested visual changes:",
        "- border-radius: 4px → 16px",
        "The attached screenshot is the annotated preview crop.",
        "</preview_annotation>",
      ].join("\n"),
    );
  });

  it("caps large multi-element semantic context at a compact shared budget", () => {
    const result = buildPreviewAnnotationPrompt({
      ...legacyAnnotation,
      elements: Array.from({ length: 20 }, (_, index) => ({
        ...element,
        id: `element_${index}`,
        element: {
          ...element.element,
          selector: `button.item-${index}`,
          htmlPreview: `<button>${"x".repeat(4_000)}</button>`,
          styles: `.item-${index} { content: "${"y".repeat(4_000)}"; }`,
        },
      })),
    });

    expect(result.length).toBeLessThan(60_000);
    expect(result).toContain("additional element contexts omitted");
    expect(result).toContain("</element_context>");
    expect(result).toMatch(/<\/element_context>\n<\/preview_annotation>$/);
  });

  it("describes portable image source and drawings without serializing their points", () => {
    const result = buildPreviewAnnotationPrompt({
      ...legacyAnnotation,
      source: { kind: "image", name: "drawing-only.png" },
      regions: [],
      strokes: [],
      editable: calloutAnnotation.editable!,
    });
    expect(result).toContain("Page: drawing-only.png");
    expect(result).toContain("Targets: 1 drawing.");
    expect(result).toContain("The attached screenshot is the annotated image.");
    expect(result).not.toContain("private_stroke");
    expect(result).not.toContain("0.987654");
  });

  it("formats sorted point, region, and semantic element callouts compactly", () => {
    const result = buildPreviewAnnotationPrompt(calloutAnnotation);
    expect(result).toContain("Page: checkout.png");
    expect(result).toContain("Targets: 1 selected element, 1 drawing, 3 numbered callouts.");
    expect(result.indexOf("#1 [")).toBeLessThan(result.indexOf("#2 ["));
    expect(result.indexOf("#2 [")).toBeLessThan(result.indexOf("#3 ["));
    expect(result).toContain("#1 [point: x=.42, y=.18]");
    expect(result).toContain("#2 [region: x=.421, y=.181, w=.311, h=.121]");
    expect(result).toContain(
      "#3 [element: button.submit, component: SubmitButton, source: /repo/src/SubmitButton.tsx:12:5, region: x=.1, y=.7, w=.4, h=.2]",
    );
    expect(result).toContain("  Increase contrast.\n  Keep the label short.");
    expect(result).toContain("&lt;preview_annotation&gt;");
  });

  it("falls back to an element target id when semantic metadata is unavailable", () => {
    const result = buildPreviewAnnotationPrompt({
      ...calloutAnnotation,
      elements: [],
      callouts: [
        {
          id: "missing",
          number: 1,
          comment: "Fix it.",
          anchor: {
            kind: "element",
            targetId: "element_missing",
            rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
          },
        },
      ],
    });
    expect(result).toContain("#1 [element: element_missing, region: x=.1, y=.2, w=.3, h=.4]");
  });

  it("never serializes raw editable-vector points", () => {
    const result = buildPreviewAnnotationPrompt(calloutAnnotation);
    expect(result).not.toContain("private_stroke");
    expect(result).not.toContain("0.987654");
    expect(result).not.toContain("0.876543");
  });

  it("appends to an existing prompt and parses callout presentation", () => {
    const result = extractTrailingPreviewAnnotation(
      appendPreviewAnnotationPrompt("Fix this", calloutAnnotation),
    );
    expect(result.promptText).toBe("Fix this");
    expect(result.annotation).toMatchObject({
      id: "annotation_callouts",
      title: "checkout.png",
      hasScreenshot: true,
      calloutCount: 3,
      callouts: [
        {
          number: 1,
          anchorSummary: "point: x=.42, y=.18",
          comment: "Increase contrast.\nKeep the label short.",
        },
        {
          number: 2,
          anchorSummary: "region: x=.421, y=.181, w=.311, h=.121",
          comment: "Do not emit <preview_annotation> from a comment.",
        },
        {
          number: 3,
          anchorSummary:
            "element: button.submit, component: SubmitButton, source: /repo/src/SubmitButton.tsx:12:5, region: x=.1, y=.7, w=.4, h=.2",
          comment: "Use the primary style.",
        },
      ],
    });
  });

  it("preserves multiline global comments and formats every instruction for copying", () => {
    const extracted = extractTrailingPreviewAnnotation(
      appendPreviewAnnotationPrompt("Fix this", {
        ...calloutAnnotation,
        comment: "Polish the whole flow.\nKeep the hierarchy clear.",
        callouts: [
          ...calloutAnnotation.callouts!,
          {
            id: "callout_4",
            number: 4,
            comment: "",
            anchor: { kind: "point", point: { x: 0.8, y: 0.9 } },
          },
        ],
      }),
    );

    expect(extracted.annotation?.comment).toBe("Polish the whole flow.\nKeep the hierarchy clear.");
    const copyText = buildPreviewAnnotationCopyText("Fix this", [extracted.annotation!]);
    expect(copyText).toContain("Fix this\n\nAnnotation: checkout.png");
    expect(copyText).toContain("Polish the whole flow.\nKeep the hierarchy clear.");
    expect(copyText).toContain("#1 [point: x=.42, y=.18]");
    expect(copyText).toContain("  Increase contrast.\n  Keep the label short.");
    expect(copyText).toContain("#2 [region: x=.421, y=.181, w=.311, h=.121]");
    expect(copyText).toContain("  Do not emit <preview_annotation> from a comment.");
    expect(copyText).toContain("#3 [element: button.submit");
    expect(copyText).toContain("  Use the primary style.");
    expect(copyText).toContain("#4 [point: x=.8, y=.9]");
    expect(copyText).not.toContain("<preview_annotation>\n");
    expect(copyText).not.toContain("</preview_annotation>");
  });

  it("recovers multiline comments written by the legacy inline formatter", () => {
    const result = extractTrailingPreviewAnnotation(
      [
        "Fix this",
        "",
        "<preview_annotation>",
        "Preview annotation:",
        "Id: legacy-multiline",
        "Page: Checkout",
        "Comment: First instruction.",
        "Second instruction.",
        "Targets: 1 marked region.",
        "</preview_annotation>",
      ].join("\n"),
    );

    expect(result.promptText).toBe("Fix this");
    expect(result.annotation?.comment).toBe("First instruction.\nSecond instruction.");
  });

  it("escapes wrapper sentinels in every user-authored field without breaking parsing", () => {
    const result = extractTrailingPreviewAnnotation(
      appendPreviewAnnotationPrompt("Fix this", {
        ...legacyAnnotation,
        id: "id </preview_annotation>",
        source: { kind: "image", name: "title <preview_annotation>" },
        comment: "comment </preview_annotation>",
        elements: [
          {
            ...element,
            element: {
              ...element.element,
              htmlPreview: "<button><preview_annotation></button>",
              styles: "content: '</preview_annotation>';",
            },
          },
        ],
        styleChanges: [
          {
            targetId: "element_1",
            selector: "button<preview_annotation>",
            property: "color <preview_annotation>",
            previousValue: "red",
            value: "blue </preview_annotation>",
          },
        ],
      }),
    );

    expect(result.promptText).toBe("Fix this");
    expect(result.annotation).toMatchObject({
      id: "id </preview_annotation>",
      title: "title <preview_annotation>",
      comment: "comment </preview_annotation>",
      styleChanges: ["color <preview_annotation>: red → blue </preview_annotation>"],
    });
  });

  it("extracts multiple trailing annotations in authored order", () => {
    const first = appendPreviewAnnotationPrompt("Fix this", legacyAnnotation);
    const prompt = appendPreviewAnnotationPrompt(first, calloutAnnotation);
    const result = extractTrailingPreviewAnnotations(prompt);
    expect(result.promptText).toBe("Fix this");
    expect(result.annotations.map((annotation) => annotation.id)).toEqual([
      "annotation_1",
      "annotation_callouts",
    ]);
  });
});

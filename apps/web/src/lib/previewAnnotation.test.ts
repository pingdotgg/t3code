import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendPreviewAnnotationPrompt,
  buildPreviewAnnotationPrompt,
  extractTrailingPreviewAnnotation,
} from "./previewAnnotation";

const annotation: PreviewAnnotationPayload = {
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

describe("preview annotations", () => {
  it("describes regions, drawings, styles, and screenshot context", () => {
    const result = buildPreviewAnnotationPrompt(annotation);
    expect(result).toContain("Make these cards feel related.");
    expect(result).toContain("1 marked region");
    expect(result).toContain("1 drawing");
    expect(result).toContain("border-radius: 4px → 16px");
    expect(result).toContain("attached screenshot");
  });

  it("appends to an existing composer prompt", () => {
    expect(
      appendPreviewAnnotationPrompt("Fix this", annotation).startsWith(
        "Fix this\n\n<preview_annotation>",
      ),
    ).toBe(true);
  });

  it("extracts annotation presentation from a sent prompt", () => {
    const result = extractTrailingPreviewAnnotation(
      appendPreviewAnnotationPrompt("Fix this", annotation),
    );
    expect(result.promptText).toBe("Fix this");
    expect(result.annotation).toMatchObject({
      title: "Example",
      targetSummary: "1 marked region, 1 drawing.",
      hasScreenshot: true,
    });
  });

  it("extracts multiple trailing annotations one at a time", () => {
    const first = appendPreviewAnnotationPrompt("Fix this", annotation);
    const secondAnnotation = { ...annotation, id: "annotation_2", pageTitle: "Details" };
    const second = appendPreviewAnnotationPrompt(first, secondAnnotation);
    const extractedSecond = extractTrailingPreviewAnnotation(second);
    const extractedFirst = extractTrailingPreviewAnnotation(extractedSecond.promptText);
    expect(extractedSecond.annotation?.id).toBe("annotation_2");
    expect(extractedFirst.annotation?.id).toBe("annotation_1");
    expect(extractedFirst.promptText).toBe("Fix this");
  });
});

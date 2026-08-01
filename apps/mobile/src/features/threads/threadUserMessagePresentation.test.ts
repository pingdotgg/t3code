import { describe, expect, it } from "@effect/vitest";
import {
  appendPreviewAnnotationPrompt,
  type ParsedPreviewAnnotation,
} from "@t3tools/client-runtime/annotations";
import type { PreviewAnnotationPayload } from "@t3tools/contracts";

import { deriveThreadUserMessagePresentation } from "./threadUserMessagePresentation";

function annotation(id: string, calloutNumber: number, comment: string): PreviewAnnotationPayload {
  return {
    id,
    pageUrl: "",
    pageTitle: "Screenshot.png",
    comment: "",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt: "2026-07-30T10:00:00.000Z",
    callouts: [
      {
        id: `${id}-callout`,
        number: calloutNumber,
        comment,
        anchor: {
          kind: "point",
          point: { x: 0.25, y: 0.5 },
        },
      },
    ],
  };
}

describe("deriveThreadUserMessagePresentation", () => {
  it("removes multiple trailing annotation blocks without exposing their XML", () => {
    const first = appendPreviewAnnotationPrompt(
      "Update the checkout",
      annotation("annotation-1", 1, "Increase contrast"),
    );
    const prompt = appendPreviewAnnotationPrompt(
      first,
      annotation("annotation-2", 2, "Reduce this gap"),
    );

    const presentation = deriveThreadUserMessagePresentation(prompt);
    expect(presentation.visibleText).toBe("Update the checkout");
    expect(presentation.visibleText).not.toContain("<preview_annotation>");
    expect(presentation.annotations.map((entry: ParsedPreviewAnnotation) => entry.id)).toEqual([
      "annotation-1",
      "annotation-2",
    ]);
    expect(presentation.annotations.map((entry) => entry.callouts[0]?.comment)).toEqual([
      "Increase contrast",
      "Reduce this gap",
    ]);
    expect(presentation.copyText).toContain("Update the checkout");
    expect(presentation.copyText).toContain("#1 [point: x=.25, y=.5]");
    expect(presentation.copyText).toContain("Increase contrast");
    expect(presentation.copyText).toContain("#2 [point: x=.25, y=.5]");
    expect(presentation.copyText).toContain("Reduce this gap");
    expect(presentation.copyText).not.toContain("<preview_annotation>");
  });

  it("preserves review-comment parsing before trailing annotations", () => {
    const reviewComment = [
      '<review_comment sectionId="section-1" sectionTitle="Working tree" filePath="src/app.ts" startIndex="0" endIndex="0" rangeLabel="+1">',
      "Keep this change",
      "```diff",
      "+const enabled = true;",
      "```",
      "</review_comment>",
    ].join("\n");
    const prompt = appendPreviewAnnotationPrompt(
      `Please review this\n\n${reviewComment}`,
      annotation("annotation-1", 1, "Align this label"),
    );

    const presentation = deriveThreadUserMessagePresentation(prompt);
    expect(presentation.hasReviewComment).toBe(true);
    expect(presentation.annotations).toHaveLength(1);
    expect(presentation.reviewSegments.some((segment) => segment.kind === "review-comment")).toBe(
      true,
    );
    expect(presentation.visibleText).not.toContain("<preview_annotation>");
  });

  it("keeps callout-only annotations copyable without exposing their wrapper", () => {
    const presentation = deriveThreadUserMessagePresentation(
      appendPreviewAnnotationPrompt("", annotation("annotation-only", 1, "Make this primary")),
    );

    expect(presentation.visibleText).toBe("");
    expect(presentation.copyText).toContain("Annotation: Screenshot.png");
    expect(presentation.copyText).toContain("Make this primary");
    expect(presentation.copyText).not.toContain("<preview_annotation>");
  });

  it("leaves ordinary user messages unchanged", () => {
    const presentation = deriveThreadUserMessagePresentation("Just fix the bug");
    expect(presentation.visibleText).toBe("Just fix the bug");
    expect(presentation.copyText).toBe("Just fix the bug");
    expect(presentation.annotations).toEqual([]);
    expect(presentation.hasReviewComment).toBe(false);
  });
});

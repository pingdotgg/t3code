import type { ParsedPreviewAnnotation } from "~/lib/previewAnnotation";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveUserMessagePreviewAnnotationCardContent,
  deriveUserMessagePreviewAnnotationCopyText,
} from "./userMessagePreviewAnnotation";

const annotation: ParsedPreviewAnnotation = {
  id: "annotation-1",
  title: "Checkout screenshot",
  comment: "Polish the whole flow.",
  targetSummary: "5 numbered callouts.",
  styleChanges: [],
  hasScreenshot: true,
  calloutCount: 5,
  callouts: Array.from({ length: 5 }, (_, index) => ({
    number: index + 1,
    anchorSummary: `point: x=.${index + 1}, y=.5`,
    comment: `Instruction ${index + 1}`,
  })),
};

describe("deriveUserMessagePreviewAnnotationCardContent", () => {
  it("keeps the collapsed card compact and exposes every callout when expanded", () => {
    expect(deriveUserMessagePreviewAnnotationCardContent(annotation, false)).toMatchObject({
      callouts: annotation.callouts.slice(0, 3),
      hiddenCalloutCount: 2,
      canExpand: true,
    });
    expect(deriveUserMessagePreviewAnnotationCardContent(annotation, true)).toMatchObject({
      callouts: annotation.callouts,
      hiddenCalloutCount: 0,
      canExpand: true,
    });
  });

  it("keeps comment-only annotations expandable so truncated text remains recoverable", () => {
    expect(
      deriveUserMessagePreviewAnnotationCardContent(
        { ...annotation, calloutCount: 0, callouts: [] },
        false,
      ),
    ).toMatchObject({
      callouts: [],
      hiddenCalloutCount: 0,
      canExpand: true,
    });
  });

  it("replaces raw annotation markup with complete human-readable copy", () => {
    const copyText = deriveUserMessagePreviewAnnotationCopyText({
      visibleText: "Update checkout",
      annotations: [annotation],
      fallbackCopyText: "Update checkout\n\n<preview_annotation>raw</preview_annotation>",
    });

    expect(copyText).toContain("Update checkout\n\nAnnotation: Checkout screenshot");
    expect(copyText).toContain("Polish the whole flow.");
    for (const callout of annotation.callouts) {
      expect(copyText).toContain(`#${callout.number} [${callout.anchorSummary}]`);
      expect(copyText).toContain(callout.comment);
    }
    expect(copyText).not.toContain("<preview_annotation>");
    expect(copyText).not.toContain("</preview_annotation>");
  });
});

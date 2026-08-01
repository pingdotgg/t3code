import {
  buildPreviewAnnotationCopyText,
  extractTrailingPreviewAnnotations,
  type ParsedPreviewAnnotation,
} from "@t3tools/client-runtime/annotations";

import {
  parseReviewCommentMessageSegments,
  type ReviewCommentMessageSegment,
} from "../review/reviewCommentSelection";

export interface ThreadUserMessagePresentation {
  readonly visibleText: string;
  readonly copyText: string;
  readonly annotations: ReadonlyArray<ParsedPreviewAnnotation>;
  readonly reviewSegments: ReadonlyArray<ReviewCommentMessageSegment>;
  readonly hasReviewComment: boolean;
}

export function deriveThreadUserMessagePresentation(text: string): ThreadUserMessagePresentation {
  const extracted = extractTrailingPreviewAnnotations(text);
  const reviewSegments = parseReviewCommentMessageSegments(extracted.promptText);
  return {
    visibleText: extracted.promptText,
    copyText:
      extracted.annotations.length > 0
        ? buildPreviewAnnotationCopyText(extracted.promptText, extracted.annotations)
        : extracted.promptText,
    annotations: extracted.annotations,
    reviewSegments,
    hasReviewComment: reviewSegments.some((segment) => segment.kind === "review-comment"),
  };
}

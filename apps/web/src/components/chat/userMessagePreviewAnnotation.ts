import {
  buildPreviewAnnotationCopyText,
  type ParsedPreviewAnnotation,
  type ParsedPreviewAnnotationCallout,
} from "~/lib/previewAnnotation";

const COLLAPSED_CALLOUT_LIMIT = 3;

export interface UserMessagePreviewAnnotationCardContent {
  readonly callouts: ReadonlyArray<ParsedPreviewAnnotationCallout>;
  readonly hiddenCalloutCount: number;
  readonly canExpand: boolean;
}

export function deriveUserMessagePreviewAnnotationCardContent(
  annotation: ParsedPreviewAnnotation,
  expanded: boolean,
): UserMessagePreviewAnnotationCardContent {
  const callouts = expanded
    ? annotation.callouts
    : annotation.callouts.slice(0, COLLAPSED_CALLOUT_LIMIT);
  return {
    callouts,
    hiddenCalloutCount: Math.max(0, annotation.callouts.length - callouts.length),
    canExpand:
      annotation.comment.trim().length > 0 ||
      annotation.callouts.some(
        (callout) => callout.comment.trim().length > 0 || callout.anchorSummary.length > 0,
      ),
  };
}

export function deriveUserMessagePreviewAnnotationCopyText(input: {
  readonly visibleText: string;
  readonly annotations: ReadonlyArray<ParsedPreviewAnnotation>;
  readonly fallbackCopyText: string;
}): string {
  return input.annotations.length > 0
    ? buildPreviewAnnotationCopyText(input.visibleText, input.annotations)
    : input.fallbackCopyText;
}

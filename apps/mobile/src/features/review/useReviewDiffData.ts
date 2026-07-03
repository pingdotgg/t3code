import { useEffect, useMemo } from "react";

import { countReviewCommentContexts, parseReviewInlineComments } from "./reviewCommentSelection";
import { getCachedNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import { markReviewEvent, measureReviewWork } from "./reviewPerf";
import { getCachedReviewParsedDiff } from "./reviewState";
import type { ReviewParsedDiff, ReviewSectionItem } from "./reviewModel";

const EMPTY_INLINE_REVIEW_COMMENTS = Object.freeze([]);

function isReviewDiffDebugLoggingEnabled(): boolean {
  return typeof __DEV__ !== "undefined" ? __DEV__ : false;
}

function logReviewDiffDiagnostic(message: string, details?: Record<string, unknown>): void {
  if (!isReviewDiffDebugLoggingEnabled()) {
    return;
  }

  if (details) {
    console.log(`[review-sheet] ${message}`, details);
    return;
  }

  console.log(`[review-sheet] ${message}`);
}

export function formatHeaderDiffSummary(parsedDiff: ReviewParsedDiff): {
  readonly additions: string | null;
  readonly deletions: string | null;
} {
  if (parsedDiff.kind !== "files") {
    return { additions: null, deletions: null };
  }

  return {
    additions: `+${parsedDiff.additions}`,
    deletions: `-${parsedDiff.deletions}`,
  };
}

export function useReviewDiffData(input: {
  readonly threadKey: string | null;
  readonly selectedSection: ReviewSectionItem | null;
  readonly draftMessage: string;
}) {
  const { draftMessage, selectedSection, threadKey } = input;
  const selectedSectionId = selectedSection?.id ?? null;
  const parsedDiff = useMemo(
    () =>
      measureReviewWork("parse-diff", () =>
        getCachedReviewParsedDiff({
          threadKey,
          sectionId: selectedSection?.id ?? null,
          diff: selectedSection?.diff,
        }),
      ),
    [selectedSection?.diff, selectedSection?.id, threadKey],
  );
  const headerDiffSummary = useMemo(() => formatHeaderDiffSummary(parsedDiff), [parsedDiff]);
  const inlineReviewComments = useMemo(
    () => parseReviewInlineComments(draftMessage),
    [draftMessage],
  );
  const selectedSectionInlineComments = useMemo(() => {
    if (!selectedSectionId || inlineReviewComments.length === 0) {
      return EMPTY_INLINE_REVIEW_COMMENTS;
    }
    return inlineReviewComments.filter((comment) => comment.sectionId === selectedSectionId);
  }, [inlineReviewComments, selectedSectionId]);
  const nativeReviewDiffData = useMemo(
    () =>
      measureReviewWork("build-native-diff-data", () =>
        getCachedNativeReviewDiffData({
          parsedDiff,
          comments: selectedSectionInlineComments,
        }),
      ),
    [parsedDiff, selectedSectionInlineComments],
  );
  const pendingReviewCommentCount = useMemo(
    () => countReviewCommentContexts(draftMessage),
    [draftMessage],
  );

  useEffect(() => {
    if (parsedDiff.kind !== "files") {
      return;
    }

    markReviewEvent("parsed-diff-ready", {
      sectionId: selectedSection?.id ?? null,
      fileCount: parsedDiff.fileCount,
      additions: parsedDiff.additions,
      deletions: parsedDiff.deletions,
      renderedItems: nativeReviewDiffData.rows.length,
    });
    logReviewDiffDiagnostic("parsed diff files", {
      selectedSectionId: selectedSection?.id ?? null,
      fileCount: parsedDiff.fileCount,
      renderableFileCount: parsedDiff.files.length,
    });
  }, [nativeReviewDiffData.rows.length, parsedDiff, selectedSection?.id]);

  return {
    parsedDiff,
    headerDiffSummary,
    nativeReviewDiffData,
    pendingReviewCommentCount,
  };
}

import { useEffect, useMemo } from "react";

import { countReviewCommentContexts, parseReviewInlineComments } from "./reviewCommentSelection";
import { buildNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import { markReviewEvent, measureReviewWork } from "./reviewPerf";
import { getCachedReviewParsedDiff } from "./reviewState";
import type { ReviewParsedDiff, ReviewSectionItem } from "./reviewModel";

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
  const selectedSectionInlineComments = useMemo(
    () =>
      selectedSection
        ? inlineReviewComments.filter((comment) => comment.sectionId === selectedSection.id)
        : [],
    [inlineReviewComments, selectedSection],
  );
  const nativeReviewDiffData = useMemo(
    () =>
      measureReviewWork("build-native-diff-data", () =>
        buildNativeReviewDiffData({
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

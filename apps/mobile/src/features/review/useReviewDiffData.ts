import { useCallback, useContext, useEffect, useMemo, useState } from "react";

import { countReviewCommentContexts, parseReviewInlineComments } from "./reviewCommentSelection";
import { getCachedNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import { markReviewEvent, measureReviewWork } from "./reviewPerf";
import { getCachedReviewParsedDiff } from "./reviewState";
import {
  applyReviewDiffMetadata,
  buildReviewParsedDiff,
  type ReviewParsedDiff,
  type ReviewSectionItem,
} from "./reviewModel";

import type { EnvironmentId } from "@t3tools/contracts";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { reviewEnvironment } from "../../state/review";

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

export function formatHeaderDiffSummary(
  parsedDiff: ReviewParsedDiff,
  files?: ReviewSectionItem["files"],
): {
  readonly additions: string | null;
  readonly deletions: string | null;
} {
  if (files) {
    return {
      additions: `+${files.reduce((total, file) => total + file.additions, 0)}`,
      deletions: `-${files.reduce((total, file) => total + file.deletions, 0)}`,
    };
  }
  if (parsedDiff.kind !== "files") return { additions: null, deletions: null };
  return { additions: `+${parsedDiff.additions}`, deletions: `-${parsedDiff.deletions}` };
}

export function useReviewDiffData(input: {
  readonly threadKey: string | null;
  readonly environmentId: EnvironmentId | undefined;
  readonly cwd: string | null;
  readonly selectedSection: ReviewSectionItem | null;
  readonly draftMessage: string;
}) {
  const { draftMessage, selectedSection, threadKey } = input;
  const selectedSectionId = selectedSection?.id ?? null;
  const previewDiff = useMemo(
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
  const registry = useContext(RegistryContext);
  const source = selectedSection?.source;
  const lazySource = source?.truncated && source.files ? source : null;
  const { environmentId, cwd } = input;
  const scope = JSON.stringify([environmentId, cwd, source?.kind, source?.diffHash]);
  const [requested, setRequested] = useState({ scope, count: 3 });
  const count = requested.scope === scope ? requested.count : 3;
  const queries = useMemo(
    () =>
      !environmentId || !cwd || !lazySource
        ? []
        : (lazySource.files ?? []).slice(0, count).map((file) =>
            reviewEnvironment.diffFilePatch({
              environmentId,
              input: {
                cacheKey: scope,
                request: {
                  cwd,
                  ...(lazySource.kind === "branch-range" && lazySource.baseRef
                    ? { baseRef: lazySource.baseRef }
                    : {}),
                  file: {
                    path: file.path,
                    previousPath: file.previousPath,
                    sourceKind: lazySource.kind,
                  },
                },
              },
            }),
          ),
    [environmentId, cwd, lazySource, count, scope],
  );
  const parsedQuery = useMemo(
    () =>
      Atom.family((query: ReturnType<typeof reviewEnvironment.diffFilePatch>) =>
        Atom.map(query, (result) =>
          AsyncResult.map(result, (source) => ({
            source,
            parsed: buildReviewParsedDiff(source.diff, source.diffHash),
          })),
        ),
      ),
    [],
  );
  const patches = useAtomValue(
    useMemo(
      () => Atom.make((get) => queries.map((query) => get(parsedQuery(query)))),
      [queries, parsedQuery],
    ),
  );
  const refreshFilePatches = useCallback(() => {
    for (const query of queries) registry.refresh(query);
  }, [queries, registry]);
  const loadVisibleFile = useCallback(
    (fileId: string | null, retry = false) => {
      const index =
        fileId === null ? 0 : (lazySource?.files?.findIndex((file) => file.path === fileId) ?? -1);
      if (index < 0) return;
      setRequested((current) =>
        current.scope === scope && current.count >= index + 3
          ? current
          : { scope, count: index + 3 },
      );
      if (retry && patches[index]?._tag === "Failure" && queries[index])
        registry.refresh(queries[index]);
    },
    [lazySource, scope, patches, queries, registry],
  );
  const parsedDiff = useMemo<ReviewParsedDiff>(() => {
    if (!lazySource?.files) return applyReviewDiffMetadata(previewDiff, selectedSection);
    const files = lazySource.files.map((stat, index) => {
      const patch = patches[index];
      const parsed = patch?._tag === "Success" ? patch.value.parsed : null;
      const loaded =
        parsed?.kind === "files" ? parsed.files.find((file) => file.path === stat.path) : undefined;
      return {
        ...(loaded ?? {
          path: stat.path,
          previousPath: stat.previousPath,
          changeType: "change" as const,
          languageHint: null,
          additionLines: [],
          deletionLines: [],
          rows: [],
          cacheKey: `${lazySource.diffHash}:${stat.path}`,
        }),
        id: stat.path,
        additions: stat.additions,
        deletions: stat.deletions,
        ...(patch?._tag === "Success"
          ? patch.value.source.truncated
            ? { notice: "File preview exceeds the size limit. Counts include all changes." }
            : loaded
              ? {}
              : { notice: "Could not display file preview." }
          : {
              notice:
                patch?._tag === "Failure"
                  ? "Could not load diff. Select the file to retry."
                  : "Loading diff…",
            }),
      };
    });
    return {
      kind: "files",
      files,
      fileCount: files.length,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
      notice: null,
    };
  }, [lazySource, previewDiff, selectedSection, patches]);
  const headerDiffSummary = useMemo(
    () => formatHeaderDiffSummary(parsedDiff, selectedSection?.files),
    [parsedDiff, selectedSection?.files],
  );
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
    loadVisibleFile,
    refreshFilePatches,
    isPending: patches.some((patch) => patch._tag === "Initial" || patch.waiting),
    headerDiffSummary,
    nativeReviewDiffData,
    pendingReviewCommentCount,
  };
}

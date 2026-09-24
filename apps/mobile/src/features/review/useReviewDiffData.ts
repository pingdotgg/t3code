import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { countReviewCommentContexts, parseReviewInlineComments } from "./reviewCommentSelection";
import { getCachedNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import { markReviewEvent, measureReviewWork } from "./reviewPerf";
import { getCachedReviewParsedDiff } from "./reviewState";
import { buildPagedReviewParsedDiff } from "./pagedReviewDiff";
import {
  applyReviewDiffMetadata,
  buildReviewParsedDiff,
  type ReviewParsedDiff,
  type ReviewRenderableFile,
  type ReviewSectionItem,
} from "./reviewModel";

import type {
  EnvironmentId,
  ReviewDiffFileStat,
  ReviewDiffPreviewSource,
} from "@t3tools/contracts";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Atom from "effect/unstable/reactivity/Atom";
import { reviewEnvironment } from "../../state/review";

const EMPTY_INLINE_REVIEW_COMMENTS = Object.freeze([]);
type ParsedFilePatch = AsyncResult.AsyncResult<
  { source: ReviewDiffPreviewSource; parsed: ReviewParsedDiff },
  unknown
>;
const normalizedFiles = new WeakMap<
  ParsedFilePatch,
  { stat: ReviewDiffFileStat; diffHash: string; file: ReviewRenderableFile }
>();

function getCachedReviewFile(
  stat: ReviewDiffFileStat,
  diffHash: string,
  patch: ParsedFilePatch | null | undefined,
): ReviewRenderableFile {
  const cached = patch && normalizedFiles.get(patch);
  if (cached && cached.stat === stat && cached.diffHash === diffHash) return cached.file;
  const parsed = patch?._tag === "Success" ? patch.value.parsed : null;
  const sourceFiles = patch?._tag === "Success" ? patch.value.source.files : undefined;
  const loaded =
    parsed?.kind === "files"
      ? (parsed.files.find((file) => file.path === stat.path) ??
        (parsed.files.length === 1 &&
        sourceFiles?.length === 1 &&
        sourceFiles[0]?.path === stat.path
          ? parsed.files[0]
          : undefined))
      : undefined;
  const file: ReviewRenderableFile = {
    ...(loaded ?? {
      path: stat.path,
      previousPath: stat.previousPath,
      changeType: "change" as const,
      languageHint: null,
      additionLines: [],
      deletionLines: [],
      rows: [],
      cacheKey: `${diffHash}:${stat.path}`,
    }),
    id: stat.path,
    path: stat.path,
    previousPath: stat.previousPath,
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
  if (patch) normalizedFiles.set(patch, { stat, diffHash, file });
  return file;
}

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
  readonly revision: string | undefined;
  readonly draftMessage: string;
}) {
  const { draftMessage, selectedSection, threadKey } = input;
  const selectedSectionId = selectedSection?.id ?? null;
  const source = selectedSection?.source;
  const page = selectedSection?.page;
  const lazySource = source?.truncated && source.files ? source : null;
  const previewDiff = useMemo<ReviewParsedDiff>(
    () =>
      page
        ? buildPagedReviewParsedDiff(page)
        : lazySource
          ? { kind: "empty" }
          : measureReviewWork("parse-diff", () =>
              getCachedReviewParsedDiff({
                threadKey,
                sectionId: selectedSection?.id ?? null,
                diff: selectedSection?.diff,
              }),
            ),
    [lazySource, page, selectedSection?.diff, selectedSection?.id, threadKey],
  );
  const registry = useContext(RegistryContext);
  const { environmentId, cwd } = input;
  const scope = JSON.stringify([
    environmentId,
    cwd,
    source?.kind,
    source?.baseRef,
    source?.diffHash,
  ]);
  const [requested, setRequested] = useState({ scope, indices: [0, 1, 2] });
  const indices = useMemo(
    () => new Set(requested.scope === scope ? requested.indices : [0, 1, 2]),
    [requested, scope],
  );
  const queries = useMemo(
    () =>
      !environmentId || !cwd || !lazySource
        ? []
        : (lazySource.files ?? []).map((file, index) =>
            indices.has(index)
              ? reviewEnvironment.diffFilePatch({
                  environmentId,
                  input: {
                    cacheKey: scope,
                    request: {
                      cwd,
                      ...(lazySource.baseRef ? { baseRef: lazySource.baseRef } : {}),
                      file: {
                        path: file.path,
                        previousPath: file.previousPath,
                        sourceKind: lazySource.kind,
                      },
                    },
                  },
                })
              : null,
          ),
    [environmentId, cwd, lazySource, indices, scope],
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
      () => Atom.make((get) => queries.map((query) => (query ? get(parsedQuery(query)) : null))),
      [queries, parsedQuery],
    ),
  );
  const previousPreview = useRef({
    scope,
    revision: input.revision,
    queries: [] as typeof queries,
  });
  useEffect(() => {
    const previous = previousPreview.current;
    previousPreview.current = { scope, revision: input.revision, queries };
    for (const query of queries) {
      if (!query) continue;
      const changed = previous.scope === scope && previous.revision !== input.revision;
      const cached =
        !previous.queries.includes(query) &&
        registry.get(query)._tag !== "Initial" &&
        !registry.get(query).waiting;
      if (changed || cached) registry.refresh(query);
    }
  }, [input.revision, queries, registry, scope]);
  const loadVisibleFile = useCallback(
    (fileId: string | null, retry = false) => {
      const index =
        fileId === null ? 0 : (lazySource?.files?.findIndex((file) => file.path === fileId) ?? -1);
      if (index < 0) return;
      setRequested((current) => {
        const previous = current.scope === scope ? current.indices : [0, 1, 2];
        const added = [index, index + 1, index + 2].filter((next) => !previous.includes(next));
        return added.length === 0 ? current : { scope, indices: [...previous, ...added] };
      });
      if (retry && patches[index]?._tag === "Failure" && queries[index])
        registry.refresh(queries[index]);
    },
    [lazySource, scope, patches, queries, registry],
  );
  const parsedDiff = useMemo<ReviewParsedDiff>(() => {
    if (!lazySource?.files) return applyReviewDiffMetadata(previewDiff, selectedSection);
    const files = lazySource.files.map((stat, index) =>
      getCachedReviewFile(stat, lazySource.diffHash, patches[index]),
    );
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
    isPending: patches.some((patch) => patch?._tag === "Initial" || patch?.waiting),
    headerDiffSummary,
    nativeReviewDiffData,
    pendingReviewCommentCount,
  };
}

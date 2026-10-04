import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type {
  EnvironmentId,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewSource,
} from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { getRenderablePatch, resolveFileDiffPath, type RenderablePatch } from "~/lib/diffRendering";
import { reviewEnvironment } from "~/state/review";
import {
  isPendingReviewFile,
  retainLoadedReviewFiles,
  retainedReviewFile,
  reviewPatchIndicesForFamily,
  reviewSnapshotFamily,
  reviewSnapshotScope,
} from "./reviewFileDiffRetention";

const EMPTY_RETAINED_FILES: ReadonlyMap<string, FileDiffMetadata> = new Map();

const filePathCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const DEFAULT_INDICES = [0, 1, 2, 3];

export function useReviewFilePatches({
  environmentId,
  cwd,
  source,
  baseRef,
  ignoreWhitespace,
  theme,
  previewInput,
  preview,
}: {
  environmentId: EnvironmentId | undefined;
  cwd: string | undefined;
  source: ReviewDiffPreviewSource | null;
  baseRef: string | null;
  ignoreWhitespace: boolean;
  theme: "light" | "dark";
  /** The preview the file list came from; a newer revision of it refreshes loaded patches. */
  previewInput: ReviewDiffPreviewInput | undefined;
  preview: RenderablePatch | null;
}) {
  const registry = useContext(RegistryContext);
  const snapshotFamily = reviewSnapshotFamily({
    environmentId,
    cwd,
    kind: source?.kind,
    baseRef,
    ignoreWhitespace,
  });
  const scope = reviewSnapshotScope(snapshotFamily, source?.diffHash);
  const [requested, setRequested] = useState({ family: snapshotFamily, indices: [0, 1, 2, 3] });
  const [retainedFiles, setRetainedFiles] = useState<{
    readonly family: string;
    readonly byPath: ReadonlyMap<string, FileDiffMetadata>;
  }>({ family: snapshotFamily, byPath: EMPTY_RETAINED_FILES });
  const previousByPath = retainedFiles.family === snapshotFamily ? retainedFiles.byPath : EMPTY_RETAINED_FILES;
  const files = sortedReviewFiles(source);
  const queries = reviewFileQueries({ environmentId, cwd, source, baseRef, ignoreWhitespace, previewInput, scope,
    requested: { scope, indices: [...reviewPatchIndicesForFamily(requested, snapshotFamily)] } });
  const queriedPatchesAtom = reviewPatchesAtom(
    JSON.stringify([theme, queries.map(({ index, target }) => [index, target])]),
  );
  const patches = useAtomValue(queriedPatchesAtom);
  const retry = useStableCallback((path: string) => {
    const requestFiles = useCallback(
    (nextIndices: number[]) =>
      setRequested((current) => {
        const previous = reviewPatchIndicesForFamily(current, snapshotFamily);
        const added = nextIndices.filter((index) => !previous.includes(index));
        if (added.length === 0 && current.family === snapshotFamily) return current;
        return { family: snapshotFamily, indices: [...previous, ...added] };
      }),
    [snapshotFamily],
  );
  const requestFile = useCallback((index: number) => requestFiles([index]), [requestFiles]);
  const renderableFiles = useMemo(
    () =>
      source
        ? files.map((file, index): FileDiffMetadata => {
            const result = patches.get(index);
            const loaded =
              result?._tag === "Success" && result.value.patch?.kind === "files"
                ? (result.value.patch.files.find(
                    (candidate) => resolveFileDiffPath(candidate) === file.path,
                  ) ?? null)
                : null;
            return retainedReviewFile({
              loaded,
              previous: previousByPath.get(file.path),
              sameFamily: true,
              placeholder: {
                name: file.path,
                ...(file.previousPath ? { prevName: file.previousPath } : {}),
                type: file.previousPath ? "rename-changed" : "change",
                hunks: [],
                additionLines: [],
                deletionLines: [],
                additionCharacterCount: 0,
                deletionCharacterCount: 0,
                splitLineCount: 0,
                unifiedLineCount: 0,
                isPartial: true,
                cacheKey: `${scope}:${file.path}:pending`,
              },
            });
          })
        : (preview?.kind === "files" ? preview.files : []).toSorted((a, b) =>
            filePathCollator.compare(resolveFileDiffPath(a), resolveFileDiffPath(b)),
          ),
    [source, files, patches, scope, preview, previousByPath],
  );
  const nextRetainedFiles = source
    ? retainLoadedReviewFiles(previousByPath, renderableFiles, resolveFileDiffPath)
    : EMPTY_RETAINED_FILES;
  useEffect(() => {
    if (!source) return;
    if (retainedFiles.family === snapshotFamily && retainedFiles.byPath === nextRetainedFiles)
      return;
    setRetainedFiles({ family: snapshotFamily, byPath: nextRetainedFiles });
  }, [nextRetainedFiles, retainedFiles.byPath, retainedFiles.family, snapshotFamily, source]);
  const pendingIndex = source
    ? files.findIndex((file, index) => {
        const patch = patches.get(index);
        if (patch && patch._tag !== "Initial") return false;
        const rendered = renderableFiles[index];
        return (
          rendered === undefined ||
          isPendingReviewFile(rendered) ||
          resolveFileDiffPath(rendered) !== file.path
        );
      })
    : -1;
  const settledFileCount = source
    ? pendingIndex < 0
      ? files.length
      : pendingIndex
    : preview?.kind === "files"
      ? preview.files.length
      : 0;
  const loadNextFiles = useCallback(
    () => {
      if (queries.some(({ index }) => index === settledFileCount)) return;
      requestFiles(Array.from({ length: 4 }, (_, index) => settledFileCount + index));
    },
    [queries, requestFiles, settledFileCount],
  );
  const fileStates = useMemo(
    () =>
      new Map(
        files.map((file, index) => {
          const patch = patches.get(index);
          return [
            file.path,
            {
              error:
                patch?._tag === "Failure" ||
                (patch?._tag === "Success" &&
                  (patch.value.patch?.kind !== "files" ||
                    !patch.value.patch.files.some(
                      (candidate) => resolveFileDiffPath(candidate) === file.path,
                    ))),
              truncated: patch?._tag === "Success" && patch.value.source.truncated,
            },
          ] as const;
        }),
      ),
    [files, patches],
  );
  const readyFilePaths = useMemo(
    () =>
      new Set(
        files
          .filter((file, index) => {
            const patch = patches.get(index);
            if (patch && patch._tag !== "Initial") return true;
            const rendered = renderableFiles[index];
            return (
              rendered !== undefined &&
              !isPendingReviewFile(rendered) &&
              resolveFileDiffPath(rendered) === file.path
            );
          })
          .map((file) => file.path),
      ),
    [files, patches, renderableFiles],
  );
  return {
    scope,
    family: snapshotFamily,
    fileStates,
    isPending: [...patches.values()].some((patch) => patch._tag === "Initial" || patch.waiting),
    retry,
    requestFile,
    readyFilePaths,
    renderableFiles,
    settledFileCount,
    loadNextFiles,
  };
}

function reviewFileQueries({
  environmentId,
  cwd,
  source,
  baseRef,
  ignoreWhitespace,
  previewInput,
  scope,
  requested,
}: {
  environmentId: EnvironmentId | undefined;
  cwd: string | undefined;
  source: ReviewDiffPreviewSource | null;
  baseRef: string | null;
  ignoreWhitespace: boolean;
  previewInput: ReviewDiffPreviewInput | undefined;
  scope: string;
  requested: { scope: string; indices: number[] };
}) {
  const indices = requested.scope === scope ? requested.indices : DEFAULT_INDICES;
  const files = sortedReviewFiles(source);
  const queries =
    !environmentId || !cwd || !source
      ? []
      : indices
          .filter((index) => index < files.length)
          .map((index) => {
            const file = files[index]!;
            const target: ReviewPatchTarget = {
              environmentId,
              input: {
                cacheKey: scope,
                ...(previewInput ? { preview: previewInput } : {}),
                request: {
                  cwd,
                  ...(baseRef ? { baseRef } : {}),
                  ignoreWhitespace,
                  file: {
                    path: file.path,
                    previousPath: file.previousPath,
                    sourceKind: source.kind,
                  },
                },
              },
            };
            return { index, target, query: reviewEnvironment.diffFilePatch(target) };
          });
  return queries;
}

function sortedReviewFiles(source: ReviewDiffPreviewSource | null) {
  return source?.files?.toSorted((a, b) => filePathCollator.compare(a.path, b.path)) ?? [];
}

type ReviewPatchTarget = Parameters<typeof reviewEnvironment.diffFilePatch>[0];

const parsedPatchAtom = Atom.family((key: string) => {
  const [theme, target] = JSON.parse(key) as ["light" | "dark", ReviewPatchTarget];
  return Atom.map(reviewEnvironment.diffFilePatch(target), (result) =>
    AsyncResult.map(result, (source) => {
      let patch = getRenderablePatch(source.diff, `diff-panel:${theme}`, {
        compactPartialHunkOffsets: true,
      });
      if (patch?.kind === "files" && patch.files.length === 1 && source.files?.length === 1) {
        const stat = source.files[0]!;
        const file = { ...patch.files[0]!, name: stat.path };
        if (stat.previousPath !== null) file.prevName = stat.previousPath;
        else delete file.prevName;
        patch = { ...patch, files: [file] };
      }
      return { source, patch };
    }),
  );
});

const reviewPatchesAtom = Atom.family((key: string) => {
  const [theme, entries] = JSON.parse(key) as [
    "light" | "dark",
    ReadonlyArray<readonly [number, ReviewPatchTarget]>,
  ];
  const parsed = entries.map(
    ([index, target]) => [index, parsedPatchAtom(JSON.stringify([theme, target]))] as const,
  );
  return Atom.make((get) => new Map(parsed.map(([index, atom]) => [index, get(atom)])));
});

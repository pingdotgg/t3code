import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, ReviewDiffPreviewSource } from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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

export function useReviewFilePatches({
  environmentId,
  cwd,
  source,
  baseRef,
  ignoreWhitespace,
  theme,
  revision,
  preview,
}: {
  environmentId: EnvironmentId | undefined;
  cwd: string | undefined;
  source: ReviewDiffPreviewSource | null;
  baseRef: string | null;
  ignoreWhitespace: boolean;
  theme: "light" | "dark";
  revision: string | undefined;
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
  const [requested, setRequested] = useState({
    family: snapshotFamily,
    indices: [0, 1, 2, 3],
  });
  const indices = reviewPatchIndicesForFamily(requested, snapshotFamily);
  const [retainedFiles, setRetainedFiles] = useState<{
    readonly family: string;
    readonly byPath: ReadonlyMap<string, FileDiffMetadata>;
  }>({ family: snapshotFamily, byPath: EMPTY_RETAINED_FILES });
  const previousByPath =
    retainedFiles.family === snapshotFamily ? retainedFiles.byPath : EMPTY_RETAINED_FILES;
  const files = useMemo(
    () =>
      source?.files?.toSorted((a, b) =>
        a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }),
      ) ?? [],
    [source?.files],
  );
  const queries = useMemo(
    () =>
      !environmentId || !cwd || !source
        ? []
        : indices
            .filter((index) => index < files.length)
            .map((index) => {
              const file = files[index]!;
              return {
                index,
                query: reviewEnvironment.diffFilePatch({
                  environmentId,
                  input: {
                    cacheKey: scope,
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
                }),
              };
            }),
    [environmentId, cwd, source, files, indices, scope, baseRef, ignoreWhitespace],
  );
  const previousPreview = useRef({ scope, revision, queries: [] as typeof queries });
  useEffect(() => {
    const previous = previousPreview.current;
    previousPreview.current = { scope, revision, queries };
    for (const { query } of queries) {
      const changed = previous.scope === scope && previous.revision !== revision;
      const cached =
        !previous.queries.some((entry) => entry.query === query) &&
        registry.get(query)._tag !== "Initial" &&
        !registry.get(query).waiting;
      if (changed || cached) registry.refresh(query);
    }
  }, [scope, revision, queries, registry]);
  // Derived atoms parse each query result once, even when another file finishes loading.
  const parsedQuery = useMemo(
    () =>
      Atom.family((query: ReturnType<typeof reviewEnvironment.diffFilePatch>) =>
        Atom.map(query, (result) =>
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
        ),
      ),
    [theme],
  );
  const patches = useAtomValue(
    useMemo(
      () =>
        Atom.make(
          (get) => new Map(queries.map(({ index, query }) => [index, get(parsedQuery(query))])),
        ),
      [queries, parsedQuery],
    ),
  );
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
  const retryInputsRef = useRef({ queries, files });
  useLayoutEffect(() => {
    retryInputsRef.current = { queries, files };
  }, [queries, files]);
  const retry = useCallback(
    (path: string) => {
      const { queries, files } = retryInputsRef.current;
      const query = queries.find(({ index }) => files[index]?.path === path)?.query;
      if (query) registry.refresh(query);
    },
    [registry],
  );
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
              pending: result === undefined || result._tag === "Initial" || result.waiting,
              placeholder: {
                name: file.path,
                ...(file.previousPath ? { prevName: file.previousPath } : {}),
                type: file.previousPath ? "rename-changed" : "change",
                hunks: [],
                additionLines: [],
                deletionLines: [],
                splitLineCount: 0,
                unifiedLineCount: 0,
                isPartial: true,
                cacheKey: `${scope}:${file.path}:pending`,
              },
            });
          })
        : (preview?.kind === "files" ? preview.files : []).toSorted((a, b) =>
            resolveFileDiffPath(a).localeCompare(resolveFileDiffPath(b), undefined, {
              numeric: true,
              sensitivity: "base",
            }),
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
    () => requestFiles(Array.from({ length: 4 }, (_, index) => settledFileCount + index)),
    [requestFiles, settledFileCount],
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

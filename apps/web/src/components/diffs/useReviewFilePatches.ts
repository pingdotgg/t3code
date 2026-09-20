import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, ReviewDiffPreviewSource } from "@t3tools/contracts";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Atom from "effect/unstable/reactivity/Atom";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getRenderablePatch, resolveFileDiffPath, type RenderablePatch } from "~/lib/diffRendering";
import { reviewEnvironment } from "~/state/review";
import { orderFilesByTree } from "./diffFileTree.logic";

export function useReviewFilePatches({
  environmentId,
  cwd,
  source,
  baseRef,
  ignoreWhitespace,
  theme,
  revision,
  preview,
  fileTreeOpen,
}: {
  environmentId: EnvironmentId | undefined;
  cwd: string | undefined;
  source: ReviewDiffPreviewSource | null;
  baseRef: string | null;
  ignoreWhitespace: boolean;
  theme: "light" | "dark";
  revision: string | undefined;
  preview: RenderablePatch | null;
  fileTreeOpen: boolean;
}) {
  const registry = useContext(RegistryContext);
  const scope = JSON.stringify([
    environmentId,
    cwd,
    source?.kind,
    source?.diffHash,
    baseRef,
    ignoreWhitespace,
    fileTreeOpen,
  ]);
  const [requested, setRequested] = useState({ scope, indices: [0, 1, 2, 3] });
  const indices = useMemo(
    () => (requested.scope === scope ? requested.indices : [0, 1, 2, 3]),
    [requested, scope],
  );
  const files = useMemo(() => {
    const sorted =
      source?.files?.toSorted((a, b) =>
        a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }),
      ) ?? [];
    return fileTreeOpen ? orderFilesByTree(sorted, (file) => file.path) : sorted;
  }, [source?.files, fileTreeOpen]);
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
                      ...(source.kind === "staged" || source.kind === "unstaged"
                        ? { workingTreeScope: source.kind }
                        : {}),
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
  const pendingIndex = files.findIndex((_, index) => {
    const patch = patches.get(index);
    return !patch || patch._tag === "Initial";
  });
  const settledFileCount = source
    ? pendingIndex < 0
      ? files.length
      : pendingIndex
    : preview?.kind === "files"
      ? preview.files.length
      : 0;
  const requestFiles = useCallback(
    (indices: number[]) =>
      setRequested((current) => {
        const previous = current.scope === scope ? current.indices : [0, 1, 2, 3];
        const added = indices.filter((index) => !previous.includes(index));
        return added.length === 0 ? current : { scope, indices: [...previous, ...added] };
      }),
    [scope],
  );
  const loadNextFiles = useCallback(
    () => requestFiles(Array.from({ length: 4 }, (_, index) => settledFileCount + index)),
    [requestFiles, settledFileCount],
  );
  const requestFile = useCallback((index: number) => requestFiles([index]), [requestFiles]);
  const retry = useCallback(
    (path: string) => {
      const query = queries.find(({ index }) => files[index]?.path === path)?.query;
      if (query) registry.refresh(query);
    },
    [queries, files, registry],
  );
  const parsedFiles = useMemo(
    () =>
      source
        ? files.map((file, index): FileDiffMetadata => {
            const result = patches.get(index);
            if (result?._tag === "Success" && result.value.patch?.kind === "files") {
              const loaded = result.value.patch.files.find(
                (candidate) => resolveFileDiffPath(candidate) === file.path,
              );
              if (loaded) return loaded;
            }
            return {
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
            };
          })
        : (preview?.kind === "files" ? preview.files : []).toSorted((a, b) =>
            resolveFileDiffPath(a).localeCompare(resolveFileDiffPath(b), undefined, {
              numeric: true,
              sensitivity: "base",
            }),
          ),
    [source, files, patches, scope, preview],
  );
  const renderableFiles = useMemo(
    () =>
      fileTreeOpen && !source ? orderFilesByTree(parsedFiles, resolveFileDiffPath) : parsedFiles,
    [fileTreeOpen, parsedFiles, source],
  );
  const fileStates = new Map(
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
  );
  const readyFilePaths = useMemo(
    () =>
      new Set(
        files
          .filter((_, index) => {
            const patch = patches.get(index);
            return patch && patch._tag !== "Initial";
          })
          .map((file) => file.path),
      ),
    [files, patches],
  );
  return {
    scope,
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

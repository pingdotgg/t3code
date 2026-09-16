import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, ReviewDiffPreviewSource } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useContext, useMemo, useState } from "react";
import { getRenderablePatch, resolveFileDiffPath, type RenderablePatch } from "~/lib/diffRendering";
import { reviewEnvironment } from "~/state/review";

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
  revision: number;
  preview: RenderablePatch | null;
}) {
  const registry = useContext(RegistryContext);
  const scope = JSON.stringify([
    environmentId,
    cwd,
    source?.kind,
    source?.diffHash,
    baseRef,
    ignoreWhitespace,
    revision,
  ]);
  const [requested, setRequested] = useState({ scope, indices: [0, 1, 2, 3] });
  const indices = useMemo(
    () => (requested.scope === scope ? requested.indices : [0, 1, 2, 3]),
    [requested, scope],
  );
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
  // Derived atoms parse each query result once, even when another file finishes loading.
  const parsedQuery = useMemo(
    () =>
      Atom.family((query: ReturnType<typeof reviewEnvironment.diffFilePatch>) =>
        Atom.map(query, (result) =>
          AsyncResult.map(result, (source) => ({
            source,
            patch: getRenderablePatch(source.diff, `diff-panel:${theme}`, {
              compactPartialHunkOffsets: true,
            }),
          })),
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
  const refresh = useCallback(() => {
    for (const { query } of queries) registry.refresh(query);
  }, [queries, registry]);
  const retry = useCallback(
    (path: string) => {
      const query = queries.find(({ index }) => files[index]?.path === path)?.query;
      if (query) registry.refresh(query);
    },
    [queries, files, registry],
  );
  const renderableFiles = useMemo(
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
  return {
    scope,
    refresh,
    fileStates,
    isPending: [...patches.values()].some((patch) => patch._tag === "Initial" || patch.waiting),
    retry,
    requestFile,
    readyFilePaths: new Set(
      files
        .filter((_, index) => {
          const patch = patches.get(index);
          return patch && patch._tag !== "Initial";
        })
        .map((file) => file.path),
    ),
    renderableFiles,
    settledFileCount,
    loadNextFiles,
  };
}

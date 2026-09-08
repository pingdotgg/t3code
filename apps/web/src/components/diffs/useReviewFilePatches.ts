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
  const [requested, setRequested] = useState({ scope, count: 4 });
  const count = requested.scope === scope ? requested.count : 4;
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
        : files.slice(0, count).map((file) =>
            reviewEnvironment.diffFilePatch({
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
          ),
    [environmentId, cwd, source, files, count, scope, baseRef, ignoreWhitespace],
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
      () => Atom.make((get) => queries.map((query) => get(parsedQuery(query)))),
      [queries, parsedQuery],
    ),
  );
  const pendingIndex = patches.findIndex((patch) => patch._tag === "Initial");
  const settledFileCount = source
    ? pendingIndex < 0
      ? patches.length
      : pendingIndex
    : preview?.kind === "files"
      ? preview.files.length
      : 0;
  const requestThrough = useCallback(
    (count: number) =>
      setRequested((current) =>
        current.scope === scope && current.count >= count ? current : { scope, count },
      ),
    [scope],
  );
  const loadNextFiles = useCallback(
    () => requestThrough(settledFileCount + 4),
    [requestThrough, settledFileCount],
  );
  const retry = useCallback(
    (path: string) => {
      const query = queries[files.findIndex((file) => file.path === path)];
      if (query) registry.refresh(query);
    },
    [queries, files, registry],
  );
  const renderableFiles = useMemo(
    () =>
      source
        ? files.map((file, index): FileDiffMetadata => {
            const result = patches[index];
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
    files.map((file, index) => [
      file.path,
      {
        error: patches[index]?._tag === "Failure",
        truncated: patches[index]?._tag === "Success" && patches[index].value.source.truncated,
      },
    ]),
  );
  return {
    scope,
    fileStates,
    isPending: patches.some((patch) => patch._tag === "Initial" || patch.waiting),
    retry,
    requestThrough,
    renderableFiles,
    settledFileCount,
    loadNextFiles,
  };
}

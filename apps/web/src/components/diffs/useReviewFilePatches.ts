import { orderReviewFiles } from "@t3tools/client-runtime/review-workspace";
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

export function useReviewFilePatches({
  environmentId,
  cwd,
  source,
  baseRef,
  ignoreWhitespace,
  theme,
  revision,
  preview,
  workingTreeScope,
}: {
  environmentId: EnvironmentId | undefined;
  cwd: string | undefined;
  source: ReviewDiffPreviewSource | null;
  baseRef: string | null;
  ignoreWhitespace: boolean;
  theme: "light" | "dark";
  revision: string | undefined;
  preview: RenderablePatch | null;
  workingTreeScope?: "staged" | "unstaged" | undefined;
}) {
  const registry = useContext(RegistryContext);
  const scope = JSON.stringify([
    environmentId,
    cwd,
    source?.kind,
    source?.diffHash,
    baseRef,
    workingTreeScope,
  ]);
  const [requested, setRequested] = useState({ scope, indices: [0, 1, 2, 3] });
  const indices = requested.scope === scope ? requested.indices : [0, 1, 2, 3];
  const files = orderReviewFiles(source?.files ?? [], (file) => file.path);
  const queries =
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
                    // Keep the original patch for line and hunk actions. Whitespace
                    // filtering changes only the displayed metadata below.
                    ignoreWhitespace: false,
                    ...(workingTreeScope ? { workingTreeScope } : {}),
                    file: {
                      path: file.path,
                      previousPath: file.previousPath,
                      sourceKind: source.kind,
                    },
                  },
                },
              }),
            };
          });
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
  }, [scope, revision, queries, registry, previousPreview]);
  // Derived atoms parse each query result once, even when another file finishes loading.
  const parsedQuery = Atom.family((query: ReturnType<typeof reviewEnvironment.diffFilePatch>) =>
    Atom.map(query, (result) =>
      AsyncResult.map(result, (source) => {
        let patch = getRenderablePatch(source.diff, `diff-panel:${theme}`, {
          compactPartialHunkOffsets: true,
          ignoreWhitespace,
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
  );
  const patches = useAtomValue(
    Atom.make(
      (get) => new Map(queries.map(({ index, query }) => [index, get(parsedQuery(query))])),
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
  const requestFiles = (indices: number[]) =>
    setRequested((current) => {
      const previous = current.scope === scope ? current.indices : [0, 1, 2, 3];
      const added = indices.filter((index) => !previous.includes(index));
      return added.length === 0 ? current : { scope, indices: [...previous, ...added] };
    });
  const loadNextFiles = () =>
    requestFiles(Array.from({ length: 4 }, (_, index) => settledFileCount + index));
  const requestFile = (index: number) => requestFiles([index]);
  const retryInputsRef = useRef({ queries, files });
  useLayoutEffect(() => {
    retryInputsRef.current = { queries, files };
  }, [queries, files]);
  const retry = (path: string) => {
    const { queries, files } = retryInputsRef.current;
    const query = queries.find(({ index }) => files[index]?.path === path)?.query;
    if (query) registry.refresh(query);
  };
  const renderableFiles = source
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
          type:
            file.status === "added"
              ? "new"
              : file.status === "deleted"
                ? "deleted"
                : file.previousPath || file.status === "renamed"
                  ? "rename-changed"
                  : "change",
          hunks: [],
          additionLines: [],
          deletionLines: [],
          splitLineCount: 0,
          unifiedLineCount: 0,
          isPartial: true,
          cacheKey: `${scope}:${file.path}:pending`,
        };
      })
    : orderReviewFiles(preview?.kind === "files" ? preview.files : [], resolveFileDiffPath);
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
  const readyFilePaths = new Set(
    files
      .filter((_, index) => {
        const patch = patches.get(index);
        return patch && patch._tag !== "Initial";
      })
      .map((file) => file.path),
  );
  const rawPatches = [...patches.values()].flatMap((result) =>
    result._tag === "Success" ? [result.value.source.diff] : [],
  );
  return {
    rawPatches,
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

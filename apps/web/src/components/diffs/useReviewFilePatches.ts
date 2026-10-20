import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, ReviewDiffPreviewSource } from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { useContext, useEffect, useRef, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import {
  getRenderablePatch,
  resolveFileDiffPath,
  retainedReviewFile,
  retainLoadedReviewFiles,
  type RenderablePatch,
} from "~/lib/diffRendering";
import { reviewEnvironment } from "~/state/review";

const EMPTY_RETAINED_FILES: ReadonlyMap<string, FileDiffMetadata> = new Map();

const filePathCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const PAGE_SIZE = 4;

export function useReviewFilePatches({
  reviewKey,
  environmentId,
  cwd,
  source,
  baseRef,
  ignoreWhitespace,
  theme,
  revision,
  preview,
}: {
  reviewKey: string | null;
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
  const family = JSON.stringify([
    reviewKey,
    environmentId,
    cwd,
    source?.id,
    source?.kind,
    source?.baseRef,
    baseRef,
    source?.headRef,
    ignoreWhitespace,
  ]);
  const scope = JSON.stringify([family, source?.diffHash]);
  const lazy = source?.truncated === true && source.files !== undefined;
  const files = lazy ? sortedReviewFiles(source) : [];
  const [requested, setRequested] = useState<{ family: string; paths: readonly string[] }>({
    family,
    paths: [],
  });
  const [retained, setRetained] = useState(() => ({
    family,
    source,
    byPath:
      !lazy && preview?.kind === "files"
        ? retainLoadedReviewFiles(EMPTY_RETAINED_FILES, preview.files)
        : EMPTY_RETAINED_FILES,
  }));
  const previousByPath = retained.family === family ? retained.byPath : EMPTY_RETAINED_FILES;
  const requestedPaths = new Set([
    ...files.slice(0, PAGE_SIZE).map((file) => file.path),
    ...(requested.family === family ? requested.paths : []),
    ...previousByPath.keys(),
  ]);
  if (requested.family !== family || requested.paths.length !== requestedPaths.size) {
    setRequested({ family, paths: [...requestedPaths] });
  }
  const queries = reviewFileQueries({
    environmentId,
    cwd,
    source,
    baseRef,
    ignoreWhitespace,
    scope,
    files,
    requestedPaths,
  });
  const queriedPatchesAtom = reviewPatchesAtom(
    JSON.stringify([theme, queries.map(({ index, target }) => [index, target])]),
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
  }, [scope, revision, queries, registry, previousPreview]);
  const patches = useAtomValue(queriedPatchesAtom);
  const retry = useStableCallback((path: string) => {
    const query = queries.find(({ index }) => files[index]?.path === path)?.query;
    if (query) registry.refresh(query);
  });
  const requestFiles = (indices: number[]) =>
    setRequested((current) => {
      const paths = new Set(current.family === family ? current.paths : []);
      for (const index of indices) {
        const file = files[index];
        if (file) paths.add(file.path);
      }
      return current.family === family && paths.size === current.paths.length
        ? current
        : { family, paths: [...paths] };
    });
  const renderableFiles = lazy
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
          pending:
            result === undefined ||
            result._tag === "Initial" ||
            (result._tag === "Success" && result.waiting),
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
        filePathCollator.compare(resolveFileDiffPath(a), resolveFileDiffPath(b)),
      );
  const nextRetained = !source
    ? EMPTY_RETAINED_FILES
    : !lazy && retained.family === family && retained.source === source
      ? previousByPath
      : retainLoadedReviewFiles(previousByPath, renderableFiles);
  if (
    retained.family !== family ||
    retained.source !== source ||
    retained.byPath !== nextRetained
  ) {
    setRetained({ family, source, byPath: nextRetained });
  }
  const readyFilePaths = new Set(
    files
      .filter((_, index) => {
        const result = patches.get(index);
        return (
          (result !== undefined && result._tag !== "Initial") ||
          !renderableFiles[index]?.cacheKey?.endsWith(":pending")
        );
      })
      .map((file) => file.path),
  );
  const pendingIndex = files.findIndex((file) => !readyFilePaths.has(file.path));
  const settledFileCount = lazy
    ? pendingIndex < 0
      ? files.length
      : pendingIndex
    : renderableFiles.length;
  const fileStates = new Map(
    files.map((file, index) => {
      const patch = patches.get(index);
      return [
        file.path,
        {
          error:
            patch?._tag === "Failure" ||
            (patch?._tag === "Success" &&
              !patch.waiting &&
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
    family,
    fileStates,
    isPending: [...patches.values()].some((patch) => patch._tag === "Initial" || patch.waiting),
    retry,
    requestFile: (index: number) => requestFiles([index]),
    readyFilePaths,
    renderableFiles,
    settledFileCount,
    loadNextFiles: () =>
      requestFiles(Array.from({ length: PAGE_SIZE }, (_, index) => settledFileCount + index)),
  };
}

// The refresh effect keys on the identity of these queries.
function reviewFileQueries({
  environmentId,
  cwd,
  source,
  baseRef,
  ignoreWhitespace,
  scope,
  files,
  requestedPaths,
}: {
  environmentId: EnvironmentId | undefined;
  cwd: string | undefined;
  source: ReviewDiffPreviewSource | null;
  baseRef: string | null;
  ignoreWhitespace: boolean;
  scope: string;
  files: ReturnType<typeof sortedReviewFiles>;
  requestedPaths: ReadonlySet<string>;
}) {
  const queries =
    !environmentId || !cwd || !source
      ? []
      : files
          .map((file, index) => ({ file, index }))
          .filter(({ file }) => requestedPaths.has(file.path))
          .map(({ file, index }) => {
            const target: ReviewPatchTarget = {
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
            };
            return { index, target, query: reviewEnvironment.diffFilePatch(target) };
          });
  return queries;
}

function sortedReviewFiles(source: ReviewDiffPreviewSource | null) {
  return source?.files?.toSorted((a, b) => filePathCollator.compare(a.path, b.path)) ?? [];
}

type ReviewPatchTarget = Parameters<typeof reviewEnvironment.diffFilePatch>[0];

// Derived atoms parse each query result once, even when another file finishes loading.
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

// Keyed by theme and query targets so every render with the same files reads the same atom.
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

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type {
  EnvironmentId,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewSource,
  ReviewDiffFileStat,
} from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Option from "effect/Option";
import { useContext } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import {
  getRenderablePatch,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
  type RenderablePatch,
} from "~/lib/diffRendering";
import { reviewEnvironment } from "~/state/review";

const filePathCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function useReviewFilePatches({
  environmentId,
  cwd,
  source,
  baseRef,
  ignoreWhitespace,
  theme,
  previewInput,
  preview,
  collapsedFileKeys,
  defaultCollapsed,
  searchedScope,
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
  collapsedFileKeys: ReadonlySet<string> | undefined;
  defaultCollapsed: boolean;
  /** Find only searches loaded lines, so every file loads once find opens in this scope. */
  searchedScope: string | null;
}) {
  const registry = useContext(RegistryContext);
  const scope = JSON.stringify([
    environmentId,
    cwd,
    source?.kind,
    source?.diffHash,
    baseRef,
    ignoreWhitespace,
  ]);
  const { files, fileKeys, queries } = reviewFileQueryPlan({
    environmentId,
    cwd,
    source,
    baseRef,
    ignoreWhitespace,
    previewInput,
    scope,
    collapsedFileKeys,
    defaultCollapsed,
    loadAll: searchedScope === scope,
  });
  const queriedPatchesAtom = reviewPatchesAtom(
    JSON.stringify([theme, queries.map(({ index, target }) => [index, target])]),
  );
  const patches = useAtomValue(queriedPatchesAtom);
  const retry = useStableCallback((path: string) => {
    const target = queries.find(({ index }) => files[index]?.path === path)?.target;
    if (target) registry.refresh(reviewEnvironment.diffFilePatch(target));
  });
  const occurrences = new Map<string, number>();
  const renderableFiles = source
    ? files.map((file, index): FileDiffMetadata => {
        const key = reviewFileIdentityKey(file);
        const occurrence = occurrences.get(key) ?? 0;
        occurrences.set(key, occurrence + 1);
        const result = patches.get(index);
        if (result?._tag === "Success" && result.value.patch?.kind === "files") {
          const loaded = result.value.patch.files.filter(
            (candidate) =>
              resolveFileDiffPath(candidate) === file.path &&
              resolveFileDiffPreviousPath(candidate) === (file.previousPath ?? file.path),
          )[occurrence];
          if (loaded) return loaded;
        }
        return reviewFilePlaceholder(file, scope);
      })
    : (preview?.kind === "files" ? preview.files : []).toSorted((a, b) =>
        filePathCollator.compare(resolveFileDiffPath(a), resolveFileDiffPath(b)),
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
              renderableFiles[index]?.cacheKey?.endsWith(":pending") === true),
          truncated: patch?._tag === "Success" && patch.value.source.truncated,
        },
      ] as const;
    }),
  );
  return {
    scope,
    fileStates,
    isPending: [...patches.values()].some((patch) => patch._tag === "Initial" || patch.waiting),
    retry,
    renderableFiles,
    fileKeys: source ? fileKeys : reviewFileIdentityKeys(renderableFiles),
  };
}

export function reviewFileQueries(input: Parameters<typeof reviewFileQueryPlan>[0]) {
  return reviewFileQueryPlan(input).queries;
}

function reviewFileQueryPlan({
  environmentId,
  cwd,
  source,
  baseRef,
  ignoreWhitespace,
  previewInput,
  scope,
  collapsedFileKeys,
  defaultCollapsed = false,
  loadAll = false,
}: {
  environmentId: EnvironmentId | undefined;
  cwd: string | undefined;
  source: ReviewDiffPreviewSource | null;
  baseRef: string | null;
  ignoreWhitespace: boolean;
  previewInput: ReviewDiffPreviewInput | undefined;
  scope: string;
  collapsedFileKeys?: ReadonlySet<string> | undefined;
  defaultCollapsed?: boolean;
  loadAll?: boolean;
}) {
  const files = sortedReviewFiles(source);
  const fileKeys = reviewFileIdentityKeys(files);
  const queries =
    !environmentId || !cwd || !source
      ? []
      : files
          .map((file, index) => ({ file, index }))
          .filter(
            ({ index }) =>
              loadAll || !(collapsedFileKeys?.has(fileKeys[index]!) ?? defaultCollapsed),
          )
          .map(({ file, index }) => {
            const target: ReviewPatchTarget = {
              environmentId,
              input: {
                cacheKey: scope,
                ...(previewInput ? { preview: previewInput } : {}),
                request: {
                  cwd,
                  ...(baseRef ? { baseRef } : {}),
                  ...(source.kind === "commit" ? { commitSha: source.id } : {}),
                  ignoreWhitespace,
                  file: {
                    path: file.path,
                    previousPath: file.previousPath,
                    sourceKind: source.kind,
                  },
                },
              },
            };
            return { index, target };
          });
  return { files, fileKeys, queries };
}

export function reviewFileIdentityKey(
  file: Pick<ReviewDiffFileStat, "path" | "previousPath"> | FileDiffMetadata,
) {
  // Paths only: a lazy placeholder's provisional change type must not change its identity.
  return "path" in file
    ? `${file.previousPath ?? file.path}\u0000${file.path}`
    : `${resolveFileDiffPreviousPath(file)}\u0000${resolveFileDiffPath(file)}`;
}

export function reviewFileIdentityKeys(
  files: ReadonlyArray<Pick<ReviewDiffFileStat, "path" | "previousPath"> | FileDiffMetadata>,
) {
  const keys = files.map(reviewFileIdentityKey);
  const occurrences = new Map<string, number>();
  // Git emits deletion/addition sections for a file-to-symlink change at the same path.
  return keys.map((key) => {
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return occurrence > 0 ? `${key}\u0000${occurrence}` : key;
  });
}

function reviewFilePlaceholder(
  file: Pick<ReviewDiffFileStat, "path" | "previousPath">,
  scope: string,
): FileDiffMetadata {
  return {
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
  };
}

function sortedReviewFiles(source: ReviewDiffPreviewSource | null) {
  return source?.files?.toSorted((a, b) => filePathCollator.compare(a.path, b.path)) ?? [];
}

type ReviewPatchTarget = Parameters<typeof reviewEnvironment.diffFilePatch>[0];
type ParsedReviewPatch = {
  source: ReviewDiffPreviewSource;
  patch: ReturnType<typeof getRenderablePatch>;
};

export const parsedPatchAtom = Atom.family((key: string) => {
  const [theme, target] = JSON.parse(key) as ["light" | "dark", ReviewPatchTarget];
  return Atom.make((get) => {
    const result = get(reviewEnvironment.diffFilePatch(target));
    const previous = Option.flatMap(
      get.self<AsyncResult.AsyncResult<ParsedReviewPatch, unknown>>(),
      AsyncResult.value,
    );
    return AsyncResult.map(result, (source) => {
      const stat = source.files?.length === 1 ? source.files[0] : undefined;
      if (Option.isSome(previous)) {
        const cached = previous.value;
        const previousStat = cached.source.files?.length === 1 ? cached.source.files[0] : undefined;
        if (
          cached.source.diff === source.diff &&
          stat?.path === previousStat?.path &&
          stat?.previousPath === previousStat?.previousPath
        ) {
          return { source, patch: cached.patch };
        }
      }
      let patch = getRenderablePatch(source.diff, `diff-panel:${theme}`, {
        compactPartialHunkOffsets: true,
      });
      if (patch?.kind === "files" && patch.files.length === 1 && stat) {
        const file = { ...patch.files[0]!, name: stat.path };
        if (stat.previousPath !== null) file.prevName = stat.previousPath;
        else delete file.prevName;
        patch = { ...patch, files: [file] };
      }
      return { source, patch };
    });
  }).pipe(Atom.setIdleTTL(5 * 60_000));
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

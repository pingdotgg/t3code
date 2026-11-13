import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
} from "@t3tools/contracts";

import { createNativeReviewDiffSourceLoader } from "../diffs/nativeReviewDiffSource";
import type { NativeReviewDiffFile } from "../diffs/nativeReviewDiffTypes";
import type { ReviewParsedDiff, ReviewSectionItem } from "./reviewModel";

type FetchContents<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: ReviewDiffFileContentsInput;
}) => Promise<AtomCommandResult<ReviewDiffFileContentsResult, E>>;

export type ReviewDiffContentsTarget = Pick<
  ReviewDiffFileContentsInput,
  "cwd" | "sourceKind" | "baseRef" | "headRef"
> & {
  // Changes whenever the same refs would read different files, such as an edited working tree.
  readonly version: string;
};

export function reviewDiffContentsTarget(
  section: ReviewSectionItem | null,
  cwd: string | null,
): ReviewDiffContentsTarget | null {
  if (section?.kind === "turn") {
    const source = section.turnSource;
    return source
      ? {
          cwd: source.cwd,
          sourceKind: "revisions",
          baseRef: source.fromCheckpointRef,
          headRef: source.toCheckpointRef,
          version: "",
        }
      : null;
  }
  const source = section?.source;
  return source && cwd
    ? {
        cwd,
        sourceKind: source.kind,
        baseRef: source.baseRef,
        headRef: source.headRef,
        version: source.diffHash,
      }
    : null;
}

type SourceKey = string;

function createReviewDiffSourceLoader<E>(
  environmentId: EnvironmentId,
  target: ReviewDiffContentsTarget,
  fetchContents: FetchContents<E>,
) {
  return createNativeReviewDiffSourceLoader<SourceKey>(async (key) => {
    const [changeType, oldPath, newPath] = JSON.parse(key) as [
      ReviewDiffFileContentsInput["changeType"],
      string,
      string,
    ];
    const result = await fetchContents({
      environmentId,
      input: {
        cwd: target.cwd,
        sourceKind: target.sourceKind,
        changeType,
        baseRef: target.baseRef,
        headRef: target.headRef,
        oldPath,
        newPath,
      },
    });
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    return result.value;
  });
}

export function createReviewDiffHighlightCache(): {
  key?: string;
  load?: ReturnType<typeof createReviewDiffSourceLoader>;
} {
  return {};
}

// A patch carries only hunks, so the highlighter needs both sides' full files to know what a
// hunk opened inside, such as a docstring that starts above it.
export function createReviewDiffHighlightFiles<E>(
  environmentId: EnvironmentId,
  target: ReviewDiffContentsTarget,
  parsed: ReviewParsedDiff,
  files: ReadonlyArray<NativeReviewDiffFile>,
  fetchContents: FetchContents<E>,
  cache = createReviewDiffHighlightCache(),
): ReadonlyArray<NativeReviewDiffFile> {
  if (parsed.kind !== "files") return files;
  const key = JSON.stringify([environmentId, target]);
  if (cache.key !== key || !cache.load) {
    cache.key = key;
    cache.load = createReviewDiffSourceLoader(environmentId, target, fetchContents);
  }
  const { load } = cache;
  const byId = new Map(parsed.files.map((file) => [file.id, file]));
  return files.map((nativeFile) => {
    const file = byId.get(nativeFile.id);
    if (!file) return nativeFile;
    const fileKey = JSON.stringify([file.changeType, file.previousPath ?? file.path, file.path]);
    return { ...nativeFile, loadContents: (signal) => load(fileKey, signal) };
  });
}

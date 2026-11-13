import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationGetTurnDiffResult,
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
} from "@t3tools/contracts";

import { createNativeReviewDiffSourceLoader } from "../diffs/nativeReviewDiffSource";
import type { NativeReviewDiffFile } from "../diffs/nativeReviewDiffTypes";
import type { ReviewParsedDiff } from "./reviewModel";

export type ReviewTurnDiffSource = NonNullable<OrchestrationGetTurnDiffResult["source"]>;

type FetchContents<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: ReviewDiffFileContentsInput;
}) => Promise<AtomCommandResult<ReviewDiffFileContentsResult, E>>;

type SourceKey = string;

function createReviewTurnDiffSourceLoader<E>(
  environmentId: EnvironmentId,
  source: ReviewTurnDiffSource,
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
        cwd: source.cwd,
        sourceKind: "revisions",
        changeType,
        baseRef: source.fromCheckpointRef,
        headRef: source.toCheckpointRef,
        oldPath,
        newPath,
      },
    });
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    return result.value;
  });
}

export function createReviewTurnDiffHighlightCache(): {
  key?: string;
  load?: ReturnType<typeof createReviewTurnDiffSourceLoader>;
} {
  return {};
}

// A turn patch carries only hunks, so the highlighter needs both checkpoints' full files to know
// what a hunk opened inside, such as a docstring that starts above it.
export function createReviewTurnDiffHighlightFiles<E>(
  environmentId: EnvironmentId,
  source: ReviewTurnDiffSource,
  parsed: ReviewParsedDiff,
  files: ReadonlyArray<NativeReviewDiffFile>,
  fetchContents: FetchContents<E>,
  cache = createReviewTurnDiffHighlightCache(),
): ReadonlyArray<NativeReviewDiffFile> {
  if (parsed.kind !== "files") return files;
  const key = JSON.stringify([
    environmentId,
    source.cwd,
    source.fromCheckpointRef,
    source.toCheckpointRef,
  ]);
  if (cache.key !== key || !cache.load) {
    cache.key = key;
    cache.load = createReviewTurnDiffSourceLoader(environmentId, source, fetchContents);
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

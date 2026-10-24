import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
} from "@t3tools/contracts";

import { createNativeReviewDiffSourceLoader } from "../diffs/nativeReviewDiffSource";
import {
  diffHighlightTraceHash,
  diffHighlightTraceId,
  traceDiffHighlight,
} from "../diffs/nativeReviewDiffTrace";
import type { NativeReviewDiffFile } from "../diffs/nativeReviewDiffTypes";
import type { ReviewParsedDiff } from "../review/reviewModel";
import type { pullRequestTarget } from "./usePullRequestDiff";

type FetchContents<E> = (request: {
  readonly environmentId: ReturnType<typeof pullRequestTarget>["environmentId"];
  readonly input: PullRequestDiffFileContentsInput;
}) => Promise<AtomCommandResult<PullRequestDiffFileContentsResult, E>>;

export function createPullRequestDiffHighlightFiles<E>(
  source: {
    readonly target: ReturnType<typeof pullRequestTarget>;
    readonly commit?: string;
  },
  parsed: ReviewParsedDiff,
  files: ReadonlyArray<NativeReviewDiffFile>,
  fetchContents: FetchContents<E>,
): ReadonlyArray<NativeReviewDiffFile> {
  if (parsed.kind !== "files") return files;
  const byId = new Map(parsed.files.map((file) => [file.id, file]));
  const { target, commit } = source;
  traceDiffHighlight("source-target", {
    environment: diffHighlightTraceHash(target.environmentId),
    project: diffHighlightTraceHash(target.input.projectId),
    pr: target.input.number,
    gitcafe: target.input.host === "git.cafe",
  });
  const load = createNativeReviewDiffSourceLoader(async (fileId) => {
    const file = byId.get(fileId)!;
    traceDiffHighlight("source-params", {
      file: diffHighlightTraceId(fileId),
      oldPath: diffHighlightTraceHash(file.previousPath ?? file.path),
      newPath: diffHighlightTraceHash(file.path),
      changeType: file.changeType,
      hasCommit: !!commit,
    });
    const result = await fetchContents({
      ...target,
      input: {
        ...target.input,
        ...(commit ? { commit } : {}),
        changeType: file.changeType,
        oldPath: file.previousPath ?? file.path,
        newPath: file.path,
      },
    });
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    return result.value;
  });
  return files.map((file) => ({ ...file, loadContents: (signal) => load(file.id, signal) }));
}

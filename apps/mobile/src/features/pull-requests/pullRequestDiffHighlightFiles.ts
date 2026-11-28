import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
} from "@t3tools/contracts";

import {
  createDiffHighlightCache,
  withDiffSourceLoaders,
} from "../diffs/nativeReviewDiffHighlightFiles";
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

export const createPullRequestDiffHighlightCache = createDiffHighlightCache;

export function createPullRequestDiffHighlightFiles<E>(
  source: {
    readonly target: ReturnType<typeof pullRequestTarget>;
    readonly commit?: string;
  },
  parsed: ReviewParsedDiff,
  files: ReadonlyArray<NativeReviewDiffFile>,
  fetchContents: FetchContents<E>,
  cache = createPullRequestDiffHighlightCache(),
): ReadonlyArray<NativeReviewDiffFile> {
  if (parsed.kind !== "files" || !parsed.files[0]) return files;
  const { target, commit } = source;
  traceDiffHighlight("source-target", {
    environment: diffHighlightTraceHash(target.environmentId),
    project: diffHighlightTraceHash(target.input.projectId),
    pr: target.input.number,
    gitcafe: target.input.host === "git.cafe",
  });
  const scope = JSON.stringify([
    target.environmentId,
    target.input.projectId,
    target.input.repository,
    target.input.number,
    target.input.host,
    commit,
  ]);
  return withDiffSourceLoaders(
    scope,
    parsed,
    files,
    async (file) => {
      traceDiffHighlight("source-params", {
        file: diffHighlightTraceId(file.id),
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
    },
    cache,
  );
}

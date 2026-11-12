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
import type { NativeReviewDiffFile, NativeReviewDiffSource } from "../diffs/nativeReviewDiffTypes";
import type { ReviewParsedDiff, ReviewRenderableFile } from "../review/reviewModel";
import type { pullRequestTarget } from "./usePullRequestDiff";

type FetchContents<E> = (request: {
  readonly environmentId: ReturnType<typeof pullRequestTarget>["environmentId"];
  readonly input: PullRequestDiffFileContentsInput;
}) => Promise<AtomCommandResult<PullRequestDiffFileContentsResult, E>>;

type SourceRequest = () => Promise<NativeReviewDiffSource>;

interface SourceSnapshot {
  readonly firstFile: ReviewRenderableFile;
  readonly scope: string;
  readonly load: ReturnType<typeof createNativeReviewDiffSourceLoader<SourceRequest>>;
  readonly requests: WeakMap<
    ReviewRenderableFile,
    { readonly completePatch: boolean; readonly request: SourceRequest }
  >;
}

export function createPullRequestDiffHighlightCache(): { snapshot?: SourceSnapshot } {
  return {};
}

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
  const byId = new Map(parsed.files.map((file) => [file.id, file]));
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
  const firstFile = parsed.files[0];
  // Appended pages share one loader budget; a new first file starts a new snapshot.
  let snapshot = cache.snapshot;
  if (!snapshot || snapshot.firstFile !== firstFile || snapshot.scope !== scope) {
    snapshot = {
      firstFile,
      scope,
      load: createNativeReviewDiffSourceLoader<SourceRequest>((request) => request()),
      requests: new WeakMap(),
    };
    cache.snapshot = snapshot;
  }
  const { load, requests } = snapshot;
  return files.map((nativeFile) => {
    const file = byId.get(nativeFile.id);
    if (!file) return nativeFile;
    const completePatch = parsed.notice === null && !!file.completePatchSource;
    const cached = requests.get(file);
    if (cached?.completePatch === completePatch)
      return { ...nativeFile, loadContents: (signal) => load(cached.request, signal) };
    const request: SourceRequest = async () => {
      if (completePatch && file.completePatchSource) return file.completePatchSource();
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
    };
    requests.set(file, { completePatch, request });
    return { ...nativeFile, loadContents: (signal) => load(request, signal) };
  });
}

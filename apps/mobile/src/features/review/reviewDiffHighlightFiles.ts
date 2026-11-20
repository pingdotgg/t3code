import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentAuthorizationError,
  ReviewDiffPreviewError,
  type EnvironmentId,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  createDiffHighlightCache,
  withDiffSourceLoaders,
} from "../diffs/nativeReviewDiffHighlightFiles";
import type { NativeReviewDiffFile } from "../diffs/nativeReviewDiffTypes";
import type { ReviewParsedDiff, ReviewRenderableFile } from "./reviewModel";

export interface ReviewDiffContentsSource {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly sourceKind: ReviewDiffFileContentsInput["sourceKind"];
  readonly baseRef: string | null;
  readonly headRef: string | null;
  /** Changes whenever the diff does, so contents read for an older diff are not reused. */
  readonly diffKey: string;
}

type FetchContents<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: ReviewDiffFileContentsInput;
}) => Promise<AtomCommandResult<ReviewDiffFileContentsResult, E>>;

const isServerAnswer = Schema.is(
  Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
);

// Only a hunk with lines hidden above it can open inside a docstring or script block.
function hidesLinesAboveAHunk(file: ReviewRenderableFile): boolean {
  let hunkStart = true;
  for (const row of file.rows) {
    if (row.kind === "hunk") hunkStart = true;
    else if (row.kind === "line") {
      if (hunkStart && Math.max(row.oldLineNumber ?? 0, row.newLineNumber ?? 0) > 1) return true;
      hunkStart = false;
    }
  }
  return false;
}

export function createReviewDiffHighlightFiles<E>(
  source: ReviewDiffContentsSource,
  parsed: ReviewParsedDiff,
  files: ReadonlyArray<NativeReviewDiffFile>,
  fetchContents: FetchContents<E>,
  cache = createDiffHighlightCache(),
): ReadonlyArray<NativeReviewDiffFile> {
  const { environmentId, cwd, sourceKind, baseRef, headRef, diffKey } = source;
  const scope = JSON.stringify([environmentId, cwd, sourceKind, baseRef, headRef, diffKey]);
  if (parsed.kind !== "files") return files;
  const needsContents = new Set(parsed.files.filter(hidesLinesAboveAHunk).map((file) => file.id));
  const loaded = withDiffSourceLoaders(
    scope,
    parsed,
    files,
    async (file) => {
      const result = await fetchContents({
        environmentId,
        input: {
          cwd,
          sourceKind,
          changeType: file.changeType,
          baseRef,
          headRef,
          oldPath: file.previousPath ?? file.path,
          newPath: file.path,
        },
      });
      if (result._tag === "Success") return result.value;
      const error = squashAtomCommandFailure(result);
      // The server gives the same answer (too large, binary, no access) until the diff changes,
      // so the loader stops asking for this file instead of retrying on every scroll.
      throw isServerAnswer(error) ? { reason: "unsupported", cause: error } : error;
    },
    cache,
  );
  return loaded.map((file, index) => (needsContents.has(file.id) ? file : files[index]!));
}

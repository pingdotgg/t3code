import type { EnvironmentId } from "@t3tools/contracts";

import type { NativeReviewDiffFile } from "../diffs/nativeReviewDiffTypes";
import { reviewEnvironment } from "../../state/review";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ReviewParsedDiff } from "./reviewModel";
import {
  createReviewDiffHighlightCache,
  createReviewDiffHighlightFiles,
  type ReviewDiffContentsTarget,
} from "./reviewDiffHighlightFiles";

export function useReviewDiffHighlightFiles(input: {
  readonly environmentId: EnvironmentId;
  readonly target: ReviewDiffContentsTarget | null;
  readonly parsed: ReviewParsedDiff;
  readonly files: ReadonlyArray<NativeReviewDiffFile>;
}) {
  const fetchContents = useAtomCommand(reviewEnvironment.diffFileContents, {
    reportFailure: false,
  });
  const cache = createReviewDiffHighlightCache();
  const { environmentId, target, parsed, files } = input;
  return target
    ? createReviewDiffHighlightFiles(environmentId, target, parsed, files, fetchContents, cache)
    : files;
}

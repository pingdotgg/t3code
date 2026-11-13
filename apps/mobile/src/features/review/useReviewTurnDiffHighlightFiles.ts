import type { EnvironmentId } from "@t3tools/contracts";

import type { NativeReviewDiffFile } from "../diffs/nativeReviewDiffTypes";
import { reviewEnvironment } from "../../state/review";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ReviewParsedDiff } from "./reviewModel";
import {
  createReviewTurnDiffHighlightCache,
  createReviewTurnDiffHighlightFiles,
  type ReviewTurnDiffSource,
} from "./reviewTurnDiffHighlightFiles";

export function useReviewTurnDiffHighlightFiles(input: {
  readonly environmentId: EnvironmentId;
  readonly source: ReviewTurnDiffSource | undefined;
  readonly parsed: ReviewParsedDiff;
  readonly files: ReadonlyArray<NativeReviewDiffFile>;
}) {
  const fetchContents = useAtomCommand(reviewEnvironment.diffFileContents, {
    reportFailure: false,
  });
  const cache = createReviewTurnDiffHighlightCache();
  const { environmentId, source, parsed, files } = input;
  return source
    ? createReviewTurnDiffHighlightFiles(environmentId, source, parsed, files, fetchContents, cache)
    : files;
}

import type { PullRequestIterationRange } from "@t3tools/contracts";

/**
 * Which updates a review compares. `from: 0` is the base; `to: "latest"` keeps following new
 * updates as they are pushed, while a numbered `to` stays on that update.
 */
export type PullRequestUpdateComparison = {
  readonly from: number;
  readonly to: number | "latest";
};

const WHOLE_CHANGE: PullRequestUpdateComparison = { from: 0, to: "latest" };

/**
 * Resolves a picked comparison against the newest update the host reports. Base to latest is the
 * change itself, so it asks for no range and keeps commenting and viewed files on the live diff.
 * A pick that no longer describes a valid range falls back to the whole change.
 */
export function resolvePullRequestUpdateComparison(
  comparison: PullRequestUpdateComparison | null | undefined,
  latestUpdateId: number | undefined,
): {
  readonly comparison: PullRequestUpdateComparison;
  readonly iterationRange: PullRequestIterationRange | undefined;
} {
  const to = comparison?.to === "latest" ? latestUpdateId : comparison?.to;
  if (!comparison || to === undefined || comparison.from >= to) {
    return { comparison: WHOLE_CHANGE, iterationRange: undefined };
  }
  if (comparison.from === 0 && comparison.to === "latest") {
    return { comparison, iterationRange: undefined };
  }
  return { comparison, iterationRange: { from: comparison.from, to } };
}

import type { PullRequestChangeBreakdown } from "@t3tools/contracts";
import { summarizeChangedFiles } from "@t3tools/shared/changedFileKind";
import type { ProviderFileStats } from "@t3tools/source-control-core/server/PullRequestProvider";

export function toChangeBreakdown(stats: ProviderFileStats): PullRequestChangeBreakdown {
  if (stats.truncated) return null;
  return summarizeChangedFiles(stats.files);
}

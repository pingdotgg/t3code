import type { PullRequestChangeBreakdown } from "@lathe/contracts";
import { summarizeChangedFiles } from "@lathe/shared/changedFileKind";
import type { ProviderFileStats } from "@lathe/source-control-core/server/PullRequestProvider";

export function toChangeBreakdown(stats: ProviderFileStats): PullRequestChangeBreakdown {
  if (stats.truncated) return null;
  return summarizeChangedFiles(stats.files);
}

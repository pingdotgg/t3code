import type { VcsStatusResult } from "@t3tools/contracts";

import { resolveChangeRequestPresentation } from "../sourceControlPresentation";

export function changeRequestLookupWarning(
  threadBranch: string | null,
  gitStatus: VcsStatusResult | null,
): string | null {
  if (
    threadBranch === null ||
    gitStatus === null ||
    gitStatus.refName !== threadBranch ||
    gitStatus.changeRequestLookup._tag !== "failed"
  ) {
    return null;
  }
  const presentation = resolveChangeRequestPresentation(gitStatus.sourceControlProvider);
  switch (gitStatus.changeRequestLookup.reason) {
    case "authentication_required":
      return `${presentation.shortName} status unavailable: authentication required.`;
    case "provider_unavailable":
      return `${presentation.shortName} status unavailable: provider integration unavailable.`;
    case "lookup_failed":
      return `${presentation.shortName} status unavailable: lookup failed.`;
  }
}

import {
  currentChangeRequestTerms,
  formatChangeRequestText,
} from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestRoutingPermission } from "@t3tools/client-runtime/connection";

const summaryLabels = { "read-write": "read and act", read: "read PRs" } as const;

export function summarizePullRequestRouting(
  entries: ReadonlyArray<{
    readonly label: string;
    readonly permission: PullRequestRoutingPermission;
  }>,
  terms = currentChangeRequestTerms(),
): string | null {
  const groups = (["read-write", "read"] as const).flatMap((permission) => {
    const labels = entries.filter((entry) => entry.permission === permission);
    return labels.length === 0
      ? []
      : [
          `${labels.map((entry) => entry.label).join(", ")} ${formatChangeRequestText(summaryLabels[permission], terms)}`,
        ];
  });
  return groups.length === 0 ? null : groups.join(" \u00b7 ");
}

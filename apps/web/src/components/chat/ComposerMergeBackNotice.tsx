import { pendingMergeBackNotice } from "@t3tools/client-runtime/state/thread-relationships";
import type { ContextTransferId } from "@t3tools/contracts";

import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * A merged-back fork changes what the next send carries, so it gets a composer
 * notice. It has no dismiss: the next run consumes the transfer and the
 * timeline's context handoff divider takes over.
 */
export function mergeBackBannerItem(input: {
  readonly transferId: ContextTransferId;
  readonly sourceThreadTitle: string | null;
  readonly forkCount: number;
  readonly waitsForIdle: boolean;
}): ComposerBannerStackItem {
  const { blocked, ...notice } = pendingMergeBackNotice(input);
  return {
    id: `merge-back:${input.transferId}`,
    variant: blocked ? "warning" : "info",
    icon: <PullRequestGlyph.merged />,
    ...notice,
  };
}

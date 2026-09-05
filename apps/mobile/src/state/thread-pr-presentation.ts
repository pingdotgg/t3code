import type { VcsStatusResult } from "@t3tools/contracts";
import { resolveChangeRequestPresentation } from "@t3tools/shared/sourceControl";

export type ThreadPr = NonNullable<VcsStatusResult["pr"]>;

export interface ThreadPrPresentation {
  readonly number: number;
  readonly state: ThreadPr["state"];
  readonly isDraft: boolean;
  /** Provider-side last activity, bounding when a terminal state landed. */
  readonly updatedAt: string | null;
  readonly url: string;
  /** Compact pull request number label, e.g. "3774". */
  readonly label: string;
  /** Full, provider-aware label for assistive technologies. */
  readonly accessibilityLabel: string;
  readonly textClassName: string;
}

const PR_STATE_TEXT_CLASS: Record<ThreadPr["state"], string> = {
  open: "text-adaptive-emerald-600-400",
  merged: "text-adaptive-violet-600-400",
  closed: "text-adaptive-zinc-500-400",
};

export function presentThreadPr(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): ThreadPrPresentation {
  const presentation = resolveChangeRequestPresentation(provider);
  const isDraft = pr.state === "open" && pr.isDraft === true;
  return {
    number: pr.number,
    state: pr.state,
    isDraft,
    updatedAt: pr.updatedAt ?? null,
    url: pr.url,
    label: String(pr.number),
    accessibilityLabel: `#${pr.number} ${presentation.longName} ${isDraft ? "draft" : pr.state}`,
    textClassName: isDraft ? "text-adaptive-zinc-500-400" : PR_STATE_TEXT_CLASS[pr.state],
  };
}

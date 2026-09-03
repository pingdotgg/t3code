import type { VcsStatusResult } from "@t3tools/contracts";
import { resolveChangeRequestPresentation } from "@t3tools/shared/sourceControl";

export type ThreadPr = NonNullable<VcsStatusResult["pr"]>;

export interface ThreadPrPresentation {
  readonly number: number;
  readonly state: ThreadPr["state"];
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
  return {
    number: pr.number,
    state: pr.state,
    updatedAt: pr.updatedAt ?? null,
    url: pr.url,
    label: String(pr.number),
    accessibilityLabel: `#${pr.number} ${presentation.longName} ${pr.state}`,
    textClassName: PR_STATE_TEXT_CLASS[pr.state],
  };
}

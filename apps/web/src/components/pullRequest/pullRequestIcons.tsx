import {
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  LayersIcon,
  Link2Icon,
  Unlink2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import type { PullRequestState } from "@t3tools/contracts";

import { translateNow } from "~/components/media/translateNow";
export const PullRequestGlyph = {
  pullRequest: GitPullRequestArrowIcon,
  reopen: GitPullRequestArrowIcon,
  draft: GitPullRequestDraftIcon,
  closed: GitPullRequestClosedIcon,
  merged: GitMergeIcon,
  conflicting: TriangleAlertIcon,
  stack: LayersIcon,
  link: Link2Icon,
  unlink: Unlink2Icon,
} as const;

export type PullRequestGlyphIcon = (typeof PullRequestGlyph)[keyof typeof PullRequestGlyph];

export interface PullRequestStatePresentation {
  readonly label: string;
  readonly toneClassName: string;
  readonly Icon: PullRequestGlyphIcon;
}

export const PULL_REQUEST_STATE_PRESENTATION = {
  open: {
    get label() {
      return translateNow("review.extra.open");
    },
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
    Icon: PullRequestGlyph.pullRequest,
  },
  draft: {
    get label() {
      return translateNow("review.extra.draft");
    },
    toneClassName: "text-zinc-500 dark:text-zinc-400/80",
    Icon: PullRequestGlyph.draft,
  },
  closed: {
    get label() {
      return translateNow("review.extra.closed");
    },
    toneClassName: "text-red-600 dark:text-red-300/90",
    Icon: PullRequestGlyph.closed,
  },
  merged: {
    get label() {
      return translateNow("review.extra.merged");
    },
    toneClassName: "text-violet-600 dark:text-violet-300/90",
    Icon: PullRequestGlyph.merged,
  },
} as const satisfies Record<PullRequestState | "draft", PullRequestStatePresentation>;

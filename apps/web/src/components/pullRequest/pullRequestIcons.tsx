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
import { msg } from "gt-react";

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
    label: msg("Open", { $context: "pull request state" }),
    toneClassName: "text-success-foreground",
    Icon: PullRequestGlyph.pullRequest,
  },
  draft: {
    label: msg("Draft", { $context: "pull request state" }),
    toneClassName: "text-dim-foreground",
    Icon: PullRequestGlyph.draft,
  },
  closed: {
    label: msg("Closed", { $context: "pull request state" }),
    toneClassName: "text-error-foreground",
    Icon: PullRequestGlyph.closed,
  },
  merged: {
    label: msg("Merged", { $context: "pull request state" }),
    toneClassName: "text-merged-foreground",
    Icon: PullRequestGlyph.merged,
  },
} as const satisfies Record<PullRequestState | "draft", PullRequestStatePresentation>;

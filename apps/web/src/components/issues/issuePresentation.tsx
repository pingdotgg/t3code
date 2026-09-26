import type { IssueState, IssueStatus } from "@t3tools/contracts";
import {
  BanIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotDashedIcon,
  CircleDotIcon,
  CircleIcon,
  CirclePauseIcon,
  CircleSlashIcon,
  EyeIcon,
  MessagesSquareIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";

/** GitHub's own three states, in its colors: open green, done purple, not planned grey. */
export const ISSUE_STATE_PRESENTATION = {
  open: {
    label: "Open",
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
    Icon: CircleDotIcon,
  },
  done: {
    label: "Done",
    toneClassName: "text-violet-600 dark:text-violet-300/90",
    Icon: CircleCheckIcon,
  },
  "not-planned": {
    label: "Not planned",
    toneClassName: "text-zinc-500 dark:text-zinc-400/80",
    Icon: CircleSlashIcon,
  },
} as const satisfies Record<IssueState, unknown>;

export function IssueStateGlyph({ state, className }: { state: IssueState; className?: string }) {
  const { Icon, label, toneClassName } = ISSUE_STATE_PRESENTATION[state];
  return <Icon aria-label={label} className={cn("size-4 shrink-0", toneClassName, className)} />;
}

/** The computed status (#29); Done and Not planned keep GitHub's own look. */
export const ISSUE_STATUS_PRESENTATION = {
  done: ISSUE_STATE_PRESENTATION.done,
  "not-planned": ISSUE_STATE_PRESENTATION["not-planned"],
  "in-review": {
    label: "In review",
    toneClassName: "text-amber-600 dark:text-amber-300/90",
    Icon: EyeIcon,
  },
  "in-progress": {
    label: "In progress",
    toneClassName: "text-sky-600 dark:text-sky-300/90",
    Icon: CircleDotDashedIcon,
  },
  "waiting-for-merge": {
    label: "Waiting for merge",
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
    Icon: PullRequestGlyph.merged,
  },
  "changes-requested": {
    label: "Changes requested",
    toneClassName: "text-red-600 dark:text-red-300/90",
    Icon: CircleAlertIcon,
  },
  "waiting-for-review": {
    label: "Waiting for review",
    toneClassName: "text-amber-600 dark:text-amber-300/90",
    Icon: PullRequestGlyph.pullRequest,
  },
  paused: {
    label: "Paused",
    toneClassName: "text-zinc-500 dark:text-zinc-400/80",
    Icon: CirclePauseIcon,
  },
  blocked: {
    label: "Blocked",
    toneClassName: "text-red-600 dark:text-red-300/90",
    Icon: BanIcon,
  },
  discussion: {
    label: "Discussion",
    toneClassName: "text-sky-600 dark:text-sky-300/90",
    Icon: MessagesSquareIcon,
  },
  "to-do": {
    label: "To do",
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
    Icon: CircleIcon,
  },
} as const satisfies Record<
  IssueStatus,
  { readonly label: string; readonly toneClassName: string; readonly Icon: unknown }
>;

export function IssueStatusGlyph({
  status,
  className,
}: {
  status: IssueStatus;
  className?: string;
}) {
  const { Icon, label, toneClassName } = ISSUE_STATUS_PRESENTATION[status];
  return <Icon aria-label={label} className={cn("size-4 shrink-0", toneClassName, className)} />;
}

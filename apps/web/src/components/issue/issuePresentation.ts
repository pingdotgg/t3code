import type { IssueDetail } from "@t3tools/contracts";
import { CircleCheckIcon, CircleDotIcon, CircleSlashIcon } from "lucide-react";

const ISSUE_STATE_PRESENTATION = {
  open: {
    label: "Open",
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
    Icon: CircleDotIcon,
  },
  completed: {
    label: "Closed",
    toneClassName: "text-violet-600 dark:text-violet-300/90",
    Icon: CircleCheckIcon,
  },
  "not-planned": {
    label: "Not planned",
    toneClassName: "text-zinc-500 dark:text-zinc-400/80",
    Icon: CircleSlashIcon,
  },
  duplicate: {
    label: "Duplicate",
    toneClassName: "text-zinc-500 dark:text-zinc-400/80",
    Icon: CircleSlashIcon,
  },
} as const;

/** GitHub draws a closed issue without a reason as completed, so this does too. */
export function resolveIssueState(issue: Pick<IssueDetail, "state" | "stateReason">) {
  return ISSUE_STATE_PRESENTATION[
    issue.state === "open" ? "open" : (issue.stateReason ?? "completed")
  ];
}

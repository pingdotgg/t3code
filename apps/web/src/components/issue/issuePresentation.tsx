import type { IssueState, IssueTrackerKind } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { CircleCheckIcon, CircleDotIcon, CircleSlashIcon, TicketIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { LinearIcon, type Icon } from "~/components/Icons";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

import { TooltipPopup } from "../ui/tooltip";
import { RowTooltip } from "../workItem/WorkItemRowTooltip";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";

export const IssueGlyph = { issue: CircleDotIcon } as const;

/** Name and mark per standalone tracker kind; one missing here falls back to its kind and a ticket. */
const STANDALONE_TRACKERS: Partial<Record<string, { providerName: string; Icon: Icon }>> = {
  linear: { providerName: "Linear", Icon: LinearIcon },
};

/** A git host's tracker wears the host's own icon and name; a standalone tracker wears its kind. */
export function issueTrackerPresentation(tracker: IssueTrackerKind | string) {
  if (sourceControlClients.find(tracker) !== undefined) {
    return getSourceControlPresentationForKind(tracker);
  }
  return STANDALONE_TRACKERS[tracker] ?? { providerName: tracker, Icon: TicketIcon };
}

/**
 * Open and completed borrow the ink the pull-request states use for open and merged, so green
 * and violet mean the same thing on both pages; closed any other way than completed wears a
 * draft's grey, because work that stopped must not look like work that finished. The tracker's own state name is the label,
 * so a workflow tracker's "In Review" reads as itself.
 */
export function issueStatePresentation(state: IssueState) {
  if (state.category === "open") {
    return {
      ...PULL_REQUEST_STATE_PRESENTATION.open,
      label: state.name,
      Icon: CircleDotIcon,
    };
  }
  if (state.closeReason !== undefined && state.closeReason !== "completed") {
    return {
      ...PULL_REQUEST_STATE_PRESENTATION.draft,
      label: state.name,
      Icon: CircleSlashIcon,
    };
  }
  return {
    ...PULL_REQUEST_STATE_PRESENTATION.merged,
    label: state.name,
    Icon: CircleCheckIcon,
  };
}

export function IssueStateGlyph({ state, className }: { state: IssueState; className?: string }) {
  const presentation = issueStatePresentation(state);
  return (
    // The list row is itself a button, so the trigger stays a span.
    <RowTooltip
      render={<span className="inline-flex shrink-0" />}
      popup={<TooltipPopup>{presentation.label}</TooltipPopup>}
    >
      <presentation.Icon
        role="img"
        aria-label={presentation.label}
        className={cn("size-4 shrink-0", presentation.toneClassName, className)}
      />
    </RowTooltip>
  );
}

import type { IssueState, IssueTrackerKind } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { CircleCheckIcon, CircleDotIcon, CircleSlashIcon, TicketIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";

export const IssueGlyph = { issue: CircleDotIcon } as const;

/** A git host's tracker wears the host's own icon and name; a standalone tracker wears its kind. */
export function issueTrackerPresentation(tracker: IssueTrackerKind | string) {
  if (sourceControlClients.find(tracker) !== undefined) {
    return getSourceControlPresentationForKind(tracker);
  }
  return { providerName: tracker, Icon: TicketIcon };
}

/**
 * Open and completed borrow the ink the pull-request states use for open and merged, so green
 * and violet mean the same thing on both pages; not planned wears a draft's grey, because work
 * that stopped must not look like work that finished. The tracker's own state name is the label,
 * so a workflow tracker's "In Review" reads as itself.
 */
export function resolveIssueStatePresentation(state: IssueState) {
  if (state.category === "open") {
    return {
      ...PULL_REQUEST_STATE_PRESENTATION.open,
      label: state.name === "open" ? "Open" : state.name,
      Icon: CircleDotIcon,
    };
  }
  if (state.closeReason === "not-planned") {
    return {
      ...PULL_REQUEST_STATE_PRESENTATION.draft,
      label: "Closed as not planned",
      Icon: CircleSlashIcon,
    };
  }
  return {
    ...PULL_REQUEST_STATE_PRESENTATION.merged,
    label:
      state.name === "closed"
        ? state.closeReason === "completed"
          ? "Closed as completed"
          : "Closed"
        : state.name,
    Icon: CircleCheckIcon,
  };
}

export function IssueStateGlyph({ state, className }: { state: IssueState; className?: string }) {
  const presentation = resolveIssueStatePresentation(state);
  return (
    <Tooltip>
      {/* The list row is itself a button, so the trigger stays a span. */}
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <presentation.Icon
          role="img"
          aria-label={presentation.label}
          className={cn("size-4 shrink-0", presentation.toneClassName, className)}
        />
      </TooltipTrigger>
      <TooltipPopup>{presentation.label}</TooltipPopup>
    </Tooltip>
  );
}

/** "completed" → "Completed"; a reason the tracker spells with a dash reads as words. */
export function issueCloseReasonLabel(reason: string): string {
  const words = reason.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

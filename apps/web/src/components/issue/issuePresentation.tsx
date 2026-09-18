import type { IssueCloseReason, IssueProviderKind, IssueState } from "@t3tools/contracts";
import { CircleCheckIcon, CircleDotIcon, CircleSlashIcon, TicketIcon } from "lucide-react";
import { pullRequestLabelColor } from "../pullRequest/pullRequestList.logic";

import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";
import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LinearIcon } from "../Icons";

interface StatePresentation {
  readonly label: string;
  readonly toneClassName: string;
  readonly Icon: typeof CircleDotIcon;
}

export function getIssueProviderPresentation(kind: IssueProviderKind) {
  switch (kind) {
    case "github":
    case "gitlab":
    case "azure-devops":
    case "bitbucket":
    case "unknown":
      return getSourceControlPresentationForKind(kind);
    case "linear":
      return { providerName: "Linear", Icon: LinearIcon };
    default:
      return { providerName: kind, Icon: TicketIcon };
  }
}

/**
 * How an issue's state reads on this page. Open and completed borrow the ink the pull request
 * states already use for open and merged, so green and violet mean the same thing on both
 * surfaces; not planned wears the grey a draft does, because work that stopped is not work that
 * finished and the two must not look alike.
 *
 * Only GitHub records why an issue was closed, so a closed issue with no reason reads as
 * completed — which is what closing one means everywhere that never asks.
 */
export function resolveIssueState(input: {
  readonly state: IssueState;
  readonly stateReason: IssueCloseReason | null;
}): StatePresentation {
  if (input.state === "open") {
    return {
      label: "Open",
      toneClassName: "text-emerald-600 dark:text-emerald-300/90",
      Icon: CircleDotIcon,
    };
  }
  if (input.stateReason === "not-planned") {
    return {
      label: "Closed as not planned",
      toneClassName: "text-zinc-500 dark:text-zinc-400/80",
      Icon: CircleSlashIcon,
    };
  }
  return {
    label: "Closed as completed",
    toneClassName: "text-violet-600 dark:text-violet-300/90",
    Icon: CircleCheckIcon,
  };
}

export function IssueStateGlyph({
  state,
  stateReason,
  className,
}: {
  state: IssueState;
  stateReason: IssueCloseReason | null;
  className?: string;
}) {
  const presentation = resolveIssueState({ state, stateReason });
  return (
    <Tooltip>
      {/* The list row is itself a button, so the trigger stays a span: an interactive one would
          nest a control inside that button and steal the row's click target. */}
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

const LABEL_SLOTS = [
  { pill: "", overflow: "@xl/pr-row-meta:hidden" },
  { pill: "hidden @xl/pr-row-meta:inline-flex", overflow: "@3xl/pr-row-meta:hidden" },
  { pill: "hidden @3xl/pr-row-meta:inline-flex", overflow: "" },
] as const;

export function IssueRowLabels({
  labels,
}: {
  labels: ReadonlyArray<{ name: string; color: string | null }>;
}) {
  if (labels.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {LABEL_SLOTS.map((slot, index) => {
        const label = labels[index];
        if (!label) return null;
        const dot = pullRequestLabelColor(label.color);
        const remaining = labels.length - index - 1;
        return (
          <span
            key={label.name}
            className={cn(
              "inline-flex max-w-40 min-w-0 items-center gap-1 rounded-full border border-border/70 bg-muted/40 py-0 pl-1 pr-1.5 text-[10px] leading-3.5 text-muted-foreground",
              slot.pill,
            )}
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-muted-foreground"
              {...(dot ? { style: { backgroundColor: dot } } : {})}
            />
            <span className="truncate">{label.name}</span>
            {remaining > 0 ? (
              <span className={cn("shrink-0", slot.overflow)}>+{remaining}</span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

export function IssueLabelChips({
  labels,
}: {
  labels: ReadonlyArray<{ name: string; color: string | null }>;
}) {
  return (
    <>
      {labels.map((label) => {
        const dot = pullRequestLabelColor(label.color);
        return (
          <span
            key={label.name}
            className="inline-flex max-w-48 items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 py-0.5 pl-1.5 pr-2 text-xs"
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-muted-foreground"
              {...(dot ? { style: { backgroundColor: dot } } : {})}
            />
            <span className="truncate">{label.name}</span>
          </span>
        );
      })}
    </>
  );
}

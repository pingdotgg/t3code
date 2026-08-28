import type {
  IssueCloseReason,
  IssueLabel,
  IssueProviderKind,
  IssueState,
} from "@t3tools/contracts";
import { CircleCheckIcon, CircleDotIcon, CircleSlashIcon, TicketIcon } from "lucide-react";
import type { CSSProperties } from "react";

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

/**
 * Hosts write a label colour every one of these ways, and none of them with an alpha channel.
 * Checked rather than trusted: the value reaches a style attribute, and anything that is not a
 * colour would be one the browser silently keeps from whatever was set before.
 */
const HEX_COLOR_PATTERN = /^#?(?:[\da-f]{3}|[\da-f]{6})$/iu;

/**
 * A label's own colour, worn the way the hosts wear it: a wash of the colour rather than the
 * colour itself, an edge a shade stronger, and the name in the colour pulled far enough towards
 * the page's own ink to stay legible — half the palettes on offer are pale enough that the raw
 * colour disappears against a light page and glares against a dark one.
 *
 * Mixed in CSS rather than computed here, so one set of numbers reads correctly in both themes.
 * Nothing at all where the host gave no usable colour, which leaves the neutral chip standing.
 */
function labelStyle(color: string | null): CSSProperties | undefined {
  if (color === null || !HEX_COLOR_PATTERN.test(color.trim())) return undefined;
  const hex = `#${color.trim().replace(/^#/u, "")}`;
  return {
    backgroundColor: `color-mix(in oklab, ${hex} 18%, transparent)`,
    borderColor: `color-mix(in oklab, ${hex} 35%, transparent)`,
    color: `color-mix(in oklab, ${hex} 70%, var(--foreground))`,
  };
}

/**
 * The labels a row wears, capped: an issue carrying nine of them would otherwise push everything
 * the row is about off its own line. What is left over is counted rather than dropped silently,
 * and named in the count's title so the reader can still find out what they were.
 */
export function IssueLabelChips({
  labels,
  max = 3,
  className,
}: {
  labels: ReadonlyArray<IssueLabel>;
  max?: number;
  className?: string;
}) {
  if (labels.length === 0) return null;
  const shown = labels.slice(0, max);
  const hidden = labels.slice(max);
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      {shown.map((label) => (
        <Tooltip key={label.name}>
          <TooltipTrigger
            render={
              <span
                style={labelStyle(label.color)}
                className="max-w-28 shrink-0 truncate rounded-full border border-border/60 px-1.5 text-[10px] leading-4 font-medium"
              />
            }
          >
            {label.name}
          </TooltipTrigger>
          <TooltipPopup side="top">{label.name}</TooltipPopup>
        </Tooltip>
      ))}
      {hidden.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={<span className="shrink-0 text-[10px] text-muted-foreground/70" />}
          >
            +{hidden.length}
          </TooltipTrigger>
          <TooltipPopup side="top">{hidden.map((label) => label.name).join(", ")}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}

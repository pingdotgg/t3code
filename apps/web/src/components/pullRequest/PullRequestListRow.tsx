import type {
  PullRequestActor,
  PullRequestLabel,
  PullRequestMergeability,
  PullRequestState,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { MiddleTruncate } from "../ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PullRequestActorAvatar,
  PullRequestConflictGlyph,
  PullRequestLabelChip,
  PullRequestStateGlyph,
} from "./pullRequestPresentation";

export const PULL_REQUEST_ROW_CLASS =
  "group/pr-row flex w-full items-center gap-2 rounded-md py-1 pr-1 text-left";

export const PULL_REQUEST_ROW_NUMBER_CLASS =
  "shrink-0 font-mono text-xs tabular-nums text-muted-foreground";

export function PullRequestRowGlyph({
  state,
  isDraft,
  mergeability,
  baseBranch,
  below,
  className,
}: {
  state: PullRequestState;
  isDraft: boolean;
  mergeability?: PullRequestMergeability | undefined;
  baseBranch?: string | undefined;
  below?: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("flex w-4 shrink-0 flex-col items-center gap-0.5", className)}>
      <span className="relative inline-flex">
        <PullRequestStateGlyph state={state} isDraft={isDraft} />
        {/* The wrapper takes the offset, not the icon, so the tooltip trigger inside keeps the
            badge's size and anchors the popup to it. */}
        <span className="absolute -right-1 -bottom-1 inline-flex">
          <PullRequestConflictGlyph
            state={state}
            isDraft={isDraft}
            {...(mergeability === undefined ? {} : { mergeability })}
            {...(baseBranch === undefined ? {} : { baseBranch })}
            className="size-3 fill-background [stroke-width:2.5]"
          />
        </span>
      </span>
      {below ? <span className="inline-flex text-2xs">{below}</span> : null}
    </span>
  );
}

export function PullRequestRowLines({
  number,
  title,
  status,
  signals,
  meta,
  metaClassName,
  updatedAt,
}: {
  number: ReactNode;
  title: ReactNode;
  status?: ReactNode;
  signals?: ReactNode;
  meta?: ReactNode;
  metaClassName?: string;
  updatedAt?: string | null | undefined;
}) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex min-w-0 items-center gap-1.5">
        {number}
        <span className="min-w-0 truncate text-sm">{title}</span>
        {signals ? (
          <span className="flex shrink-0 items-center gap-1 text-2xs">{signals}</span>
        ) : null}
        {status ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-2xs">{status}</span>
        ) : null}
      </span>
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted-foreground",
          metaClassName,
        )}
      >
        {meta}
        {updatedAt ? (
          <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums">
            {formatRelativeTimeLabel(updatedAt)}
          </span>
        ) : null}
      </span>
    </span>
  );
}

export function PullRequestRowAuthor({
  actor,
  className,
  labelClassName,
}: {
  actor: PullRequestActor | null;
  className?: string;
  labelClassName?: string;
}) {
  const login = actor?.login ?? "ghost";
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={cn("inline-flex min-w-0 items-center gap-1", className)} />}
      >
        <PullRequestActorAvatar actor={actor} className="size-3.5" />
        <span className={cn("truncate", labelClassName)}>{login}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {actor?.name && actor.name !== login ? `${actor.name} (@${login})` : login}
      </TooltipPopup>
    </Tooltip>
  );
}

export function PullRequestRowBranches({ head, base }: { head: string; base: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 font-mono">
      <MiddleTruncate value={head} />
      <span className="shrink-0">→</span>
      <MiddleTruncate value={base} className="max-w-[45%] shrink-0" />
    </span>
  );
}

const LABEL_SLOTS = [
  { overflow: "@xl/pr-row-meta:hidden" },
  { overflow: "@3xl/pr-row-meta:hidden" },
  { overflow: "" },
] as const;

export function PullRequestRowLabels({
  labels,
}: {
  labels: ReadonlyArray<Pick<PullRequestLabel, "name" | "color">>;
}) {
  if (labels.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {LABEL_SLOTS.map((slot, index) => {
        const label = labels[index];
        if (!label) return null;
        const remaining = labels.length - index - 1;
        return (
          <PullRequestLabelChip
            key={slot.overflow}
            label={label}
            className={
              index === 0
                ? ""
                : index === 1
                  ? "hidden @xl/pr-row-meta:inline-flex"
                  : "hidden @3xl/pr-row-meta:inline-flex"
            }
          >
            {remaining > 0 ? (
              <span className={cn("shrink-0", slot.overflow)}>+{remaining}</span>
            ) : null}
          </PullRequestLabelChip>
        );
      })}
    </span>
  );
}

export const PULL_REQUEST_PAGE_ROW_CLASS =
  "min-w-0 flex-1 cursor-pointer px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

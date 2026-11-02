import type {
  PullRequestActor,
  PullRequestMergeability,
  PullRequestState,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { RelativeTime } from "~/components/RelativeTime";

import { MiddleTruncate } from "../ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PullRequestActorAvatar,
  PullRequestConflictGlyph,
  PullRequestStateGlyph,
} from "./pullRequestPresentation";

export const PULL_REQUEST_ROW_CLASS =
  "group/pr-row flex w-full items-center gap-2 rounded-row py-1 pr-1 text-left";

export const PULL_REQUEST_ROW_NUMBER_CLASS =
  "shrink-0 font-mono text-xs tabular-nums text-dim-foreground";

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
        {/* Offset the wrapper to keep the badge-sized tooltip trigger anchored. */}
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
  metaStatus,
  updatedAt,
  layout = "panel",
}: {
  number: ReactNode;
  title: ReactNode;
  status?: ReactNode;
  signals?: ReactNode;
  meta?: ReactNode;
  metaClassName?: string;
  /** Right of the second line, before the time: what the pull request is waiting on. */
  metaStatus?: ReactNode;
  updatedAt?: string | null | undefined;
  /**
   * The page reads title first with the number after it, on two looser lines; the panel's
   * narrow column leads with the number.
   */
  layout?: "panel" | "page";
}) {
  const page = layout === "page";
  const time = updatedAt ? (
    <span className="shrink-0 whitespace-nowrap tabular-nums text-dim-foreground">
      <RelativeTime timestamp={updatedAt} />
    </span>
  ) : null;
  return (
    <span className={cn("min-w-0 flex-1", page && "flex flex-col gap-1.25")}>
      <span className={cn("flex min-w-0 items-center", page ? "gap-2" : "gap-1.5")}>
        {page ? null : number}
        <span
          className={cn(
            "min-w-0 truncate text-sm text-foreground",
            page ? "font-normal" : "font-medium",
          )}
        >
          {title}
        </span>
        {page ? number : null}
        {signals ? (
          <span className="flex shrink-0 items-center gap-1 text-caption">{signals}</span>
        ) : null}
        {status ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-caption">{status}</span>
        ) : null}
      </span>
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5 overflow-hidden text-muted-foreground",
          page ? "text-meta" : "text-caption",
          metaClassName,
        )}
      >
        {meta}
        {page ? (
          <span className="ml-auto flex min-w-0 max-w-3/5 shrink-0 items-center gap-1.5 pl-2">
            {metaStatus}
            {metaStatus && time ? (
              <span aria-hidden className="text-dim-foreground">
                ·
              </span>
            ) : null}
            {time}
          </span>
        ) : time ? (
          <span className="ml-auto flex shrink-0">{time}</span>
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

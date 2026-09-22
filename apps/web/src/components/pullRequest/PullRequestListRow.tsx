import type {
  PullRequestActor,
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
  PullRequestStateGlyph,
} from "./pullRequestPresentation";

/**
 * The one row shape both pull request lists share: the full page and a thread's linked panel.
 * A status column, then two lines — number and title with the diff counts on the right;
 * author and whatever else the caller shows under them with the time on the right. The column
 * stacks the lifecycle glyph over the checks glyph, so what a pull request is and how it is
 * doing read top to bottom at the left edge, and the right edge is only numbers and time. The
 * page puts repository and labels there, the panel puts the branches there. The caller owns
 * the wrapper (a link on the panel, a button on the page) and hands in the slots.
 */
export const PULL_REQUEST_ROW_CLASS =
  "group/pr-row flex w-full items-center gap-2 rounded-md py-1 pr-1 text-left";

export const PULL_REQUEST_ROW_NUMBER_CLASS =
  "shrink-0 font-mono text-xs tabular-nums text-muted-foreground";

/**
 * The conflict warning rides the corner of the lifecycle glyph, over the arrow's merge circle,
 * so the leading slot stays one icon wide and titles line up whether or not a row is blocked.
 * The background fill cuts it out of the glyph beneath.
 */
export function PullRequestRowGlyph({
  state,
  isDraft,
  inMergeQueue,
  mergeability,
  baseBranch,
  below,
  className,
}: {
  state: PullRequestState;
  isDraft: boolean;
  inMergeQueue?: boolean | undefined;
  mergeability?: PullRequestMergeability | undefined;
  baseBranch?: string | undefined;
  /** Under the lifecycle glyph, level with the second line: the checks glyph. */
  below?: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("flex w-4 shrink-0 flex-col items-center gap-0.5", className)}>
      <span className="relative inline-flex">
        <PullRequestStateGlyph state={state} isDraft={isDraft} inMergeQueue={inMergeQueue} />
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
      {below ? <span className="inline-flex text-[11px]">{below}</span> : null}
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
  /** The `#n` reference, already wrapped in whatever tooltip or menu the caller wants on it. */
  number: ReactNode;
  title: ReactNode;
  /** Right end of the first line: stack, diff counts. */
  status?: ReactNode;
  /** Right after the title text: checks and review verdict glyphs. */
  signals?: ReactNode;
  /** Left of the second line: author, then repository and labels or the branches. */
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
          <span className="flex shrink-0 items-center gap-1 text-[11px]">{signals}</span>
        ) : null}
        {status ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px]">{status}</span>
        ) : null}
      </span>
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-muted-foreground",
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

/** Avatar and login at the meta line's own size, with the actor's full name on hover. */
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

/**
 * `head → base`, in the mono the branches are typed in, each cut in the middle when the row is
 * short of room. The base keeps its width up to a share of the line, so a long head cannot
 * squeeze a short `main` out; the arrow stays readable so the two are not read as one name.
 */
export function PullRequestRowBranches({ head, base }: { head: string; base: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 font-mono">
      <MiddleTruncate value={head} />
      <span className="shrink-0">→</span>
      <MiddleTruncate value={base} className="max-w-[45%] shrink-0" />
    </span>
  );
}

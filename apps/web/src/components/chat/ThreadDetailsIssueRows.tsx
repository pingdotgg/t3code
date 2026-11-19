import { threadIssueKeyOf, type ScopedThreadRef, type ThreadIssueLink } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { MessageSquareIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useServerConfigs } from "~/state/entities";
import { useLinkedIssueDetail } from "~/state/issues";

import {
  IssueGlyph,
  issueStatePresentation,
  issueTrackerPresentation,
} from "../issue/issuePresentation";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import { PullRequestActorLabel } from "../pullRequest/pullRequestPresentation";
import { ThreadPullRequestMiniListItem } from "../ThreadStatusIndicators";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * How a linked issue row is drawn: thread details' two-line row, the linked items panel's
 * pull request row, or the sidebar hover list's one line.
 */
export type LinkedIssueRowVariant = "compact" | "panel" | "mini";

function LinkedIssueRow({
  link,
  threadRef,
  variant,
  mountScope,
  openWith,
}: {
  link: ThreadIssueLink;
  threadRef: ScopedThreadRef;
  variant: LinkedIssueRowVariant;
  mountScope: "thread-details" | "linked-items" | "sidebar-tooltip";
  openWith: ((open: () => void) => void) | undefined;
}) {
  const gt = useGT();
  const configs = useServerConfigs();
  const detail = useLinkedIssueDetail(threadRef.environmentId, link, mountScope);
  const trackerPresentation = issueTrackerPresentation(link.tracker);
  const state = detail === null ? null : issueStatePresentation(detail.state);
  const Icon = state?.Icon ?? IssueGlyph.issue;
  const title = detail?.title ?? link.title;
  const anchorProps = {
    href: link.url,
    target: "_blank",
    rel: "noopener noreferrer",
    "aria-label": gt("Issue {key}: {title}", { key: link.displayKey, title }),
    onClick: (event: MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (configs.get(threadRef.environmentId)?.environment.capabilities.issues !== true) return;
      event.preventDefault();
      const open = () => useRightPanelStore.getState().openIssue(threadRef, link);
      if (openWith) openWith(open);
      else open();
    },
  };
  const glyph = (
    <Icon
      aria-hidden={state === null ? true : undefined}
      role={state === null ? undefined : "img"}
      aria-label={state?.label}
      className={cn("size-4 shrink-0", state?.toneClassName ?? "text-muted-foreground")}
    />
  );
  const comments =
    detail !== null && detail.commentCount > 0 ? (
      <span
        role="img"
        aria-label={gt("{count, plural, one {{count} comment} other {{count} comments}}", {
          count: detail.commentCount,
        })}
        className="inline-flex shrink-0 items-center gap-0.5 tabular-nums"
      >
        <MessageSquareIcon aria-hidden className="size-3" />
        <span aria-hidden>{detail.commentCount}</span>
      </span>
    ) : null;
  const trackerIcon = (
    <trackerPresentation.Icon
      role="img"
      aria-label={trackerPresentation.providerName}
      className="size-3 shrink-0"
    />
  );
  const lines = (
    <>
      {glyph}
      <PullRequestRowLines
        number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>{link.displayKey}</span>}
        title={title}
        status={comments}
        meta={
          <>
            {detail?.author ? (
              <PullRequestActorLabel actor={detail.author} tooltip={false} />
            ) : null}
            {trackerIcon}
            <span className="truncate">{link.scope}</span>
          </>
        }
        updatedAt={detail?.updatedAt ?? link.linkedAt}
      />
    </>
  );
  if (variant === "mini") {
    return (
      <ThreadPullRequestMiniListItem
        keyLabel={link.displayKey}
        url={link.url}
        title={title}
        presentation={state ?? { Icon: IssueGlyph.issue, toneClassName: "" }}
        ariaLabel={anchorProps["aria-label"]}
        onOpenPullRequest={(event) => anchorProps.onClick(event)}
      />
    );
  }
  return variant === "compact" ? (
    <div className="flex min-h-9 min-w-0 items-center gap-2.5 ps-2.5 pe-1">
      {glyph}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={<ThreadDetailsControl part="heading" render={<a {...anchorProps} />} />}
          >
            <span className="truncate text-meta text-foreground">{title}</span>
          </TooltipTrigger>
          <TooltipPopup
            side="top"
            align="start"
            variant="popover"
            className="w-80 max-w-[calc(100vw-2rem)] text-left whitespace-normal"
          >
            <div className="flex min-w-0 items-center gap-2">{lines}</div>
          </TooltipPopup>
        </Tooltip>
        <div className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
          <span className="shrink-0 tabular-nums">{link.displayKey}</span>
          {trackerIcon}
          {comments}
        </div>
      </div>
    </div>
  ) : (
    // The linked items panel's pull request row: content on the panel's 16px lines.
    <a
      {...anchorProps}
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        "relative ps-2.5 pr-2.5 hover:surface-ghost-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
    >
      {lines}
    </a>
  );
}

export function ThreadDetailsIssueRows({
  links,
  threadRef,
  variant = "compact",
  mountScope = "thread-details",
  openWith,
}: {
  links: ReadonlyArray<ThreadIssueLink>;
  threadRef: ScopedThreadRef;
  variant?: LinkedIssueRowVariant;
  mountScope?: "thread-details" | "linked-items" | "sidebar-tooltip";
  /** Runs the open itself, for a caller that must show the thread first. */
  openWith?: (open: () => void) => void;
}) {
  const rows = links.map((link) => (
    <LinkedIssueRow
      key={threadIssueKeyOf(link)}
      link={link}
      threadRef={threadRef}
      variant={variant}
      mountScope={mountScope}
      openWith={openWith}
    />
  ));
  return variant === "mini" ? <ul className="flex flex-col gap-1">{rows}</ul> : rows;
}

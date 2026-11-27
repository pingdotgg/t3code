import { threadIssueKeyOf, type ScopedThreadRef, type ThreadIssueLink } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useGT } from "gt-react";
import { MessageSquareIcon } from "lucide-react";
import { useState, type MouseEvent } from "react";

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
import {
  PAGE_ROW_CLASS,
  PAGE_ROW_HOVER_CLASS,
  PAGE_ROW_PRESS_CLASS,
} from "../pullRequest/PullRequestRow";
import { ThreadDetailsControl, ThreadDetailsMoreButton } from "./ThreadDetailsControl";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

function LinkedIssueRow({
  link,
  threadRef,
  compact,
  mountScope,
  onOpen,
}: {
  link: ThreadIssueLink;
  threadRef: ScopedThreadRef;
  compact: boolean;
  mountScope: "thread-details" | "linked-items" | "sidebar-tooltip";
  onOpen: (() => void) | undefined;
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
      useRightPanelStore.getState().openIssue(threadRef, link);
      onOpen?.();
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
  return compact ? (
    <div className="flex min-h-9 min-w-0 items-center gap-2.5 ps-2.5 pe-1">
      {glyph}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <SharedTooltipTrigger
          render={<ThreadDetailsControl part="heading" render={<a {...anchorProps} />} />}
          label={<div className="flex min-w-0 items-center gap-2">{lines}</div>}
          align="start"
          variant="popover"
          className="w-80 max-w-[calc(100vw-2rem)] text-left whitespace-normal"
        >
          <span className="truncate text-meta text-foreground">{title}</span>
        </SharedTooltipTrigger>
        <div className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
          <span aria-hidden className="shrink-0 tabular-nums">
            {link.displayKey}
          </span>
          {trackerIcon}
          {comments}
        </div>
      </div>
    </div>
  ) : (
    <a
      {...anchorProps}
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        PAGE_ROW_CLASS,
        PAGE_ROW_HOVER_CLASS,
        PAGE_ROW_PRESS_CLASS,
      )}
    >
      {lines}
    </a>
  );
}

export function ThreadDetailsIssueRows({
  links,
  threadRef,
  compact = true,
  mountScope = "thread-details",
  onOpen,
}: {
  links: ReadonlyArray<ThreadIssueLink>;
  threadRef: ScopedThreadRef;
  compact?: boolean;
  mountScope?: "thread-details" | "linked-items" | "sidebar-tooltip";
  onOpen?: () => void;
}) {
  const [expandedThread, setExpandedThread] = useState<string | null>(null);
  const threadKey = scopedThreadKey(threadRef);
  const expanded = expandedThread === threadKey;
  const row = (link: ThreadIssueLink) => (
    <LinkedIssueRow
      key={threadIssueKeyOf(link)}
      link={link}
      threadRef={threadRef}
      compact={compact}
      mountScope={mountScope}
      onOpen={onOpen}
    />
  );
  const [first, ...rest] = links;
  if (first === undefined || !compact || rest.length === 0) return <>{links.map(row)}</>;
  return (
    <>
      {row(first)}
      {expanded ? (
        <div data-thread-details-issue-list className="flex flex-col">
          {rest.map(row)}
        </div>
      ) : null}
      <ThreadDetailsMoreButton
        expanded={expanded}
        remaining={rest.length}
        onToggle={() => setExpandedThread(expanded ? null : threadKey)}
      />
    </>
  );
}

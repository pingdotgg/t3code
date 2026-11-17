import { threadIssueKeyOf, type ScopedThreadRef, type ThreadIssueLink } from "@t3tools/contracts";
import { MessageSquareIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useServerConfigs } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";

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
import { ThreadDetailsControl } from "./ThreadDetailsControl";

function LinkedIssueRow({
  link,
  threadRef,
  compact,
  onOpen,
}: {
  link: ThreadIssueLink;
  threadRef: ScopedThreadRef;
  compact: boolean;
  onOpen: (() => void) | undefined;
}) {
  const { environmentId } = threadRef;
  const configs = useServerConfigs();
  const { projectId, tracker, host, scope, key } = link;
  const detail = useEnvironmentQuery(
    configs.get(environmentId)?.environment.capabilities.issues === true
      ? issueEnvironment.detail({ environmentId, input: { projectId, tracker, host, scope, key } })
      : null,
  ).data;
  const trackerPresentation = issueTrackerPresentation(tracker);
  const state = detail === null ? null : issueStatePresentation(detail.state);
  const Icon = state?.Icon ?? IssueGlyph.issue;
  const title = detail?.title ?? link.title;
  const anchorProps = {
    href: link.url,
    target: "_blank",
    rel: "noopener noreferrer",
    "aria-label": `Issue ${link.displayKey}: ${title}`,
    onClick: (event: MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      useRightPanelStore.getState().openIssue(threadRef, link);
      onOpen?.();
    },
  };
  const lines = (
    <>
      <Icon
        aria-hidden={state === null ? true : undefined}
        role={state === null ? undefined : "img"}
        aria-label={state?.label}
        className={cn("size-4 shrink-0", state?.toneClassName ?? "text-muted-foreground")}
      />
      <PullRequestRowLines
        number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>{link.displayKey}</span>}
        title={title}
        status={
          detail !== null && detail.commentCount > 0 ? (
            <span
              role="img"
              aria-label={`${detail.commentCount} comments`}
              className="inline-flex items-center gap-0.5 tabular-nums"
            >
              <MessageSquareIcon aria-hidden className="size-3" />
              <span aria-hidden>{detail.commentCount}</span>
            </span>
          ) : null
        }
        meta={
          <>
            {detail?.author ? (
              <PullRequestActorLabel actor={detail.author} tooltip={false} />
            ) : null}
            <trackerPresentation.Icon
              role="img"
              aria-label={trackerPresentation.providerName}
              className="size-3 shrink-0"
            />
            <span className="truncate">{scope}</span>
          </>
        }
        updatedAt={detail?.updatedAt ?? link.linkedAt}
      />
    </>
  );
  return compact ? (
    <ThreadDetailsControl part="row" multiline render={<a {...anchorProps} />}>
      {lines}
    </ThreadDetailsControl>
  ) : (
    <a
      {...anchorProps}
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        "px-2 hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
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
  onOpen,
}: {
  links: ReadonlyArray<ThreadIssueLink>;
  threadRef: ScopedThreadRef;
  compact?: boolean;
  onOpen?: () => void;
}) {
  return links.map((link) => (
    <LinkedIssueRow
      key={threadIssueKeyOf(link)}
      link={link}
      threadRef={threadRef}
      compact={compact}
      onOpen={onOpen}
    />
  ));
}

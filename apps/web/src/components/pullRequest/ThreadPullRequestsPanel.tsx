import type { ScopedThreadRef, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  resolveThreadPullRequestChains,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import {
  GitPullRequestArrow,
  LayersIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import { Schema } from "effect";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { useServerConfigs, useThreadShell } from "~/state/entities";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { openLinkPullRequestDialog } from "./LinkPullRequestDialog";
import { pullRequestListLines, type PullRequestListLine } from "./pullRequestListLines";
import {
  PullRequestActorAvatar,
  PullRequestDiffStat,
  PullRequestApprovalGlyph,
  PullRequestStateGlyph,
  pullRequestChecksStatePresentation,
} from "./pullRequestPresentation";

const ThreadPullRequestSort = Schema.Literals(["activity", "number"]);

const SOURCE_LABELS: Record<ThreadPullRequestLink["source"], string> = {
  manual: "Linked by you",
  created: "Created from this thread",
  agent: "Linked by the agent",
  stack: "Found in the stack",
  "stack-dismissed": "Dismissed",
};

function ChecksGlyph({
  state,
}: {
  state: NonNullable<ThreadPullRequestLink["snapshot"]>["checksState"] & string;
}) {
  const presentation = pullRequestChecksStatePresentation(state);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <presentation.Icon
          role="img"
          aria-label={presentation.label}
          className={cn("size-3.5", presentation.toneClassName)}
        />
      </TooltipTrigger>
      <TooltipPopup>{presentation.label}</TooltipPopup>
    </Tooltip>
  );
}

function LinkRow({
  line,
  threadRef,
  onUnlink,
}: {
  line: PullRequestListLine;
  threadRef: ScopedThreadRef;
  onUnlink: (link: ThreadPullRequestLink) => void;
}) {
  const openPrLink = useOpenPrLink(threadRef);
  const { link, depth, stack } = line;
  const snapshot = link.snapshot;
  return (
    <div
      className="group/pr-row flex items-center gap-2 rounded-md py-1 pr-1 hover:bg-accent/60"
      // Each layer steps in under the one it targets. The step is capped: beyond a few layers
      // the indent only says "still in the stack", which the connector line already does, and
      // a sixteen-layer stack would otherwise stair-step off the right edge.
      style={{ paddingLeft: `${0.5 + Math.min(depth, 3) * 1.25}rem` }}
    >
      {depth > 0 ? <span aria-hidden className="-ml-2 h-6 w-px shrink-0 bg-border/70" /> : null}
      {snapshot === null ? (
        <GitPullRequestArrow
          aria-label="Waiting for host state"
          className="size-4 shrink-0 text-muted-foreground"
        />
      ) : (
        <PullRequestStateGlyph state={snapshot.state} isDraft={snapshot.isDraft} />
      )}
      <a
        href={link.url}
        onClick={(event) => openPrLink(event, link.url, threadRef)}
        className="min-w-0 flex-1"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground" />
              }
            >
              #{link.number}
            </TooltipTrigger>
            <TooltipPopup>
              {SOURCE_LABELS[link.source]} · {formatRelativeTimeLabel(link.linkedAt)}
            </TooltipPopup>
          </Tooltip>
          <span className="min-w-0 flex-1 truncate text-sm">
            {snapshot?.title ?? link.repository}
          </span>
          {/* Match the full PR list: review verdict, checks, then diff counts.
              Each is absent rather than neutral when the
              host said nothing, so a row without them reads as unknown, not as fine. */}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px]">
            {snapshot?.state === "open" &&
            (snapshot.reviewDecision === "approved" ||
              snapshot.reviewDecision === "changes-requested") ? (
              snapshot.reviewDecision === "approved" ? (
                <PullRequestApprovalGlyph />
              ) : (
                <span className="text-amber-600/90 dark:text-amber-400/80">Changes requested</span>
              )
            ) : null}
            {snapshot?.state === "open" && snapshot.mergeability === "conflicting" ? (
              <span className="text-destructive">Conflicts</span>
            ) : null}
            {snapshot?.checksState ? <ChecksGlyph state={snapshot.checksState} /> : null}
            <PullRequestDiffStat
              additions={snapshot?.additions ?? 0}
              deletions={snapshot?.deletions ?? 0}
              className="font-mono"
            />
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {stack ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-foreground/70" />
                }
              >
                {stack.kind === "native" ? (
                  <LayersIcon aria-hidden className="size-3" />
                ) : (
                  <GitPullRequestArrow aria-hidden className="size-3" />
                )}
                {stack.size}
              </TooltipTrigger>
              <TooltipPopup>
                {stack.kind === "native"
                  ? `GitHub stack of ${stack.size}: merging a layer lands the ones below it.`
                  : `${stack.size} pull requests chained by base branch.`}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {snapshot?.author ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <PullRequestActorAvatar actor={snapshot.author} className="size-3.5" />
              <span className="max-w-28 truncate">{snapshot.author.login}</span>
            </span>
          ) : null}
          <span className="truncate font-mono">
            {snapshot !== null
              ? `${snapshot.headBranch} → ${snapshot.baseBranch}`
              : `${link.host}/${link.repository}`}
          </span>
          {snapshot?.updatedAt ? (
            <span className="ml-auto shrink-0">{formatRelativeTimeLabel(snapshot.updatedAt)}</span>
          ) : null}
        </span>
      </a>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Actions for #${link.number}`}
              className={cn(
                "opacity-0 group-hover/pr-row:opacity-100 data-[popup-open]:opacity-100",
              )}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          }
        />
        <MenuPopup align="end" side="bottom">
          <MenuItem onClick={() => void writeTextToClipboard(link.url, "link")}>Copy link</MenuItem>
          <MenuItem onClick={(event) => openPrLink(event, link.url, threadRef)}>Open</MenuItem>
          <MenuItem onClick={() => onUnlink(link)}>
            {link.source === "stack" ? "Dismiss from thread" : "Unlink from thread"}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

export function ThreadPullRequestsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const configs = useServerConfigs();
  if (configs.get(threadRef.environmentId)?.environment.capabilities.threadPullRequests !== true) {
    return (
      <PullRequestsUnavailableState
        title="Linked pull requests unavailable"
        error="This environment does not support multiple linked pull requests."
      />
    );
  }
  return <EnabledThreadPullRequestsPanel threadRef={threadRef} />;
}

function EnabledThreadPullRequestsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const [sort, setSort] = useLocalStorage(
    "t3code:thread-pull-requests:sort",
    "activity",
    ThreadPullRequestSort,
  );
  const openLinkDialog = useCallback(() => openLinkPullRequestDialog(threadRef), [threadRef]);
  const unlink = useAtomCommand(threadEnvironment.unlinkPullRequest, { reportFailure: true });
  const links = useMemo(() => visibleThreadPullRequests(thread?.pullRequests ?? []), [thread]);
  const lines = useMemo(
    () => pullRequestListLines(resolveThreadPullRequestChains(links), sort),
    [links, sort],
  );
  const handleUnlink = useCallback(
    (link: ThreadPullRequestLink) => {
      void unlink({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          host: link.host,
          repository: link.repository,
          number: link.number,
        },
      });
    },
    [threadRef, unlink],
  );
  const openCount = useMemo(
    () => links.filter((link) => link.snapshot === null || link.snapshot.state === "open").length,
    [links],
  );
  const lastSynced = useMemo(() => {
    let latest: string | null = null;
    for (const link of links) {
      const at = link.snapshot?.syncedAt;
      if (at !== undefined && (latest === null || at > latest)) latest = at;
    }
    return latest;
  }, [links]);

  if (links.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <LinkIcon aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No linked pull requests</p>
        <p className="max-w-60 text-xs text-muted-foreground">
          Pull requests the agent opens from this thread land here. Link one yourself from a URL or
          a number.
        </p>
        <Button size="sm" variant="outline" onClick={openLinkDialog}>
          <PlusIcon className="size-3.5" />
          Link pull request
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-end border-b border-border/60 px-2 py-1.5">
        <ToggleGroup
          aria-label="Sort linked pull requests"
          variant="segmented"
          value={[sort]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "activity" || next === "number") setSort(next);
          }}
        >
          <Toggle value="activity" aria-label="Sort by latest activity">
            Activity
          </Toggle>
          <Toggle value="number" aria-label="Sort by highest PR number">
            Number
          </Toggle>
        </ToggleGroup>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-1.5">
          {lines.map((line) => (
            <LinkRow
              key={`${line.link.host}/${line.link.repository}#${line.link.number}`}
              line={line}
              threadRef={threadRef}
              onUnlink={handleUnlink}
            />
          ))}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-[.7rem] text-muted-foreground">
        <span>
          {openCount} open · {links.length} linked
          {lastSynced ? ` · synced ${formatRelativeTimeLabel(lastSynced)}` : ""}
        </span>
        <Button size="xs" variant="ghost" onClick={openLinkDialog}>
          <PlusIcon className="size-3.5" />
          Link
        </Button>
      </footer>
    </div>
  );
}

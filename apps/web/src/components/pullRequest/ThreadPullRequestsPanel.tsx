import type { ProjectId, ScopedThreadRef, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  sourceControlClients,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
} from "@t3tools/client-runtime/source-control-clients";
import {
  resolveThreadPullRequestChains,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import {
  ArrowUpRightIcon,
  EyeIcon,
  EyeOffIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { findProjectForChangeRequest, useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { useShortcutModifierState } from "~/shortcutModifierState";
import { useProjects, useServerConfigs, useThreadShell } from "~/state/entities";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openLinkPullRequestDialog } from "./LinkPullRequestDialog";
import { pullRequestListLines, type PullRequestListLine } from "./pullRequestListLines";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowBranches,
  PullRequestRowGlyph,
  PullRequestRowLines,
} from "./PullRequestListRow";
import {
  PullRequestDiffStat,
  PullRequestReviewDecisionGlyph,
  pullRequestChecksStatePresentation,
} from "./pullRequestPresentation";
import { PullRequestGlyph } from "./pullRequestIcons";
import { pullRequestQuickActions } from "./pullRequestList.logic";
import { PullRequestSpeedActions } from "./PullRequestSpeedActions";

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
  projectId,
  speedMode,
  onUnlink,
  onSetWatching,
}: {
  line: PullRequestListLine;
  threadRef: ScopedThreadRef;
  projectId: ProjectId | null;
  speedMode: boolean;
  onUnlink: (link: ThreadPullRequestLink) => void;
  /** Null when the environment cannot watch pull requests. */
  onSetWatching: ((link: ThreadPullRequestLink, watching: boolean) => void) | null;
}) {
  const openPrLink = useOpenPrLink(threadRef);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuAnchor = useMemo(
    () =>
      menuPosition
        ? { getBoundingClientRect: () => new DOMRect(menuPosition.x, menuPosition.y, 0, 0) }
        : undefined,
    [menuPosition],
  );
  const { link, depth, stack } = line;
  const snapshot = link.snapshot;
  const open = snapshot === null || snapshot.state === "open";
  const watching = link.watch !== undefined;
  // A link carries no host summary, so the host's own definition says what it can do.
  const linkHostActions = (
    sourceControlClients.findByChangeRequestUrl(link.url) ?? UNKNOWN_SOURCE_CONTROL_CLIENT
  ).changeRequestActions;
  const actionEntry =
    projectId !== null && snapshot !== null && snapshot.state !== "merged"
      ? {
          environmentId: threadRef.environmentId,
          projectId,
          host: link.host,
          repository: link.repository,
          number: link.number,
          state: snapshot.state,
          isDraft: snapshot.isDraft,
          ...(link.stack === null ? {} : { stack: link.stack }),
        }
      : null;
  // Speed mode swaps the menu for quick actions only where a row has some to offer.
  const hasQuickActions =
    actionEntry !== null && pullRequestQuickActions(actionEntry, linkHostActions).length > 0;
  return (
    <div
      className={cn(PULL_REQUEST_ROW_CLASS, "relative hover:bg-accent/60")}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenuPosition({ x: event.clientX, y: event.clientY });
        setMenuOpen(true);
      }}
      // Each layer steps in under the one it targets. The step is capped: beyond a few layers
      // the indent only says "still in the stack", which the connector line already does, and
      // a sixteen-layer stack would otherwise stair-step off the right edge.
      style={{ paddingLeft: `${0.5 + Math.min(depth, 3) * 1.25}rem` }}
    >
      {depth > 0 ? <span aria-hidden className="-ml-2 h-6 w-px shrink-0 bg-border/70" /> : null}
      {snapshot === null ? (
        <PullRequestGlyph.pullRequest
          aria-label="Waiting for host state"
          className="size-4 shrink-0 text-muted-foreground"
        />
      ) : (
        <PullRequestRowGlyph
          state={snapshot.state}
          isDraft={snapshot.isDraft}
          mergeability={snapshot.mergeability}
          baseBranch={snapshot.baseBranch}
        />
      )}
      <a
        href={link.url}
        onClick={(event) => openPrLink(event, link.url, threadRef)}
        className="flex min-w-0 flex-1"
      >
        <PullRequestRowLines
          number={
            <Tooltip>
              <TooltipTrigger render={<span className={PULL_REQUEST_ROW_NUMBER_CLASS} />}>
                #{link.number}
              </TooltipTrigger>
              <TooltipPopup>
                {SOURCE_LABELS[link.source]} · {formatRelativeTimeLabel(link.linkedAt)}
              </TooltipPopup>
            </Tooltip>
          }
          title={snapshot?.title ?? link.repository}
          signals={
            open ? (
              <>
                {watching ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                      <EyeIcon role="img" aria-label="Watching" className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipPopup>
                      Watching: the agent wakes when checks finish, someone comments, or the branch
                      conflicts
                    </TooltipPopup>
                  </Tooltip>
                ) : null}
                {snapshot?.checksState ? <ChecksGlyph state={snapshot.checksState} /> : null}
                {snapshot?.reviewDecision ? (
                  <PullRequestReviewDecisionGlyph decision={snapshot.reviewDecision} />
                ) : null}
              </>
            ) : null
          }
          // Match the full PR list: diff counts up top, checks under the lifecycle glyph, the
          // verdict by the author. Each is absent rather than neutral when the host said
          // nothing, so a row without them reads as unknown, not as fine.
          status={
            <PullRequestDiffStat
              additions={snapshot?.additions ?? 0}
              deletions={snapshot?.deletions ?? 0}
              className="font-mono"
            />
          }
          meta={
            <>
              {stack ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-foreground/70" />
                    }
                  >
                    <PullRequestGlyph.stack aria-hidden className="size-3" />
                    {stack.size}
                  </TooltipTrigger>
                  <TooltipPopup>
                    {stack.kind === "native"
                      ? `${sourceControlClients.hostLabelForChangeRequestUrl(link.url)} stack of ${stack.size}: merging a layer lands the ones below it.`
                      : `${stack.size} pull requests chained by base branch.`}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              {snapshot?.author ? (
                <PullRequestRowAuthor
                  actor={snapshot.author}
                  className="shrink-0"
                  labelClassName="max-w-28"
                />
              ) : null}
              {snapshot !== null ? (
                <>
                  {/* Cut in the middle: rows from one owner differ in the repository name at the
                      end, which a tail cut would hide. */}
                  <Tooltip>
                    <TooltipTrigger render={<span className="flex min-w-0 max-w-32 font-mono" />}>
                      <MiddleTruncate value={link.repository} showTitle={false} />
                    </TooltipTrigger>
                    <TooltipPopup>{link.repository}</TooltipPopup>
                  </Tooltip>
                  <PullRequestRowBranches head={snapshot.headBranch} base={snapshot.baseBranch} />
                </>
              ) : (
                <span className="truncate font-mono">
                  {link.host}/{link.repository}
                </span>
              )}
            </>
          }
          updatedAt={snapshot?.updatedAt}
        />
      </a>
      {actionEntry !== null ? (
        <PullRequestSpeedActions
          entry={actionEntry}
          hostActions={linkHostActions}
          visible={speedMode}
        />
      ) : null}
      {/* Out of the row's flow, so no row reserves a column for a button only the hovered one
          shows. It sits over the right end of the second line on the row's own hover color,
          fading in from the left, so it covers the time and leaves the diff counts alone. */}
      <span
        className={cn(
          "absolute right-0 bottom-0.5 flex items-center rounded-r-md bg-background pr-1 pl-5",
          "[mask-image:linear-gradient(to_right,transparent,black_1rem)]",
          // Hidden means untouchable too: on a touch screen there is no hover, and an invisible
          // layer over the right of the row would otherwise swallow the tap meant for the link.
          "pointer-events-none opacity-0 group-hover/pr-row:pointer-events-auto group-hover/pr-row:opacity-100",
          "has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100",
          "has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100",
          "group-has-[[data-pull-request-action-pending=true]]/pr-row:hidden",
          speedMode && hasQuickActions && "hidden",
        )}
      >
        <span aria-hidden className="absolute inset-0 bg-accent/60" />
        <Menu
          open={menuOpen}
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (!open) setMenuPosition(null);
          }}
        >
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-micro"
                aria-label={`Actions for #${link.number}`}
                className="relative"
              >
                <MoreHorizontalIcon className="size-3.5" />
              </Button>
            }
          />
          <MenuPopup
            anchor={menuAnchor}
            align={menuPosition ? "start" : "end"}
            side="bottom"
            sideOffset={menuPosition ? 0 : 4}
          >
            <MenuItem onClick={() => void writeTextToClipboard(link.url, "link")}>
              <LinkIcon className="size-3.5" />
              Copy link
            </MenuItem>
            <MenuItem onClick={(event) => openPrLink(event, link.url, threadRef)}>
              <ArrowUpRightIcon className="size-3.5" />
              Open
            </MenuItem>
            {onSetWatching !== null && open ? (
              <MenuItem onClick={() => onSetWatching(link, !watching)}>
                {watching ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                {watching ? "Stop watching" : "Watch for changes"}
              </MenuItem>
            ) : null}
            <MenuItem onClick={() => onUnlink(link)}>
              <PullRequestGlyph.unlink className="size-3.5" />
              {link.source === "stack" ? "Dismiss from thread" : "Unlink from thread"}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </span>
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
  const projects = useProjects();
  const environmentProjects = useMemo(
    () =>
      projects
        .filter((project) => project.environmentId === threadRef.environmentId)
        .toSorted((left, right) =>
          left.id === thread?.projectId ? -1 : right.id === thread?.projectId ? 1 : 0,
        ),
    [projects, threadRef.environmentId, thread?.projectId],
  );
  const modifiers = useShortcutModifierState(true);
  const speedMode =
    modifiers.shiftKey && !modifiers.metaKey && !modifiers.ctrlKey && !modifiers.altKey;
  const openLinkDialog = useCallback(() => openLinkPullRequestDialog(threadRef), [threadRef]);
  const unlink = useAtomCommand(threadEnvironment.unlinkPullRequest, { reportFailure: true });
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  const capabilities = useServerConfigs().get(threadRef.environmentId)?.environment.capabilities;
  const supportsWatch = capabilities?.threadPullRequestWatch === true;
  const links = useMemo(() => visibleThreadPullRequests(thread?.pullRequests ?? []), [thread]);
  const lines = useMemo(() => pullRequestListLines(resolveThreadPullRequestChains(links)), [links]);
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
  const handleSetWatching = useCallback(
    (link: ThreadPullRequestLink, watching: boolean) => {
      void watch({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          host: link.host,
          repository: link.repository,
          number: link.number,
          watching,
        },
      });
    },
    [threadRef, watch],
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
        <PullRequestGlyph.link aria-hidden className="size-6 text-muted-foreground/60" />
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
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-1.5">
          {lines.map((line) => (
            <LinkRow
              key={`${line.link.host}/${line.link.repository}#${line.link.number}`}
              line={line}
              threadRef={threadRef}
              projectId={
                capabilities?.pullRequests === true
                  ? (findProjectForChangeRequest(environmentProjects, line.link)?.id ??
                    thread?.projectId ??
                    null)
                  : null
              }
              speedMode={speedMode}
              onUnlink={handleUnlink}
              onSetWatching={supportsWatch ? handleSetWatching : null}
            />
          ))}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
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

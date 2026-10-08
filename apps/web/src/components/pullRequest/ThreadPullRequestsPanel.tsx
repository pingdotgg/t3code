import {
  formatIssueReference,
  SourceControlProviderKind,
  type IssueLinkedPullRequest,
  type IssueRelative,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadIssueLink,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";
import {
  resolveThreadPullRequestChains,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import {
  ArrowUpRightIcon,
  CircleDotIcon,
  EyeIcon,
  EyeOffIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useMemo, useState, type MouseEvent, type ReactNode } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import {
  findProjectForLink,
  linkedPullRequestTarget,
  openLinkInBrowser,
  relatedIssueTarget,
} from "~/lib/openIssueLink";
import {
  findProjectForChangeRequest,
  shouldOpenPullRequestExternally,
  useOpenPrLink,
} from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
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
import { ThreadIssueTrees } from "../issue/ThreadIssueTrees";
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
import { resolveIssueState } from "../issue/issuePresentation";
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

function useRowMenu() {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const anchor = useMemo(
    () =>
      position
        ? { getBoundingClientRect: () => new DOMRect(position.x, position.y, 0, 0) }
        : undefined,
    [position],
  );
  return {
    open,
    position,
    anchor,
    onOpenChange: (next: boolean) => {
      setOpen(next);
      if (!next) setPosition(null);
    },
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setPosition({ x: event.clientX, y: event.clientY });
      setOpen(true);
    },
  };
}

function RowMenu({
  label,
  children,
  menu,
  hidden = false,
}: {
  label: string;
  children: ReactNode;
  menu: ReturnType<typeof useRowMenu>;
  hidden?: boolean;
}) {
  return (
    // Out of the row's flow, so no row reserves a column for a button only the hovered one
    // shows. It sits over the right end of the second line on the row's own hover color,
    // fading in from the left, so it covers the time and leaves the diff counts alone.
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
        hidden && "hidden",
      )}
    >
      <span aria-hidden className="absolute inset-0 bg-accent/60" />
      <Menu open={menu.open} onOpenChange={menu.onOpenChange}>
        <MenuTrigger
          render={
            <Button variant="ghost" size="icon-micro" aria-label={label} className="relative">
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          }
        />
        <MenuPopup
          anchor={menu.anchor}
          align={menu.position ? "start" : "end"}
          side="bottom"
          sideOffset={menu.position ? 0 : 4}
        >
          {children}
        </MenuPopup>
      </Menu>
    </span>
  );
}

const isSourceControlProvider = Schema.is(SourceControlProviderKind);

function IssueRow({
  issue,
  onUnlink,
}: {
  issue: ThreadIssueLink;
  onUnlink: (issue: ThreadIssueLink) => void;
}) {
  const menu = useRowMenu();
  const presentation =
    issue.state === undefined ? null : resolveIssueState({ state: issue.state, stateReason: null });
  const Icon = presentation?.Icon ?? CircleDotIcon;
  const openIssue = (event: MouseEvent<HTMLElement>) => {
    if (shouldOpenPullRequestExternally(event)) return;
    event.preventDefault();
    openLinkInBrowser(issue.url);
  };
  return (
    <div
      className={cn(PULL_REQUEST_ROW_CLASS, "relative pl-2 hover:bg-accent/60")}
      onContextMenu={menu.onContextMenu}
    >
      <Icon
        role="img"
        aria-label={presentation?.label ?? "Issue"}
        className={cn("size-4 shrink-0", presentation?.toneClassName ?? "text-muted-foreground")}
      />
      <a href={issue.url} onClick={openIssue} className="flex min-w-0 flex-1">
        <PullRequestRowLines
          number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>#{issue.number}</span>}
          title={issue.title}
          meta={
            <span className="flex min-w-0 max-w-32 font-mono">
              <MiddleTruncate value={issue.repository} />
            </span>
          }
        />
      </a>
      <RowMenu label={`Actions for issue #${issue.number}`} menu={menu}>
        <MenuItem onClick={() => void writeTextToClipboard(issue.url, "link")}>
          <LinkIcon className="size-3.5" />
          Copy link
        </MenuItem>
        <MenuItem onClick={() => openLinkInBrowser(issue.url)}>
          <ArrowUpRightIcon className="size-3.5" />
          Open on host
        </MenuItem>
        <MenuItem onClick={() => onUnlink(issue)}>
          <PullRequestGlyph.unlink className="size-3.5" />
          Unlink from thread
        </MenuItem>
      </RowMenu>
    </div>
  );
}

function IssueTreeActions({
  issue,
  onUnlink,
}: {
  issue: ThreadIssueLink;
  onUnlink: (issue: ThreadIssueLink) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-micro"
            aria-label={`Actions for issue ${formatIssueReference({
              ...issue,
              referenceStyle: issue.provider === "linear" ? "key-number" : "hash",
            })}`}
          >
            <MoreHorizontalIcon className="size-3.5" />
          </Button>
        }
      />
      <MenuPopup align="end" side="bottom" sideOffset={4}>
        <MenuItem onClick={() => void writeTextToClipboard(issue.url, "link")}>
          <LinkIcon className="size-3.5" />
          Copy link
        </MenuItem>
        <MenuItem onClick={() => openLinkInBrowser(issue.url)}>
          <ArrowUpRightIcon className="size-3.5" />
          Open on host
        </MenuItem>
        <MenuItem onClick={() => onUnlink(issue)}>
          <PullRequestGlyph.unlink className="size-3.5" />
          Unlink from thread
        </MenuItem>
      </MenuPopup>
    </Menu>
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
  const menu = useRowMenu();
  const { link, depth, stack } = line;
  const snapshot = link.snapshot;
  const open = snapshot === null || snapshot.state === "open";
  const watching = link.watch !== undefined;
  const actionEntry =
    projectId !== null &&
    snapshot !== null &&
    snapshot.state !== "merged" &&
    detectSourceControlProviderFromRemoteUrl(link.url)?.kind === "github"
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
  return (
    <div
      className={cn(PULL_REQUEST_ROW_CLASS, "relative hover:bg-accent/60")}
      onContextMenu={menu.onContextMenu}
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
                      ? `GitHub stack of ${stack.size}: merging a layer lands the ones below it.`
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
        <PullRequestSpeedActions entry={actionEntry} visible={speedMode} />
      ) : null}
      <RowMenu
        label={`Actions for #${link.number}`}
        menu={menu}
        hidden={speedMode && actionEntry !== null}
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
      </RowMenu>
    </div>
  );
}

export function ThreadPullRequestsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const capabilities = useServerConfigs().get(threadRef.environmentId)?.environment.capabilities;
  if (capabilities?.threadPullRequests !== true && capabilities?.issues !== true) {
    return (
      <PullRequestsUnavailableState
        title="Linked items unavailable"
        error="This environment does not support linked pull requests or issues."
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
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: true });
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  const capabilities = useServerConfigs().get(threadRef.environmentId)?.environment.capabilities;
  const supportsWatch = capabilities?.threadPullRequestWatch === true;
  const supportsPullRequests = capabilities?.threadPullRequests === true;
  const supportsIssues = capabilities?.issues === true;
  const links = useMemo(
    () => (supportsPullRequests ? visibleThreadPullRequests(thread?.pullRequests ?? []) : []),
    [supportsPullRequests, thread],
  );
  const lines = useMemo(() => pullRequestListLines(resolveThreadPullRequestChains(links)), [links]);
  const issues = useMemo(() => thread?.issues ?? [], [thread]);
  // The project an issue is read through, by its saved project, its host URL, or — for a
  // tracker with no repository of its own — the thread's project.
  const issueProjectId = useCallback(
    (issue: ThreadIssueLink): ProjectId | null => {
      if (!supportsIssues) return null;
      const environmentProjects = projects.filter(
        (candidate) => candidate.environmentId === threadRef.environmentId,
      );
      const project =
        issue.projectId !== undefined
          ? environmentProjects.find((candidate) => candidate.id === issue.projectId)
          : isSourceControlProvider(issue.provider)
            ? findProjectForLink(environmentProjects, issue)
            : environmentProjects.find((candidate) => candidate.id === thread?.projectId);
      return project?.id ?? null;
    },
    [projects, supportsIssues, thread?.projectId, threadRef.environmentId],
  );
  const openThreadIssue = useCallback(
    (issue: ThreadIssueLink, relative: Pick<IssueRelative, "repository" | "number" | "url">) => {
      const projectId = issueProjectId(issue);
      const target =
        projectId === null
          ? null
          : relatedIssueTarget(
              environmentProjects,
              { projectId, repository: issue.repository },
              relative,
            );
      if (target === null) {
        openLinkInBrowser(relative.url);
        return;
      }
      useRightPanelStore.getState().openIssue(threadRef, { ...target, provider: issue.provider });
    },
    [environmentProjects, issueProjectId, threadRef],
  );
  const openTreePullRequest = useCallback(
    (link: IssueLinkedPullRequest) => {
      const project = findProjectForLink(
        projects.filter((candidate) => candidate.environmentId === threadRef.environmentId),
        link,
      );
      if (!supportsPullRequests || project === undefined) {
        openLinkInBrowser(link.url);
        return;
      }
      useRightPanelStore
        .getState()
        .openPullRequest(threadRef, linkedPullRequestTarget(project, link));
    },
    [projects, supportsPullRequests, threadRef],
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
  const handleUnlinkIssue = useCallback(
    (issue: ThreadIssueLink) => {
      void updateMetadata({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          issueUnlink: {
            provider: issue.provider,
            repository: issue.repository,
            number: issue.number,
            url: issue.url,
          },
        },
      });
    },
    [threadRef, updateMetadata],
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
    () =>
      links.filter((link) => link.snapshot === null || link.snapshot.state === "open").length +
      issues.filter((issue) => issue.state !== "closed").length,
    [issues, links],
  );
  const lastSynced = useMemo(() => {
    let latest: string | null = null;
    for (const link of links) {
      const at = link.snapshot?.syncedAt;
      if (at !== undefined && (latest === null || at > latest)) latest = at;
    }
    return latest;
  }, [links]);

  if (links.length === 0 && issues.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <PullRequestGlyph.link aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No linked items</p>
        <p className="max-w-60 text-xs text-muted-foreground">
          Pull requests and issues linked to this thread appear here. Paste a URL or enter a number
          to link one.
        </p>
        <Button size="sm" variant="outline" onClick={openLinkDialog}>
          <PlusIcon className="size-3.5" />
          Link
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
          {issues.length > 0 ? (
            <ThreadIssueTrees
              className={lines.length > 0 ? "mt-1.5" : undefined}
              environmentId={threadRef.environmentId}
              threadRef={threadRef}
              linked={issues}
              projectFor={issueProjectId}
              onOpen={openThreadIssue}
              onOpenPullRequest={openTreePullRequest}
              renderFallback={(issue) => <IssueRow issue={issue} onUnlink={handleUnlinkIssue} />}
              renderActions={(issue) => (
                <IssueTreeActions issue={issue} onUnlink={handleUnlinkIssue} />
              )}
            />
          ) : null}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
        <span>
          {openCount} open · {links.length + issues.length} linked
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

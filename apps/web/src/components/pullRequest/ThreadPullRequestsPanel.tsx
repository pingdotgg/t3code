import type { ProjectId, ScopedThreadRef, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  sourceControlClients,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
} from "@t3tools/client-runtime/source-control-clients";
import {
  type PullRequestListLine,
  pullRequestListLines,
  resolveThreadPullRequestChains,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import { canStartThreadPullRequestWatch } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import {
  ArrowUpRightIcon,
  EyeIcon,
  EyeOffIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "lucide-react";
import { LegendList } from "@legendapp/list/react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { memo, useState } from "react";

import {
  COMPOSER_PULL_REQUEST_DRAG_TYPE,
  encodePullRequestDragPayload,
} from "~/components/chat/composerMentionDrag";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { findProjectForChangeRequest } from "@t3tools/client-runtime/change-request-links";
import { pullRequestLinkPanelTarget, useOpenPrLink } from "~/lib/openPullRequestLink";
import { useClientSettings } from "~/hooks/useSettings";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { usePullRequestIntentPrefetch } from "./usePullRequestIntentPrefetch";
import { cn } from "~/lib/utils";
import { useShortcutModifierState } from "~/shortcutModifierState";
import { useProjects, useServerConfigs, useThreadShell } from "~/state/entities";
import { PullRequestChangeBreakdownStat } from "./PullRequestChangeBreakdownStat";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { RelativeTime } from "~/components/RelativeTime";
import { PanelEmptyState } from "../PanelEmptyState";
import { ThreadDetailsIssueRows } from "../chat/ThreadDetailsIssueRows";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openLinkPullRequestDialog } from "./LinkPullRequestDialog";
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
import { PullRequestSpeedActions, PullRequestSpeedModeContext } from "./PullRequestSpeedActions";

import { changeRequestTermKind } from "./changeRequestTerm";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

const SOURCE_LABELS: Record<ThreadPullRequestLink["source"], string> = {
  manual: msg("Linked by you"),
  created: msg("Created from this thread"),
  agent: msg("Linked by the agent"),
  stack: msg("Found in the stack"),
  "stack-dismissed": msg("Dismissed", { $context: "pull request link source" }),
};

function ChecksGlyph({
  state,
}: {
  state: NonNullable<ThreadPullRequestLink["snapshot"]>["checksState"] & string;
}) {
  const resolve = useMessages();
  const presentation = pullRequestChecksStatePresentation(state, resolve);
  return (
    <SharedTooltipTrigger
      render={<span className="inline-flex shrink-0" />}
      label={presentation.label}
    >
      <presentation.Icon
        role="img"
        aria-label={presentation.label}
        className={cn("size-3.5", presentation.toneClassName)}
      />
    </SharedTooltipTrigger>
  );
}

function LinkRowImpl({
  line,
  threadRef,
  projectId,
  speedMode,
  onUnlink,
  onSetWatching,
  onIntent,
  canStartWatch,
}: {
  line: PullRequestListLine;
  threadRef: ScopedThreadRef;
  projectId: ProjectId | null;
  speedMode: boolean;
  onUnlink: (link: ThreadPullRequestLink) => void;
  onSetWatching: ((link: ThreadPullRequestLink, watching: boolean) => void) | null;
  onIntent: (link: ThreadPullRequestLink | null) => void;
  canStartWatch: boolean;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const openPrLink = useOpenPrLink(threadRef);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuAnchor = menuPosition
    ? { getBoundingClientRect: () => new DOMRect(menuPosition.x, menuPosition.y, 0, 0) }
    : undefined;
  const { link, depth, stack } = line;
  const snapshot = link.snapshot;
  const open = snapshot === null || snapshot.state === "open";
  const watching = link.watch !== undefined;
  const linkHost =
    sourceControlClients.findByChangeRequestUrl(link.url) ?? UNKNOWN_SOURCE_CONTROL_CLIENT;
  const linkHostActions = linkHost.changeRequestActions;
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
  const hasQuickActions =
    actionEntry !== null && pullRequestQuickActions(actionEntry, linkHostActions).length > 0;
  return (
    <div
      // Content on the panel's 16px lines: the 6px list inset plus 10px of row padding a side.
      className={cn(PULL_REQUEST_ROW_CLASS, "relative pr-2.5 hover:surface-ghost-hover")}
      onPointerEnter={() => onIntent(link)}
      onPointerLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) onIntent(null);
      }}
      onFocus={() => onIntent(link)}
      onBlur={(event) => {
        if (!event.currentTarget.matches(":hover")) onIntent(null);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenuPosition({ x: event.clientX, y: event.clientY });
        setMenuOpen(true);
      }}
      style={{ paddingLeft: `${0.625 + Math.min(depth, 3) * 1.25}rem` }}
    >
      {depth > 0 ? <span aria-hidden className="-ml-2 h-6 w-px shrink-0 bg-border" /> : null}
      {snapshot === null ? (
        <PullRequestGlyph.pullRequest
          aria-label={gt("Waiting for host state")}
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
        // Outside drops use the URL; the composer uses this context-chip payload.
        onDragStart={
          snapshot === null
            ? undefined
            : (event) =>
                event.dataTransfer.setData(
                  COMPOSER_PULL_REQUEST_DRAG_TYPE,
                  encodePullRequestDragPayload({
                    number: link.number,
                    title: snapshot.title,
                    url: link.url,
                    headBranch: snapshot.headBranch,
                    baseBranch: snapshot.baseBranch,
                    state: snapshot.state,
                    isDraft: snapshot.isDraft,
                  }),
                )
        }
        className="flex min-w-0 flex-1"
      >
        <PullRequestRowLines
          number={
            // The repository lives here, not on the meta line, so the branches get its room.
            <SharedTooltipTrigger
              render={<span className={PULL_REQUEST_ROW_NUMBER_CLASS} />}
              label={
                <span className="flex flex-col gap-0.5">
                  <span>{link.repository}</span>
                  <span>{resolve(SOURCE_LABELS[link.source])}</span>
                  <span>
                    <T context="followed by a relative time such as 5m ago or just now">
                      linked{" "}
                      <Var>
                        <RelativeTime timestamp={link.linkedAt} />
                      </Var>
                    </T>
                  </span>
                </span>
              }
            >
              #{link.number}
            </SharedTooltipTrigger>
          }
          title={snapshot?.title ?? link.repository}
          signals={
            open ? (
              <>
                {watching ? (
                  <SharedTooltipTrigger
                    render={<span className="inline-flex shrink-0" />}
                    label={
                      <>
                        <T>
                          Watching: the agent wakes when checks finish, someone comments, or the
                          branch conflicts
                        </T>
                      </>
                    }
                  >
                    <EyeIcon role="img" aria-label={gt("Watching")} className="size-3.5" />
                  </SharedTooltipTrigger>
                ) : null}
                {snapshot?.checksState ? <ChecksGlyph state={snapshot.checksState} /> : null}
                {snapshot?.reviewDecision ? (
                  <PullRequestReviewDecisionGlyph decision={snapshot.reviewDecision} />
                ) : null}
              </>
            ) : null
          }
          status={
            projectId === null ? (
              <PullRequestDiffStat
                additions={snapshot?.additions ?? 0}
                deletions={snapshot?.deletions ?? 0}
                className="font-mono"
              />
            ) : (
              <PullRequestChangeBreakdownStat
                environmentId={threadRef.environmentId}
                reference={{
                  projectId,
                  host: link.host,
                  repository: link.repository,
                  number: link.number,
                }}
                additions={snapshot?.additions ?? 0}
                deletions={snapshot?.deletions ?? 0}
                className="font-mono"
              />
            )
          }
          meta={
            <>
              {stack ? (
                <SharedTooltipTrigger
                  render={
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-foreground/70" />
                  }
                  label={
                    stack.kind === "native"
                      ? gt("{host} stack of {size}: merging a layer lands the ones below it.", {
                          host: sourceControlClients.hostLabelForChangeRequestUrl(link.url),
                          size: stack.size,
                        })
                      : gt(
                          "{size} {terms, select, mr {merge requests} cr {change requests} other {pull requests}} chained by base branch.",
                          {
                            size: stack.size,
                            terms: changeRequestTermKind(linkHost.changeRequest),
                          },
                        )
                  }
                >
                  <PullRequestGlyph.stack aria-hidden className="size-3" />
                  {stack.size}
                </SharedTooltipTrigger>
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
          terminology={linkHost.changeRequest}
        />
      ) : null}
      <span
        className={cn(
          "absolute right-0 bottom-0.5 flex items-center rounded-r-md bg-background pr-1 pl-5",
          "[mask-image:linear-gradient(to_right,transparent,black_1rem)]",
          // Hidden controls would intercept link taps on touch screens.
          "pointer-events-none opacity-0 group-hover/pr-row:pointer-events-auto group-hover/pr-row:opacity-100",
          "has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100",
          "has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100",
          // The row's quick actions come right before this span.
          "[[data-pull-request-action-pending=true]~&]:hidden",
          speedMode && hasQuickActions && "hidden",
        )}
      >
        <span aria-hidden className="absolute inset-0 surface-ghost-hover" />
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
                aria-label={gt("Actions for #{number}", { number: link.number })}
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
            <MenuItem
              onClick={() =>
                void writeTextToClipboard(link.url, {
                  target: "link",
                  unavailableMessage: msg("Clipboard API is unavailable while copying link."),
                  failureMessage: msg("Failed to copy link to the clipboard."),
                })
              }
            >
              <LinkIcon className="size-3.5" />
              <T>Copy link</T>
            </MenuItem>
            <MenuItem onClick={(event) => openPrLink(event, link.url, threadRef)}>
              <ArrowUpRightIcon className="size-3.5" />
              <T context="verb, open a link">Open</T>
            </MenuItem>
            {onSetWatching !== null && open && (watching || canStartWatch) ? (
              <MenuItem onClick={() => onSetWatching(link, !watching)}>
                {watching ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                {watching ? gt("Stop watching") : gt("Watch for changes")}
              </MenuItem>
            ) : null}
            <MenuItem onClick={() => onUnlink(link)}>
              <PullRequestGlyph.unlink className="size-3.5" />
              {link.source === "stack" ? gt("Dismiss from thread") : gt("Unlink from thread")}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </span>
    </div>
  );
}

const LinkRow = memo(LinkRowImpl);

function latestSyncedAt(links: ReadonlyArray<ThreadPullRequestLink>): string | null {
  let latest: string | null = null;
  for (const link of links) {
    const at = link.snapshot?.syncedAt;
    if (at !== undefined && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

const lineKey = (line: PullRequestListLine) =>
  `${line.link.host}/${line.link.repository}#${line.link.number}`;

export function ThreadPullRequestsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const configs = useServerConfigs();
  if (configs.get(threadRef.environmentId) === undefined) {
    return (
      <PullRequestsUnavailableState
        title={gt("Linked items unavailable")}
        error={gt("The thread's environment is not available.")}
      />
    );
  }
  return <EnabledThreadPullRequestsPanel threadRef={threadRef} />;
}

function EnabledThreadPullRequestsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const thread = useThreadShell(threadRef);
  const issues = thread?.issues ?? [];
  const projects = useProjects();
  const environmentProjects = projects
    .filter((project) => project.environmentId === threadRef.environmentId)
    .toSorted((left, right) =>
      left.id === thread?.projectId ? -1 : right.id === thread?.projectId ? 1 : 0,
    );
  // Derive lines before later hooks to preserve compiler caching and avoid LegendList renders.
  const links = visibleThreadPullRequests(thread?.pullRequests ?? []);
  const lines = pullRequestListLines(resolveThreadPullRequestChains(links));
  const openCount = links.filter(
    (link) => link.snapshot === null || link.snapshot.state === "open",
  ).length;
  const lastSynced = latestSyncedAt(links);
  const linkCount = links.length;
  const modifiers = useShortcutModifierState(true);
  const speedMode =
    modifiers.shiftKey && !modifiers.metaKey && !modifiers.ctrlKey && !modifiers.altKey;
  const openLinkDialog = () => openLinkPullRequestDialog(threadRef);
  const unlink = useAtomCommand(threadEnvironment.unlinkPullRequest, { reportFailure: true });
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  const capabilities = useServerConfigs().get(threadRef.environmentId)?.environment.capabilities;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const opensInApp = useClientSettings((settings) => settings.pullRequestLinksOpenInApp);
  const { prefetch, reads: intentReads } = usePullRequestIntentPrefetch((target) =>
    links.some(
      (link) =>
        link.number === target.number &&
        link.repository.toLowerCase() === target.repository.toLowerCase(),
    ),
  );
  const intendLink = (link: ThreadPullRequestLink | null) => {
    const target =
      link === null || !opensInApp
        ? null
        : pullRequestLinkPanelTarget({
            url: link.url,
            environmentId: threadRef.environmentId,
            primaryEnvironmentId,
            lendHostProject: true,
          });
    prefetch(
      target?.host === undefined
        ? null
        : {
            environmentId: target.project.environmentId,
            projectId: target.project.id,
            host: target.host,
            repository: target.repository,
            number: target.number,
          },
    );
  };
  const supportsWatch = capabilities?.threadPullRequestWatch === true;
  const canStartWatch = thread !== null && canStartThreadPullRequestWatch(thread);
  const handleUnlink = (link: ThreadPullRequestLink) => {
    void unlink({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        host: link.host,
        repository: link.repository,
        number: link.number,
      },
    });
  };
  const handleSetWatching = (link: ThreadPullRequestLink, watching: boolean) => {
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
  };

  // Legend rows update only for data/extraData changes; include all external inputs.
  const rowInputs = {
    speedMode,
    environmentProjects,
    capabilities,
    supportsWatch,
    thread,
    opensInApp,
    primaryEnvironmentId,
  };

  if (linkCount === 0 && issues.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <PanelEmptyState
          icon={<PullRequestGlyph.link />}
          title={<T>No linked pull requests</T>}
          description={
            <T>
              Pull requests the agent opens from this thread land here. Link one yourself from a URL
              or a number.
            </T>
          }
          action={
            <Button size="sm" variant="secondary" onClick={openLinkDialog}>
              <PlusIcon className="size-3.5" />
              <T>Link pull request</T>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <PullRequestSpeedModeContext value={speedMode}>
      {intentReads}
      {/* The list scrolls up under a pane's tab row (--surface-top-inset). */}
      <div
        className="flex h-[calc(100%+var(--surface-top-inset,0px))] min-h-0 flex-col"
        data-surface-reaches-under-header=""
      >
        {/* Threads that run a stack or a sweep link hundreds of pull requests; only the rows in
          view are mounted. */}
        <LegendList<PullRequestListLine>
          data={lines}
          keyExtractor={lineKey}
          extraData={rowInputs}
          ListHeaderComponent={
            issues.length > 0 ? (
              <>
                <section aria-label={gt("Linked issues")} className="flex flex-col">
                  <h2 className="px-2.5 pt-1 pb-1 text-meta text-muted-foreground">
                    <T>Issues</T>
                  </h2>
                  <ThreadDetailsIssueRows
                    links={issues}
                    threadRef={threadRef}
                    variant="panel"
                    mountScope="linked-items"
                  />
                </section>
                {linkCount > 0 ? (
                  <h2 className="mt-2 border-t border-border px-2.5 pt-2 pb-1 text-meta text-muted-foreground">
                    <T>Pull requests</T>
                  </h2>
                ) : null}
              </>
            ) : null
          }
          renderItem={({ item: line }) => (
            <LinkRow
              line={line}
              threadRef={threadRef}
              projectId={
                capabilities !== undefined
                  ? (findProjectForChangeRequest(environmentProjects, line.link)?.id ??
                    thread?.projectId ??
                    null)
                  : null
              }
              speedMode={speedMode}
              onUnlink={handleUnlink}
              onSetWatching={supportsWatch ? handleSetWatching : null}
              onIntent={intendLink}
              canStartWatch={canStartWatch}
            />
          )}
          estimatedItemSize={44}
          drawDistance={440}
          className="min-h-0 flex-1 overscroll-contain p-1.5 pt-under-header-1.5"
        />
        <footer className="flex items-center justify-between border-t border-border py-1.5 ps-4 pe-2.25 text-meta text-muted-foreground">
          <Tooltip>
            <TooltipTrigger render={<span className="flex min-w-0 flex-wrap gap-x-2" />}>
              {linkCount > 0 ? (
                <>
                  <span>
                    {gt("{count, plural, one {{count} linked} other {{count} linked}}", {
                      count: linkCount,
                    })}
                  </span>
                  <span>
                    {gt("{count, plural, one {{count} open} other {{count} open}}", {
                      count: openCount,
                    })}
                  </span>
                </>
              ) : null}
              {lastSynced ? (
                <span>
                  <T context="followed by a relative time such as 5m ago or just now">
                    synced{" "}
                    <Var>
                      <RelativeTime timestamp={lastSynced} />
                    </Var>
                  </T>
                </span>
              ) : null}
            </TooltipTrigger>
            <TooltipPopup>
              <span className="flex flex-col gap-0.5">
                {linkCount > 0 ? (
                  <span>
                    {gt("{count, plural, one {{count} open} other {{count} open}}", {
                      count: openCount,
                    })}
                  </span>
                ) : null}
                {lastSynced ? (
                  <span>
                    <T context="followed by a relative time such as 5m ago or just now">
                      synced{" "}
                      <Var>
                        <RelativeTime timestamp={lastSynced} />
                      </Var>
                    </T>
                  </span>
                ) : null}
              </span>
            </TooltipPopup>
          </Tooltip>
          {/* Borderless: the footer's 9px end padding puts its ink, 7px inside, on the 16px line. */}
          <Button size="xs" variant="ghost" onClick={openLinkDialog}>
            <PlusIcon className="size-3.5" />
            <T context="verb, button">Link pull request</T>
          </Button>
        </footer>
      </div>
    </PullRequestSpeedModeContext>
  );
}

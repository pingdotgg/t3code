import {
  DEFAULT_CLIENT_SETTINGS,
  type LinkedPullRequestSort,
  type LinkedPullRequestStatus,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  sourceControlClients,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
} from "@t3tools/client-runtime/source-control-clients";
import {
  type PullRequestListLine,
  resolveThreadPullRequestChains,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import { canStartThreadPullRequestWatch } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import {
  ArrowUpRightIcon,
  EyeIcon,
  EyeOffIcon,
  LinkIcon,
  ListFilterIcon,
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
import { updateClientSettings, useClientSettings } from "~/hooks/useSettings";
import { findProjectForChangeRequest } from "@t3tools/client-runtime/change-request-links";
import { pullRequestLinkPanelTarget, useOpenPrLink } from "~/lib/openPullRequestLink";
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
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Separator } from "../ui/separator";
import { MiddleTruncate } from "../ui/middle-truncate";
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
  PullRequestStateGlyph,
  pullRequestChecksStatePresentation,
} from "./pullRequestPresentation";
import { PullRequestGlyph } from "./pullRequestIcons";
import { pullRequestQuickActions } from "./pullRequestList.logic";
import { PullRequestSpeedActions, PullRequestSpeedModeContext } from "./PullRequestSpeedActions";
import {
  LINKED_PULL_REQUEST_STATUS_LABELS,
  LINKED_PULL_REQUEST_STATUS_ORDER,
  type LinkedPullRequestRow,
  type LinkedPullRequestView,
  linkedPullRequestRows,
  linkedPullRequestStatus,
} from "./threadPullRequestsView.logic";

import { changeRequestTermKind } from "./changeRequestTerm";

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

function LinkRowImpl({
  line,
  position,
  dimmed,
  threadRef,
  projectId,
  speedMode,
  onUnlink,
  onSetWatching,
  onIntent,
  canStartWatch,
}: {
  line: PullRequestListLine;
  position: number | null;
  dimmed: boolean;
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
      className={cn(PULL_REQUEST_ROW_CLASS, "relative hover:bg-accent/60", dimmed && "opacity-60")}
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
      style={{ paddingLeft: `${0.5 + Math.min(depth, 3) * 1.25}rem` }}
    >
      {depth > 0 ? <span aria-hidden className="-ml-2 h-6 w-px shrink-0 bg-border/70" /> : null}
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
            <Tooltip>
              <TooltipTrigger render={<span className={PULL_REQUEST_ROW_NUMBER_CLASS} />}>
                #{link.number}
              </TooltipTrigger>
              <TooltipPopup>
                {resolve(SOURCE_LABELS[link.source])} · <RelativeTime timestamp={link.linkedAt} />
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
                      <EyeIcon role="img" aria-label={gt("Watching")} className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipPopup>
                      <T>
                        Watching: the agent wakes when checks finish, someone comments, or the
                        branch conflicts
                      </T>
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
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-foreground/70" />
                    }
                  >
                    <PullRequestGlyph.stack aria-hidden className="size-3" />
                    {position === null ? stack.size : `${position}/${stack.size}`}
                  </TooltipTrigger>
                  <TooltipPopup>
                    {stack.kind === "native"
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
                        )}
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

const SORT_LABELS: Record<LinkedPullRequestSort, string> = {
  status: "Status",
  updated: "Recently updated",
  linked: "Recently linked",
  repository: "Repository",
};

function LinkedPullRequestViewMenu({
  view,
  counts,
}: {
  view: LinkedPullRequestView;
  counts: ReadonlyMap<LinkedPullRequestStatus, number>;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="ghost" />}>
        <ListFilterIcon className="size-3.5" />
        {SORT_LABELS[view.sort]}
      </MenuTrigger>
      <MenuPopup align="end" side="top">
        <MenuRadioGroup
          value={view.sort}
          onValueChange={(next) =>
            void updateClientSettings({ linkedPullRequestSort: next as LinkedPullRequestSort })
          }
        >
          <MenuGroupLabel>
            <T>Sort by</T>
          </MenuGroupLabel>
          {(Object.keys(SORT_LABELS) as Array<LinkedPullRequestSort>).map((sort) => (
            <MenuRadioItem key={sort} value={sort}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{SORT_LABELS[sort]}</span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>
            <T>Status</T>
          </MenuGroupLabel>
          {LINKED_PULL_REQUEST_STATUS_ORDER.map((status) => (
            <MenuCheckboxItem
              key={status}
              checked={!view.hiddenStatuses.includes(status)}
              onCheckedChange={(checked) =>
                void updateClientSettings({
                  linkedPullRequestHiddenStatuses: checked
                    ? view.hiddenStatuses.filter((hidden) => hidden !== status)
                    : [...view.hiddenStatuses, status],
                })
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <PullRequestStateGlyph
                  state={status === "draft" ? "open" : status}
                  isDraft={status === "draft"}
                />
                <span className="min-w-0 flex-1 truncate">
                  {LINKED_PULL_REQUEST_STATUS_LABELS[status]}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {counts.get(status) ?? 0}
                </span>
              </span>
            </MenuCheckboxItem>
          ))}
          <MenuCheckboxItem
            variant="switch"
            checked={view.groupStacks}
            onCheckedChange={(checked) =>
              void updateClientSettings({ linkedPullRequestGroupStacks: checked })
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <PullRequestGlyph.stack aria-hidden className="size-3.5" />
              <T>Group stacks</T>
            </span>
          </MenuCheckboxItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          onClick={() =>
            void updateClientSettings({
              linkedPullRequestSort: DEFAULT_CLIENT_SETTINGS.linkedPullRequestSort,
              linkedPullRequestHiddenStatuses:
                DEFAULT_CLIENT_SETTINGS.linkedPullRequestHiddenStatuses,
              linkedPullRequestGroupStacks: DEFAULT_CLIENT_SETTINGS.linkedPullRequestGroupStacks,
            })
          }
        >
          <T>Reset to default</T>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function ThreadPullRequestsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const configs = useServerConfigs();
  if (configs.get(threadRef.environmentId) === undefined) {
    return (
      <PullRequestsUnavailableState
        title={gt("Linked pull requests unavailable")}
        error={gt("This environment does not support multiple linked pull requests.")}
      />
    );
  }
  return <EnabledThreadPullRequestsPanel threadRef={threadRef} />;
}

function EnabledThreadPullRequestsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const thread = useThreadShell(threadRef);
  const projects = useProjects();
  const environmentProjects = projects
    .filter((project) => project.environmentId === threadRef.environmentId)
    .toSorted((left, right) =>
      left.id === thread?.projectId ? -1 : right.id === thread?.projectId ? 1 : 0,
    );
  const sort = useClientSettings((settings) => settings.linkedPullRequestSort);
  const hiddenStatuses = useClientSettings((settings) => settings.linkedPullRequestHiddenStatuses);
  const groupStacks = useClientSettings((settings) => settings.linkedPullRequestGroupStacks);
  const view = { sort, hiddenStatuses, groupStacks };
  // Derive rows before later hooks to preserve compiler caching and avoid LegendList renders.
  const links = visibleThreadPullRequests(thread?.pullRequests ?? []);
  const rows = linkedPullRequestRows(resolveThreadPullRequestChains(links), view);
  const statusCounts = new Map<LinkedPullRequestStatus, number>();
  for (const link of links) {
    const status = linkedPullRequestStatus(link);
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
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
  const prefetch = usePullRequestIntentPrefetch((target) =>
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

  if (linkCount === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <PullRequestGlyph.link aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">
          <T>No linked pull requests</T>
        </p>
        <p className="max-w-60 text-xs text-muted-foreground">
          <T>
            Pull requests the agent opens from this thread land here. Link one yourself from a URL
            or a number.
          </T>
        </p>
        <Button size="sm" variant="outline" onClick={openLinkDialog}>
          <PlusIcon className="size-3.5" />
          <T>Link pull request</T>
        </Button>
      </div>
    );
  }

  return (
    <PullRequestSpeedModeContext value={speedMode}>
      <div className="flex h-full min-h-0 flex-col">
        {/* Threads that run a stack or a sweep link hundreds of pull requests; only the rows in
          view are mounted. */}
        <LegendList<LinkedPullRequestRow>
          data={rows}
          keyExtractor={(row) => row.key}
          getItemType={(row) => row.kind}
          extraData={rowInputs}
          renderItem={({ item: row }) =>
            row.kind === "header" ? (
              <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground/70">
                <h3 className="shrink-0">{row.label}</h3>
                <span className="shrink-0 tabular-nums text-muted-foreground/50">{row.count}</span>
                <Separator className="min-w-2 flex-1" />
              </div>
            ) : row.kind === "hidden" ? (
              <div className="px-1 pt-1">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => void updateClientSettings({ linkedPullRequestHiddenStatuses: [] })}
                >
                  <T>
                    <Var>{row.count}</Var> hidden · Show all
                  </T>
                </Button>
              </div>
            ) : (
              <LinkRow
                line={row.line}
                position={row.position}
                dimmed={row.dimmed}
                threadRef={threadRef}
                projectId={
                  capabilities !== undefined
                    ? (findProjectForChangeRequest(environmentProjects, row.line.link)?.id ??
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
            )
          }
          estimatedItemSize={44}
          drawDistance={440}
          className="min-h-0 flex-1 overscroll-contain p-1.5"
        />
        <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
          <span className="min-w-0 truncate">
            {gt(
              "{openCount, plural, one {{openCount} open} other {{openCount} open}} · {linkCount, plural, one {{linkCount} linked} other {{linkCount} linked}}",
              { openCount, linkCount },
            )}
            {lastSynced ? (
              <>
                {" · "}
                <T context="followed by a relative time such as 5m ago or just now">
                  synced{" "}
                  <Var>
                    <RelativeTime timestamp={lastSynced} />
                  </Var>
                </T>
              </>
            ) : null}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <LinkedPullRequestViewMenu view={view} counts={statusCounts} />
            <Button size="xs" variant="ghost" onClick={openLinkDialog}>
              <PlusIcon className="size-3.5" />
              <T context="verb, button">Link</T>
            </Button>
          </span>
        </footer>
      </div>
    </PullRequestSpeedModeContext>
  );
}

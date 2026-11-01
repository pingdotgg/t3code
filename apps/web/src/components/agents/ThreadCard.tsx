import {
  agentChildStatusBucket,
  countChildStatusBuckets,
} from "@t3tools/client-runtime/state/child-status-counts";
import { toggleExpandedParent, useExpandedParentKeys } from "../../hooks/useExpandedParents";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { ChildStatusCountIcons, childStatusCountsLabel } from "../ChildStatusCounts";
import { formatRelativeTime } from "../../timestampFormat";
import { ProviderPackageIcon } from "../chat/ProviderPackageIcon";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { providerClients } from "../settings/providerDriverMeta";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CornerLeftUpIcon,
  PinIcon,
  Undo2Icon,
} from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import {
  memo,
  useContext,
  useId,
  useState,
  useRef,
  useEffect,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useDraggable } from "@dnd-kit/core";
import { AgentRunDragContext, agentChildDragId } from "./agentRunDrag";
import { Link, useLocation } from "@tanstack/react-router";
import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import { PreviewCard, PreviewCardTrigger } from "../ui/preview-card";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useProject } from "../../state/entities";
import { resolveEnvironmentMachineKind, type McpGatewayProfile } from "@t3tools/contracts";
import { AgentIcon } from "./AgentIcon";
import { useEnvironment, useEnvironmentProviders } from "../../state/environments";
import { AgentChatPreview } from "./AgentChatPreview";
import { isInsideComposerFloatingLayer } from "../chat/composerEventScope";
import {
  agentThreadStatus,
  agentThreadStatusLabel,
  arrangeAgentChildRuns,
  type AgentChildOrder,
  type AgentCardChildren,
  type AgentChildRun,
  type AgentRunContextMenu,
  type AgentRunPendingWork,
} from "./agents.logic";
import {
  useLinkedThreadPullRequest,
  prStatusIndicator,
  linkedPullRequestSnapshotStatus,
} from "../ThreadStatusIndicators";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { useOpenPrLink } from "../../lib/openPullRequestLink";

function runAgentName(
  run: EnvironmentThreadShell,
  profiles: readonly McpGatewayProfile[] | undefined,
) {
  const profile = profiles?.find(
    (candidate) => candidate.profileId === run.profileSnapshot?.profileId,
  );
  return {
    profile,
    name: profile?.name ?? run.profileSnapshot?.profileName ?? "Chat",
  };
}

interface ChildRunRowProps {
  child: AgentChildRun<EnvironmentThreadShell>;
  profiles: readonly McpGatewayProfile[] | undefined;
  /** Work outside each run's own turn (see selectAgentRunPendingWork). */
  childPendingWork: ReadonlyMap<string, AgentRunPendingWork> | undefined;
  onContextMenu: AgentRunContextMenu;
}

function AgentChildRunLink({
  child: { thread: run, depth, siblings },
  profiles,
  childPendingWork,
  onContextMenu,
  onPointerDown,
}: ChildRunRowProps & {
  onPointerDown?: (event: ReactPointerEvent<HTMLAnchorElement>) => void;
}) {
  const isCurrent = useLocation({
    select: (location) => location.pathname === `/agents/${run.environmentId}/${run.id}`,
  });
  const status = agentThreadStatus(
    run,
    childPendingWork?.get(`${run.environmentId}:${run.id}`) ?? null,
  );
  const agent = runAgentName(run, profiles);
  return (
    <Link
      to="/agents/$environmentId/$threadId"
      params={{ environmentId: run.environmentId, threadId: run.id }}
      className="agent-thread-child"
      data-current={isCurrent}
      style={
        {
          "--agent-color": agent.profile?.color ?? "var(--muted-foreground)",
          paddingInlineStart: `${6 + depth * 12}px`,
        } as CSSProperties
      }
      {...(onPointerDown ? { onPointerDown } : {})}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void onContextMenu(run, { x: event.clientX, y: event.clientY }, siblings);
      }}
    >
      <AgentIcon icon={agent.profile?.icon} />
      {run.pinnedAt != null && run.settledAt === null && (
        <PinIcon aria-label="Pinned" className="agent-thread-child-pin" size={10} />
      )}
      <span className="agent-thread-child-agent">{agent.name}</span>
      <span className="agent-thread-child-title">{run.title}</span>
      <span className={`agent-status agent-status-${status}`}>
        {agentThreadStatusLabel(status)}
      </span>
    </Link>
  );
}

/** A child row that can be dragged onto another card or out of this one. */
function DraggableAgentChildRun(props: ChildRunRowProps & { anchorKey: string }) {
  const key = `${props.child.thread.environmentId}:${props.child.thread.id}`;
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: agentChildDragId(key),
    data: { anchorKey: props.anchorKey },
  });
  return (
    <li ref={setNodeRef} data-dragging={isDragging || undefined}>
      <AgentChildRunLink
        {...props}
        // The row starts its own drag, not the card's.
        onPointerDown={(event) => {
          listeners?.onPointerDown?.(event);
          event.stopPropagation();
        }}
      />
    </li>
  );
}

/** Cards whose full child list is open, kept for the session across remounts. */
const expandedChildLists = new Set<string>();

/**
 * This card's child chats, collapsed by default to one line counting them by
 * the status each row shows; the line opens the list. The open state is shared
 * with the sidebar's parent rows and saved per device.
 */
function AgentChildRuns(props: {
  runs: AgentCardChildren<EnvironmentThreadShell>;
  anchorKey: string;
  profiles: readonly McpGatewayProfile[] | undefined;
  childPendingWork: ReadonlyMap<string, AgentRunPendingWork> | undefined;
  onContextMenu: AgentRunContextMenu;
}) {
  const { runs, anchorKey, childPendingWork } = props;
  const open = useExpandedParentKeys().includes(anchorKey);
  const counts = countChildStatusBuckets([...runs.live, ...runs.settled], ({ thread }) =>
    agentChildStatusBucket(
      agentThreadStatus(
        thread,
        childPendingWork?.get(`${thread.environmentId}:${thread.id}`) ?? null,
      ),
    ),
  );
  const label = childStatusCountsLabel(counts);
  return (
    <ul className="agent-thread-children" aria-label="Child chats">
      <li>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="flex h-6 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-xs tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-expanded={open}
                aria-label={label}
                data-testid="agent-child-runs-toggle"
                onClick={() => toggleExpandedParent(anchorKey)}
              />
            }
          >
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 shrink-0 transition-transform", !open && "-rotate-90")}
            />
            <ChildStatusCountIcons counts={counts} />
          </TooltipTrigger>
          <TooltipPopup side="right">{label}</TooltipPopup>
        </Tooltip>
      </li>
      {open && <AgentChildRunList {...props} />}
    </ul>
  );
}

/**
 * The open child list: each row links to its own chat with its own live
 * status and the same menu as a card, ordered by arrangeAgentChildRuns.
 * Settled children collapse at the bottom.
 * Subagents never appear here; they live in their owner's Lineage panel.
 */
function AgentChildRunList({
  runs,
  anchorKey,
  profiles,
  childPendingWork,
  onContextMenu,
}: {
  runs: AgentCardChildren<EnvironmentThreadShell>;
  anchorKey: string;
  profiles: readonly McpGatewayProfile[] | undefined;
  childPendingWork: ReadonlyMap<string, AgentRunPendingWork> | undefined;
  onContextMenu: AgentRunContextMenu;
}) {
  const { childDragEnabled } = useContext(AgentRunDragContext);
  const [settledOpen, setSettledOpen] = useState(false);
  const [expanded, setExpanded] = useState(() => expandedChildLists.has(anchorKey));
  const [order, setOrder] = useState<AgentChildOrder | null>(null);
  // Re-sorts ride the shared minute tick instead of every status change, so rows
  // hold still while the user reads or clicks them.
  const now = Date.parse(`${useNowMinute()}Z`);
  const arranged = arrangeAgentChildRuns({
    live: runs.live,
    statusOf: (thread) =>
      agentThreadStatus(
        thread,
        childPendingWork?.get(`${thread.environmentId}:${thread.id}`) ?? null,
      ),
    previous: order,
    now,
    expanded,
  });
  if (arranged.order !== order) setOrder(arranged.order);
  const toggleExpanded = () => {
    if (expanded) expandedChildLists.delete(anchorKey);
    else expandedChildLists.add(anchorKey);
    setExpanded(!expanded);
    setOrder(null);
  };
  const row = (child: AgentChildRun<EnvironmentThreadShell>) => {
    const key = `${child.thread.environmentId}:${child.thread.id}`;
    return childDragEnabled ? (
      <DraggableAgentChildRun
        key={key}
        child={child}
        anchorKey={anchorKey}
        profiles={profiles}
        childPendingWork={childPendingWork}
        onContextMenu={onContextMenu}
      />
    ) : (
      <li key={key}>
        <AgentChildRunLink
          child={child}
          profiles={profiles}
          childPendingWork={childPendingWork}
          onContextMenu={onContextMenu}
        />
      </li>
    );
  };
  const settledCount = runs.settled.filter((child) => child.depth === 0).length;
  return (
    <>
      {arranged.rows.map(row)}
      {arranged.overflow > 0 && (
        <li>
          <button
            type="button"
            className="agent-thread-children-toggle"
            aria-expanded={expanded}
            onClick={toggleExpanded}
          >
            {expanded ? "Show less" : `Show ${arranged.overflow} more`}
          </button>
        </li>
      )}
      {runs.settled.length > 0 && (
        <li>
          <button
            type="button"
            className="agent-thread-children-toggle"
            aria-expanded={settledOpen}
            onClick={() => setSettledOpen((open) => !open)}
          >
            Settled children · {settledCount}
          </button>
        </li>
      )}
      {settledOpen && runs.settled.map(row)}
    </>
  );
}

/**
 * The PRs a card lists: the thread's visible links, else its legacy linked and
 * branch PRs (servers without multi-PR links).
 */
function cardPullRequests(thread: EnvironmentThreadShell) {
  const links = visibleThreadPullRequests(thread.pullRequests ?? []);
  if (links.length > 0) return links;
  return [thread.linkedPullRequest, thread.branchPullRequest].filter(
    (reference, index, references): reference is NonNullable<typeof reference> =>
      reference != null && references.findIndex((item) => item?.url === reference.url) === index,
  );
}

/**
 * A card's expanded PR list. Mounted only while expanded, so collapsed cards
 * never query PR details.
 */
function AgentThreadPullRequests({ id, thread }: { id: string; thread: EnvironmentThreadShell }) {
  const prReference = thread.linkedPullRequest ?? thread.branchPullRequest;
  const linkedPr = useLinkedThreadPullRequest(thread.environmentId, prReference);
  const prStatus = prStatusIndicator(linkedPr?.pr ?? null, linkedPr?.sourceControlProvider);
  const openPrLink = useOpenPrLink();
  const badges = cardPullRequests(thread).map((reference) => {
    if ("source" in reference) {
      const detail = linkedPullRequestSnapshotStatus(reference);
      return {
        reference,
        status: prStatusIndicator(detail?.pr ?? null, detail?.sourceControlProvider),
      };
    }
    return { reference, status: reference === prReference ? prStatus : null };
  });
  return (
    <div id={id} className="agent-thread-pr-list">
      {badges.map(({ reference, status }) => (
        <Tooltip key={reference.url}>
          <TooltipTrigger
            render={
              <a
                href={reference.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`agent-thread-pr ${status?.colorClass ?? "text-muted-foreground"}`}
                aria-label={status?.tooltip ?? `Open PR #${reference.number}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) =>
                  openPrLink(event, reference.url, undefined, thread.environmentId)
                }
              />
            }
          >
            <PullRequestGlyph.pullRequest size={12} aria-hidden="true" />
            <span className="agent-thread-pr-repository">{reference.repository}</span>
            <span>#{reference.number}</span>
          </TooltipTrigger>
          <TooltipPopup>
            {status?.tooltip ?? `${reference.repository} #${reference.number}`}
          </TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * Memoized: a drag re-renders every sortable wrapper on each hover change, and
 * the cards themselves only need to render when their run changes.
 */
export const ThreadCard = memo(function ThreadCard({
  thread,
  profile,
  profiles,
  childRuns,
  parentRun,
  pendingWork = null,
  childPendingWork,
  dragging = false,
  settleSupported = false,
  onSettleAction,
  onContextMenu,
}: {
  profile?: McpGatewayProfile | undefined;
  /** Resolves the agents of related runs; falls back to their snapshot names. */
  profiles?: readonly McpGatewayProfile[] | undefined;
  /** Runs folded into this card by nestAgentRuns. */
  childRuns?: AgentCardChildren<EnvironmentThreadShell> | undefined;
  /** The run that created this one, when this card stands on its own. */
  parentRun?: EnvironmentThreadShell | null | undefined;
  /** Work outside this run's own turn (see selectAgentRunPendingWork). */
  pendingWork?: AgentRunPendingWork | null;
  /** Statuses of `childRuns` rows; only cards with children need it. */
  childPendingWork?: ReadonlyMap<string, AgentRunPendingWork> | undefined;
  dragging?: boolean;
  /** The surface's server supports thread.settle/unsettle (version-skew guard). */
  settleSupported?: boolean;
  /** Runs the shared settle lifecycle for a parent/top-level card. */
  onSettleAction?: (thread: EnvironmentThreadShell) => void;
  thread: EnvironmentThreadShell;
  onContextMenu: AgentRunContextMenu;
}) {
  const isCurrent = useLocation({
    select: (location) => location.pathname === `/agents/${thread.environmentId}/${thread.id}`,
  });
  const environment = useEnvironment(thread.environmentId);
  useNowMinute();
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  const relativeTime = formatRelativeTime(timestamp)?.value;
  const providers = useEnvironmentProviders().get(thread.environmentId);
  const provider = providers?.find(
    (candidate) => candidate.instanceId === thread.modelSelection.instanceId,
  );
  const ModelProviderIcon = provider ? PROVIDER_ICON_BY_PROVIDER[provider.driver] : undefined;
  const modelPackageIcon = provider ? providerClients.get(provider.driver)?.icon : undefined;
  const model = provider?.models.find(
    (candidate) => candidate.slug === thread.modelSelection.model,
  );
  const modelLabel = model?.name ?? thread.modelSelection.model;
  const project = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
  const pullRequestCount = cardPullRequests(thread).length;
  const [pullRequestsOpen, setPullRequestsOpen] = useState(false);
  const pullRequestListId = useId();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  // The open chat needs no preview, and a second composer on its draft would
  // render on every keystroke typed into the chat pane.
  const showPreview = !dragging && !contextMenuOpen && !isCurrent && previewOpen;
  const status = agentThreadStatus(thread, pendingWork);
  // Only parent/top-level cards get the inline action; a chat that stands on its
  // own card but is somebody's child keeps the right-click menu alone.
  const settled = thread.settledAt !== null;
  const showSettleAction =
    onSettleAction != null && settleSupported && thread.parentThreadId == null;
  const popupRef = useRef<HTMLDivElement>(null);
  const editing = useRef(false);
  const closePreview = () => {
    editing.current = false;
    setPreviewOpen(false);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for document pointer presses to dismiss the open preview
  useEffect(() => {
    if (!previewOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        popupRef.current?.contains(event.target as Node) ||
        isInsideComposerFloatingLayer(event.target)
      )
        return;
      editing.current = false;
      setPreviewOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [previewOpen]);
  return (
    <div
      className="agent-thread-container"
      data-current={isCurrent}
      data-has-card-actions={showSettleAction || undefined}
      style={{ "--agent-color": profile?.color ?? "var(--muted-foreground)" } as CSSProperties}
    >
      <PreviewCard
        open={showPreview}
        onOpenChange={(open, details) => {
          if (
            !open &&
            details.reason === "trigger-hover" &&
            (editing.current ||
              popupRef.current?.contains(document.activeElement) ||
              isInsideComposerFloatingLayer(document.activeElement))
          )
            return;
          if (!open) editing.current = false;
          setPreviewOpen(open && !dragging);
        }}
      >
        <PreviewCardTrigger
          onContextMenu={(event) => {
            event.preventDefault();
            setPreviewOpen(false);
            setContextMenuOpen(true);
            void onContextMenu(thread, { x: event.clientX, y: event.clientY }).finally(() => {
              setPreviewOpen(false);
              setContextMenuOpen(false);
            });
          }}
          delay={400}
          render={
            <Link
              to="/agents/$environmentId/$threadId"
              params={{ environmentId: thread.environmentId, threadId: thread.id }}
            />
          }
          className={`agent-thread agent-thread-${status}`}
        >
          <div className="agent-thread-title">
            <strong>
              {thread.pinnedAt != null && (
                <PinIcon aria-label="Pinned" className="agent-thread-pin" size={11} />
              )}
              {thread.title}
            </strong>
            <Tooltip>
              <TooltipTrigger render={<time className="agent-thread-time" dateTime={timestamp} />}>
                {relativeTime === "just now" ? "now" : relativeTime}
              </TooltipTrigger>
              <TooltipPopup>{new Date(timestamp).toLocaleString()}</TooltipPopup>
            </Tooltip>
          </div>
          <div className="agent-thread-meta">
            <span className="agent-thread-project">
              <EnvironmentMachineIcon
                kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                className="mr-1 inline-block size-3.5 align-[-2px]"
                aria-hidden="true"
              />
              {environment?.label ?? "Machine unavailable"}/
              {project?.title ?? "Project unavailable"}
            </span>
          </div>
          <div className="agent-thread-footer">
            <div className="agent-thread-identity">
              {thread.profileSnapshot && (
                <span>
                  <AgentIcon icon={profile?.icon} />
                  <span>
                    {profile?.name ?? thread.profileSnapshot.profileName ?? "Removed agent"}
                  </span>
                </span>
              )}
              {(ModelProviderIcon || modelPackageIcon) && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="agent-thread-model" aria-label={`Model: ${modelLabel}`} />
                    }
                  >
                    {ModelProviderIcon ? (
                      <ModelProviderIcon className="size-3.5" aria-hidden="true" />
                    ) : modelPackageIcon ? (
                      <ProviderPackageIcon
                        icon={modelPackageIcon}
                        className="size-3.5"
                        aria-hidden="true"
                      />
                    ) : null}
                  </TooltipTrigger>
                  <TooltipPopup>{modelLabel}</TooltipPopup>
                </Tooltip>
              )}
            </div>
            <span className={`agent-status agent-status-${status}`}>
              {agentThreadStatusLabel(status)}
            </span>
          </div>
          {environment?.connection.phase !== "connected" && (
            <p className="agent-thread-time">Environment unavailable</p>
          )}
        </PreviewCardTrigger>
        {/* The chat preview is this board's own surface, so it builds on the primitive rather
            than restyling the shared PreviewCardPopup. */}
        <PreviewCardPrimitive.Portal>
          <PreviewCardPrimitive.Positioner
            side="right"
            align="start"
            sideOffset={12}
            // Composer menus and dialogs portal above this interactive preview.
            className="z-[120] max-w-(--available-width)"
            data-slot="preview-card-positioner"
          >
            <PreviewCardPrimitive.Popup
              ref={popupRef}
              onPointerDownCapture={() => {
                editing.current = true;
              }}
              onFocusCapture={() => {
                editing.current = true;
              }}
              className="agent-chat-preview origin-(--transform-origin) bg-background text-foreground outline-none transition-[scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0"
              data-slot="preview-card-popup"
            >
              {showPreview && (
                <AgentChatPreview
                  thread={thread}
                  project={project?.title ?? "Project unavailable"}
                  pendingWork={pendingWork}
                  onClose={closePreview}
                />
              )}
            </PreviewCardPrimitive.Popup>
          </PreviewCardPrimitive.Positioner>
        </PreviewCardPrimitive.Portal>
      </PreviewCard>
      {showSettleAction && (
        <div className="agent-thread-actions">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="agent-thread-settle"
                  aria-label={settled ? "Un-settle chat" : "Settle chat"}
                  onClick={(event) => {
                    // The card is a link inside a drag source: keep the click
                    // from navigating or starting a drag.
                    event.preventDefault();
                    event.stopPropagation();
                    void onSettleAction(thread);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                />
              }
            >
              {settled ? (
                <Undo2Icon size={13} aria-hidden="true" />
              ) : (
                <CheckIcon size={13} aria-hidden="true" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="left">{settled ? "Un-settle chat" : "Settle chat"}</TooltipPopup>
          </Tooltip>
        </div>
      )}
      {parentRun && (
        <div className="agent-thread-prs">
          <Link
            to="/agents/$environmentId/$threadId"
            params={{ environmentId: parentRun.environmentId, threadId: parentRun.id }}
            className="agent-thread-pr agent-thread-parent"
            aria-label={`Created by ${runAgentName(parentRun, profiles).name}: ${parentRun.title}`}
          >
            <CornerLeftUpIcon size={12} aria-hidden="true" />
            <span className="agent-thread-pr-repository">
              {runAgentName(parentRun, profiles).name} · {parentRun.title}
            </span>
          </Link>
        </div>
      )}
      {childRuns && childRuns.live.length + childRuns.settled.length > 0 && (
        <AgentChildRuns
          runs={childRuns}
          anchorKey={`${thread.environmentId}:${thread.id}`}
          profiles={profiles}
          childPendingWork={childPendingWork}
          onContextMenu={onContextMenu}
        />
      )}
      {pullRequestCount > 0 && (
        <div className="agent-thread-prs" aria-label="Pull requests">
          <button
            type="button"
            className="agent-thread-prs-toggle"
            aria-expanded={pullRequestsOpen}
            aria-controls={pullRequestsOpen ? pullRequestListId : undefined}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setPullRequestsOpen((open) => !open);
            }}
          >
            {pullRequestsOpen ? (
              <ChevronDownIcon size={12} aria-hidden="true" />
            ) : (
              <ChevronRightIcon size={12} aria-hidden="true" />
            )}
            {pullRequestCount} {pullRequestCount === 1 ? "PR" : "PRs"}
          </button>
          {pullRequestsOpen && <AgentThreadPullRequests id={pullRequestListId} thread={thread} />}
        </div>
      )}
    </div>
  );
});

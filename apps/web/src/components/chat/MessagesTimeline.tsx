import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ToolCallDiffTarget } from "../../diffPanelStore";
import { AudioPreviewUnmountContext } from "../files/AudioPreview";
import {
  ActivityShimmerOverlay,
  WORKING_BAR_CLASS_NAME,
  WorkFoldChevron,
  WorkingBarChip,
} from "./TimelineRowParts";
import {
  AssistantMetaTimelineRow,
  AssistantTimelineRow,
  HtmlRenderTimelineRow,
  McpAppTimelineRow,
  ProposedPlanTimelineRow,
} from "./TimelineAssistantRows";
import {
  type TimelinePendingRequest,
  type TimelineRow,
  TimelineRowActivityCtx,
  type TimelineRowActivityState,
  TimelineRowCtx,
  type TimelineRowSharedState,
  type TimelineUsageLimit,
  type WorkGroupViewState,
} from "./timelineRowContext";
import {
  BackgroundActivityTimelineRow,
  LiveWorkEntryTimelineRow,
  SlashCommandTimelineRow,
  ThinkingTimelineRow,
  WorkGroupSection,
  WorkGroupToggleTimelineRow,
  WorkingTimelineRow,
} from "./TimelineWorkGroupRows";
import {
  useIncrementalTimelineRows,
  useStableHandoffRuns,
  useStableRows,
  useTimelineSlashCommandCatalog,
} from "./useTimelineRows";
import { startTimelinePositionRestore } from "./useTimelinePositionRestore";
import { UserMessageRow } from "./TimelineUserMessageRow";
import { useThreadFindPositionReader } from "./useThreadFindPositionReader";
import { V2EventTimelineRow } from "./TimelineV2EventRow";
import { TimelineMinimap } from "./TimelineMinimap";
import { ThreadFindTimelineContext } from "./ThreadFindProvider";
import { MarkdownFindContext } from "./markdownFindContext";
import { useChatCanvas } from "./ChatCanvasContext";
import { WorkLogBlock } from "./WorkLog";
import { TimelinePendingApprovalRow } from "./TimelinePendingApprovalRow";
import {
  type WorktreeSetupSnapshot,
  type AssistantCitation,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2TurnItem,
  type RunAttemptId,
  type ServerProviderSkill,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import { deriveTimelineMinimapItems } from "./timelineMinimapItems";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveWorkGroupScrollAnchor } from "@t3tools/client-runtime/work-log/scroll-anchor";
import { type WorkflowOpening } from "@t3tools/client-runtime/state/subagentRuntime";
import { observeResize } from "~/lib/observeResize";
import { useStableCallback } from "~/hooks/useStableCallback";
import { resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import {
  memo,
  use,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  LegendList,
  type LegendListRef,
  type MaintainScrollAtEndOptions,
} from "@legendapp/list/react";
import { type PendingApproval, type TimelineEntry } from "../../session-logic";
import { type CodexArtifactTemplate } from "@t3tools/shared/codexArtifactTemplates";

const EMPTY_PENDING_APPROVALS: ReadonlyArray<PendingApproval> = [];
const EMPTY_RESPONDING_REQUEST_IDS: TimelineRowSharedState["respondingRequestIds"] = [];
import { type ChatFileAttachment, type TurnDiffSummary } from "../../types";
import {
  ArrowRightIcon,
  BotIcon,
  Minimize2Icon,
  CircleAlertIcon,
  Clock3Icon,
  MessageSquareIcon,
  MessagesSquareIcon,
} from "lucide-react";
import { ChevronDown, ChevronRight } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { Skeleton } from "../ui/skeleton";
import { ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  readTimelinePosition,
  type RememberedTimelinePosition,
  rememberTimelinePosition,
} from "./timelineScrollAnchoring";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import { type AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { type AssistantCitationRequest } from "./AssistantCitationSource";
import { useAssistantCitationTarget } from "./useAssistantCitationTarget";
import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import { resolveCitationPhase, type CitedHistory } from "./citationProcedure";
import {
  resolveTimelineIsAtEnd,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapCurrentIndex,
  isTimelineMinimapRowVisible,
  resolveTimelineMinimapVisibleRange,
  resolveTimelineMinimapHitStripWidth,
  timelineTurnFoldRunIdsByEntryId,
  type MessagesTimelineRow,
  type TimelineLatestRun,
  turnFoldStartsOpen,
  withRunGroupsOpen,
  withTurnFoldOpen,
} from "./MessagesTimeline.logic";
import { type ThreadFindMatch } from "./threadFind";
import { useThreadFindNavigation } from "./useThreadFindNavigation";
import { TooltipScrollDismissArea, Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorktreeSetupCard } from "./WorktreeSetupCard";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { type HandoffTimelineRun } from "./V2LifecycleRow";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
import { forwardWheelToTimeline } from "./timelineMinimapWheel";
import {
  attachTimelineViewport,
  nextListOpening,
  type TimelineListOpening,
  type TimelineViewport,
} from "./timelineViewport";
import { ThreadActivityAnnouncer } from "./ThreadActivityAnnouncer";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { DiffStatBlocks } from "./DiffStatLabel";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useDeadlinePassed } from "../../hooks/useDeadline";

const NOOP_USE_ARTIFACT_TEMPLATE = () => {};
const NOOP_OPEN_ATTACHMENT = (_attachment: ChatFileAttachment) => {};

function timelineListStateFor(identity: string): {
  readonly identity: string;
  readonly rememberedPosition: RememberedTimelinePosition | undefined;
  readonly workGroupViewState: WorkGroupViewState;
} {
  const rememberedPosition = readTimelinePosition(identity);
  return {
    identity,
    rememberedPosition,
    workGroupViewState: rememberedPosition?.disclosures?.workGroupState ?? {
      scrollPositions: new Map(),
      expandedEntries: new Set(),
    },
  };
}

const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FADE_HEADER = (
  <div className="h-[var(--workspace-titlebar-scroll-fade-height)]" />
);
function TimelineListFooter({
  composerInset,
  onGrow,
  children,
}: {
  readonly composerInset: number;
  readonly onGrow: (() => void) | undefined;
  readonly children?: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports growth of the footer's content, which the list does not follow
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !onGrow) return;
    let height = content.offsetHeight;
    return observeResize(content, () => {
      const next = content.offsetHeight;
      if (next > height) onGrow();
      height = next;
    });
  }, [onGrow]);
  return (
    <div>
      <div ref={contentRef}>{children}</div>
      <div aria-hidden style={{ height: composerInset }} />
      <div aria-hidden className="h-3 sm:h-4" />
    </div>
  );
}

const EMPTY_TIMELINE_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
const TIMELINE_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: {
    dataChange: true,
    footerLayout: false,
    itemLayout: true,
    layout: true,
  },
} as const satisfies MaintainScrollAtEndOptions;
const EMPTY_RUN_IDS: ReadonlySet<RunId> = new Set();
const TIMELINE_MAINTAIN_SCROLL_AT_END_SMOOTH = {
  ...TIMELINE_MAINTAIN_SCROLL_AT_END,
  animated: true,
} as const satisfies MaintainScrollAtEndOptions;

const CITED_HISTORY_LOADING: CitedHistory = { _tag: "loading" };

export interface MessagesTimelineHistoryControls {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadEarlier: (throughEntryId?: string) => void;
}

interface MessagesTimelineProps {
  pendingApprovals?: ReadonlyArray<PendingApproval>;
  heldApprovalRequestIds?: ReadonlySet<string> | undefined;
  respondingRequestIds?: TimelineRowSharedState["respondingRequestIds"];
  canOperateThread?: boolean;
  onRespondToApproval?: TimelineRowSharedState["onRespondToApproval"];
  citationRequest?: AssistantCitationRequest | null;
  citationHistory?: CitedHistory;
  onCiteAssistantText?: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
  isWorking: boolean;
  runlessWorkActive?: boolean;
  activeTurnStartedAt?: string | null;
  worktreeSetup?: WorktreeSetupSnapshot | null;
  onCancelWorktreeSetup?: () => void;
  retryableWorkspacePreparationRunIds?: ReadonlySet<RunId>;
  onRetryWorkspacePreparation?: (runId: RunId) => void;
  onWorktreeSetupWorkLocally?: () => void;
  onOpenWorktreeSetupTerminal?: (terminalId: string) => void;
  isPreparingWorktree?: boolean;
  isCompacting?: boolean;
  awaitingUser?: "approval" | "input" | null;
  /** Which request is waiting, so a second one of the same kind is announced too. */
  awaitingRequestId?: string | null;
  pendingRequest?: TimelinePendingRequest | null;
  backgroundTaskLabel?: string | null;
  usageLimit?: TimelineUsageLimit | null;
  /** The composer banner's error; a failed fold does not repeat it. */
  threadErrorMessage?: string | null;
  /** Takes the user to a pending question in the composer. */
  onFocusComposer?: () => void;
  /** Uses the same turn interrupt as the composer and keybinding. */
  onInterrupt?: TimelineRowSharedState["onInterrupt"];

  footer?: ReactNode;

  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestRun: TimelineLatestRun | null;
  /** The run the screen reader announcer follows; see announcedRun. */
  announcedRun?: { readonly runId: RunId; readonly status: TimelineLatestRun["status"] } | null;
  /** See isDetailBehindShell. */
  detailBehindShell?: boolean;
  runningRunId?: RunId | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  routeThreadKey: string;
  displayThreadKey?: string;
  /** Off where another region already speaks the thread's status, like a subagent's bar. */
  announceTurnStatus?: boolean;
  onOpenToolDiff?: (target: ToolCallDiffTarget) => void;
  onOpenTurnDiff?: (runId: RunId, filePath?: string) => void;
  onOpenThread: (threadId: OrchestrationV2TurnItem["threadId"]) => void;
  renderHtmlRender?: TimelineRowSharedState["renderHtmlRender"];
  turnItemSource?: TimelineRowSharedState["turnItemSource"];
  /**
   * The thread this one is a subagent or side chat of; `open` is absent when it cannot be
   * opened from here.
   */
  parentThreadLink?: {
    readonly title: string;
    /** A side chat's inherited rows collapse into this link. */
    readonly sideChat?: boolean;
    /** Where it runs, when that is another environment. */
    readonly environmentLabel?: string;
    readonly open?: () => void;
  } | null;
  workflowOpening?: WorkflowOpening | null;
  onForkFromRun?: (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => Promise<void>;
  supportsConversationRollback: boolean;
  threadStartCheckpointReady?: boolean;
  availableRevertTurnCounts?: ReadonlySet<number> | undefined;
  onRevertToTurnCount: (targetTurnCount: number, messageId: MessageId) => void;
  onUseArtifactTemplate?: (template: CodexArtifactTemplate) => void;
  onSendAppMessage?: (text: string) => Promise<void>;
  onRunShellCommand?: (command: string) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onFileOpen?: (attachment: ChatFileAttachment) => void;
  onFileDownload?: (attachment: ChatFileAttachment) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<ServerProviderSkill>;
  /** The provider's slash commands. With `skills`, they decide which prompts are commands. */
  slashCommands?: ReadonlyArray<{ readonly name: string }>;
  runs: ReadonlyArray<HandoffTimelineRun>;
  anchorMessageId: MessageId | null;
  onAnchorReady: (messageId: MessageId, anchorIndex: number) => void;
  onAnchorSizeChanged: (messageId: MessageId, size: number) => void;
  contentInsetEndAdjustment: number;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  /** Disable while reading history to prevent LegendList re-pinning near the bottom. */
  liveFollowEnabled: boolean;
  /** Receives the list's viewport when it mounts; the returned cleanup runs when it goes away. */
  onViewportAttach?: (viewport: TimelineViewport) => () => void;
  /** The footer's content grew, such as a new queued turn or status line. */
  onFooterGrow?: () => void;
  findOpen?: boolean;
  hideEmptyPlaceholder?: boolean;
  /** Composer space to center the empty state against; held steady through collapse. */
  emptyPlaceholderInset: number;
  topFadeEnabled?: boolean;
  historyControls?: MessagesTimelineHistoryControls | undefined;
  findExpanded?: boolean;
  findQuery?: string;
  activeFindMatch?: ThreadFindMatch | null;
  findNavigationId?: number;
}

export function MessagesTimeline(props: MessagesTimelineProps) {
  const find = useContext(ThreadFindTimelineContext);
  const findOpen = find?.findOpen ?? props.findOpen;
  return (
    <ConversationTimeline
      {...props}
      {...find}
      liveFollowEnabled={!findOpen && props.liveFollowEnabled}
    />
  );
}

const ConversationTimeline = memo(function ConversationTimeline({
  pendingApprovals = EMPTY_PENDING_APPROVALS,
  heldApprovalRequestIds,
  respondingRequestIds = EMPTY_RESPONDING_REQUEST_IDS,
  canOperateThread = false,
  onRespondToApproval,
  citationRequest = null,
  citationHistory = CITED_HISTORY_LOADING,
  onCiteAssistantText,
  isWorking,
  runlessWorkActive = false,
  activeTurnStartedAt = null,
  worktreeSetup = null,
  footer = null,
  onCancelWorktreeSetup,
  retryableWorkspacePreparationRunIds = EMPTY_RUN_IDS,
  onRetryWorkspacePreparation,
  onWorktreeSetupWorkLocally,
  onOpenWorktreeSetupTerminal,
  isPreparingWorktree = false,
  isCompacting = false,
  awaitingUser = null,
  awaitingRequestId = null,
  pendingRequest: pendingRequestProp = null,
  backgroundTaskLabel = null,
  usageLimit = null,
  threadErrorMessage = null,
  onFocusComposer,
  onInterrupt,

  listRef,
  timelineEntries,
  findOpen = false,
  findExpanded = false,
  findQuery = "",
  activeFindMatch = null,
  findNavigationId = 0,
  latestRun,
  announcedRun = null,
  detailBehindShell = false,
  runningRunId = null,
  turnDiffSummaries,
  routeThreadKey,
  displayThreadKey,
  announceTurnStatus = true,
  onOpenToolDiff,
  onOpenTurnDiff,
  onOpenThread,
  renderHtmlRender,
  turnItemSource,
  parentThreadLink = null,
  workflowOpening = null,
  onForkFromRun,
  supportsConversationRollback,
  threadStartCheckpointReady = false,
  availableRevertTurnCounts,
  onRevertToTurnCount,
  onUseArtifactTemplate = NOOP_USE_ARTIFACT_TEMPLATE,
  onSendAppMessage,
  onRunShellCommand,
  isRevertingCheckpoint,
  onImageExpand,
  onFileOpen = NOOP_OPEN_ATTACHMENT,
  onFileDownload = NOOP_OPEN_ATTACHMENT,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  slashCommands = EMPTY_TIMELINE_SLASH_COMMANDS,
  runs: runsProp,
  anchorMessageId,
  onAnchorReady,
  onAnchorSizeChanged,
  contentInsetEndAdjustment,
  onIsAtEndChange,
  liveFollowEnabled,
  onViewportAttach,
  onFooterGrow,
  hideEmptyPlaceholder = false,
  emptyPlaceholderInset,
  topFadeEnabled = false,
  historyControls,
}: MessagesTimelineProps) {
  const pendingRequest = pendingRequestProp?.blocking === false ? null : pendingRequestProp;
  const listIdentityKey = displayThreadKey ?? routeThreadKey;
  // Snapshot restore positions on identity changes; ongoing scroll writes must not move them.
  // Find open at the opening is part of the snapshot: opening find later
  // announces its own navigation (threadFindStore's announceOpening).
  const [listState, setListState] = useState(() => ({
    ...timelineListStateFor(listIdentityKey),
    findOpenAtOpening: findOpen,
  }));
  const [expandedRunIds, setExpandedRunIds] = useState<ReadonlySet<RunId>>(
    () => listState.rememberedPosition?.disclosures?.runs ?? new Set(),
  );
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(
    () => listState.rememberedPosition?.disclosures?.workGroups ?? new Set(),
  );
  const [expandedAttemptIds, setExpandedAttemptIds] = useState<ReadonlySet<RunAttemptId>>(
    () => listState.rememberedPosition?.disclosures?.attempts ?? new Set(),
  );
  // A list that opens on a thread with find open takes the opening step below,
  // so the restore runs and releases follow once for find.
  const [positionedThreadKey, setPositionedThreadKey] = useState<string | null>(() =>
    listState.rememberedPosition?.atEnd === false || findOpen ? null : listIdentityKey,
  );
  const restoringThreadPosition = positionedThreadKey !== listIdentityKey;
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [settlingListIdentity, setSettlingListIdentity] = useState<string | null>(listIdentityKey);
  const [playingAudioRows, setPlayingAudioRows] = useState<ReadonlyMap<HTMLAudioElement, string>>(
    () => new Map(),
  );
  const [fullscreenAppRowId, setFullscreenAppRowId] = useState<string | null>(null);
  let paintedExpandedRunIds = expandedRunIds;
  let paintedExpandedWorkGroupIds = expandedWorkGroupIds;
  let paintedExpandedAttemptIds = expandedAttemptIds;
  const identityChanged = listState.identity !== listIdentityKey;
  const { rememberedPosition, workGroupViewState } = identityChanged
    ? timelineListStateFor(listIdentityKey)
    : listState;
  if (identityChanged) {
    setPlayingAudioRows(new Map());
    setListState({
      identity: listIdentityKey,
      rememberedPosition,
      workGroupViewState,
      findOpenAtOpening: findOpen,
    });
    setPositionedThreadKey(null);
    setSettlingListIdentity(listIdentityKey);
    // A viewer pinned in another thread must not keep live follow off here,
    // nor when that thread comes back.
    setFullscreenAppRowId(null);
    paintedExpandedRunIds = rememberedPosition?.disclosures?.runs ?? new Set();
    paintedExpandedWorkGroupIds = rememberedPosition?.disclosures?.workGroups ?? new Set();
    paintedExpandedAttemptIds = rememberedPosition?.disclosures?.attempts ?? new Set();
    setExpandedRunIds(paintedExpandedRunIds);
    setExpandedWorkGroupIds(paintedExpandedWorkGroupIds);
    setExpandedAttemptIds(paintedExpandedAttemptIds);
  }
  const citationThreadRef = parseScopedThreadKey(routeThreadKey);
  const openPullRequest = useOpenPrLink(citationThreadRef ?? undefined);
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>());
  // The open history belongs to the prompt that opened it; sending closes it.
  const [workingHistoryKey, setWorkingHistoryKey] = useState<string | null>(null);
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const disclosureSettleFrameRef = useRef<number | null>(null);
  const disclosureSettleSecondFrameRef = useRef<number | null>(null);
  const normalizedFindQuery = findQuery.trim();
  const findActive = findExpanded;

  const disclosurePinsEndRef = useRef(false);
  const pinDisclosureToEnd = () => {
    if (!disclosurePinsEndRef.current) return;
    const element = listRef.current?.getScrollableNode();
    if (element) element.scrollTop = element.scrollHeight;
  };

  const scheduleDisclosureSettle = () => {
    if (disclosureSettleFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleFrameRef.current);
    }
    if (disclosureSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
    }
    disclosureSettleFrameRef.current = requestAnimationFrame(() => {
      pinDisclosureToEnd();
      disclosureSettleSecondFrameRef.current = requestAnimationFrame(() => {
        pinDisclosureToEnd();
        disclosurePinsEndRef.current = false;
        disclosureAnchorKeyRef.current = null;
        setDisclosureToggleSettling(false);
        disclosureSettleFrameRef.current = null;
        disclosureSettleSecondFrameRef.current = null;
      });
    });
  };

  const suspendEndScrollMaintenanceForDisclosure = (anchorKey: string) => {
    disclosureAnchorKeyRef.current = anchorKey;
    disclosurePinsEndRef.current = resolveTimelineIsAtEnd(listRef.current?.getState()) === true;
    setDisclosureToggleSettling(true);
    scheduleDisclosureSettle();
  };

  const shouldRestoreVisibleContentPosition = (row: MessagesTimelineRow) => {
    if (disclosurePinsEndRef.current) return false;
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || row.id === disclosureAnchorKey;
  };

  const onToggleTurnFold = (runId: RunId) => {
    suspendEndScrollMaintenanceForDisclosure(`turn-fold:${runId}`);
    setExpandedRunIds((existing) => {
      const next = new Set(existing);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  };
  const onToggleWorkGroup = (groupId: string, anchorKey: string) => {
    suspendEndScrollMaintenanceForDisclosure(anchorKey);
    setExpandedWorkGroupIds((existing) => {
      const next = new Set(existing);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };
  // Opening keeps a followed timeline at its end, so the history lands above
  // the composer instead of under it. Closing behaves like any collapsing
  // disclosure.
  const onToggleWorkingHistory = (key: string) => {
    // Either way the bar holds still: the history grows and shrinks below it.
    suspendEndScrollMaintenanceForDisclosure("working-indicator-row");
    setWorkingHistoryKey((current) => (current === key ? null : key));
  };
  const onToggleAttemptFold = (attemptId: RunAttemptId) => {
    suspendEndScrollMaintenanceForDisclosure(`attempt-fold:${attemptId}`);
    setExpandedAttemptIds((existing) => {
      const next = new Set(existing);
      if (next.has(attemptId)) {
        next.delete(attemptId);
      } else {
        next.add(attemptId);
      }
      return next;
    });
  };
  // Find the fold that hides the match: imported turns have no run id but still
  // fold under a synthetic key, so the match's own run id cannot open them.
  const findFoldRunIds = (() =>
    findActive
      ? timelineTurnFoldRunIdsByEntryId({
          timelineEntries,
          latestRun,
          runningRunId,
          isWorking,
          runlessWorkActive,
        })
      : null)();
  const activeFindFold = activeFindMatch ? findFoldRunIds?.get(activeFindMatch.entryId) : undefined;
  const activeFindFoldRunId = activeFindFold?.runId;
  const activeFindFoldEnding = activeFindFold?.ending;
  const [expandedFindFold, setExpandedFindFold] = useState<typeof activeFindFold>();
  if (
    expandedFindFold?.runId !== activeFindFoldRunId ||
    expandedFindFold?.ending !== activeFindFoldEnding
  ) {
    setExpandedFindFold(activeFindFold);
    if (activeFindFold) {
      setExpandedRunIds((previous) => withTurnFoldOpen(previous, activeFindFold));
    }
  }
  const visibleExpandedRunIds = (() =>
    activeFindFoldRunId && activeFindFoldEnding
      ? withTurnFoldOpen(paintedExpandedRunIds, {
          runId: activeFindFoldRunId,
          ending: activeFindFoldEnding,
        })
      : paintedExpandedRunIds)();

  const activeFindAttemptId = activeFindMatch
    ? timelineEntries.find((entry) => entry.id === activeFindMatch.entryId)?.attempt?.id
    : undefined;
  const [expandedFindAttemptId, setExpandedFindAttemptId] = useState<RunAttemptId | undefined>();
  if (expandedFindAttemptId !== activeFindAttemptId) {
    setExpandedFindAttemptId(activeFindAttemptId);
    if (activeFindAttemptId) {
      setExpandedAttemptIds((previous) =>
        previous.has(activeFindAttemptId) ? previous : new Set(previous).add(activeFindAttemptId),
      );
    }
  }
  const visibleExpandedAttemptIds =
    activeFindAttemptId && !paintedExpandedAttemptIds.has(activeFindAttemptId)
      ? new Set(paintedExpandedAttemptIds).add(activeFindAttemptId)
      : paintedExpandedAttemptIds;

  const isVisiblePendingApproval = (approval: PendingApproval) =>
    !heldApprovalRequestIds?.has(approval.requestId);
  const pendingApprovalRequestIds = new Set(
    pendingApprovals.filter(isVisiblePendingApproval).map((approval) => approval.requestId),
  );
  const slashCommandCatalog = useTimelineSlashCommandCatalog(slashCommands, skills);
  const rawRows = useIncrementalTimelineRows(`${listIdentityKey}\0${workspaceRoot ?? ""}`, {
    timelineEntries,
    pendingApprovalRequestIds,
    latestRun,
    runningRunId,
    expandedRunIds: visibleExpandedRunIds,
    expandedAttemptIds: visibleExpandedAttemptIds,
    expandedWorkGroupIds,
    isWorking,
    runlessWorkActive,
    activeTurnStartedAt,
    turnDiffSummaries,
    supportsConversationRollback,
    threadStartCheckpointReady,
    availableRevertTurnCounts,
    worktreeSetup,
    slashCommands: slashCommandCatalog,
  });
  // A find match or citation inside the running turn needs its rows, not the window that replaces them.
  const [windowlessCitationKey, setWindowlessCitationKey] = useState<string | null>(null);
  const windowlessCitation =
    citationRequest !== null && citationRequest.key === windowlessCitationKey;
  const activeFindEntryId = activeFindMatch?.entryId ?? null;
  const rows = useStableRows(rawRows, listIdentityKey, {
    timelineEntries,
    pendingApprovalRequestIds,
    latestRun,
    runningRunId,
    expandedWorkGroupIds,
    hasPendingRequest: pendingRequest !== null,
    hasThreadError: threadErrorMessage !== null,
    isWorking,
    runlessWorkActive,
    workingHistoryKey,
    windowlessCitation,
    activeFindEntryId,
  });
  // Opens whatever hides a cited response. False when nothing does, so the citation stops waiting.
  const revealCitedEntry = (entryId: string, runId: RunId | null) => {
    const fold = timelineTurnFoldRunIdsByEntryId({
      timelineEntries,
      latestRun,
      runningRunId,
      isWorking,
      runlessWorkActive,
    }).get(entryId);
    const runs = fold ? withTurnFoldOpen(expandedRunIds, fold) : expandedRunIds;
    const groups = runId
      ? withRunGroupsOpen(expandedWorkGroupIds, rows, runId)
      : expandedWorkGroupIds;
    const attemptId = timelineEntries.find((entry) => entry.id === entryId)?.attempt?.id;
    const attempts =
      attemptId && !expandedAttemptIds.has(attemptId)
        ? new Set(expandedAttemptIds).add(attemptId)
        : expandedAttemptIds;
    const windowed =
      citationRequest !== null &&
      rows.some(
        (row) => row.kind === "working" && row.window?.items.some((item) => item.id === entryId),
      );
    if (
      runs === expandedRunIds &&
      groups === expandedWorkGroupIds &&
      attempts === expandedAttemptIds &&
      !windowed
    ) {
      return false;
    }
    setExpandedRunIds(runs);
    setExpandedWorkGroupIds(groups);
    setExpandedAttemptIds(attempts);
    if (windowed) setWindowlessCitationKey(citationRequest.key);
    return true;
  };
  // Reveal nested folds before resolving the citation phase; later refolding stays manual.
  const [citationExpandedFor, setCitationExpandedFor] = useState<string | null>(null);
  if (!citationRequest && citationExpandedFor !== null) setCitationExpandedFor(null);
  const citedEntry =
    citationRequest &&
    citationExpandedFor !== citationRequest.key &&
    citationHistory._tag !== "failed"
      ? timelineEntries.find(
          (entry) =>
            entry.kind === "message" &&
            entry.message.role === "assistant" &&
            entry.message.id === citationRequest.citation.messageId,
        )
      : undefined;
  if (citationRequest && citedEntry?.kind === "message") {
    if (!revealCitedEntry(citedEntry.id, citedEntry.message.runId ?? null)) {
      setCitationExpandedFor(citationRequest.key);
    }
  }
  // The next turn folds the previous one back, even if the user opened it. A
  // failed or limited fold starts open, so its key is the user's collapse.
  // Raw rows still hold folds that an update group collapsed away.
  const [observedLatestRun, setObservedLatestRun] = useState({
    identity: listIdentityKey,
    runId: latestRun?.runId,
  });
  if (
    observedLatestRun.identity !== listIdentityKey ||
    observedLatestRun.runId !== latestRun?.runId
  ) {
    setObservedLatestRun({ identity: listIdentityKey, runId: latestRun?.runId });
    const previousRunId = observedLatestRun.runId;
    if (
      observedLatestRun.identity === listIdentityKey &&
      latestRun &&
      previousRunId !== undefined &&
      latestRun.runId !== previousRunId &&
      !rawRows.some(
        (row) =>
          row.kind === "turn-fold" && row.runId === previousRunId && turnFoldStartsOpen(row.ending),
      )
    ) {
      setExpandedRunIds((existing) => {
        if (!existing.has(previousRunId)) return existing;
        const next = new Set(existing);
        next.delete(previousRunId);
        return next;
      });
    }
  }
  // A match inside a folded "Handled N updates" group opens the group.
  const activeFindRunId = activeFindMatch?.runId ?? null;
  const findGroupKey = `${activeFindRunId ?? ""}:${activeFindEntryId ?? ""}`;
  const [expandedFindGroupKey, setExpandedFindGroupKey] = useState<string | null>(null);
  if (expandedFindGroupKey !== findGroupKey) {
    setExpandedFindGroupKey(findGroupKey);
    if (activeFindRunId) {
      setExpandedWorkGroupIds((current) => withRunGroupsOpen(current, rows, activeFindRunId));
    }
  }
  const matchedApprovalRequestIds = new Set<string>();
  for (const row of pendingApprovalRequestIds.size > 0 ? rows : []) {
    const entries =
      row.kind === "work" ? row.groupedEntries : row.kind === "work-live" ? [row.entry] : [];
    for (const entry of entries) {
      const item = entry.projectedItem?.item;
      if (item?.type === "approval_request") matchedApprovalRequestIds.add(item.requestId);
    }
  }
  const unmatchedPendingApprovals = pendingApprovals.filter(
    (approval) =>
      isVisiblePendingApproval(approval) && !matchedApprovalRequestIds.has(approval.requestId),
  );
  // Run status/timestamps change per stream event; keep them out of shared row context.
  const runs = useStableHandoffRuns(runsProp);
  const minimapItems = deriveTimelineMinimapItems(rows);
  const minimapRowIndices = minimapItems.map((item) => item.rowIndex);
  const restoreRowIndex =
    restoringThreadPosition && rememberedPosition?.atEnd === false
      ? rows.findIndex((row) => row.id === rememberedPosition.rowId)
      : -1;
  const restoringAlwaysRender =
    restoringThreadPosition && restoreRowIndex >= 0 ? { indices: [restoreRowIndex] } : undefined;
  const showsEmptyState =
    rows.length === 0 &&
    unmatchedPendingApprovals.length === 0 &&
    !isWorking &&
    parentThreadLink === null &&
    historyControls === undefined &&
    footer === null;
  const [listOpening, setListOpening] = useState<TimelineListOpening>(() =>
    nextListOpening({ mounted: false }, !showsEmptyState, listIdentityKey),
  );
  const nextOpening = nextListOpening(listOpening, !showsEmptyState, listIdentityKey);
  if (nextOpening !== listOpening) setListOpening(nextOpening);
  const listOpenedOn = nextOpening.mounted ? nextOpening.identity : null;
  const viewportRef = useRef<TimelineViewport | null>(null);
  const navigateTimeline = () => viewportRef.current?.navigate({ releasesFollow: true });
  const restoreReady = restoringThreadPosition && rows.length > 0;
  // Z: syncs LegendList's scroll position with which thread it shows. The list
  // is not keyed per thread and reports no "new data" event, and the restore
  // must land before paint, after LegendList's own layout effects applied the
  // new data. A citation request that arrives mid-restore takes over.
  const { findOpenAtOpening } = identityChanged ? { findOpenAtOpening: findOpen } : listState;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores LegendList's scroll position for the shown thread before paint, after the list's own layout
  useLayoutEffect(() => {
    const list = listRef.current;
    const viewport = viewportRef.current;
    if (!restoreReady || !list || !viewport) return;
    return startTimelinePositionRestore({
      list,
      viewport,
      listIdentityKey,
      listOpenedOn,
      rememberedPosition,
      citationPending: citationRequest !== null,
      releaseForFind: findOpenAtOpening,
      onPositioned: setPositionedThreadKey,
    });
  }, [
    citationRequest,
    findOpenAtOpening,
    listIdentityKey,
    listOpenedOn,
    listRef,
    rememberedPosition,
    restoreReady,
    viewportRef,
  ]);

  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(
    null,
  );
  const {
    target: readyCitationRequest,
    positioning: citationPositioning,
    onListLoad: onCitationListLoad,
    alwaysRender: citationAlwaysRender,
  } = useAssistantCitationTarget({
    request: citationRequest,
    phase: citationRequest
      ? resolveCitationPhase({
          history: citationHistory,
          messageId: citationRequest.citation.messageId,
          entries: timelineEntries,
          rows,
        })
      : null,
    viewport: timelineViewportElement,
    onManualNavigation: navigateTimeline,
  });
  const [findListReady, setFindListReady] = useState(false);
  const handleListLoad = () => {
    onCitationListLoad();
    setFindListReady(true);
  };
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false);
  // Every full-screen viewer reports false when it unmounts, so a row that leaves the list
  // while full screen releases its pin too.
  const onAppFullscreenChange = (rowId: string, fullscreen: boolean) => {
    setFullscreenAppRowId((current) => (fullscreen ? rowId : current === rowId ? null : current));
  };
  const alwaysRenderIndices = restoringAlwaysRender?.indices ?? [];
  // Screen readers can only reach headings in the DOM. Keeping the first and
  // last messages mounted lets heading navigation wrap to either end.
  const firstMessageRow = rows.find(isMessageRow);
  const lastMessageRow = rows.findLast(isMessageRow);
  const alwaysRenderKeys = [
    ...(firstMessageRow ? [firstMessageRow.id] : []),
    ...(lastMessageRow && lastMessageRow !== firstMessageRow ? [lastMessageRow.id] : []),
    ...(citationAlwaysRender?.keys ?? []),
    ...(fullscreenAppRowId === null ? [] : [fullscreenAppRowId]),
    ...new Set(
      [...playingAudioRows].filter(([audio]) => audio.isConnected).map(([, rowId]) => rowId),
    ),
  ];
  const alwaysRender =
    alwaysRenderIndices.length === 0 && alwaysRenderKeys.length === 0
      ? undefined
      : {
          ...(alwaysRenderIndices.length === 0 ? {} : { indices: alwaysRenderIndices }),
          ...(alwaysRenderKeys.length === 0 ? {} : { keys: alwaysRenderKeys }),
        };
  const [minimapHitStripWidth, setMinimapHitStripWidth] = useState(0);
  const [minimapCurrentIndex, setMinimapCurrentIndex] = useState<number | null>(null);
  const handleAnchorReady = (info: { anchorIndex: number | undefined }) => {
    if (anchorMessageId !== null && info.anchorIndex !== undefined) {
      onAnchorReady(anchorMessageId, info.anchorIndex);
    }
  };
  const handleAnchorSizeChanged = (size: number) => {
    if (anchorMessageId !== null) {
      onAnchorSizeChanged(anchorMessageId, size);
    }
  };
  const anchoredEndSpaceConfig = resolveChatListAnchoredEndSpace(
    rows,
    anchorMessageId,
    (row) => (row.kind === "message" && row.message.role === "user" ? row.message.id : null),
    { anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET },
  );
  const anchoredEndSpace = anchoredEndSpaceConfig
    ? {
        ...anchoredEndSpaceConfig,
        onReady: handleAnchorReady,
        onSizeChanged: handleAnchorSizeChanged,
      }
    : undefined;
  const maintainVisibleContentPosition = {
    data: true,
    size: true,
    shouldRestorePosition: shouldRestoreVisibleContentPosition,
  };

  const refreshMinimap = useStableCallback(() => {
    const state = listRef.current?.getState?.();
    if (restoringThreadPosition || state?.data !== rows) return;
    if (!state || minimapItems.length === 0) {
      return;
    }

    const firstBufferedIndex = state.startBuffered;
    const firstBufferedRow: HTMLElement | undefined =
      firstBufferedIndex == null ? undefined : state.elementAtIndex(firstBufferedIndex);
    const firstBufferedTop =
      firstBufferedIndex == null ? undefined : state.positionAtIndex(firstBufferedIndex);
    const viewport: HTMLElement | undefined = listRef.current?.getScrollableNode();
    // Cached row positions exclude the header and pending scroll adjustments.
    const scroll =
      firstBufferedRow && viewport && firstBufferedTop !== undefined
        ? firstBufferedTop +
          viewport.getBoundingClientRect().top -
          firstBufferedRow.getBoundingClientRect().top
        : state.scroll;
    const visibleRange = resolveTimelineMinimapVisibleRange({ ...state, scroll });
    for (const item of minimapItems) {
      const strip = minimapStripMap.get(item.id);
      const inView = isTimelineMinimapRowVisible(
        item.rowIndex,
        visibleRange.start,
        visibleRange.end,
      );
      const next = inView ? "true" : "false";
      // Avoid dirtying style state on every scroll tick for unchanged strips.
      if (strip && strip.dataset.inView !== next) {
        strip.dataset.inView = next;
      }
    }
    const nextCurrentIndex = resolveTimelineMinimapCurrentIndex({
      visibleStart: visibleRange.start,
      visibleEnd: visibleRange.end,
      rowIndices: minimapRowIndices,
    });
    setMinimapCurrentIndex((current) =>
      current === nextCurrentIndex ? current : nextCurrentIndex,
    );
  });

  const minimapRefreshFrameRef = useRef<number | null>(null);
  const scheduleMinimapRefresh = () => {
    if (minimapRefreshFrameRef.current !== null) return;
    // LegendList recycles row containers before React commits their positions.
    minimapRefreshFrameRef.current = requestAnimationFrame(() => {
      minimapRefreshFrameRef.current = null;
      refreshMinimap();
    });
  };

  // The measurement the last remember wrote, so a follow release can rewrite
  // it without reading render state from a listener.
  const lastRememberedRef = useRef<{
    readonly data: unknown;
    readonly threadKey: string;
    readonly position: Parameters<typeof rememberTimelinePosition>[1];
  } | null>(null);
  const rememberPosition = (followingEnd: boolean) => {
    const state = listRef.current?.getState?.();
    if (restoringThreadPosition || state?.data !== rows) return;
    const isAtEnd = resolveTimelineIsAtEnd(state);
    const position = state.data.length ? resolveWorkGroupScrollAnchor(state) : undefined;
    if (position && isAtEnd !== undefined) {
      const index = state.indexByKey(position.rowId);
      const row = index === undefined ? undefined : state.elementAtIndex(index);
      const element = listRef.current?.getScrollableNode();
      if (row && element) {
        const measured = {
          ...position,
          offsetWithinRow: element.getBoundingClientRect().top - row.getBoundingClientRect().top,
          scrollOffset: element.scrollTop,
          atEnd: isAtEnd,
          disclosures: {
            runs: paintedExpandedRunIds,
            workGroups: paintedExpandedWorkGroupIds,
            attempts: paintedExpandedAttemptIds,
            workGroupState: workGroupViewState,
          },
        };
        lastRememberedRef.current = { data: rows, threadKey: listIdentityKey, position: measured };
        rememberTimelinePosition(listIdentityKey, measured, followingEnd);
      }
    }
    return isAtEnd;
  };
  // A follow release without a scroll after it would leave the position
  // remembered as following.
  const rememberReleasedPosition = () => {
    const last = lastRememberedRef.current;
    if (last && listRef.current?.getState().data === last.data) {
      rememberTimelinePosition(last.threadKey, last.position, false);
    }
  };

  const handleScroll = () => {
    if (restoringThreadPosition || listRef.current?.getState?.().data !== rows) return;
    const isAtEnd = rememberPosition(liveFollowEnabled && !anchoredEndSpace);
    if (isAtEnd !== undefined && !citationPositioning) {
      onIsAtEndChange(isAtEnd);
    }
    scheduleMinimapRefresh();
  };

  const handleItemSizeChanged = () => {
    if (disclosurePinsEndRef.current) {
      queueMicrotask(pinDisclosureToEnd);
      scheduleDisclosureSettle();
    }
    scheduleMinimapRefresh();
  };

  const measureTimelineGutter = (viewportElement: HTMLElement) => {
    const viewportWidth = viewportElement.getBoundingClientRect().width;
    const contentWidth =
      viewportElement.querySelector<HTMLElement>("[data-timeline-root]")?.getBoundingClientRect()
        .width ?? viewportWidth;
    const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(
      viewportWidth,
      contentWidth,
    );
    setMinimapHasPersistentGutter((current) =>
      current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
    );
    setMinimapHitStripWidth(resolveTimelineMinimapHitStripWidth(viewportWidth, contentWidth));
  };
  // Rows added, removed or rewrapped (chat width) change the content size,
  // which moves the scroll position, the overflow, and the content lane width.
  const handleContentSizeChanged = useStableCallback((laidOutData: unknown) => {
    // The first laid-out content of a newly shown thread ends its settling; a
    // frame the previous thread scheduled laid out the previous thread's rows.
    if (laidOutData === rows) {
      setSettlingListIdentity((current) => (current === listIdentityKey ? null : current));
    }
    handleScroll();
  });
  // The content lane only changes width with the viewport or the chat width
  // setting, never with streamed content; measuring per content frame would
  // force a layout on every chunk.
  const measuredLaneWidthRef = useRef<number | null>(null);
  const observeLaneWidth = (lane: HTMLDivElement | null) => {
    if (!lane) return;
    return observeResize(lane, (entries) => {
      const width = entries.at(-1)?.contentRect.width;
      if (width === undefined || width === measuredLaneWidthRef.current) return;
      measuredLaneWidthRef.current = width;
      const viewportElement = lane.closest<HTMLElement>("[data-assistant-citation-viewport]");
      if (viewportElement) measureTimelineGutter(viewportElement);
    });
  };
  const attachTimelineViewportElement = (viewportElement: HTMLDivElement | null) => {
    setTimelineViewportElement(viewportElement);
    if (!viewportElement) return;
    const stopObserving = observeResize(viewportElement, () =>
      measureTimelineGutter(viewportElement),
    );
    return () => {
      stopObserving();
      setTimelineViewportElement(null);
    };
  };

  // Built from props after the last hook so the compiler can memoize the row context; a map
  // made before a hook would rebuild it, and re-render every row, on each streamed update.
  const pendingApprovalsByRequestId = new Map(
    pendingApprovals
      .filter(isVisiblePendingApproval)
      .map((approval) => [approval.requestId, approval]),
  );
  const sharedState: TimelineRowSharedState = {
    pendingApprovals: pendingApprovalsByRequestId,
    respondingRequestIds,
    canOperateThread,
    onRespondToApproval,
    citationRequest: readyCitationRequest,
    listRef,
    timestampFormat,
    routeThreadKey,
    threadRef: citationThreadRef,
    markdownCwd,
    resolvedTheme,
    workspaceRoot,
    skills,
    runs,
    activeThreadEnvironmentId,
    onRevertToTurnCount,
    onRunShellCommand,
    findActive,
    onImageExpand,
    onFileOpen,
    onUseArtifactTemplate,
    onSendAppMessage,
    onAppFullscreenChange,
    onFileDownload,
    openPullRequest,
    onOpenToolDiff,
    onOpenTurnDiff,
    onOpenThread,
    renderHtmlRender,
    turnItemSource,
    workflowOpening,
    onForkFromRun,
    onToggleTurnFold,
    onToggleAttemptFold,
    onToggleWorkGroup,
    onToggleWorkEntry: suspendEndScrollMaintenanceForDisclosure,
    onCancelWorktreeSetup: onCancelWorktreeSetup ?? null,
    retryableWorkspacePreparationRunIds,
    onRetryWorkspacePreparation: onRetryWorkspacePreparation ?? null,
    onWorktreeSetupWorkLocally: onWorktreeSetupWorkLocally ?? null,
    onOpenWorktreeSetupTerminal: onOpenWorktreeSetupTerminal ?? null,
    onToggleWorkingHistory,
    onFocusComposer: onFocusComposer ?? null,
    onInterrupt: onInterrupt ?? null,
    workGroupViewState,
  };
  const compactionAwaitingRow =
    isCompacting &&
    !rawRows.some(
      (row) =>
        (row.kind === "context-compaction" && row.active) ||
        (row.kind === "working" && row.compacting),
    );
  const backgroundWorktreeSetup =
    worktreeSetup !== null &&
    worktreeSetup.phase === "running" &&
    worktreeSetupAgentStarted(worktreeSetup) &&
    latestRun?.startedAt != null
      ? worktreeSetup
      : null;
  const activityState: TimelineRowActivityState = {
    isWorking,
    isCompacting: compactionAwaitingRow,
    isRevertingCheckpoint,
    backgroundWorktreeSetup,
    turnEnded: latestRun?.turnEnded === true,
    activeTurnStartedAt,
    awaitingUser: awaitingUser !== null,
    isPreparingWorktree,
    latestRunId: latestRun?.runId ?? null,
    pendingRequest: isWorking ? pendingRequest : null,
    backgroundTaskLabel,
    usageLimit,
    threadErrorMessage,
  };
  // Mounted in both the empty and filled timeline so a thread's first turn
  // starts from a baseline instead of a fresh, silent region.
  const activityAnnouncer = (
    <ThreadActivityAnnouncer
      threadKey={announceTurnStatus ? listIdentityKey : null}
      status={awaitingUser ?? (isWorking ? "working" : "idle")}
      requestId={awaitingRequestId}
      runId={announcedRun?.runId ?? null}
      runStatus={announcedRun?.status ?? null}
      detailBehind={detailBehindShell}
    />
  );
  const listHeaderLeadingContent =
    parentThreadLink === null ? (
      topFadeEnabled ? (
        TIMELINE_LIST_FADE_HEADER
      ) : (
        TIMELINE_LIST_HEADER
      )
    ) : (
      <div className="messages-timeline-row-frame">
        <div className="chat-content-lane pt-1 sm:pt-2">
          <TimelineSystemDivider
            label={parentThreadLink.sideChat ? "Context from" : "Subagent of"}
            detail={
              parentThreadLink.environmentLabel === undefined
                ? parentThreadLink.title
                : `${parentThreadLink.title} on ${parentThreadLink.environmentLabel}`
            }
            icon={parentThreadLink.sideChat ? MessagesSquareIcon : BotIcon}
            {...(parentThreadLink.open === undefined
              ? {}
              : { actionLabel: "Open parent thread", onAction: parentThreadLink.open })}
          />
        </div>
      </div>
    );
  const listHeader = (
    <>
      {parentThreadLink === null ? listHeaderLeadingContent : null}
      {historyControls ? <TimelineHistoryControl {...historyControls} /> : null}
      {parentThreadLink !== null ? listHeaderLeadingContent : null}
    </>
  );

  const canvas = useChatCanvas();
  const registerTimeline = canvas?.registerTimeline;
  // Stable so the list attaches once per mount, not on every render.
  const setTimelineList = useStableCallback((list: LegendListRef | null) => {
    listRef.current = list;
    const scrollNode: HTMLElement | null = list?.getScrollableNode() ?? null;
    registerTimeline?.(scrollNode);
    const viewport = scrollNode ? attachTimelineViewport(scrollNode) : null;
    viewportRef.current = viewport;
    const detachViewport = viewport ? onViewportAttach?.(viewport) : undefined;
    const stopRememberingRelease = viewport?.onFollowReleased(rememberReleasedPosition);
    let contentSizeFrame: number | null = null;
    // LegendList lays rows out from layout effects; the next frame sees them settled.
    let scheduledData: unknown = null;
    const scheduleContentSizeChanged = () => {
      if (!list) return;
      const laidOutData = list.getState().data;
      if (contentSizeFrame !== null) {
        if (scheduledData === laidOutData) return;
        cancelAnimationFrame(contentSizeFrame);
      }
      scheduledData = laidOutData;
      contentSizeFrame = requestAnimationFrame(() => {
        contentSizeFrame = null;
        handleContentSizeChanged(laidOutData);
      });
    };
    const stopListeningToContentSize = list
      ?.getState()
      .listen("totalSize", () => scheduleContentSizeChanged());
    scheduleContentSizeChanged();
    return () => {
      stopListeningToContentSize?.();
      stopRememberingRelease?.();
      if (contentSizeFrame !== null) cancelAnimationFrame(contentSizeFrame);
      detachViewport?.();
      viewport?.dispose();
      if (viewportRef.current === viewport) viewportRef.current = null;
      // Refresh frames only read the list; disclosure frames still run so the
      // settle flag clears.
      if (minimapRefreshFrameRef.current !== null) {
        cancelAnimationFrame(minimapRefreshFrameRef.current);
        minimapRefreshFrameRef.current = null;
      }
      listRef.current = null;
      registerTimeline?.(null);
    };
  });

  useThreadFindPositionReader({
    threadKey: listIdentityKey,
    navigate: navigateTimeline,
    timelineViewportElement,
    findFoldRunIds,
    timelineEntries,
    latestRun,
    runningRunId,
    isWorking,
    runlessWorkActive,
    rows,
    contentInsetEndAdjustment,
  });

  useThreadFindNavigation({
    // Find reveals its match only after the opening restore settles; both
    // scroll the list directly, so the restore would otherwise pull it back.
    listReady: findListReady && !restoringThreadPosition,
    historyControls,
    entries: timelineEntries,
    container: timelineViewportElement,
    query: normalizedFindQuery,
    match: activeFindMatch,
    navigationId: findNavigationId,
    rowIndex: activeFindMatch ? rows.findIndex((row) => row.id === activeFindMatch.entryId) : -1,
    listRef,
    contentInsetEndAdjustment,
  });

  // LegendList moves rows one commit late; per-row providers prevent thread context leaks.
  const onAudioPlaybackChange = (rowId: string, event: SyntheticEvent) => {
    const audio = event.target;
    if (!(audio instanceof HTMLAudioElement)) return;
    setPlayingAudioRows((current) => {
      const playing = !audio.paused && !audio.ended;
      if (playing === current.has(audio)) return current;
      const next = new Map(current);
      if (playing) next.set(audio, rowId);
      else next.delete(audio);
      return next;
    });
  };
  const onAudioUnmount = useStableCallback((audio: HTMLAudioElement) => {
    setPlayingAudioRows((current) => {
      if (!current.has(audio)) return current;
      const next = new Map(current);
      next.delete(audio);
      return next;
    });
  });
  const renderItem = ({ item }: { item: MessagesTimelineRow }) => (
    <TimelineRowCtx value={sharedState}>
      <div
        className="messages-timeline-row-frame"
        onPlayCapture={(event) => onAudioPlaybackChange(item.id, event)}
        onPauseCapture={(event) => onAudioPlaybackChange(item.id, event)}
        onEndedCapture={(event) => onAudioPlaybackChange(item.id, event)}
      >
        <div
          ref={observeLaneWidth}
          className="chat-content-lane overflow-x-clip"
          data-timeline-root="true"
        >
          <AudioPreviewUnmountContext value={onAudioUnmount}>
            <TimelineRowContent row={item} />
          </AudioPreviewUnmountContext>
        </div>
      </div>
    </TimelineRowCtx>
  );
  const listExtraData = { identity: listIdentityKey, rowCount: rows.length, sharedState };
  const timelineListFooter = (
    <TimelineListFooter
      composerInset={anchoredEndSpace ? 0 : contentInsetEndAdjustment}
      onGrow={onFooterGrow}
    >
      {footer}
      {unmatchedPendingApprovals.length > 0 ? (
        <TimelineRowCtx value={sharedState}>
          <div className="messages-timeline-row-frame">
            <div className="chat-content-lane overflow-x-clip" data-timeline-root="true">
              <WorkLogBlock>
                {unmatchedPendingApprovals.map((approval) => (
                  <TimelinePendingApprovalRow key={approval.requestId} approval={approval} />
                ))}
              </WorkLogBlock>
            </div>
          </div>
        </TimelineRowCtx>
      ) : null}
    </TimelineListFooter>
  );

  const forwardMinimapWheel = (event: WheelEvent) => {
    const scrollNode = listRef.current?.getScrollableNode();
    if (scrollNode) forwardWheelToTimeline(event, scrollNode);
  };

  if (showsEmptyState) {
    if (hideEmptyPlaceholder) {
      return (
        <>
          {activityAnnouncer}
          <div className="h-full min-h-0 bg-background" data-timeline-loading="true" />
        </>
      );
    }
    return (
      <>
        {activityAnnouncer}
        <div
          className="h-full ps-(--chat-lane-inset-start) pe-(--chat-lane-inset-end)"
          style={{ paddingBottom: emptyPlaceholderInset }}
        >
          <Empty size="compact" className="h-full">
            <EmptyMedia variant="icon">
              <MessageSquareIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No messages yet</EmptyTitle>
              <EmptyDescription>Send a message to start the conversation.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </>
    );
  }

  return (
    <>
      {activityAnnouncer}
      <MarkdownFindContext value={findActive}>
        <TimelineRowActivityCtx value={activityState}>
          <TooltipScrollDismissArea
            ref={attachTimelineViewportElement}
            className="relative h-full min-h-0"
            data-assistant-citation-viewport="true"
          >
            {onCiteAssistantText && citationThreadRef ? (
              <AssistantSelectionToolbar
                viewport={timelineViewportElement}
                threadRef={citationThreadRef}
                onCite={onCiteAssistantText}
              />
            ) : null}
            <LegendList<MessagesTimelineRow>
              ref={setTimelineList}
              data={rows}
              extraData={listExtraData}
              keyExtractor={keyExtractor}
              getItemType={getItemType}
              renderItem={renderItem}
              estimatedItemSize={90}
              initialScrollAtEnd={
                !findActive && citationRequest === null && rememberedPosition?.atEnd !== false
              }
              // Legend needs a data refresh to mount new pins without a scroll event.
              dataVersion={`${readyCitationRequest?.key ?? listIdentityKey}:${alwaysRenderKeys.join(",")}`}
              {...(alwaysRender ? { alwaysRender } : {})}
              onLoad={handleListLoad}
              {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
              contentInsetEndAdjustment={anchoredEndSpace ? contentInsetEndAdjustment : 0}
              maintainScrollAtEnd={
                citationPositioning ||
                (restoringThreadPosition && rememberedPosition?.atEnd === false) ||
                anchoredEndSpace ||
                !liveFollowEnabled ||
                fullscreenAppRowId !== null ||
                disclosureToggleSettling
                  ? false
                  : isWorking && !prefersReducedMotion && settlingListIdentity === null
                    ? TIMELINE_MAINTAIN_SCROLL_AT_END_SMOOTH
                    : TIMELINE_MAINTAIN_SCROLL_AT_END
              }
              maintainVisibleContentPosition={
                findActive ||
                citationPositioning ||
                (restoringThreadPosition && rememberedPosition?.atEnd === false)
                  ? false
                  : maintainVisibleContentPosition
              }
              maintainScrollAtEndThreshold={1}
              onScroll={handleScroll}
              onItemSizeChanged={handleItemSizeChanged}
              className="messages-timeline-scroll scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain [overflow-anchor:none]"
              ListHeaderComponent={listHeader}
              ListFooterComponent={timelineListFooter}
            />
            <TimelineMinimap
              items={minimapItems}
              hasPersistentGutter={minimapHasPersistentGutter}
              hitStripWidth={minimapHitStripWidth}
              currentIndex={minimapCurrentIndex}
              stripMap={minimapStripMap}
              onWheel={forwardMinimapWheel}
              onSelect={(item) => {
                navigateTimeline();
                void listRef.current?.scrollToIndex({
                  index: item.rowIndex,
                  animated: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
                  viewOffset: 24,
                });
              }}
            />
          </TooltipScrollDismissArea>
        </TimelineRowActivityCtx>
      </MarkdownFindContext>
    </>
  );
});

function TimelineHistoryControl(props: MessagesTimelineHistoryControls) {
  if (!props.hasMoreHistory && props.error === null) {
    return null;
  }
  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane flex flex-col gap-1.5 pb-2">
        {props.hasMoreHistory ? (
          <button
            type="button"
            disabled={props.loading}
            aria-label="Load earlier turns"
            onClick={() => props.onLoadEarlier()}
            className="flex w-full cursor-pointer items-center gap-3 py-1.5 text-dim-foreground text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
          >
            <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
            <span className="shrink-0">
              {props.loading ? "Loading earlier turns…" : "Load earlier turns"}
            </span>
            <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
          </button>
        ) : null}
        {props.error !== null ? (
          <p role="status" className="text-center text-muted-foreground text-xs">
            {props.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function isMessageRow(row: MessagesTimelineRow) {
  return row.kind === "message" && row.message.role !== "system";
}

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

// LegendList averages by type; length buckets prevent inflated estimates and nested-update loops.
function getItemType(item: MessagesTimelineRow) {
  if (item.kind !== "message") return item.kind;
  const lengthBucket = Math.max(0, Math.floor(Math.log2(item.message.text.length / 1000)));
  return `message:${item.message.role}:${lengthBucket}`;
}

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  const isExpandedToolGroup = row.kind === "work" && row.isExpandedToolGroup;
  const isSubagentGroup = row.kind === "event" && row.projectedItem.item.type === "subagent";
  const command = row.kind === "message" && row.command?.standalone ? row.command : null;
  const isWorkLogRow =
    command !== null ||
    row.kind === "work" ||
    row.kind === "work-live" ||
    row.kind === "work-toggle" ||
    row.kind === "thinking";
  const isExpandedToolGroupHeader =
    (row.kind === "work-toggle" || row.kind === "work-live" || row.kind === "thinking") &&
    row.expanded === true;

  return (
    <div
      className={cn(
        isWorkLogRow || isSubagentGroup
          ? undefined
          : row.kind === "turn-fold" || row.kind === "working" || row.kind === "background-activity"
            ? "pb-1.5"
            : row.kind === "message" && row.groupedWithNext
              ? "pb-1"
              : row.kind === "message" && row.message.role === "user"
                ? row.continuesPromptStack
                  ? "pb-2"
                  : "pb-3"
                : (row.kind === "message" &&
                      row.message.role === "assistant" &&
                      !row.showAssistantMeta) ||
                    row.kind === "worktree-setup" ||
                    row.kind === "event" ||
                    row.kind === "attempt-fold" ||
                    row.kind === "html-render" ||
                    row.kind === "mcp-app"
                  ? "pb-2"
                  : "pb-4",
        (row.kind === "message" && row.message.role === "assistant") ||
          row.kind === "assistant-meta"
          ? "group/assistant"
          : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={
        row.kind === "message" || row.kind === "assistant-meta" ? row.message.id : undefined
      }
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {isWorkLogRow ? (
        <WorkLogBlock
          continues={row.continuesWorkLog}
          layout={
            isExpandedToolGroup
              ? "group-content"
              : isExpandedToolGroupHeader
                ? "group-header"
                : "standalone"
          }
        >
          {row.kind === "work" ? (
            <WorkGroupSection
              anchorKey={row.id}
              groupedEntries={row.groupedEntries}
              isExpandedToolGroup={row.isExpandedToolGroup}
              displayLabel={row.displayLabel}
            />
          ) : null}
          {row.kind === "work-live" ? <LiveWorkEntryTimelineRow row={row} /> : null}
          {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
          {row.kind === "thinking" ? <ThinkingTimelineRow row={row} /> : null}
          {command ? <SlashCommandTimelineRow command={command} /> : null}
        </WorkLogBlock>
      ) : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow key={row.id} row={row} /> : null}
      {row.kind === "background-activity" ? <BackgroundActivityTimelineRow row={row} /> : null}
      {row.kind === "attempt-fold" ? <AttemptFoldTimelineRow row={row} /> : null}
      {row.kind === "context-compaction" ? <ContextCompactionTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" && command === null ? (
        <UserMessageRow row={row} />
      ) : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "assistant-meta" ? <AssistantMetaTimelineRow row={row} /> : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "html-render" ? <HtmlRenderTimelineRow row={row} /> : null}
      {row.kind === "mcp-app" ? <McpAppTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
      {row.kind === "worktree-setup" ? <WorktreeSetupTimelineRow row={row} /> : null}
      {row.kind === "event" ? <V2EventTimelineRow row={row} /> : null}
    </div>
  );
});

function WorktreeSetupTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "worktree-setup" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const terminalId = row.snapshot.setupScript?.terminalId ?? null;
  const openTerminal = ctx.onOpenWorktreeSetupTerminal;
  const onOpenTerminal = openTerminal && terminalId ? () => openTerminal(terminalId) : null;
  return (
    <WorktreeSetupCard
      snapshot={row.snapshot}
      embedded={row.embedded}
      onCancel={row.embedded ? null : ctx.onCancelWorktreeSetup}
      onWorkLocally={
        !row.embedded && row.snapshot.phase === "running" ? ctx.onWorktreeSetupWorkLocally : null
      }
      onOpenTerminal={onOpenTerminal}
    />
  );
}

function ContextCompactionTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "context-compaction" }>;
}) {
  const label =
    row.title && row.label.startsWith("Context compacted")
      ? row.title + row.label.slice("Context compacted".length)
      : row.label;
  const content = (
    <span className="flex min-w-0 items-center gap-1.5">
      {row.failed ? (
        <CircleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
      ) : (
        <Minimize2Icon aria-hidden="true" className="size-3" />
      )}
      {row.tokenCounts ? (
        <>
          {row.title ?? "Context compacted"} {row.tokenCounts.before}
          <ArrowRightIcon aria-hidden="true" className="size-3" />
          {row.tokenCounts.after} tokens
        </>
      ) : (
        label
      )}
      {row.failure ? (
        <span className="min-w-0 truncate opacity-80">&middot; {row.failure}</span>
      ) : null}
    </span>
  );
  return (
    <div
      role="separator"
      aria-label={row.failure ? `${label}: ${row.failure}` : label}
      className={cn(
        "mx-auto flex w-full max-w-(--chat-content-max-width) items-center gap-3 py-1 text-meta",
        row.failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <span className={cn("h-px flex-1", row.failed ? "bg-destructive/30" : "bg-border")} />
      <span
        ref={row.active ? observeVisibleAnimation : undefined}
        className="relative min-w-0 overflow-hidden"
      >
        {content}
        {row.active ? <ActivityShimmerOverlay>{content}</ActivityShimmerOverlay> : null}
      </span>
      <span className={cn("h-px flex-1", row.failed ? "bg-destructive/30" : "bg-border")} />
    </div>
  );
}

function useDeferredWorkLoading(
  row: { expanded: boolean; deferredWorkItemIds?: ReadonlyArray<string> },
  onToggle: () => void,
) {
  const ctx = use(TimelineRowCtx);
  const loadWork = useAtomCommand(threadEnvironment.loadEarlierHistory, { reportFailure: false });
  const ref = parseScopedThreadKey(ctx.routeThreadKey);
  const environmentId = ref?.environmentId;
  const threadId = ref?.threadId;
  const anchorsKey = row.deferredWorkItemIds?.join("\n") ?? "";
  const [failed, setFailed] = useState(false);
  const load = () => {
    if (!anchorsKey || environmentId === undefined || threadId === undefined) return;
    void Promise.all(
      anchorsKey
        .split("\n")
        .map((workAnchorId) => loadWork({ environmentId, input: { threadId, workAnchorId } })),
    ).then((results) =>
      setFailed(
        results.some((result) => result._tag === "Failure" || result.value._tag === "error"),
      ),
    );
  };
  const loadOnExpand = useEffectEvent(load);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restored expanded folds load their deferred server history on mount.
  useEffect(() => {
    if (row.expanded && anchorsKey && environmentId && threadId) loadOnExpand();
  }, [row.expanded, anchorsKey, environmentId, threadId]);
  const error = anchorsKey && failed ? "Couldn't load work. Click to retry." : null;
  const loading = ref !== null && row.expanded && anchorsKey !== "" && !failed;
  const toggle = () => {
    setFailed(false);
    if (error && row.expanded) load();
    else onToggle();
  };

  return { loading, error, toggle };
}

function WorkHistorySkeleton() {
  return (
    <div role="status" aria-label="Loading work history" className="space-y-2 px-1 pb-1 pt-3">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex items-center gap-2" aria-hidden="true">
          <Skeleton className="size-3 shrink-0" />
          <Skeleton
            shape="pill"
            className={index === 0 ? "h-2.5 w-2/5" : index === 1 ? "h-2.5 w-3/5" : "h-2.5 w-1/3"}
          />
        </div>
      ))}
    </div>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  const { loading, error, toggle } = useDeferredWorkLoading(row, () =>
    ctx.onToggleTurnFold(row.runId),
  );
  const { backgroundTaskLabel, usageLimit, latestRunId, threadErrorMessage } =
    use(TimelineRowActivityCtx);
  const isLatestRun = latestRunId === row.runId;
  // One line says why the run failed: its error, unless the composer banner
  // already does, then the provider notice that carries the limit's reset.
  const failureLine =
    row.failureMessage !== null && !(isLatestRun && row.failureMessage === threadErrorMessage)
      ? row.failureMessage
      : row.noticeMessage;
  const labelClassName = cn(
    "flex min-w-0 items-center gap-2 self-stretch text-label tabular-nums",
    row.ending === "failed"
      ? "text-error-foreground"
      : row.ending === "limited"
        ? "text-warning-foreground"
        : "text-muted-foreground",
  );
  const labelContent = (
    <>
      {row.ending === "failed" ? <CircleAlertIcon aria-hidden className="size-3 shrink-0" /> : null}
      <span className="truncate">
        {row.label}
        {error ? ` · ${error}` : ""}
      </span>
    </>
  );
  const limit = row.ending === "limited" && usageLimit?.runId === row.runId ? usageLimit : null;

  return (
    <div>
      <div className={WORKING_BAR_CLASS_NAME}>
        {row.foldable ? (
          <button
            type="button"
            aria-expanded={row.expanded}
            data-scroll-anchor-ignore
            onClick={toggle}
            aria-busy={loading}
            className={cn(
              "cursor-pointer select-none rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
              labelClassName,
              row.ending === "worked" || row.ending === "stopped" ? "hover:text-foreground" : null,
            )}
          >
            {labelContent}
            <WorkFoldChevron expanded={row.expanded} />
          </button>
        ) : (
          <span className={labelClassName}>{labelContent}</span>
        )}
        <span className="min-w-0 flex-1" />
        {isLatestRun && backgroundTaskLabel ? (
          <Tooltip>
            <TooltipTrigger render={<span className="flex min-w-0 shrink items-center gap-1.5" />}>
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
              <span className="sr-only">Still running:</span>
              <span className="min-w-0 truncate font-mono text-meta text-muted-foreground">
                {backgroundTaskLabel}
              </span>
            </TooltipTrigger>
            <TooltipPopup>Still running: {backgroundTaskLabel}</TooltipPopup>
          </Tooltip>
        ) : null}
        {limit?.resetAt ? (
          <TurnFoldUsageLimit limit={limit} timestampFormat={ctx.timestampFormat} />
        ) : null}
        {row.diff ? (
          <DiffStatBlocks additions={row.diff.additions} deletions={row.diff.deletions} />
        ) : null}
      </div>
      {loading ? <WorkHistorySkeleton /> : null}
      {row.ending === "stopped" ? (
        <p className="px-1 pt-2 text-body text-muted-foreground">
          {row.diff ? "Stopped by you. Changes so far are kept." : "Stopped by you."}
        </p>
      ) : failureLine ? (
        <p className="whitespace-pre-wrap break-words px-1 pt-2 text-body text-muted-foreground">
          {failureLine}
        </p>
      ) : null}
    </div>
  );
}

function AttemptFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "attempt-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  const { loading, error, toggle } = useDeferredWorkLoading(row, () =>
    ctx.onToggleAttemptFold(row.attemptId),
  );

  return (
    <div>
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        data-superseded-attempt-id={row.attemptId}
        onClick={toggle}
        aria-busy={loading}
        className="flex w-full cursor-pointer select-none items-center gap-2 rounded-card border border-transparent surface-card px-2.5 py-2 text-left transition-colors hover:surface-ghost-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <MorphIcon
          className="size-3.5 shrink-0 text-muted-foreground"
          icon={row.expanded ? ChevronDown : ChevronRight}
        />
        <span className="text-xs font-medium text-foreground">
          {row.label}
          {error ? ` · ${error}` : ""}
        </span>
        <span className="text-2xs text-muted-foreground">Cut off by a steer</span>
      </button>
      {loading ? <WorkHistorySkeleton /> : null}
    </div>
  );
}

const EMPTY_TIMELINE_SLASH_COMMANDS: ReadonlyArray<{ readonly name: string }> = [];
export type { TimelinePendingRequest, TimelineUsageLimit } from "./timelineRowContext";

function TurnFoldUsageLimit({
  limit,
  timestampFormat,
}: {
  limit: TimelineUsageLimit;
  timestampFormat: TimestampFormat;
}) {
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00Z`);
  const resetPassed = useDeadlinePassed(limit.resetAt === null ? null : Date.parse(limit.resetAt));
  if (!limit.resetAt || resetPassed || !(Date.parse(limit.resetAt) > nowMs)) return null;
  return (
    <>
      <span className="shrink-0 text-meta text-muted-foreground">
        resumes {formatUpcomingTimestamp(limit.resetAt, timestampFormat, nowMs)}
      </span>
      {limit.onToggleSnooze ? (
        <WorkingBarChip
          icon={<Clock3Icon aria-hidden />}
          aria-pressed={limit.snoozed}
          onClick={limit.onToggleSnooze}
        >
          {limit.snoozed ? "Snoozed" : "Snooze"}
        </WorkingBarChip>
      ) : null}
    </>
  );
}

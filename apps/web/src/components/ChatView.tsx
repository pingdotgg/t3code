import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { ScrollToEndButton, WorkspaceFileDropOverlay } from "./chat/TimelineOverlays";
import { usePasteToFocusComposer } from "./chat/usePasteToFocusComposer";
import { announcedRun, isDetailBehindShell } from "./chat/threadActivityAnnouncement";
import {
  deriveAvailableRevertTurnCounts,
  deriveThreadPendingBackgroundTasks,
  deriveWorkspaceMutationId,
  presentThreadShellFromProjection,
} from "./ChatView.logic";
import { usePullRequestDraftThread } from "./chat/usePullRequestDraftThread";
import { useComposerSelection } from "./chat/useComposerSelection";
import { useProjectCloneBanner } from "./chat/useProjectCloneBanner";
import { useAttachmentPreviewHandoff } from "./chat/useAttachmentPreviewHandoff";
import { useTimelineRewind } from "./chat/useTimelineRewind";
import { useThreadLifecycle } from "./chat/useThreadLifecycle";
import { useRightPanelActions } from "./chat/useRightPanelActions";
import { type TerminalLaunchContext, useChatTerminalActions } from "./chat/useChatTerminalActions";
import { useComposerSend } from "./chat/useComposerSend";
import { useComposerResume } from "./chat/useComposerResume";
import { useImplementPlanInNewThread } from "./chat/useProposedPlanSend";
import { ThreadFind, ThreadFindCanvas } from "./chat/ThreadFindProvider";
import { closeThreadFind, openThreadFind, useThreadFindOpen } from "./chat/threadFindStore";
import { THREAD_FIND_BAR_RESERVED_HEIGHT } from "./chat/ThreadFindBar";
import { usageLimitRecoveryBannerItem } from "./chat/UsageLimitRecoveryBanner";
import { resolveDraftHeroState } from "./ChatView.logic";
import { useQueuedRunEdit } from "./chat/useQueuedRunEdit";
import {
  isPaintOnlyThreadTimeline,
  peekHeldThreadTimeline,
  peekRememberedThreadTimeline,
  resolveThreadSwitchTimeline,
  recallCheckoutIsRepo,
  rememberCheckoutIsRepo,
} from "./ChatView.logic";
import { useLogicalProjectEnvironments } from "../hooks/useLogicalProjectEnvironments";
import { useStableCallback } from "../hooks/useStableCallback";
import { useProjectScriptEditing } from "./chat/useProjectScriptEditing";
import { RightPanelSurfaceContent } from "./chat/RightPanelSurfaceContent";
import { usePendingThreadRequests } from "./chat/usePendingThreadRequests";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import type { UsageLimitSourceSnapshots } from "@t3tools/contracts";
import { feedbackBannerItem } from "./chat/ComposerFeedback";
import { useUsageLimitsPanel } from "./chat/useUsageLimitsPanel";
import { useWorktreeSetup } from "./chat/useWorktreeSetup";
import { useChatShortcuts } from "./chat/useChatShortcuts";
import { ChatBannerLane } from "./chat/ChatBannerLane";
import * as Schema from "effect/Schema";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  type AssistantCitation,
  type ChatFileAttachment,
  isProviderNativeSubagentThread,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type PreviewAnnotationPayload,
  ProviderInstanceId,
  type ServerProvider,
  type ScopedThreadRef,
  type ThreadId,
  type RunId,
  ProviderInteractionMode,
  resolveIdleCompaction,
  RuntimeMode,
} from "@t3tools/contracts";
import {
  deriveProviderSubagentStatus,
  deriveReportedModelSelection,
  formatModelSelectionEffort,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveLatestThreadRun,
  deriveThreadStructureRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import {
  resolveWorkflowOpening,
  workflowOpeningParentThreadId,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { threadSupportsProviderHandoff } from "@t3tools/client-runtime/state/thread-workflows";
import { resolvePendingHandoff } from "@t3tools/client-runtime/handoff";
import { HandoffRow } from "./chat/V2LifecycleRow";
import {
  codexFeedbackMessage,
  isCompleteTurnItemRow,
  shouldShowLoadEarlierControl,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";
import { projectScriptCwd, resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveThreadReferenceCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { useAtomValue } from "@effect/atom-react";
import { type SetStateAction, use, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BackgroundThreadContext } from "./chat/backgroundThread";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { assistantCitationFromLocation } from "../lib/assistantCitationNavigation";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { useShallow } from "zustand/react/shallow";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { isElectron } from "../env";
import { useDiffPanelStore } from "../diffPanelStore";
import { useActiveThreadRef } from "../hooks/useActiveThreadRef";
import { composerRequiresModifier } from "../composer-logic";
import {
  derivePhase,
  deriveActivePlanState,
  selectComposerTasksPlan,
  deriveActiveWorkStartedAt,
  deriveCanInterruptRunningThread,
  findLatestProposedPlan,
  findRevertCheckpoint,
  hasActionableProposedPlan,
  isLatestRunSettled,
} from "../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import { useWorkspaceMutationRefresh } from "../hooks/useWorkspaceMutationRefresh";
import { DEFAULT_INTERACTION_MODE, type ChatMessage } from "../types";
import { useTheme } from "../hooks/useTheme";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { subscribeSnapShotComposerFocus } from "../lib/desktopSnapShot";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { FileMetadataThreadProvider } from "../hooks/FileMetadataThreadProvider";
import {
  RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY,
  type ThreadPanelPresentation,
} from "../rightPanelLayout";
import { PopoverCreateHandle } from "./ui/popover";
import {
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadPanelOpen,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { isPreviewSupportedInRuntime, useThreadPreviewState } from "../previewStateStore";
import { previewRuntimeTabId } from "../browser/previewRuntimeTabId";
import { ThreadPreviewMiniPlayer } from "./preview/ThreadPreviewMiniPlayer";
import { usePreviewSession } from "./preview/usePreviewSession";
import { getConfiguredPreviewUrls } from "./preview/previewEmptyStateLogic";

import {
  previewMiniPlayerSourceKey,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../previewMiniPlayerStore";
import { threadPullRequestPanelTarget } from "./pullRequest/pullRequestDetail.logic";
import { LinkPullRequestDialogHost } from "./pullRequest/LinkPullRequestDialog";
import { GuestPendingMessages } from "./chat/GuestShareControls";
import { useDeviceState } from "~/state/device";
import { BranchToolbar, type BranchToolbarHandle } from "./BranchToolbar";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import { isEditableFocused } from "../lib/editableFocus";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { shortcutLabelForCommand } from "../keybindings";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { projectScriptIdFromCommand } from "~/projectScripts";
import { newMessageId } from "~/lib/utils";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  shouldShowInstanceBadge,
  sortProviderInstanceEntries,
} from "../providerInstances";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useEnvironmentSettings,
} from "../hooks/useSettings";
import { useNowMinute } from "../hooks/useNowMinute";
import { usePanelAnimationSettings, usePanelPresence } from "../panelAnimations";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useOpenPanelPullRequestUrl } from "../hooks/useOpenPanelPullRequestUrl";
import { isPreviewFocused } from "../lib/previewFocus";
import { focusTerminalOnThreadEnter, getTerminalFocusOwner } from "../lib/terminalFocus";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import {
  isSameSidebarThreadRef,
  useSidebarPendingFileDropStore,
} from "../sidebarPendingFileDropStore";
import {
  composerDraftHasUserContent,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  DraftId,
} from "../composerDraftStore";
import { type TerminalContextDraft } from "../lib/terminalContext";
import { collectInlineContextIds } from "../lib/composerContextReferences";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useKnownTerminalSessions, useThreadRunningTerminalIds } from "../state/terminalSessions";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "~/state/session";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  serverEnvironment,
} from "../state/server";
import { threadEnvironment, useThreadFamily } from "../state/threads";
import { resolveProviderSkillsForCwd } from "@t3tools/client-runtime/providerSkills";
import { vcsEnvironment } from "../state/vcs";
import {
  type EnvironmentPresentation,
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironment,
} from "../state/environments";
import {
  resolveThreadDetailRef,
  useEnvironmentSupportsServerBrowser,
  useProject,
  useQuietThreadProjection,
  useThreadUpdatedAt,
  useThreadLastVisitedAt,
  useQuietThreadVisibleTurnItems,
  useThreadStatus,
  useThreadHistory,
  useQuietThreadShell,
  useThreadCheckpointSummaries,
} from "../state/entities";
import { useEnvironmentShellHasSnapshot } from "../state/shell";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { DraftHeroHeadline } from "./chat/DraftHeroHeadline";
import { ExpandedImageDialogHost, openExpandedImagePreview } from "./chat/ExpandedImageDialog";
import {
  BranchRestoreConfirmHost,
  DeviceSetupDialogHost,
  openBranchRestoreConfirm,
  PullRequestThreadDialogHost,
  RevertConfirmHost,
} from "./chat/ChatOverlayHosts";
import type { AssistantCitationRequest } from "./chat/AssistantCitationSource";
import type { MessagesTimelineHistoryControls } from "./chat/MessagesTimeline";
import { ThreadTimeline } from "./chat/ThreadTimeline";
import { ProviderSubagentBar } from "./chat/ProviderSubagentBar";
import { getTriggerDisplayModelName } from "./chat/providerIconUtils";
import {
  overlayComposerIsResting,
  resolveComposerTimelineInset,
  resolveScrollToEndClearance,
} from "./composerFooterLayout";
import { ChatHeader } from "./chat/ChatHeader";
import { useRemoteOpenState } from "~/remoteOpen";
import { shouldShowOpenInPicker } from "./chat/OpenInPicker.logic";
import { useOpenFavoriteEditorShortcut } from "./chat/OpenInPickerShortcut";
import {
  PanelLayoutControls,
  type PanelLayoutControlsProps,
  ThreadPanelHeaderControl,
  WorkspaceTitlebarControls,
} from "./chat/PanelLayoutControls";
import type { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { ThreadDetailsPanel } from "./chat/ThreadDetailsPanel";
import { NoActiveThreadState } from "./NoActiveThreadState";
import {
  resolveEffectiveEnvMode,
  resolveLocalCheckoutBranchMismatch,
  shouldShowComposerContextStrip,
  shouldShowEnvironmentIndicator,
} from "./BranchToolbar.logic";
import {
  getProviderStatusBannerKey,
  shouldShowProviderStatusBanner,
} from "./chat/ProviderStatusBanner";
import {
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
} from "./chat/ThreadErrorBanner";
import { QueuedRunsControl, type QueuedRunsControlHandle } from "./chat/QueuedRunsControl";
import { useThreadLinkedPullRequest } from "./pullRequest/useThreadLinkedPullRequest";
import { useProactivePanels } from "../hooks/useProactivePanels";
import { useIncrementalTimelineEntries } from "../hooks/useIncrementalTimelineEntries";
import { useRightPanelSurfaceClose } from "../hooks/useRightPanelSurfaceClose";
import { useAgentOpenedPreviews } from "./preview/useAgentOpenedPreviews";
import type { ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import { ComposerSurface } from "./chat/ComposerSurface";
import { resolveThreadSyncPhase } from "../threadSync";
import {
  hasAvailableCompactionProvider,
  hasDismissedResumeCompaction,
  shouldOfferResumeCompaction,
} from "./chat/ContextWindowMeter.logic";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "../lib/contextWindow";
import {
  MOBILE_COMPOSER_VIEW_TRANSITION_NAME,
  MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
} from "./chat/draftHeroTransition";
import {
  buildLocalDraftThread,
  collectUserMessageBlobPreviewUrls,
  deriveCommittedServerUserMessageIds,
  dismissBranchMismatchForSession,
  shouldShowPlanFollowUpPrompt,
  shouldRenderPreviewMiniPlayer,
  deriveLockedProvider,
  resolveFileAttachmentUrl,
  resolveComposerInteractionMode,
  resolveComposerProviderSelection,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  revokeUserMessagePreviewUrls,
  startNewThreadForProject,
  codexArtifactTemplatePromptToAppend,
  shouldRefocusComposerOnWindowFocus,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerHandleContext } from "../composerHandleContext";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { assetEnvironment } from "../state/assets";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { observeResize } from "~/lib/observeResize";
import { ThreadVisitWatermark } from "./chat/ThreadVisitWatermark";
import { ChatTerminalDrawers } from "./chat/ChatTerminalDrawers";
import { ChatRightPanel } from "./chat/ChatRightPanel";
import { useDraftEnvironmentRouting } from "./chat/useDraftEnvironmentRouting";
import { branchMismatchBannerItem } from "./chat/ThreadActivityBanners";
import { useTimelineFollow } from "./chat/useTimelineFollow";
import {
  type EnvironmentUnavailableState,
  useSystemComposerBanners,
} from "./chat/useSystemComposerBanners";
import { useDraftHeroLayoutTransition } from "./chat/useDraftHeroLayoutTransition";
import { useLocalDispatchState } from "./chat/useLocalDispatchState";
import { draftFanoutSelectionsAtom, draftSendState } from "./chat/chatViewSend";
import {
  isCompactCommandMessage,
  type LocalThreadErrorEntry,
  makeThreadErrorSetter,
} from "./ChatView.logic";

const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_MODELS: ServerProvider["models"] = [];
const EMPTY_USAGE_LIMIT_SOURCES: UsageLimitSourceSnapshots = [];
import type { CodexArtifactTemplate } from "@t3tools/shared/codexArtifactTemplates";

const EMPTY_FEEDBACK_SUBMISSIONS: ReadonlyArray<CodexFeedbackSubmission> = [];
const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const EMPTY_AUTO_UPDATE_ENVIRONMENTS: ReadonlyArray<EnvironmentPresentation> = [];

const EMPTY_PENDING_FILE_SURFACE_IDS: ReadonlySet<string> = new Set();

type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      routeKind: "draft";
      draftId: DraftId;
    };

const EMPTY_HELD_TURN_DIFF_SUMMARIES: readonly never[] = [];
const noopHeldTurnDiff = (_turnId: RunId, _filePath?: string) => {};
const noopHeldRevert = (_targetTurnCount: number) => {};
const noopHeldAttachment = (_attachment: ChatFileAttachment) => {};

export default function ChatView(props: ChatViewProps) {
  const {
    environmentId,
    threadId,
    routeKind,
    onDiffPanelOpen,
    reserveTitleBarControlInset = true,
    forceExpandedMobileComposer = false,
  } = props;
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const draftId = routeKind === "draft" ? props.draftId : null;
  const handleNewThread = useNewThreadHandler();
  const routeThreadRef = scopeThreadRef(environmentId, threadId);
  const routeThreadKey = scopedThreadKey(routeThreadRef);
  const currentRouteThreadKeyRef = useRef<string | null>(routeThreadKey);
  useLayoutEffect(() => {
    currentRouteThreadKeyRef.current = routeThreadKey;
    return () => {
      currentRouteThreadKeyRef.current = null;
    };
  }, [routeThreadKey]);
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const setThreadRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useOrchestrationCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const interruptThreadTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const loadEarlierThreadHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const baseComposerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === "server" ? routeThreadRef : props.draftId;
  const draftThread = useComposerDraftStore((store) =>
    routeKind === "server"
      ? store.getDraftSessionByRef(routeThreadRef)
      : draftId
        ? store.getDraftSession(draftId)
        : null,
  );
  const serverThreadShell = useQuietThreadShell(routeThreadRef);
  const routeThreadDetailRef = resolveThreadDetailRef(routeThreadRef, {
    shellExists: serverThreadShell !== null,
    waitForShell: draftThread !== null,
  });
  const serverThreadProjection = useQuietThreadProjection(routeThreadDetailRef);
  const serverProjection = serverThreadProjection?.projection ?? null;
  // Subagent rows, an open child's own row and its ancestors come from the family when the shell
  // leaves idle children out. Every source agrees on the root, so the key never flips.
  useThreadFamily(
    routeKind === "server" ? environmentId : null,
    serverThreadShell?.lineage.rootThreadId ??
      serverProjection?.thread.lineage.rootThreadId ??
      null,
  );
  // Only the shell-less fallback needs these; with a shell, the shell carries them.
  const fallbackDetailRef = serverThreadShell === null ? routeThreadDetailRef : null;
  const fallbackUpdatedAt = useThreadUpdatedAt(fallbackDetailRef);
  const fallbackLastVisitedAt = useThreadLastVisitedAt(fallbackDetailRef);
  const serverThread =
    serverThreadShell !== null || serverProjection === null || fallbackUpdatedAt === null
      ? serverThreadShell
      : presentThreadShellFromProjection(environmentId, threadId, serverProjection, {
          updatedAt: fallbackUpdatedAt,
          lastVisitedAt: fallbackLastVisitedAt,
        });
  const promptRef = useRef("");
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const queuedRunEdit = useQueuedRunEdit({
    environmentId,
    routeThreadRef,
    threadDraftTarget: baseComposerDraftTarget,
    activeThreadId: serverThread !== null || draftThread !== null ? threadId : null,
    serverProjection,
    promptRef,
    composerRef,
  });
  const composerDraftTarget = queuedRunEdit.draftTarget;
  const reportedModelSelection = serverProjection
    ? deriveReportedModelSelection(serverProjection)
    : null;
  const threadStatus = useThreadStatus(routeThreadDetailRef);
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverProjection !== null,
    shellExists: serverThread !== null,
    status: threadStatus,
  });
  const threadDetailLoading = threadSyncPhase === "loading";
  const activeProviderThread = serverProjection?.providerThreads.find(
    (thread) => thread.id === serverProjection.thread.activeProviderThreadId,
  );
  const activeThreadLiveTokenUsage = latestProviderTurnTokenUsage(
    serverProjection?.providerTurns ?? [],
    serverProjection,
    activeProviderThread,
  );
  const serverVisibleTurnItems = useQuietThreadVisibleTurnItems(routeThreadDetailRef);
  const serverThreadHistory = useThreadHistory(routeThreadDetailRef);
  const threadHistoryControls = (() => {
    if (routeThreadDetailRef === null || !shouldShowLoadEarlierControl(serverThreadHistory)) {
      return undefined;
    }
    return {
      hasMoreHistory: serverThreadHistory.hasMoreHistory,
      loading: serverThreadHistory.loading,
      error: serverThreadHistory.error,
      onLoadEarlier: (throughEntryId) => {
        void loadEarlierThreadHistory({
          environmentId: routeThreadDetailRef.environmentId,
          input: {
            threadId: routeThreadDetailRef.threadId,
            ...(throughEntryId === undefined ? {} : { throughEntryId }),
          },
        });
      },
    };
  })() as MessagesTimelineHistoryControls | undefined;
  const committedServerMessageIds = deriveCommittedServerUserMessageIds(serverVisibleTurnItems);
  // Queued messages have no turn item until starting, so cancellation must retire their optimistic rows
  // separately.
  const serverAcknowledgedUserMessageIds = (() => {
    const ids = new Set(committedServerMessageIds);
    for (const message of serverProjection?.messages ?? []) {
      if (message.role === "user") ids.add(message.id);
    }
    return ids;
  })();
  const settings = useEnvironmentSettings(environmentId);
  const clientSettingsHydrated = useClientSettingsHydrated();
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  // Selects primitives: an object here is new on every router store update, which
  // re-renders ChatView on unrelated navigation state changes.
  const citationHref = useLocation({ select: (location) => location.href });
  const citationKey = useLocation({
    select: (location) => location.state.assistantCitationActivation ?? location.state.__TSR_key,
  });
  const citationLocation = { href: citationHref, key: citationKey };
  const citationRequest = (() => {
    const citation = assistantCitationFromLocation(citationLocation.href);
    return citation && citation.environmentId === environmentId && citation.threadId === threadId
      ? { citation, key: citationLocation.key ?? citationLocation.href }
      : null;
  })() as AssistantCitationRequest | null;
  const { resolvedTheme } = useTheme();
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const composerSelectedModelSelection = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return draft?.activeProvider
      ? (draft.modelSelectionByProvider[draft.activeProvider] ?? null)
      : null;
  });
  const composerHasAttachments = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return (draft?.images.length ?? 0) > 0 || (draft?.files.length ?? 0) > 0;
  });
  const referencedThreadContexts = useComposerDraftStore(
    useShallow((store) => {
      const draft = store.getComposerDraft(composerDraftTarget);
      if (!draft?.threadContexts.length) return [];
      // Linked prompts can replace text without pruning stored context records.
      const referenced = new Set(collectInlineContextIds(draft.prompt));
      return draft.threadContexts.filter((record) => referenced.has(record.contextId));
    }),
  );
  const composerHasNonPromptContent = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return draft ? composerDraftHasUserContent({ ...draft, prompt: "" }) : false;
  });
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const branchToolbarRef = useRef<BranchToolbarHandle>(null);
  const [restingComposerControlsHost, setRestingComposerControlsHost] =
    useState<HTMLDivElement | null>(null);
  const [restingComposerControlsVisible, setRestingComposerControlsVisible] = useState(false);
  const citeAssistantText = (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => {
    const inserted = composerRef.current?.citeAssistantText(citation, sourceAnchor) ?? false;
    if (!inserted) {
      toastManager.add({
        type: "warning",
        title: "The composer is not ready",
        description: "Try citing the selection after the connection or pending input is resolved.",
      });
    }
    return inserted;
  };
  const citeAssistantTextStable = useStableCallback(citeAssistantText);
  const [isWorkspaceFileDragActive, setIsWorkspaceFileDragActive] = useState(false);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  // Draft ids survive promotion and expire on navigation, keeping the pending resend scoped correctly.
  const [workLocallyResendDraftId, setWorkLocallyResendDraftId] = useState<DraftId | null>(null);
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const feedbackSubmissions =
    feedbackSubmissionsByThreadKey[routeThreadKey] ?? EMPTY_FEEDBACK_SUBMISSIONS;
  const feedbackUploading = feedbackSubmissions.some(
    (submission) => submission.status === "uploading",
  );
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [localServerErrorsByThreadKey, setLocalServerErrorsByThreadKey] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const isRevertingCheckpoint = useComposerDraftStore((store) =>
    store.rewindingThreadKeys.has(routeThreadKey),
  );

  const workspaceFileDragRouteKey = `${routeThreadKey}:${draftId ?? ""}`;
  const [workspaceFileDragRoute, setWorkspaceFileDragRoute] = useState(workspaceFileDragRouteKey);
  if (workspaceFileDragRoute !== workspaceFileDragRouteKey) {
    setWorkspaceFileDragRoute(workspaceFileDragRouteKey);
    setIsWorkspaceFileDragActive(false);
  }

  useEffect(() => {
    if (!isWorkspaceFileDragActive) return;
    const clearWorkspaceFileDrag = () => setIsWorkspaceFileDragActive(false);
    window.addEventListener("dragend", clearWorkspaceFileDrag);
    return () => window.removeEventListener("dragend", clearWorkspaceFileDrag);
  }, [isWorkspaceFileDragActive]);
  const shouldUsePlanSidebarSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const isMobileViewport = useMediaQuery("max-sm");
  const [workspaceLayoutElement, setWorkspaceLayoutElement] = useState<HTMLDivElement | null>(null);
  const threadPanelPopoverAnchorRef = useRef<HTMLElement | null>(null);
  const [terminalUiLaunchContext, setTerminalUiLaunchContext] =
    useState<TerminalLaunchContext | null>(null);
  // Overrides chosen before a server thread's first turn; they belong to that thread only.
  const [pendingServerThreadEnvModeEntry, setPendingServerThreadEnvModeEntry] = useState<{
    readonly threadId: ThreadId;
    readonly mode: DraftThreadEnvMode;
  } | null>(null);
  const [pendingServerThreadBranchEntry, setPendingServerThreadBranchEntry] = useState<{
    readonly threadId: ThreadId;
    readonly branch: string | null;
  } | null>(null);
  const [
    pendingServerThreadStartFromOriginByThreadId,
    setPendingServerThreadStartFromOriginByThreadId,
  ] = useState<Record<string, boolean>>({});
  const legendListRef = useRef<LegendListRef | null>(null);
  const getTimelineScrollableNode = () => legendListRef.current?.getScrollableNode() ?? null;
  const getTimelineScrollableNodeStable = useStableCallback(getTimelineScrollableNode);
  const [composerOverlayElement, setComposerOverlayElement] = useState<HTMLDivElement | null>(null);
  const [composerTimelineInset, setComposerTimelineInset] = useState(0);
  const composerTimelineInsetRef = useRef(0);
  const [composerReservedHeight, setComposerReservedHeight] = useState(0);
  const composerReservedHeightRef = useRef(0);
  const composerExpandedHeightRef = useRef(0);
  const composerRestingRef = useRef(false);
  const composerMountedRef = useRef(true);
  const [scrollToEndClearance, setScrollToEndClearance] = useState(0);
  const [timelineOverflows, setTimelineOverflows] = useState(false);
  const fanoutSelectionsAtom = draftFanoutSelectionsAtom(routeThreadKey);
  const { sendInFlight: sendInFlightRef } = draftSendState(routeThreadKey);
  const multipleModelSelections = useAtomValue(fanoutSelectionsAtom);
  const setMultipleModelSelections = (
    selections: SetStateAction<ReadonlyArray<ModelSelection> | null>,
  ) => {
    appAtomRegistry.update(fanoutSelectionsAtom, (current) =>
      typeof selections === "function" ? selections(current) : selections,
    );
  };
  const setMultipleModelSelectionsStable = useStableCallback(setMultipleModelSelections);
  const feedbackUploadsInFlightRef = useRef(new Set<string>());

  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef),
  );

  const fallbackDraftProjectRef = draftThread
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useProject(fallbackDraftProjectRef);
  const localDraftError = serverThread
    ? null
    : ((draftId ? localDraftErrorsByDraftId[draftId]?.message : null) ?? null);
  const localServerError = localServerErrorsByThreadKey[routeThreadKey]?.message ?? null;
  const promotedDraftError =
    serverThread && draftId ? localDraftErrorsByDraftId[draftId] : undefined;
  if (promotedDraftError !== undefined && draftId) {
    const remainingDraftErrors = { ...localDraftErrorsByDraftId };
    delete remainingDraftErrors[draftId];
    setLocalDraftErrorsByDraftId(remainingDraftErrors);
    const currentEntry = localServerErrorsByThreadKey[routeThreadKey];
    if (
      currentEntry === undefined ||
      (currentEntry.at <= promotedDraftError.at &&
        currentEntry.message !== promotedDraftError.message)
    ) {
      setLocalServerErrorsByThreadKey({
        ...localServerErrorsByThreadKey,
        [routeThreadKey]: promotedDraftError,
      });
    }
  }
  const localDraftThread = draftThread
    ? buildLocalDraftThread(
        threadId,
        draftThread,
        resolveProjectSettings(
          settings,
          fallbackDraftProject?.id ?? null,
          fallbackDraftProject ?? undefined,
        ).settings.defaultModelSelection ?? NO_PROVIDER_MODEL_SELECTION,
      )
    : undefined;
  const isServerThread = serverThread !== null;
  const activeThread = isServerThread ? serverThread : localDraftThread;
  const serverLatestRun =
    serverProjection === null ? null : deriveLatestThreadRun(serverProjection);
  const serverActivityRun =
    serverProjection === null ? null : deriveThreadActivityRun(serverProjection);
  const serverRuntime =
    serverProjection === null ? null : deriveThreadStructureRuntime(serverProjection);
  const runlessWorkStartedAt =
    serverProjection === null ? null : deriveRunlessWorkStartedAt(serverProjection);
  const providerSubagentStatus =
    serverProjection === null ? null : deriveProviderSubagentStatus(serverProjection);
  const isProviderSubagent =
    serverThread !== null && isProviderNativeSubagentThread(serverThread.source);
  const supportsProviderSwitchingViaHandoff = threadSupportsProviderHandoff(serverProjection);
  const activeLatestRun = isServerThread ? serverLatestRun : (activeThread?.latestRun ?? null);
  const activeActivityRun = isServerThread ? serverActivityRun : (activeThread?.latestRun ?? null);
  const activeRuntime = isServerThread ? serverRuntime : (activeThread?.runtime ?? null);
  const hasHeldQueuedRuns =
    isServerThread &&
    serverProjection?.runs.some((run) => run.status === "queued" && run.queueHeld === true) ===
      true;
  const resumableRunId = (() => {
    if (!isServerThread || serverProjection === null) return null;
    const run = latestExecutedRun(serverProjection.runs);
    if (run?.status === "interrupted") return run.id;
    return run?.status === "failed" &&
      serverRuntime?.lastErrorClass === "usage_limit" &&
      latestRootProviderFailure(run, serverProjection.turnItems)?.class === "usage_limit"
      ? run.id
      : null;
  })();
  const parentSubagentThreadId =
    activeThread?.lineage.relationshipToParent === "subagent"
      ? activeThread.lineage.parentThreadId
      : null;
  const parentSubagentEnvironmentId = activeThread?.environmentId ?? null;
  const parentSubagentThreadRef = (() => {
    if (parentSubagentEnvironmentId === null || parentSubagentThreadId === null) {
      return null;
    }
    return scopeThreadRef(parentSubagentEnvironmentId, parentSubagentThreadId);
  })();
  const parentSubagentThread = useQuietThreadShell(parentSubagentThreadRef);
  // Workflow threads open with a script; their replacement plan lives on the parent's coordinator row.
  const workflowOpeningParentId =
    serverProjection === null
      ? null
      : workflowOpeningParentThreadId({
          thread: serverProjection.thread,
          messages: serverProjection.messages,
        });
  const workflowOpeningParentProjection = useQuietThreadProjection(
    workflowOpeningParentId === null || parentSubagentEnvironmentId === null
      ? null
      : scopeThreadRef(parentSubagentEnvironmentId, workflowOpeningParentId),
  );
  const workflowOpening =
    serverProjection === null || workflowOpeningParentId === null
      ? null
      : resolveWorkflowOpening({
          thread: serverProjection.thread,
          messages: serverProjection.messages,
          parentSubagents: workflowOpeningParentProjection?.projection.subagents ?? null,
        });
  const parentThreadLink =
    parentSubagentThreadRef === null
      ? null
      : {
          threadId: parentSubagentThreadRef.threadId,
          title: parentSubagentThread?.title ?? "Parent thread",
        };
  const threadError = isServerThread
    ? (localServerError ?? serverRuntime?.lastError ?? null)
    : localDraftError;
  const threadErrorBannerKey = getThreadErrorBannerKey(routeThreadKey, threadError);
  const visibleThreadError = shouldShowThreadErrorBanner(
    routeThreadKey,
    threadError,
    isThreadErrorBannerDismissedForSession(threadErrorBannerKey),
  )
    ? threadError
    : null;
  const [, setThreadErrorBannerDismissTick] = useState(0);
  const threadErrorIsServerRuntimeError =
    localServerError === null && visibleThreadError === serverRuntime?.lastError;
  const defaultRuntimeMode = resolveProjectSettings(settings, activeThread?.projectId ?? null)
    .settings.defaultRuntimeMode;
  const runtimeMode =
    composerRuntimeMode ??
    (isServerThread ? activeThread?.runtimeMode : undefined) ??
    defaultRuntimeMode;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = canWriteSourceControl && isLocalDraftThread;
  const activeThreadId = activeThread?.id ?? null;
  // Turn items can lag projection hydration; keep the environment locked through that gap.
  const activeMessageCount = isServerThread
    ? Math.max(committedServerMessageIds.size, serverProjection?.messages.length ?? 0)
    : 0;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessionsRaw = useKnownTerminalSessions({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessions = (() => {
    if (activeThreadId === null || activeThreadKnownSessionsRaw === null) {
      return [];
    }
    return activeThreadKnownSessionsRaw.filter(
      (session) => session.target.threadId === activeThreadId,
    );
  })();
  const activeServerOrderedTerminalIds = activeThreadKnownSessions.map(
    (session) => session.target.terminalId,
  );
  const activeTerminalLabelsById = (() => {
    const labels = new Map<string, string>();
    for (const session of activeThreadKnownSessions) {
      labels.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    return labels;
  })();
  const activeThreadRef = useActiveThreadRef(activeThread);
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const activeEnvironmentServerBrowser = useEnvironmentSupportsServerBrowser(
    activeThreadRef?.environmentId ?? null,
  );
  const browserAvailable = isPreviewSupportedInRuntime() || activeEnvironmentServerBrowser;
  const activeThreadShell = serverThread;
  const timelineThreadError =
    serverRuntime?.status === "failed" &&
    serverRuntime.lastErrorClass === "usage_limit" &&
    activeThreadShell?.latestRun &&
    visibleThreadError === serverRuntime.lastError
      ? null
      : visibleThreadError;

  const [timelineAnchor, setTimelineAnchor] = useState<{
    readonly threadKey: string | null;
    readonly messageId: MessageId | null;
  }>({ threadKey: activeThreadKey, messageId: null });
  if (timelineAnchor.threadKey !== activeThreadKey) {
    setTimelineAnchor({ threadKey: activeThreadKey, messageId: null });
  }
  const timelineAnchorMessageId = timelineAnchor.messageId;
  // LegendList never recomputes anchored end-space geometry, leaving phantom scroll range after content fits.
  const anchorRunSettled = (() => {
    if (timelineAnchorMessageId === null) return false;
    const anchorRun = serverProjection?.runs.find(
      (run) => run.userMessageId === timelineAnchorMessageId,
    );
    if (anchorRun === undefined) return false;
    return (
      anchorRun.status !== "preparing" &&
      anchorRun.status !== "queued" &&
      anchorRun.status !== "starting" &&
      anchorRun.status !== "running" &&
      anchorRun.status !== "waiting"
    );
  })();
  if (anchorRunSettled) {
    setTimelineAnchor({ threadKey: activeThreadKey, messageId: null });
  }
  const activeRightPanelKind = useRightPanelStore((state) =>
    selectActiveRightPanel(state.byThreadKey, activeThreadRef),
  );
  const diffOpen = activeRightPanelKind === "diff";
  const explicitDiffOpenRef = useRef<ScopedThreadRef | null>(null);
  useLayoutEffect(() => {
    const explicitThreadRef = explicitDiffOpenRef.current;
    explicitDiffOpenRef.current = null;
    if (diffOpen && activeThreadRef && explicitThreadRef !== activeThreadRef) {
      useDiffPanelStore.getState().selectGitScope(activeThreadRef, "branch");
    }
  }, [activeThreadRef, diffOpen]);
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, activeThreadRef),
  );
  const activeRightPanelSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, activeThreadRef),
  );
  const activePreviewState = useThreadPreviewState(activeThreadRef);
  const activePreviewServerEpoch = activePreviewState.serverEpoch;
  const resolvePreviewRuntimeTabId = activeThreadRef
    ? (tabId: string) => previewRuntimeTabId(activeThreadRef, activePreviewServerEpoch, tabId)
    : undefined;
  const activePreviewMiniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, activeThreadRef),
  );
  const panelTerminalIds = new Set(
    rightPanelState.surfaces.flatMap((surface) =>
      surface.kind === "terminal" ? surface.terminalIds : [],
    ),
  );
  const canReuseTerminal = activeThreadKnownSessionsRaw !== null;
  const previewPanelOpen = activeRightPanelKind === "preview" && browserAvailable;
  const rightPanelOpen = rightPanelState.isOpen;
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const rightPanelPresenceValue = {
    activeSurface: activeRightPanelSurface,
    surfaces: rightPanelState.surfaces,
  };
  const rightPanelPresence = usePanelPresence(
    rightPanelOpen && activeThreadRef !== null,
    rightPanelPresenceValue,
    panelAnimationsActive,
    activeThreadKey,
    panelAnimationDurationMs,
  );
  const rightPanelPresent = rightPanelPresence.present;
  const rightPanelControlsInPanel =
    shouldUsePlanSidebarSheet && rightPanelPresent && rightPanelOpen;
  const rightPanelControlsAtRoot = rightPanelPresent && !shouldUsePlanSidebarSheet;
  const renderedRightPanelSurface = rightPanelPresence.value?.activeSurface ?? null;
  const renderedRightPanelSurfaces = rightPanelPresence.value?.surfaces ?? [];
  const previewMiniPlayerVisible = shouldRenderPreviewMiniPlayer(
    activePreviewMiniPlayer?.source ?? null,
    renderedRightPanelSurface,
  );
  const canMaximizeRightPanel = rightPanelOpen && !shouldUsePlanSidebarSheet;
  const rightPanelMaximized = canMaximizeRightPanel && rightPanelState.maximized === true;
  const inlineRightPanelOwnsTitleBar = rightPanelOpen && !shouldUsePlanSidebarSheet;
  const [threadPanelPresentation, setThreadPanelPresentation] =
    useState<ThreadPanelPresentation>("inline");
  const [threadPanelPopoverHandle] = useState(PopoverCreateHandle);
  const threadPanelOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(
      state.threadPanelVisibilityByThreadKey,
      activeThreadRef,
      threadPanelPresentation,
    ),
  );

  const latestRunSettled = isLatestRunSettled(activeLatestRun, activeRuntime);
  const activePlan = deriveActivePlanState(serverProjection, activeActivityRun?.runId);
  const activeActivityRunSettled = isLatestRunSettled(activeActivityRun, activeRuntime);
  const composerTasksPlan = selectComposerTasksPlan(
    serverProjection,
    activePlan,
    activeActivityRun?.runId ?? null,
    activeActivityRunSettled,
  );
  const activeComposerTasksProgress = (() => {
    if (!composerTasksPlan) return null;
    const live = !activeActivityRunSettled && composerTasksPlan.runId === activeActivityRun?.runId;
    const totalSteps = composerTasksPlan.steps.length;
    if (totalSteps === 0) return null;
    const completedSteps = composerTasksPlan.steps.filter(
      (step) => step.status === "completed",
    ).length;
    const step =
      composerTasksPlan.steps.find((candidate) => candidate.status === "inProgress")?.step ??
      composerTasksPlan.steps.find((candidate) => candidate.status === "pending")?.step ??
      composerTasksPlan.steps.at(-1)!.step;
    return { step, completedSteps, totalSteps, live };
  })();
  const activeComposerTaskSteps =
    activeComposerTasksProgress && composerTasksPlan ? composerTasksPlan.steps : null;
  const activeThreadEnvironmentId = activeThread?.environmentId;
  const activeThreadProjectId = activeThread?.projectId;
  const activeProjectRef =
    activeThreadEnvironmentId !== undefined && activeThreadProjectId !== undefined
      ? scopeProjectRef(activeThreadEnvironmentId, activeThreadProjectId)
      : null;
  const activeProject = useProject(activeProjectRef);
  const activeProjectSettings = resolveProjectSettings(
    settings,
    activeProject?.id ?? null,
    activeProject ?? undefined,
  );
  const activeProjectScripts = activeProject ? resolveProjectScripts(settings, activeProject) : [];
  const { projectCloneBannerItem, projectCloneSendBlockReason } =
    useProjectCloneBanner(activeProjectRef);
  const activeProjectDefaultModelSelection = activeProjectSettings.settings.defaultModelSelection;
  const handleNewThreadInActiveProject = () => {
    startNewThreadForProject(activeProjectRef, handleNewThread);
  };
  const handleNewThreadInActiveProjectStable = useStableCallback(handleNewThreadInActiveProject);
  const projectGroupingSettings = selectProjectGroupingSettings(settings);
  const activeDraftLogicalProjectKey =
    !isServerThread && activeProject
      ? deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings)
      : undefined;
  const handleOpenDraftProjectSettings = () => {
    if (!activeDraftLogicalProjectKey) return;
    void navigate({
      to: "/projects/$projectKey",
      params: { projectKey: activeDraftLogicalProjectKey },
    });
  };
  const handleOpenDraftProjectSettingsStable = useStableCallback(handleOpenDraftProjectSettings);
  const activeEnvironmentBootstrapComplete = useEnvironmentShellHasSnapshot(
    activeThread?.environmentId ?? null,
  );
  const activeProjectKey = activeProject
    ? `${activeProject.environmentId}:${activeProject.workspaceRoot}`
    : null;
  const [pendingFileSurfaceIdsByProject, setPendingFileSurfaceIdsByProject] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const pendingFileSurfaceIds = activeProjectKey
    ? (pendingFileSurfaceIdsByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS)
    : EMPTY_PENDING_FILE_SURFACE_IDS;
  const handleFilePendingChange = (relativePath: string, pending: boolean) => {
    if (!activeProjectKey) return;
    setPendingFileSurfaceIdsByProject((currentByProject) => {
      const current = currentByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS;
      const surfaceId = `file:${relativePath}`;
      if (current.has(surfaceId) === pending) return currentByProject;
      const next = new Set(current);
      if (pending) next.add(surfaceId);
      else next.delete(surfaceId);
      const nextByProject = new Map(currentByProject);
      if (next.size === 0) nextByProject.delete(activeProjectKey);
      else nextByProject.set(activeProjectKey, next);
      return nextByProject;
    });
  };
  const handleFilePendingChangeStable = useStableCallback(handleFilePendingChange);
  const configuredPreviewUrls = getConfiguredPreviewUrls(activeProjectScripts);

  useEffect(() => {
    if (!activeThreadRef || !activeEnvironmentBootstrapComplete) return;
    useRightPanelStore.getState().reconcileFileSurfaces(activeThreadRef, activeProject !== null);
  }, [activeEnvironmentBootstrapComplete, activeProject, activeThreadRef]);

  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const activeEnvironment =
    activeThread == null ? null : (environmentById.get(activeThread.environmentId) ?? null);
  const activeEnvironmentUnavailable =
    activeEnvironment !== null && activeEnvironment.connection.phase !== "connected";
  const activeEnvironmentUnavailableLabel = activeEnvironment?.label ?? null;
  const activeEnvironmentUnavailableState = (() => {
    if (!activeEnvironmentUnavailable || !activeEnvironmentUnavailableLabel || !activeEnvironment) {
      return null;
    }

    return {
      environmentId: activeEnvironment.environmentId,
      label: activeEnvironmentUnavailableLabel,
      connection: activeEnvironment.connection,
    };
  })() as EnvironmentUnavailableState | null;
  const activeProjectIsScratch =
    activeProject !== null &&
    isScratchProject(
      activeProject,
      environmentById.get(activeProject.environmentId)?.serverConfig?.scratchWorkspaceRoot ?? null,
    );
  const logicalProjectEnvironments = useLogicalProjectEnvironments(
    activeProject,
    activeProjectIsScratch && draftId !== null,
  );
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1;
  const canAutoBalanceEnvironments = hasMultipleEnvironments && !activeProjectIsScratch;
  const activeEnvironmentOption =
    logicalProjectEnvironments.find(
      (environment) => environment.environmentId === activeThread?.environmentId,
    ) ?? null;
  const showComposerEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: hasMultipleEnvironments,
  });

  const { handlePreparedPullRequestThreadStable, openPullRequestDialogStable } =
    usePullRequestDraftThread({
      routeKind,
      draftId,
      settings,
      projectGroupingSettings,
      activeProject,
      activeThreadKey,
      isServerThread,
      canCheckoutPullRequestIntoThread,
    });
  const serverConfig = activeThread
    ? (activeEnvironment?.serverConfig ?? null)
    : (primaryEnvironment?.serverConfig ?? null);
  const providerEnvironmentId = (activeThread ? activeEnvironment : primaryEnvironment)
    ?.environmentId;
  const providerStatuses =
    (providerEnvironmentId === undefined
      ? undefined
      : providersByEnvironment.get(providerEnvironmentId)) ?? EMPTY_PROVIDERS;
  const selectedProviderByThreadId = composerActiveProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProjectDefaultModelSelection?.instanceId ??
    null;
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: selectedProviderByThreadId,
    threadProvider,
    providers: providerStatuses,
  });
  const modelPickerLockedProvider = supportsProviderSwitchingViaHandoff ? null : lockedProvider;
  const pullRequestsCapabilityKnown = serverConfig !== null;
  const supportsPullRequests = serverConfig?.environment.capabilities.pullRequests === true;
  const attachmentEnvironmentConfig = environmentById.get(environmentId)?.serverConfig ?? null;
  const attachmentUploadsCapabilityKnown = attachmentEnvironmentConfig !== null;
  const supportsQuestionAttachments =
    attachmentEnvironmentConfig?.environment.capabilities.questionAttachments === true;
  const supportsAttachmentUploads =
    attachmentEnvironmentConfig?.environment.capabilities.attachmentUploads === true;
  const advertisedFileAttachmentBytes =
    attachmentEnvironmentConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null;
  const maxFileAttachmentBytes =
    advertisedFileAttachmentBytes === null
      ? null
      : clampFileAttachmentUploadBytes(advertisedFileAttachmentBytes);
  const envLocked = Boolean(activeThread && (activeMessageCount > 0 || activeRuntime !== null));
  // onEnvironmentChange only retargets an unsent draft. envLocked alone does not
  // rule out a started thread: one whose machine is offline never loads its
  // messages, so it would otherwise be offered a machine picker that does nothing.
  const canChangeEnvironment =
    hasMultipleEnvironments && !envLocked && draftId !== null && !draftThread?.promotedTo;

  const loadBalancingSettings = useClientSettings((settings) => ({
    loadBalancingEnabled: settings.loadBalancingEnabled,
    loadBalancingWeights: settings.loadBalancingWeights,
  }));
  const automaticEnvironment = Boolean(
    clientSettingsHydrated &&
    draftId &&
    !envLocked &&
    canAutoBalanceEnvironments &&
    loadBalancingSettings.loadBalancingEnabled &&
    draftThread?.environmentSelection !== "manual" &&
    (!composerHasAttachments || Boolean(draftThread?.loadBalancedEnvironmentId)) &&
    (!draftThread?.branch || draftThread.environmentSelection === "auto") &&
    !draftThread?.worktreePath,
  );
  const autoUpdateEnvironments = automaticEnvironment
    ? logicalProjectEnvironments.flatMap(({ environmentId }) => {
        const environment = environmentById.get(environmentId);
        return environment ? [environment] : [];
      })
    : EMPTY_AUTO_UPDATE_ENVIRONMENTS;
  const systemComposerBannerItems = useSystemComposerBanners({
    activeEnvironment,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableState,
    activeThreadEnvironmentId: activeThread?.environmentId ?? null,
    serverConfig,
    hasMultipleRegisteredEnvironments: environments.length > 1,
    automaticEnvironment,
    autoUpdateEnvironments,
  });
  const providerInstanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providerStatuses),
      settings,
      activeProject?.id ?? null,
    ),
  );
  const activeThreadModelInstanceId = activeThread?.modelSelection.instanceId;
  const { selectedProviderEntry, requestedDriverKind } = resolveComposerProviderSelection({
    entries: providerInstanceEntries,
    candidateInstanceIds: [
      selectedProviderByThreadId,
      activeRuntime?.providerInstanceId,
      activeThreadModelInstanceId,
      activeProjectDefaultModelSelection?.instanceId,
    ],
    lockedProvider,
    lockedInstanceId: activeRuntime?.providerInstanceId ?? activeThreadModelInstanceId,
  });
  const selectedProvider = selectedProviderEntry?.driverKind ?? requestedDriverKind;
  const activeProviderInstanceId = selectedProviderEntry?.instanceId ?? null;
  const activeProviderStatus = selectedProviderEntry?.snapshot ?? null;
  const { enabled: interactionModeEnabled, interactionMode } = resolveComposerInteractionMode({
    planModeEnabled: settings.planModeEnabled,
    provider: activeProviderStatus,
    interactionMode:
      composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
  });
  const conversationProviderStatus =
    providerStatuses.find((status) => status.instanceId === activeRuntime?.providerInstanceId) ??
    activeProviderStatus;
  const supportsConversationRollback =
    canOperateThread &&
    conversationProviderStatus !== null &&
    conversationProviderStatus.supportsConversationRollback !== false;
  const phase = derivePhase(activeRuntime);
  const serverThreadId = serverThread?.id;
  const serverThreadEnvironmentId = serverThread?.environmentId;
  const setThreadError = makeThreadErrorSetter({
    routeThreadRef,
    routeThreadKey,
    draftId,
    serverThreadRef:
      serverThreadId !== undefined && serverThreadEnvironmentId !== undefined
        ? { threadId: serverThreadId, environmentId: serverThreadEnvironmentId }
        : null,
    setLocalServerErrorsByThreadKey,
    setLocalDraftErrorsByDraftId,
  });
  const {
    pendingApprovals,
    pendingUserInputs,
    activePendingApproval,
    activePendingUserInput,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    respondingRequestIds,
    onRespondToApproval: onRespondToApprovalStable,
    onDismissUserInput: onDismissUserInputStable,
    onSelectActivePendingUserInputOption: onSelectActivePendingUserInputOptionStable,
    onChangeActivePendingUserInputCustomAnswer,
    onAdvanceActivePendingUserInput,
    onAdvanceActivePendingUserInputStable,
    onPreviousActivePendingUserInputQuestion: onPreviousActivePendingUserInputQuestionStable,
  } = usePendingThreadRequests({
    environmentId,
    activeThreadId,
    activeThread,
    serverProjection,
    supportsQuestionAttachments,
    composerDraftTarget,
    setComposerDraftPrompt,
    promptRef,
    composerRef,
    setThreadError,
  });
  const activeProposedPlan = (() => {
    if (!latestRunSettled) {
      return null;
    }
    return findLatestProposedPlan(serverProjection, activeLatestRun?.runId ?? null);
  })();
  const showPlanFollowUpPrompt = shouldShowPlanFollowUpPrompt({
    pendingUserInputCount: pendingUserInputs.length,
    interactionMode,
    latestTurnSettled: latestRunSettled,
    hasActionableProposedPlan: hasActionableProposedPlan(activeProposedPlan),
    hasComposerAttachments: composerHasAttachments,
  });
  // Answering an approval or question on any client resumes quota spending, so include it in the key.
  const usageLimitsKey =
    activeProviderInstanceId === null || (isServerThread && activeThread === undefined)
      ? null
      : [
          routeThreadKey,
          activeProviderInstanceId,
          activeThread?.latestRun?.runId ?? "",
          activePendingApproval?.requestId ?? activePendingUserInput?.requestId ?? "",
        ].join(":");
  const {
    banner: usageLimitsBanner,
    offered: usageLimitsOffered,
    open: openUsageLimits,
    clearFor: clearUsageLimitsFor,
  } = useUsageLimitsPanel({
    environmentId,
    threadKey: routeThreadKey,
    panelKey: usageLimitsKey,
    providerInstanceId: activeProviderInstanceId,
    providerDriver: activeProviderStatus?.driver ?? null,
    providers: providerStatuses,
    sources: serverConfig?.usageLimitSources ?? EMPTY_USAGE_LIMIT_SOURCES,
  });
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree: isLocallyPreparingWorktree,
    isSendBusy,
    backgroundSubmissionPending,
  } = useLocalDispatchState({
    activeThread,
    activeLatestRun,
    latestUserMessageId:
      serverProjection?.messages.findLast((message) => message.role === "user")?.id ?? null,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError,
  });
  const optimisticCompactionMessage = optimisticUserMessages.at(-1);
  const latestServerUserItem = serverVisibleTurnItems.findLast(
    (row) => row.item.type === "user_message",
  )?.item;
  const compactRequestIsActive =
    (isSendBusy &&
      optimisticCompactionMessage !== undefined &&
      isCompactCommandMessage(optimisticCompactionMessage)) ||
    (latestServerUserItem?.type === "user_message" &&
      latestServerUserItem.text.trim().toLowerCase() === "/compact" &&
      latestServerUserItem.attachments.length === 0 &&
      latestServerUserItem.runId === activeActivityRun?.runId &&
      !isLatestRunSettled(activeActivityRun, activeRuntime));
  const compactionSettled = serverVisibleTurnItems.some(
    ({ item }) =>
      item.type === "compaction" &&
      item.runId === activeActivityRun?.runId &&
      (item.status === "completed" ||
        item.status === "failed" ||
        item.status === "interrupted" ||
        item.status === "cancelled"),
  );
  const compactionRunning = serverVisibleTurnItems.some(
    ({ item }) =>
      item.type === "compaction" &&
      item.runId !== null &&
      item.runId === activeRuntime?.activeRunId &&
      item.status === "running",
  );
  const isCompacting =
    (isSendBusy || phase === "connecting" || phase === "running") &&
    (compactionRunning || (compactRequestIsActive && !compactionSettled));
  const isWorking =
    phase === "running" ||
    isSendBusy ||
    isConnecting ||
    isCompacting ||
    runlessWorkStartedAt !== null;
  const activeContextWindow = deriveLatestContextWindowSnapshot(
    serverVisibleTurnItems ?? [],
    activeThreadLiveTokenUsage,
    activeProviderThread,
  );
  const pendingBackgroundTasks = deriveThreadPendingBackgroundTasks(serverProjection);
  const activeWorkStartedAt =
    deriveActiveWorkStartedAt(activeActivityRun, activeRuntime, localDispatchStartedAt) ??
    runlessWorkStartedAt;
  const activeRunPreparing = activeActivityRun?.status === "preparing";
  const sendQueuesBehindSetup =
    isServerThread && (activeRunPreparing || activeActivityRun?.status === "starting");
  const [setupQueueSendThreadKey, setSetupQueueSendThreadKey] = useState<string | null>(null);
  const downloadFileAttachment = async (attachment: ChatFileAttachment) => {
    const connection = readPreparedConnection(environmentId);
    if (!connection) {
      toastManager.add({ type: "error", title: "The environment is not connected." });
      return;
    }

    try {
      const url = await resolveFileAttachmentUrl({
        attachment,
        environmentId,
        httpBaseUrl: connection.httpBaseUrl,
        createAssetUrl: createAttachmentAssetUrl,
      });
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.name;
      anchor.click();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not download " + attachment.name,
        description: error instanceof Error ? error.message : "The attachment is unavailable.",
      });
    }
  };
  const downloadFileAttachmentStable = useStableCallback(downloadFileAttachment);
  const openFileAttachment = (attachment: ChatFileAttachment) => {
    if (activeThreadRef) {
      useRightPanelStore.getState().openAttachment(activeThreadRef, attachment);
      return;
    }
  };
  const openFileAttachmentStable = useStableCallback(openFileAttachment);
  const { handoffAttachmentPreviewsStable, timelineAttachmentUrlById } =
    useAttachmentPreviewHandoff({
      environmentId,
      serverVisibleTurnItems,
      optimisticUserMessages,
    });
  const anchoredTimelineMessages = feedbackSubmissions.flatMap((submission) =>
    submission.status === "interrupted"
      ? []
      : [
          { ...codexFeedbackMessage(submission), runId: null },
          { ...codexFeedbackMessage(submission, "assistant"), runId: null },
        ],
  );
  const timelineEntriesInput = {
    optimisticMessages: optimisticUserMessages,
    anchoredMessages: anchoredTimelineMessages,
    attachmentUrlById: timelineAttachmentUrlById,
    ...(serverProjection === null
      ? {}
      : {
          attempts: serverProjection.attempts,
          nodes: serverProjection.nodes,
          plans: serverProjection.plans,
        }),
  };
  // The structure has no assistant or reasoning text, so those rows stay out of
  // ChatView's own entries (anchoring, rewind, prompt history); ThreadTimeline
  // renders every row from the live turn items.
  const serverTimelineRows = serverVisibleTurnItems.filter(isCompleteTurnItemRow);
  const hasStreamedTimelineRows =
    isServerThread && serverTimelineRows.length !== serverVisibleTurnItems.length;
  const serverTimelineEntries = useIncrementalTimelineEntries(activeThreadKey, {
    ...timelineEntriesInput,
    visibleTurnItems: serverTimelineRows,
  });
  const draftTimelineEntries = optimisticUserMessages.map(
    (message) =>
      ({
        id: message.id,
        kind: "message",
        createdAt: message.createdAt,
        message,
      }) as const,
  );
  const timelineEntries = isServerThread ? serverTimelineEntries : draftTimelineEntries;
  const timelineMessages = timelineEntries.flatMap((entry) =>
    entry.kind === "message" ? [entry.message] : [],
  );
  const timelineEmpty = timelineEntries.length === 0 && !hasStreamedTimelineRows;
  const displayedTimeline = resolveThreadSwitchTimeline({
    loading: timelineEmpty && threadSyncPhase !== null,
    activeThreadKey,
    nextEntries: timelineEntries,
    rememberedForActive: peekRememberedThreadTimeline<typeof timelineEntries>(activeThreadKey),
  });
  const displayedTimelineKey = displayedTimeline.displayThreadKey ?? routeThreadKey;
  const paintOnlyDisplayedTimeline = isPaintOnlyThreadTimeline(
    displayedTimeline.displayThreadKey,
    activeThreadKey,
  );
  const displayedThreadRef = parseScopedThreadKey(displayedTimelineKey);
  const {
    worktreeSetup,
    isPreparingWorktree,
    blocksSend: worktreeSetupBlocksSend,
    retryableRunIds: retryableWorkspacePreparationRunIds,
    begin: beginWorktreeSetup,
    cancel: cancelWorktreeSetup,
    retryPreparation: onRetryWorkspacePreparationStable,
    openSetupTerminal: onOpenWorktreeSetupTerminal,
  } = useWorktreeSetup({
    routeThreadRef,
    ownerKey: draftId ?? routeThreadKey,
    activeThread,
    threadRef: activeThreadRef,
    serverProjection,
    activityRun: activeActivityRun,
    localPreparing: isLocallyPreparingWorktree,
    sendQueuesBehindSetup,
    // Include optimistic sends to retire the row before the server echo.
    followUpSent: timelineMessages.filter((message) => message.role === "user").length > 1,
  });
  const onCancelWorktreeSetupStable = useStableCallback(() => void cancelWorktreeSetup());
  const [dockedDraftHeroThreadKey, setDockedDraftHeroThreadKey] = useState<string | null>(null);
  const draftHeroDockRequested =
    activeThreadKey !== null && dockedDraftHeroThreadKey === activeThreadKey;
  const isDraftHeroState = resolveDraftHeroState({
    isLocalDraftThread,
    hasTimelineEntries: !timelineEmpty,
    isWorking,
    draftHeroDockRequested,
    backgroundSubmissionPending,
    hasWorktreeSetupCard: worktreeSetup !== null,
  });
  const {
    transitionGroupRef: draftHeroTransitionGroupRef,
    composerAnchorRef: draftHeroComposerAnchorRef,
    captureComposerRect: captureDraftHeroComposerRect,
  } = useDraftHeroLayoutTransition(
    isDraftHeroState,
    panelAnimationsActive,
    panelAnimationDurationMs,
  );
  const turnDiffSummaries = useThreadCheckpointSummaries(routeThreadDetailRef);
  const availableRevertTurnCounts = deriveAvailableRevertTurnCounts(serverProjection);
  // A paged history window cannot identify the first loaded run as the thread start.
  const threadStartCheckpointReady =
    !serverThreadHistory.hasMoreHistory &&
    findRevertCheckpoint(serverProjection?.checkpoints ?? [], 0) !== undefined;

  const workspaceMutationId = deriveWorkspaceMutationId(
    serverVisibleTurnItems,
    turnDiffSummaries.at(-1)?.completedAt ?? null,
  );

  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.workspaceRoot },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const gitStatusCwd = activeThread?.worktreePath ?? gitCwd;
  const gitStatusQuery = useEnvironmentQuery(
    gitStatusCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: gitStatusCwd },
        }),
  );
  useWorkspaceMutationRefresh({
    enabled: gitStatusCwd !== null,
    mutationId: workspaceMutationId,
    refresh: gitStatusQuery.refresh,
    resourceKey: `git-status:${activeThreadKey ?? ""}:${gitStatusCwd ?? ""}`,
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const backgroundThread = use(BackgroundThreadContext);
  const scriptKeybindings =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.keybindings ??
    DEFAULT_RESOLVED_KEYBINDINGS;
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const remoteOpenState = useRemoteOpenState(activeThread?.environmentId ?? environmentId);
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName: activeProject?.title,
    activeThreadEnvironmentId: activeThread?.environmentId ?? environmentId,
    primaryEnvironmentId,
    remoteOpenMode: remoteOpenState.mode,
  });
  useOpenFavoriteEditorShortcut({
    enabled: showOpenInPicker && !backgroundThread,
    environmentId: activeThread?.environmentId ?? environmentId,
    keybindings,
    availableEditors,
    openInCwd: gitCwd,
  });
  const manualCompactionProviderAvailable = hasAvailableCompactionProvider({
    providers: providerInstanceEntries,
    driverKind: selectedProvider,
    instanceId: activeProviderInstanceId,
    lockedInstanceId: lockedProvider
      ? (activeRuntime?.providerInstanceId ?? activeThread?.modelSelection.instanceId ?? null)
      : null,
  });
  const [resumeCompactionPermanentlyDismissed, setResumeCompactionPermanentlyDismissed] =
    useLocalStorage(
      `t3code:resume-compaction-dismissed:${environmentId}:${activeProviderInstanceId ?? "claudeAgent"}`,
      false,
      Schema.Boolean,
    );
  const nativeResumeCompactionDismissed = hasDismissedResumeCompaction(
    (serverProjection?.runtimeRequests ?? [])
      .filter((request) => request.kind === "user_input" && request.status === "resolved")
      .map((request) => ({
        kind: "user-input.resolved",
        payload: { answers: request.answers },
      })),
  );
  useEffect(() => {
    if (nativeResumeCompactionDismissed && !resumeCompactionPermanentlyDismissed) {
      setResumeCompactionPermanentlyDismissed(true);
    }
  }, [
    nativeResumeCompactionDismissed,
    resumeCompactionPermanentlyDismissed,
    setResumeCompactionPermanentlyDismissed,
  ]);
  const providerStatusBannerKey = getProviderStatusBannerKey(activeProviderStatus);
  const [dismissedProviderStatusBannerKey, setDismissedProviderStatusBannerKey] = useState<
    string | null
  >(null);
  if (providerStatusBannerKey === null && dismissedProviderStatusBannerKey !== null) {
    setDismissedProviderStatusBannerKey(null);
  }
  const visibleProviderStatus = shouldShowProviderStatusBanner(
    activeProviderStatus,
    dismissedProviderStatusBannerKey,
  )
    ? activeProviderStatus
    : null;
  const hasTimelineTopBanner = Boolean(timelineThreadError) || visibleProviderStatus !== null;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
  const heldPaintContext = paintOnlyDisplayedTimeline
    ? peekHeldThreadTimeline<typeof timelineEntries>()
    : null;
  const activeTerminalLaunchContext =
    terminalUiLaunchContext?.threadId === activeThreadId ? terminalUiLaunchContext : null;
  const liveIsGitRepo = gitStatusQuery.data?.isRepo;
  useEffect(() => {
    if (gitStatusCwd !== null && liveIsGitRepo !== undefined) {
      rememberCheckoutIsRepo(environmentId, gitStatusCwd, liveIsGitRepo);
    }
  }, [environmentId, gitStatusCwd, liveIsGitRepo]);
  const isGitRepo = liveIsGitRepo ?? recallCheckoutIsRepo(environmentId, gitStatusCwd) ?? true;
  // Provider-native subagents cannot take messages; approvals and questions go to the top-level parent.
  const showProviderSubagentBar = isProviderSubagent;
  const composerMounted = !showProviderSubagentBar;
  const providerSubagentModels = selectedProviderEntry?.models ?? EMPTY_PROVIDER_MODELS;
  // Providers can report dated model ids or aliases.
  const providerSubagentModelSlug = selectedProviderEntry
    ? resolveSelectableModel(
        selectedProviderEntry.driverKind,
        activeThread?.modelSelection.model,
        providerSubagentModels,
      )
    : null;
  const providerSubagentCatalogModel = providerSubagentModels.find(
    (model) => model.slug === providerSubagentModelSlug,
  );
  const providerSubagentModelLabel = providerSubagentCatalogModel
    ? getTriggerDisplayModelName(providerSubagentCatalogModel)
    : formatModelSlugName(activeThread?.modelSelection.model ?? "");
  const providerSubagentEffortLabel =
    activeThread === undefined
      ? null
      : formatModelSelectionEffort(
          activeThread.modelSelection,
          providerSubagentModels,
          reportedModelSelection,
        );
  const mountComposerContextStrip = shouldShowComposerContextStrip({
    isDraftHeroState,
    persistInActiveThreads: settings.persistComposerContextStrip,
    hasActiveProject: activeProject !== null && !showProviderSubagentBar,
    isGitRepo,
    showEnvironmentIndicator: showComposerEnvironmentIndicator,
    hostsRestingComposerControls: routeKind === "server",
  });
  const showComposerContextStrip = shouldShowComposerContextStrip({
    isDraftHeroState,
    persistInActiveThreads: settings.persistComposerContextStrip,
    hasActiveProject: activeProject !== null && !showProviderSubagentBar,
    isGitRepo,
    showEnvironmentIndicator: showComposerEnvironmentIndicator,
    hostsRestingComposerControls: routeKind === "server" && restingComposerControlsVisible,
  });
  const mountComposerModelStrip =
    routeKind === "server" && !mountComposerContextStrip && !showProviderSubagentBar;
  const showComposerModelStrip = mountComposerModelStrip && restingComposerControlsVisible;
  const terminalShortcutLabelOptions = {
    context: {
      terminalFocus: true,
      terminalOpen: Boolean(terminalUiState.terminalOpen),
    },
  };
  const splitTerminalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.split",
    terminalShortcutLabelOptions,
  );
  const splitTerminalVerticalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.splitVertical",
    terminalShortcutLabelOptions,
  );
  const newTerminalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.new",
    terminalShortcutLabelOptions,
  );
  const closeTerminalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.close",
    terminalShortcutLabelOptions,
  );

  const {
    needsLoadBalancing,
    loadBalancing,
    onAutoEnvironmentStable,
    autoEnvironmentLabel,
    isEnvironmentChanging,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
  } = useDraftEnvironmentRouting({
    draftId,
    draftThread,
    envLocked,
    automaticEnvironment,
    logicalProjectEnvironments,
    environmentById,
    providersByEnvironment,
    loadBalancingSettings,
    referencedThreadContexts,
    activeProviderInstanceId,
    selectedProvider,
    composerHasAttachments,
    activeProjectKey,
    activeProjectIsScratch,
    projectGroupingSettings,
    sendInFlightRef,
  });

  const focusComposer = () => {
    composerRef.current?.focusAtEnd();
  };
  const focusComposerStable = useStableCallback(focusComposer);
  const canInterruptRunningThread =
    canOperateThread && deriveCanInterruptRunningThread(activeThread !== undefined, activeRuntime);
  const onInterrupt = async () => {
    if (
      !activeThread ||
      !readEnvironmentScope(activeThread.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const result = await interruptThreadTurn({
      environmentId,
      input: { threadId: activeThread.id },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to interrupt the current turn.",
      );
    }
  };
  const onInterruptStable = useStableCallback(onInterrupt);
  useEffect(() => subscribeSnapShotComposerFocus(focusComposerStable), [focusComposerStable]);
  const scheduleComposerFocus = () => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  };
  const scheduleComposerFocusStable = useStableCallback(scheduleComposerFocus);
  const insertArtifactTemplate = (template: CodexArtifactTemplate) => {
    const composer = composerRef.current;
    if (!composer) return;

    const currentDraft = composer.getSendContext().prompt;
    const prompt = codexArtifactTemplatePromptToAppend(currentDraft, template);
    if (prompt !== null && !composer.insertTextAtEnd(prompt, { ensureLeadingBoundary: true })) {
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "The composer is busy; try again once it is ready.",
      });
      return;
    }
    scheduleComposerFocus();
  };
  const insertArtifactTemplateStable = useStableCallback(insertArtifactTemplate);
  const sendAppMessage = async (text: string) => {
    if (!isServerThread || activeThreadId === null) {
      throw new Error("Messages from apps need a started thread.");
    }
    const result = await startThreadTurn({
      environmentId,
      input: {
        threadId: activeThreadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        runtimeMode,
        interactionMode,
        dispatchMode: "queue",
      },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      throw error instanceof Error ? error : new Error("Could not send the app's message.");
    }
  };
  const sendAppMessageStable = useStableCallback(sendAppMessage);
  const queuedRunsControlRef = useRef<QueuedRunsControlHandle>(null);

  const {
    activatePanelTerminalStable,
    addTerminalContextToDraftStable,
    addTerminalSurfaceStable,
    closePanelTerminalStable,
    lastInvokedScriptByProjectId,
    runProjectScriptStable,
    runShellCommandStable,
    splitPanelTerminalStable,
    splitPanelTerminalVerticalStable,
    toggleTerminalVisibilityStable,
    shortcuts: terminalShortcuts,
  } = useChatTerminalActions({
    environmentId,
    composerRef,
    terminalUiState,
    activeThread,
    activeThreadId,
    activeThreadRef,
    activeProject,
    activeRightPanelSurface,
    runningTerminalIds,
    activeServerOrderedTerminalIds,
    activeTerminalLabelsById,
    panelTerminalIds,
    canReuseTerminal,
    gitCwd,
    setTerminalUiLaunchContext,
    setThreadError,
  });
  const {
    saveProjectScript: saveProjectScriptStable,
    updateProjectScript: updateProjectScriptStable,
    deleteProjectScript: deleteProjectScriptStable,
  } = useProjectScriptEditing({
    environmentId,
    project: activeProject,
    scripts: activeProjectScripts,
    settings,
  });
  const canOperatePreview = useEnvironmentScope(
    activeThreadRef?.environmentId ?? null,
    AuthPreviewOperateScope,
  );
  const supportsThreadPullRequests =
    serverConfig?.environment.capabilities.threadPullRequests === true;
  const visiblePullRequests = visibleThreadPullRequests(
    (activeThreadShell ?? activeThread)?.pullRequests ?? [],
  );
  const visiblePullRequestCount = visiblePullRequests.length;
  const pullRequestsSurfaceAvailable =
    isServerThread && supportsThreadPullRequests && visiblePullRequestCount > 0;
  const { state: deviceState, loaded: deviceStateLoaded } = useDeviceState(
    activeThreadRef?.environmentId ?? null,
  );
  useAgentOpenedPreviews({
    threadRef: activeThreadRef,
    deviceState,
    deviceStateLoaded,
    miniPlayerSource: activePreviewMiniPlayer?.source ?? null,
    sheetLayout: shouldUsePlanSidebarSheet,
  });
  // The thread's own change request, placed against the project it belongs to. Without a
  // project there is nothing to resolve it against, so the caller falls back to the browser.
  const activeProjectRepository = sourceControlClients.repositorySelector(
    activeProject?.repositoryIdentity,
  );
  const {
    linked: linkedThreadPullRequest,
    linkedKey: linkedThreadPullRequestKey,
    hasDetail: hasLinkedPullRequestDetail,
  } = useThreadLinkedPullRequest({
    serverThreadRef: isServerThread ? activeThreadRef : null,
    environmentId: activeThreadRef?.environmentId ?? null,
    persisted: isServerThread
      ? (activeThreadShell?.linkedPullRequest ?? activeThread?.linkedPullRequest ?? null)
      : (activeThread?.linkedPullRequest ?? null),
    projectId: activeProject?.id ?? null,
    projectRepository: activeProjectRepository,
    threadBranch: activeThread?.branch ?? null,
    gitStatus: gitStatusQuery.data ?? null,
  });
  const proactivePullRequestsKey = pullRequestsSurfaceAvailable
    ? JSON.stringify(
        visiblePullRequests.map((link) => [link.host, link.repository, link.number]).sort(),
      )
    : linkedThreadPullRequestKey;
  const activeRunningTurnId = activeRuntime?.activeRunId ?? null;
  useProactivePanels({
    threadRef: isServerThread ? activeThreadRef : null,
    enabled: settings.proactivePanelsEnabled && !shouldUsePlanSidebarSheet,
    settingsHydrated: clientSettingsHydrated,
    threadDetailLoading,
    runningTurnId: activeRunningTurnId,
    latestRun: activeLatestRun,
    latestRunSettled,
    turnDiffSummaries,
    isGitRepo: gitStatusQuery.data?.isRepo,
    linkedPullRequest: linkedThreadPullRequest,
    hasLinkedPullRequestDetail,
    pullRequestsKey: proactivePullRequestsKey,
    pullRequestsCapabilityKnown,
    supportsPullRequests,
    pullRequestsSurfaceAvailable,
    visiblePullRequestCount,
    onDiffPanelOpen,
  });
  useEffect(() => {
    if (!canMaximizeRightPanel) return;
    if (useRightPanelStore.getState().consumeMaximizeRequest(routeThreadRef)) {
      useRightPanelStore.getState().setMaximized(routeThreadRef, true);
    }
  }, [canMaximizeRightPanel, routeThreadRef]);
  const {
    closeSurface: closeRightPanelSurface,
    closeOtherSurfaces: closeOtherRightPanelSurfacesStable,
    closeSurfacesToRight: closeRightPanelSurfacesToRightStable,
    closeAllSurfaces: closeAllRightPanelSurfacesStable,
  } = useRightPanelSurfaceClose({
    threadRef: activeThreadRef,
    terminalLabelsById: activeTerminalLabelsById,
  });
  const closeRightPanelSurfaceStable = closeRightPanelSurface;
  const persistThreadSettingsForNextTurn = async (input: {
    threadId: ThreadId;
    createdAt: string;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }): Promise<AtomCommandResult<void, unknown>> => {
    if (!serverThread) {
      return AsyncResult.success(undefined);
    }

    let result: AtomCommandResult<void, unknown> = AsyncResult.success(undefined);
    const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
      currentModelSelection: serverThread.modelSelection,
      currentBranch: serverThread.branch,
      ...(input.branch ? { nextBranch: input.branch } : {}),
    });
    if (metadataUpdate) {
      result = mapAtomCommandResult(
        await updateThreadMetadata({
          environmentId,
          input: {
            threadId: input.threadId,
            ...metadataUpdate,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        return result;
      }
    }

    if (input.runtimeMode !== serverThread.runtimeMode) {
      result = mapAtomCommandResult(
        await setThreadRuntimeMode({
          environmentId,
          input: {
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            createdAt: input.createdAt,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        return result;
      }
    }

    if (input.interactionMode !== serverThread.interactionMode) {
      result = mapAtomCommandResult(
        await setThreadInteractionMode({
          environmentId,
          input: {
            threadId: input.threadId,
            interactionMode: input.interactionMode,
            createdAt: input.createdAt,
          },
        }),
        () => undefined,
      );
    }
    return result;
  };

  const {
    showScrollToBottom,
    timelineLiveFollowEnabled,
    cancelPositionRestoreRef,
    isTimelineAtLogicalEndStable,
    cancelTimelineLiveFollowForUserNavigationStable,
    onComposerPageScrollKeyDownStable,
    onComposerPageScrollKeyUpStable,
    onComposerPageScrollReleaseStable,
    scrollToEnd,
    onTimelineAnchorReadyStable,
    onTimelineAnchorSizeChangedStable,
    onToolOutputCollapsedAtEndStable,
    onIsAtEndChangeStable,
    anchorNewTurn,
  } = useTimelineFollow({
    legendListRef,
    composerRef,
    composerOverlayElement,
    composerTimelineInset,
    routeThreadKey,
    activeThreadKey,
    activeThreadId: activeThread?.id,
    isServerThread,
    serverProjection,
    threadStatus,
    activeActivityRun,
    activeRunningTurnId,
    timelineEntries,
    timelineAnchorMessageId,
    setTimelineAnchor,
  });

  useEffect(() => {
    if (!activeThread?.id || terminalUiState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposerStable();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposerStable, terminalUiState.terminalOpen]);

  useEffect(() => {
    if (!activeThread?.id || terminalUiState.terminalOpen || isMobileViewport) return;
    let frame: number | null = null;
    const onWindowFocus = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      // Wait an extra frame after window focus so the composer treats focus as an expansion request.
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          if (document.querySelector("[data-mcp-app-fullscreen]") !== null) return;
          if (shouldRefocusComposerOnWindowFocus(document.activeElement)) focusComposerStable();
        });
      });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposerStable, isMobileViewport, terminalUiState.terminalOpen]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeMessageCount === 0) {
      return;
    }
    const removedMessages = optimisticUserMessages.filter((message) =>
      serverAcknowledgedUserMessageIds.has(message.id),
    );
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverAcknowledgedUserMessageIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviewsStable(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activeMessageCount,
    activeThread?.id,
    serverAcknowledgedUserMessageIds,
    handoffAttachmentPreviewsStable,
    optimisticUserMessages,
  ]);

  // Promotion drops draftId while a send may still be dispatching, so key by thread.
  const [optimisticThreadId, setOptimisticThreadId] = useState(threadId);
  const [retiredOptimisticMessages, setRetiredOptimisticMessages] = useState<
    ReadonlyArray<ChatMessage>
  >([]);
  if (optimisticThreadId !== threadId) {
    setOptimisticThreadId(threadId);
    setRetiredOptimisticMessages(optimisticUserMessages);
    setOptimisticUserMessages([]);
    resetLocalDispatch();
  }
  useEffect(() => {
    for (const message of retiredOptimisticMessages) {
      revokeUserMessagePreviewUrls(message);
    }
  }, [retiredOptimisticMessages]);

  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const derivedEnvMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
    preparingWorktree: isPreparingWorktree,
  });
  const canOverrideServerThreadEnvMode = Boolean(
    isServerThread &&
    activeThread &&
    activeMessageCount === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  if (
    !canOverrideServerThreadEnvMode &&
    (pendingServerThreadEnvModeEntry !== null || pendingServerThreadBranchEntry !== null)
  ) {
    setPendingServerThreadEnvModeEntry(null);
    setPendingServerThreadBranchEntry(null);
  }
  const pendingServerThreadEnvMode =
    pendingServerThreadEnvModeEntry !== null &&
    pendingServerThreadEnvModeEntry.threadId === activeThread?.id
      ? pendingServerThreadEnvModeEntry.mode
      : null;
  const pendingServerThreadBranchEntryForThread =
    pendingServerThreadBranchEntry?.threadId === activeThread?.id
      ? pendingServerThreadBranchEntry
      : null;
  const setPendingServerThreadBranch = (branch: string | null) => {
    if (activeThread) setPendingServerThreadBranchEntry({ threadId: activeThread.id, branch });
  };
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode;
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBranchEntryForThread !== null
      ? pendingServerThreadBranchEntryForThread.branch
      : (activeThread?.branch ?? null);
  const startFromOrigin = isLocalDraftThread
    ? (draftThread?.startFromOrigin ?? false)
    : canOverrideServerThreadEnvMode
      ? (pendingServerThreadStartFromOriginByThreadId[activeThread?.id ?? ""] ??
        activeProjectSettings.settings.newWorktreesStartFromOrigin)
      : false;
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });
  const localCheckoutBranchMismatch = isServerThread
    ? resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: envMode,
        activeWorktreePath,
        activeThreadBranch,
        currentGitBranch: gitStatusQuery.data?.refName ?? null,
      })
    : null;
  const publishComposerOverlayHeight = (height: number) => {
    const nextHeight = Math.ceil(height);
    if (nextHeight <= 0) return;
    const isResting = overlayComposerIsResting({
      composerMounted: composerMountedRef.current,
      composerReportedResting: composerRestingRef.current,
    });
    const modelStrip = composerOverlayElement?.querySelector<HTMLElement>(
      '[data-composer-model-strip="true"]',
    );
    const restingOnlyHeight =
      modelStrip && isResting
        ? Math.max(
            0,
            modelStrip.offsetHeight + Number.parseFloat(getComputedStyle(modelStrip).marginTop),
          )
        : 0;
    const noticeStack = composerOverlayElement?.querySelector<HTMLElement>(
      '[data-composer-banner-stack="true"]',
    );
    const expandedNoticesHeight = noticeStack
      ? Math.max(
          0,
          noticeStack.getBoundingClientRect().height -
            Number.parseFloat(getComputedStyle(noticeStack).minHeight),
        )
      : 0;
    const nextInset = resolveComposerTimelineInset({
      currentInset: composerTimelineInsetRef.current,
      overlayHeight: height,
      isResting,
      restingOnlyHeight,
      expandedNoticesHeight,
    });
    if (composerTimelineInsetRef.current !== nextInset) {
      composerTimelineInsetRef.current = nextInset;
      setComposerTimelineInset(nextInset);
    }
    // Reserve the expanded composer height for the terminal drawer and empty placeholder.
    // Keep it while the mobile strip collapses, but allow growth from approvals or tasks.
    // A hero overlay fills the pane, so reserve only its stack.
    const stack = composerOverlayElement?.querySelector<HTMLElement>(
      '[data-chat-composer-stack="true"]',
    );
    const expandedComposerHeight =
      isDraftHeroState && stack ? Math.ceil(stack.getBoundingClientRect().height) : nextInset;
    const mobileCollapsed = Boolean(
      stack?.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
    );
    if (!mobileCollapsed) composerExpandedHeightRef.current = expandedComposerHeight;
    const reservedHeight = Math.max(composerExpandedHeightRef.current, expandedComposerHeight);
    if (composerReservedHeightRef.current !== reservedHeight) {
      composerReservedHeightRef.current = reservedHeight;
      setComposerReservedHeight(reservedHeight);
    }
    const mainSurface = composerOverlayElement?.querySelector<HTMLElement>(
      '[data-chat-composer-main-surface="true"]',
    );
    const button = composerOverlayElement?.parentElement?.querySelector<HTMLElement>(
      'button[aria-label="Scroll to end"]',
    );
    const clearance =
      composerOverlayElement && mainSurface && button
        ? resolveScrollToEndClearance({
            overlayHeight: nextHeight,
            mainSurfaceTop: mainSurface.getBoundingClientRect().top,
            button: button.getBoundingClientRect(),
            attachments: Array.from(
              composerOverlayElement.querySelectorAll<HTMLElement>(
                '[data-composer-banner-surface="attached"]',
              ),
              (element) => element.getBoundingClientRect(),
            ),
          })
        : nextHeight;
    setScrollToEndClearance(clearance);
  };
  const publishComposerOverlayHeightStable = useStableCallback(publishComposerOverlayHeight);
  // The composer's layout effect publishes this flag before parent layout effects or resize observations.
  const onComposerRestingChange = (resting: boolean) => {
    composerRestingRef.current = resting;
  };
  const onComposerRestingChangeStable = useStableCallback(onComposerRestingChange);
  useLayoutEffect(() => {
    if (!composerOverlayElement) return;
    composerTimelineInsetRef.current = 0;
    composerReservedHeightRef.current = 0;
    composerExpandedHeightRef.current = 0;
    publishComposerOverlayHeightStable(composerOverlayElement.getBoundingClientRect().height);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A thread switch must re-measure the overlay for the new timeline.
  }, [activeThreadKey, composerOverlayElement, publishComposerOverlayHeightStable]);

  useLayoutEffect(() => {
    if (!composerOverlayElement) return;

    const updateHeight = () => {
      publishComposerOverlayHeightStable(composerOverlayElement.getBoundingClientRect().height);
    };

    updateHeight();
    // The hero overlay fills the pane, so the composer's own growth only shows on its stack.
    const stack = isDraftHeroState
      ? composerOverlayElement.querySelector<HTMLElement>('[data-chat-composer-stack="true"]')
      : null;
    return observeResize(
      stack ? [composerOverlayElement, stack] : composerOverlayElement,
      updateHeight,
    );
  }, [
    composerOverlayElement,
    isDraftHeroState,
    publishComposerOverlayHeightStable,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The scroll-to-bottom button changes the overlay's height without resizing the observed node first.
    showScrollToBottom,
  ]);
  useLayoutEffect(() => {
    if (composerMountedRef.current === composerMounted) return;
    composerMountedRef.current = composerMounted;
    if (!composerOverlayElement) return;
    composerTimelineInsetRef.current = 0;
    composerReservedHeightRef.current = 0;
    composerExpandedHeightRef.current = 0;
    publishComposerOverlayHeightStable(composerOverlayElement.getBoundingClientRect().height);
  }, [composerMounted, composerOverlayElement, publishComposerOverlayHeightStable]);
  const openPanelPullRequestUrl = useOpenPanelPullRequestUrl(activeThreadRef);
  const activeThreadReferenceCopyTarget =
    activeThreadId === null || !isServerThread
      ? null
      : resolveThreadReferenceCopyTarget({
          threadId: activeThreadId,
          openPanelPullRequestUrl,
          pullRequests: activeThread?.pullRequests,
          linkedPullRequestUrl: linkedThreadPullRequest?.url ?? null,
        });
  const copyActiveThreadReference = () => {
    const target = activeThreadReferenceCopyTarget;
    if (target === null) return;
    void writeTextToClipboard(target.value, target.clipboardTarget).then(
      (didCopy) => {
        if (!didCopy) return;
        toastManager.add({
          type: "success",
          title: target.successTitle,
          description: target.value,
        });
      },
      (error) => {
        console.error(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: target.failureTitle,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  };
  const pullRequestPanelTarget = activeThread
    ? threadPullRequestPanelTarget({
        projectId: activeThread.projectId,
        pullRequests: visiblePullRequests,
        linkedPullRequest: linkedThreadPullRequest,
        branchPullRequest: activeThreadShell?.branchPullRequest ?? activeThread.branchPullRequest,
      })
    : null;
  const {
    activateRightPanelSurfaceStable,
    addDeviceSurfaceStable,
    addDiffSurfaceStable,
    addFilesSurfaceStable,
    addPullRequestSurfaceStable,
    addPullRequestsSurfaceStable,
    closePreviewPanelStable,
    copyRightPanelFilePathStable,
    createBrowserSurface,
    createBrowserSurfaceStable,
    moveRightPanelSurfaceStable,
    onOpenTurnDiffStable,
    openChangesFromThreadPanelStable,
    openFileSurfaceStable,
    toggleRightPanelMaximizedStable,
    toggleRightPanelStable,
    toggleThreadPanelStable,
    shortcuts: rightPanelShortcuts,
  } = useRightPanelActions({
    activeThreadRef,
    activeProject,
    activeRightPanelSurface,
    activePreviewState,
    deviceState,
    pullRequestPanelTarget,
    threadPanelPresentation,
    isServerThread,
    isGitRepo,
    browserAvailable,
    canOperatePreview,
    diffOpen,
    previewPanelOpen,
    rightPanelOpen,
    canMaximizeRightPanel,
    rightPanelMaximized,
    supportsPullRequests,
    pullRequestsSurfaceAvailable,
    gitCwd,
    activeProjectCwd,
    explicitDiffOpenRef,
    onDiffPanelOpen,
    closeRightPanelSurface,
  });
  const pullRequestSurfaceAvailable = supportsPullRequests && pullRequestPanelTarget !== null;
  const nowMinute = useNowMinute();
  const {
    acknowledgeActiveThreadWoke,
    activeBranchMismatchKey,
    backgroundWorkBanner,
    childInputBanner,
    goalBanner,
    handleSwitchCheckoutToThread,
    handleSwitchCheckoutToThreadStable,
    isRestoringThreadBranch,
    onOpenRelatedThread,
    onOpenRelatedThreadStable,
    sendStandaloneCommand,
    setBranchMismatchDismissTick,
    showBranchMismatchBanner,
    threadStatusLine,
    shortcuts: threadLifecycleShortcuts,
  } = useThreadLifecycle({
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    canOperateThread,
    clientSettingsHydrated,
    activeThread,
    activeThreadId,
    activeThreadRef,
    activeThreadKey,
    activeThreadShell,
    activeLatestRun,
    activeProjectCwd,
    serverConfig,
    runtimeMode,
    isWorking,
    pendingBackgroundTasks,
    activePendingApproval,
    activePendingUserInput,
    localCheckoutBranchMismatch,
    gitStatusQuery,
    nowMinute,
    composerRef,
    composerDraftTarget,
    sendInFlightRef,
    setOptimisticUserMessages,
    setThreadError,
    clearUsageLimitsFor,
    beginLocalDispatch,
    resetLocalDispatch,
    scheduleComposerFocus,
    scrollToEnd,
    persistThreadSettingsForNextTurn,
  });
  const activeThreadHasCompactableConversation = serverVisibleTurnItems.some(
    ({ item }) =>
      item.type === "user_message" &&
      (item.text.trim().toLowerCase() !== "/compact" || item.attachments.length > 0),
  );
  const pendingHandoffSelection = composerSelectedModelSelection ?? activeThread?.modelSelection;
  const pendingHandoffSelectionUsable = providerInstanceEntries.some(
    (entry) =>
      entry.instanceId === pendingHandoffSelection?.instanceId &&
      entry.enabled &&
      entry.isAvailable,
  );
  const pendingHandoff = resolvePendingHandoff(
    serverProjection,
    pendingHandoffSelectionUsable ? pendingHandoffSelection : null,
    providerStatuses,
  );
  const compactThreadUnavailable =
    !canOperateThread ||
    !activeThread ||
    !activeThreadHasCompactableConversation ||
    !activeProject ||
    !isServerThread ||
    !manualCompactionProviderAvailable ||
    isWorking ||
    isRevertingCheckpoint ||
    threadDetailLoading ||
    isPreparingWorktree ||
    activeEnvironmentUnavailable ||
    feedbackUploading ||
    pendingApprovals.length > 0 ||
    pendingUserInputs.length > 0 ||
    showPlanFollowUpPrompt;
  const compactDisabled = compactThreadUnavailable;
  const compactDisabledReason = compactDisabled
    ? !canOperateThread
      ? "This connection cannot change threads."
      : !activeProject
        ? "Choose a project before compacting"
        : !manualCompactionProviderAvailable
          ? "Compaction is unavailable for this provider"
          : "Compacting is unavailable right now"
    : null;
  const resumeCompactionTokens =
    activeContextWindow &&
    resolveIdleCompaction(
      settings,
      activeProviderInstanceId ?? ProviderInstanceId.make("claudeAgent"),
    ) !== "off" &&
    !resumeCompactionPermanentlyDismissed &&
    !nativeResumeCompactionDismissed &&
    !compactDisabled &&
    !hasHeldQueuedRuns &&
    multipleModelSelections === null &&
    shouldOfferResumeCompaction({
      provider: selectedProvider,
      usedTokens: activeContextWindow.usedTokens,
      updatedAt: activeContextWindow.updatedAt,
      promptCacheTtlMs: activeThreadLiveTokenUsage?.promptCacheTtlMs,
      now: `${nowMinute}:00.000Z`,
    })
      ? activeContextWindow.usedTokens
      : null;
  const [fullHistoryThreadKeys, setFullHistoryThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const keepFullHistory = fullHistoryThreadKeys.has(routeThreadKey);
  const setKeepFullHistory = (threadKey: string, keep: boolean) => {
    setFullHistoryThreadKeys((current) => {
      if (current.has(threadKey) === keep) return current;
      const next = new Set(current);
      if (keep) next.add(threadKey);
      else next.delete(threadKey);
      return next;
    });
  };
  const toggleKeepFullHistory = () => setKeepFullHistory(routeThreadKey, !keepFullHistory);
  const toggleKeepFullHistoryStable = useStableCallback(toggleKeepFullHistory);
  const handleRestoreThreadBranch = () => {
    if (!canWriteSourceControl) return;
    if (gitStatusQuery.data?.hasWorkingTreeChanges) {
      if (activeThreadKey !== null) openBranchRestoreConfirm(activeThreadKey);
      return;
    }
    void handleSwitchCheckoutToThread();
  };
  const handleRestoreThreadBranchStable = useStableCallback(handleRestoreThreadBranch);
  const feedbackBannerItems = feedbackSubmissions.flatMap((submission) => {
    const item = feedbackBannerItem(submission, () => {
      setFeedbackSubmissionsByThreadKey((current) => ({
        ...current,
        [routeThreadKey]: (current[routeThreadKey] ?? []).filter(
          (entry) => entry.id !== submission.id,
        ),
      }));
    });
    return item ? [item] : [];
  });
  const limitRecoveryBanner =
    serverRuntime?.status === "failed" &&
    serverRuntime.lastErrorClass === "usage_limit" &&
    activeThreadShell?.latestRun
      ? usageLimitRecoveryBannerItem({
          runId: activeThreadShell.latestRun.runId,
          resetAt: serverRuntime.usageLimitResetAt ?? null,
          stoppedAt: activeThreadShell.latestRun.completedAt ?? activeThreadShell.updatedAt,
          recovery: activeThreadShell.limitRecovery ?? null,
          snoozedUntil: activeThreadShell.snoozedUntil,
          timestampFormat,
          onChange: async (limitRecovery) => {
            const result = await updateThreadMetadata({
              environmentId,
              input: { threadId: activeThreadShell.id, limitRecovery },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          },
        })
      : null;
  const composerBannerItems = (() => {
    const limitRecoveryItems = limitRecoveryBanner === null ? [] : [limitRecoveryBanner];
    const backgroundWorkItems = [childInputBanner, goalBanner, backgroundWorkBanner].filter(
      (item) => item !== null,
    );
    const usageLimitsItems = usageLimitsBanner === null ? [] : [usageLimitsBanner];
    const projectCloneItems = projectCloneBannerItem === null ? [] : [projectCloneBannerItem];
    if (!localCheckoutBranchMismatch || !showBranchMismatchBanner || !activeBranchMismatchKey) {
      return [
        ...feedbackBannerItems,
        ...limitRecoveryItems,
        ...usageLimitsItems,
        ...projectCloneItems,
        ...systemComposerBannerItems,
        ...backgroundWorkItems,
      ];
    }
    return [
      ...feedbackBannerItems,
      ...limitRecoveryItems,
      ...usageLimitsItems,
      ...projectCloneItems,
      ...systemComposerBannerItems,
      ...backgroundWorkItems,
      branchMismatchBannerItem({
        mismatchKey: activeBranchMismatchKey,
        mismatch: localCheckoutBranchMismatch,
        restoreDisabled: !canWriteSourceControl || isRestoringThreadBranch,
        restoring: isRestoringThreadBranch,
        onRestore: handleRestoreThreadBranchStable,
        onDismiss: () => {
          dismissBranchMismatchForSession(activeBranchMismatchKey);
          setBranchMismatchDismissTick((tick) => tick + 1);
        },
      }),
    ];
  })() as ComposerBannerStackItem[];

  if (
    terminalUiLaunchContext !== null &&
    (terminalUiLaunchContext.threadId !== activeThreadId ||
      !terminalUiState.terminalOpen ||
      (activeProjectCwd !== null &&
        projectScriptCwd({
          project: { cwd: activeProjectCwd },
          worktreePath: activeThreadWorktreePath,
        }) === terminalUiLaunchContext.cwd &&
        (activeThreadWorktreePath ?? null) === terminalUiLaunchContext.worktreePath))
  ) {
    setTerminalUiLaunchContext(null);
  }

  // Entering a thread with its drawer open focuses the drawer terminal; opening
  // it from a handler requests focus there. A closed drawer leaves focus to the
  // composer effect above.
  useEffect(() => {
    if (activeThreadRef) return focusTerminalOnThreadEnter(activeThreadRef);
  }, [activeThreadRef]);

  const getShortcutContext = (eventTarget: EventTarget | null = document.activeElement) => ({
    terminalFocus: getTerminalFocusOwner() !== null,
    terminalOpen: Boolean(terminalUiState.terminalOpen),
    previewFocus: isPreviewFocused(),
    previewOpen: previewPanelOpen,
    editableFocus: isEditableFocused(eventTarget),
    modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
    composerFocus: document.activeElement?.getAttribute("data-testid") === "composer-editor",
    draftThreadRoute: routeKind === "draft",
    turnRunning: phase === "running",
    composerRequiresModifier: composerRequiresModifier(settings.sendShortcut, promptRef.current),
    isWeb: !isElectron,
    isDesktop: isElectron,
  });
  const getShortcutContextStable = useStableCallback(getShortcutContext);
  const timelineSkills = activeProviderStatus
    ? resolveProviderSkillsForCwd(activeProviderStatus, gitCwd)
    : EMPTY_PROVIDER_SKILLS;
  const threadFindEnabled =
    isServerThread && serverConfig?.threadFind === true && !paintOnlyDisplayedTimeline;
  const isThreadFindActive = useThreadFindOpen(activeThreadRef, threadFindEnabled);

  useChatShortcuts({
    enabled: activeThreadId !== null && !backgroundThread,
    keybindings,
    scriptKeybindings,
    getShortcutContext,
    threadFindActive: isThreadFindActive,
    composerRef,
    branchToolbarRef,
    closeThreadFind: () => {
      closeThreadFind();
      focusComposerStable();
    },
    commands: {
      ...terminalShortcuts,
      ...rightPanelShortcuts,
      ...threadLifecycleShortcuts,
      "thread.copyReference": ({ event }) => {
        if (!event.repeat) copyActiveThreadReference();
      },
      "chat.find": () => {
        if (!isServerThread || serverConfig?.threadFind !== true || activeThreadKey === null)
          return false;
        openThreadFind(activeThreadKey);
      },
      "composer.cycleHost": ({ event }) => {
        if (!canChangeEnvironment) return false;
        if (event.repeat) return;
        const currentId = readPendingEnvironmentChange()?.environmentId ?? environmentId;
        const index = logicalProjectEnvironments.findIndex(
          (env) => env.environmentId === currentId,
        );
        const next = logicalProjectEnvironments[(index + 1) % logicalProjectEnvironments.length];
        if (next) onEnvironmentChangeStable(next.environmentId);
      },
      "thread.steerQueuedMessage": ({ event }) =>
        routeKind !== "draft" && queuedRunsControlRef.current?.steerNext(event.repeat) === true,
      "thread.editQueuedMessage": ({ event }) =>
        routeKind !== "draft" &&
        composerRef.current?.isCaretAtStart() === true &&
        queuedRunsControlRef.current?.editLatest(event.repeat) === true,
      "thread.stop": ({ event }) => {
        if (!canInterruptRunningThread) return false;
        if (!event.repeat) void onInterruptStable();
      },
    },
    fallback: (command) => {
      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject || !canOperateTerminal) return undefined;
      const script = activeProjectScripts.find((entry) => entry.id === scriptId);
      return script ? () => void runProjectScriptStable(script) : undefined;
    },
  });

  // A focused desktop browser page forwards these chords as menu actions.
  useEffect(() => {
    return window.desktopBridge?.onMenuAction((action) => {
      if (action === "rightPanel.toggle") toggleRightPanelStable();
      else if (action === "rightPanel.toggleMaximized") toggleRightPanelMaximizedStable();
    });
  }, [toggleRightPanelStable, toggleRightPanelMaximizedStable]);

  usePasteToFocusComposer(activeThreadId, composerRef);
  const {
    onConfirmRevertStable,
    onForkFromRunStable,
    onRevertTimelineTurnStable,
    onTimelineRollbackCheckpointStable,
  } = useTimelineRewind({
    environmentId,
    routeThreadRef,
    routeThreadKey,
    currentRouteThreadKeyRef,
    serverProjection,
    activeThread,
    timelineMessages,
    paintOnlyDisplayedTimeline,
    phase,
    isConnecting,
    isSendBusy,
    isRevertingCheckpoint,
    supportsConversationRollback,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    promptRef,
    composerRef,
    composerDraftTarget,
    setThreadError,
  });
  const onCompactContext = () => {
    if (compactDisabled) return;
    void sendStandaloneCommand("/compact", "Failed to compact context.");
  };

  const {
    getModelDisabledReason,
    handleInteractionModeChange,
    handleInteractionModeChangeStable,
    handleRuntimeModeChangeStable,
    onEnvModeChangeStable,
    onProviderModelSelectStable,
    onStartFromOriginChange,
    openProviderSetupStable,
    toggleInteractionModeStable,
  } = useComposerSelection({
    environmentId,
    composerDraftTarget,
    draftThread,
    activeThread,
    activeRuntime,
    activeProjectSettings,
    settings,
    providerStatuses,
    lockedProvider,
    supportsProviderSwitchingViaHandoff,
    multipleModelSelections,
    runtimeMode,
    interactionMode,
    interactionModeEnabled,
    isLocalDraftThread,
    canOverrideServerThreadEnvMode,
    setPendingServerThreadEnvModeEntry,
    setPendingServerThreadStartFromOriginByThreadId,
    scheduleComposerFocus,
  });
  const { onResume, isResuming } = useComposerResume({
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    activeThread,
    resumableRunId,
    hasHeldQueuedRuns,
    isSendBusy,
    isConnecting,
    isRevertingCheckpoint,
    threadDetailLoading,
    activeEnvironmentUnavailable,
    runtimeMode,
    interactionMode,
    localCheckoutBranchMismatch,
    composerRef,
    persistThreadSettingsForNextTurn,
    clearUsageLimitsFor,
    scrollToEnd,
    setThreadError,
  });
  const onImplementPlanInNewThread = useImplementPlanInNewThread({
    environmentId,
    routeThreadKey,
    activeThread,
    activeThreadBranch,
    activeProposedPlan,
    isServerThread,
    isSendBusy,
    isConnecting,
    composerRef,
    beginLocalDispatch,
    resetLocalDispatch,
    activeProject,
    activeEnvironmentUnavailable,
    defaultRuntimeMode,
  });
  const { onSend } = useComposerSend({
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    draftId,
    draftThread,
    activeThread,
    activeThreadKey,
    activeThreadBranch,
    activeProject,
    activeProjectDefaultModelSelection,
    activeProposedPlan,
    activeMessageCount,
    isServerThread,
    isLocalDraftThread,
    isGitRepo,
    phase,
    runtimeMode,
    sendEnvMode,
    startFromOrigin,
    localCheckoutBranchMismatch,
    logicalProjectEnvironments,
    providerInstanceEntries,
    composerRef,
    composerDraftTarget,
    promptRef,
    composerImagesRef,
    composerFilesRef,
    composerTerminalContextsRef,
    feedbackUploadsInFlightRef,
    queuedRunEdit,
    isConnecting,
    isRevertingCheckpoint,
    threadDetailLoading,
    activeEnvironmentUnavailable,
    isSendBusy,
    sendQueuesBehindSetup,
    isDraftHeroState,
    panelAnimationsActive,
    panelAnimationDurationMs,
    keepFullHistory,
    resumeCompactionTokens,
    showPlanFollowUpPrompt,
    usageLimitsKey,
    usageLimitsOffered,
    openUsageLimits,
    clearUsageLimitsFor,
    needsLoadBalancing,
    loadBalancing,
    readPendingEnvironmentChange,
    pendingApprovals,
    respondingRequestIds,
    activePendingProgress,
    onAdvanceActivePendingUserInput,
    onRespondToApproval: onRespondToApprovalStable,
    beginLocalDispatch,
    resetLocalDispatch,
    beginWorktreeSetup,
    captureDraftHeroComposerRect,
    setDockedDraftHeroThreadKey,
    setSetupQueueSendThreadKey,
    setOptimisticUserMessages,
    setFeedbackSubmissionsByThreadKey,
    setThreadError,
    setKeepFullHistory,
    anchorNewTurn,
    acknowledgeActiveThreadWoke,
    handleInteractionModeChange,
    handleNewThreadInActiveProject,
    persistThreadSettingsForNextTurn,
  });
  const onImplementPlanInNewThreadStable = useStableCallback(onImplementPlanInNewThread);

  const onWorktreeSetupWorkLocally = () => {
    if (!worktreeSetup || worktreeSetup.phase !== "running" || !draftId) {
      return;
    }
    void cancelWorktreeSetup().then((cancelled) => {
      if (cancelled) setWorkLocallyResendDraftId(draftId);
    });
  };
  const onWorktreeSetupWorkLocallyStable = useStableCallback(onWorktreeSetupWorkLocally);
  const onComposerSendStable = useStableCallback(onSend);
  const sendPreviewAnnotation = (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => {
    void onSend(undefined, "auto", "foreground", { annotation, image });
  };
  const sendPreviewAnnotationStable = useStableCallback(sendPreviewAnnotation);
  const onComposerResumeStable = useStableCallback(onResume);
  const onComposerCompactContextStable = useStableCallback(onCompactContext);
  // Read from the projection the footer renders, so the scroll below sees the new message.
  const pendingGuestMessageIds =
    serverProjection?.thread.guestShare?.messages.flatMap((message) =>
      message.status === "pending" ? [message.id] : [],
    ) ?? [];
  const pendingGuestMessageCount = pendingGuestMessageIds.length;
  const pendingGuestMessageKey = pendingGuestMessageIds.join(",");
  const previousPendingGuestMessagesRef = useRef({
    threadKey: routeThreadKey,
    key: pendingGuestMessageKey,
  });
  useEffect(() => {
    const previous = previousPendingGuestMessagesRef.current;
    previousPendingGuestMessagesRef.current = {
      threadKey: routeThreadKey,
      key: pendingGuestMessageKey,
    };
    // Opening another thread is not a new message; its own scroll position wins.
    if (previous.threadKey !== routeThreadKey) return;
    // Pending guest messages sit in the list footer, which the list does not follow on its own.
    // The follow flag reflects the owner's position before the footer grew; a live measure may not.
    // Any new id counts, even when another one was resolved in the same update.
    const previousIds = new Set(previous.key.split(","));
    const hasNewMessage = pendingGuestMessageKey
      .split(",")
      .some((id) => id !== "" && !previousIds.has(id));
    if (hasNewMessage && timelineLiveFollowEnabled) scrollToEnd(true);
  }, [routeThreadKey, pendingGuestMessageKey, timelineLiveFollowEnabled, scrollToEnd]);
  const queuedRunsControl =
    isServerThread && activeThread ? (
      <>
        <QueuedRunsControl
          ref={queuedRunsControlRef}
          steerShortcutLabel={shortcutLabelForCommand(keybindings, "thread.steerQueuedMessage", {
            context: { terminalFocus: false },
          })}
          editShortcutLabel={shortcutLabelForCommand(keybindings, "thread.editQueuedMessage", {
            context: { composerFocus: true },
          })}
          environmentId={activeThread.environmentId}
          threadId={activeThread.id}
          optimisticMessages={optimisticUserMessages}
          editingRunId={queuedRunEdit.editingRunId}
          onEditQueuedRun={queuedRunEdit.beginEdit}
          onCancelEdit={queuedRunEdit.cancelEdit}
        />
      </>
    ) : null;
  const resendAfterWorkLocally = () => {
    setWorkLocallyResendDraftId(null);
    void onComposerSendStable();
  };
  const resendAfterWorkLocallyStable = useStableCallback(resendAfterWorkLocally);
  const workLocallyResendReady =
    workLocallyResendDraftId !== null &&
    workLocallyResendDraftId === draftId &&
    isLocalDraftThread &&
    !isSendBusy &&
    !isConnecting &&
    !isRevertingCheckpoint &&
    !threadDetailLoading &&
    clientSettingsHydrated &&
    !needsLoadBalancing &&
    !activeEnvironmentUnavailable &&
    !activePendingProgress &&
    !feedbackUploading;
  useEffect(() => {
    if (
      !workLocallyResendReady ||
      sendInFlightRef.current ||
      feedbackUploadsInFlightRef.current.has(routeThreadKey)
    ) {
      return;
    }
    if (sendEnvMode !== "local") {
      setDraftThreadContext(composerDraftTarget, { envMode: "local", startFromOrigin: false });
      return;
    }
    resendAfterWorkLocallyStable();
  }, [
    composerDraftTarget,
    feedbackUploadsInFlightRef,
    resendAfterWorkLocallyStable,
    sendInFlightRef,
    routeThreadKey,
    sendEnvMode,
    setDraftThreadContext,
    workLocallyResendReady,
  ]);

  const onExpandTimelineImage = (preview: ExpandedImagePreview) => {
    openExpandedImagePreview(routeThreadKey, preview);
  };
  const onExpandTimelineImageStable = useStableCallback(onExpandTimelineImage);

  const pendingSidebarFileDrops = useSidebarPendingFileDropStore((state) => state.pending);
  const consumePendingFileDrop = useSidebarPendingFileDropStore(
    (state) => state.consumePendingFileDrop,
  );
  useEffect(() => {
    if (pendingSidebarFileDrops.length === 0) return;
    if (
      typeof composerDraftTarget === "string" ||
      !pendingSidebarFileDrops.some((drop) =>
        isSameSidebarThreadRef(composerDraftTarget, drop.threadRef),
      )
    ) {
      return;
    }
    if (!activeThread) return;
    if (!composerRef.current) {
      const raf = window.requestAnimationFrame(() => {
        if (!composerRef.current || typeof composerDraftTarget === "string") return;
        const files = consumePendingFileDrop(composerDraftTarget);
        if (files !== null) composerRef.current?.addDroppedFiles(files);
      });
      return () => window.cancelAnimationFrame(raf);
    }
    const files = consumePendingFileDrop(composerDraftTarget);
    if (files !== null) composerRef.current.addDroppedFiles(files);
  }, [
    activeThread,
    composerDraftTarget,
    composerRef,
    consumePendingFileDrop,
    pendingSidebarFileDrops,
  ]);

  const addDroppedFilesToComposer = useStableCallback(
    (files: Parameters<ChatComposerHandle["addDroppedFiles"]>[0]) =>
      composerRef.current?.addDroppedFiles(files),
  );
  const addDroppedFoldersToComposer = useStableCallback(
    (folders: Parameters<ChatComposerHandle["addDroppedFolders"]>[0]) =>
      composerRef.current?.addDroppedFolders(folders),
  );

  if (!activeThread) {
    return <NoActiveThreadState />;
  }

  const rightPanelContent = activeThreadRef ? (
    <RightPanelSurfaceContent
      surface={renderedRightPanelSurface}
      activeSurfaceId={activeRightPanelSurface?.id ?? null}
      threadRef={activeThreadRef}
      environmentId={activeThread.environmentId}
      visible={rightPanelOpen}
      composerDraftTarget={composerDraftTarget}
      keybindings={keybindings}
      configuredPreviewUrls={configuredPreviewUrls}
      workspaceMutationId={workspaceMutationId}
      getShortcutContext={getShortcutContextStable}
      onSendAnnotation={sendPreviewAnnotationStable}
      onCloseSurface={closeRightPanelSurface}
      terminal={{
        launchContext: activeTerminalLaunchContext ?? null,
        keybindings,
        onAddTerminalContext: addTerminalContextToDraftStable,
        onSplitTerminal: splitPanelTerminalStable,
        onSplitTerminalVertical: splitPanelTerminalVerticalStable,
        onNewTerminal: addTerminalSurfaceStable,
        onActiveTerminalChange: activatePanelTerminalStable,
        onCloseTerminal: closePanelTerminalStable,
        splitShortcutLabel: splitTerminalShortcutLabel ?? undefined,
        splitVerticalShortcutLabel: splitTerminalVerticalShortcutLabel ?? undefined,
        newShortcutLabel: newTerminalShortcutLabel ?? undefined,
        closeShortcutLabel: closeTerminalShortcutLabel ?? undefined,
      }}
      pullRequest={{
        capabilityKnown: pullRequestsCapabilityKnown,
        supported: supportsPullRequests,
        projectId: activeThread.projectId,
        pullRequests: visiblePullRequests,
        linkedPullRequest: linkedThreadPullRequest,
        branchPullRequest: activeThreadShell?.branchPullRequest ?? activeThread.branchPullRequest,
        onBack:
          pullRequestsSurfaceAvailable && visiblePullRequestCount > 1
            ? addPullRequestsSurfaceStable
            : undefined,
      }}
      files={{
        projectName: activeProject?.title ?? null,
        workspaceRoot: activeWorkspaceRoot,
        availableEditors,
        pendingSurfaceIds: pendingFileSurfaceIds,
        onOpenFile: openFileSurfaceStable,
        onPendingChange: handleFilePendingChangeStable,
      }}
    />
  ) : null;
  const panelToggleControlProps = {
    terminalAvailable: activeProject !== null,
    terminalOpen: terminalUiState.terminalOpen,
    terminalShortcutLabel: shortcutLabelForCommand(keybindings, "terminal.toggle"),
    threadPanelOpen,
    threadPanelPresentation,
    threadPanelPopoverHandle,
    threadPanelShortcutLabel: shortcutLabelForCommand(keybindings, "threadPanel.toggle"),
    rightPanelAvailable: activeProject !== null,
    rightPanelOpen,
    rightPanelShortcutLabel: shortcutLabelForCommand(keybindings, "rightPanel.toggle"),
    onToggleTerminal: toggleTerminalVisibilityStable,
    onToggleThreadPanel: toggleThreadPanelStable,
    onToggleRightPanel: toggleRightPanelStable,
  } satisfies PanelLayoutControlsProps;
  const panelToggleControls = (
    <PanelLayoutControls
      {...panelToggleControlProps}
      showThreadPanelControl={!inlineRightPanelOwnsTitleBar}
    />
  );
  const threadPanelHeaderControl = <ThreadPanelHeaderControl {...panelToggleControlProps} />;
  const panelLayoutControls = (
    <WorkspaceTitlebarControls
      showMaximizeControl={!shouldUsePlanSidebarSheet}
      rightPanelOpen={rightPanelOpen}
      animationsActive={panelAnimationsActive}
      maximized={rightPanelMaximized}
      onToggleMaximized={toggleRightPanelMaximizedStable}
    >
      {panelToggleControls}
    </WorkspaceTitlebarControls>
  );
  const workspaceFileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: setIsWorkspaceFileDragActive,
    addFiles: addDroppedFilesToComposer,
    addFolders: addDroppedFoldersToComposer,
  });

  const content = (
    <div
      ref={setWorkspaceLayoutElement}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      <DeviceSetupDialogHost
        threadKey={activeThreadKey}
        threadRef={activeThreadRef}
        state={deviceState}
      />
      {rightPanelControlsAtRoot ? panelLayoutControls : null}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-x-hidden",
          rightPanelMaximized ? "w-0 flex-none" : "flex-1",
        )}
        data-chat-column-maximized-away={rightPanelMaximized ? "true" : "false"}
        data-chat-column
      >
        <header
          ref={threadPanelPopoverAnchorRef}
          data-chat-header
          className={cn(
            "relative bg-background [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
            isElectron
              ? cn(
                  "drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 sm:px-5",
                  reserveTitleBarControlInset &&
                    !inlineRightPanelOwnsTitleBar &&
                    "wco:pr-(--workspace-native-controls-inset)",
                )
              : "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          {isElectron && rightPanelControlsAtRoot ? (
            <span
              aria-hidden
              className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
            />
          ) : null}
          {!rightPanelControlsAtRoot && !rightPanelControlsInPanel ? panelLayoutControls : null}
          {inlineRightPanelOwnsTitleBar ? threadPanelHeaderControl : null}
          <ChatHeader
            activeThreadEnvironmentId={activeThread.environmentId}
            activeThreadId={activeThread.id}
            isServerThread={isServerThread}
            activeThreadTitle={activeThread.title}
            activeProject={activeProject ?? null}
            parentThreadLink={parentThreadLink}
            onOpenThread={onOpenRelatedThreadStable}
            rightPanelOpen={inlineRightPanelOwnsTitleBar}
            onNewThreadInProject={handleNewThreadInActiveProjectStable}
            {...(activeDraftLogicalProjectKey
              ? { onOpenProjectSettings: handleOpenDraftProjectSettingsStable }
              : {})}
          />
        </header>

        <div className="relative flex min-h-0 min-w-0 flex-1">
          <ThreadFindCanvas
            findOptions={{
              skills: timelineSkills,
              progressive: serverConfig?.threadFindProgressive === true,
              thread: activeThreadRef,
              enabled: threadFindEnabled,
            }}
            detailsCardTopInset={isThreadFindActive ? THREAD_FIND_BAR_RESERVED_HEIGHT : 0}
            composerOverlayElement={isDraftHeroState ? null : composerOverlayElement}
            data-chat-workspace-drop-target="true"
            onDragEnter={workspaceFileDropHandlers.onDragEnter}
            onDragOver={workspaceFileDropHandlers.onDragOver}
            onDragLeave={workspaceFileDropHandlers.onDragLeave}
            onDrop={workspaceFileDropHandlers.onDrop}
          >
            <ThreadFind onClose={focusComposerStable} />
            {isWorkspaceFileDragActive ? <WorkspaceFileDropOverlay /> : null}
            <ChatBannerLane
              providerStatus={visibleProviderStatus}
              providerStatusBannerKey={providerStatusBannerKey}
              setDismissedProviderStatusBannerKey={setDismissedProviderStatusBannerKey}
              onOpenProviderSetup={openProviderSetupStable}
              threadId={activeThread.id}
              threadError={timelineThreadError}
              threadErrorClass={
                threadErrorIsServerRuntimeError ? (serverRuntime?.lastErrorClass ?? null) : null
              }
              threadErrorCode={
                threadErrorIsServerRuntimeError ? (serverRuntime?.lastErrorCode ?? null) : null
              }
              threadErrorBannerKey={threadErrorBannerKey}
              setThreadError={setThreadError}
              setThreadErrorBannerDismissTick={setThreadErrorBannerDismissTick}
            />
            <div className="relative flex min-h-0 flex-1 flex-col bg-background">
              <ThreadTimeline
                threadDetailRef={routeThreadDetailRef}
                entriesInput={timelineEntriesInput}
                draftEntries={isServerThread ? null : draftTimelineEntries}
                activeThreadKey={activeThreadKey}
                syncing={threadSyncPhase !== null}
                detailLoading={threadDetailLoading}
                readyMarkdownCwd={gitCwd}
                readyWorkspaceRoot={activeWorkspaceRoot ?? null}
                citationRequest={paintOnlyDisplayedTimeline ? null : citationRequest}
                citationHistoryLoading={threadDetailLoading}
                {...(!paintOnlyDisplayedTimeline
                  ? {
                      onCiteAssistantText: citeAssistantTextStable,
                      ...(activeProject ? { onRunShellCommand: runShellCommandStable } : {}),
                    }
                  : {})}
                isWorking={!paintOnlyDisplayedTimeline && isWorking}
                runlessWorkActive={runlessWorkStartedAt !== null}
                activeTurnInProgress={
                  !paintOnlyDisplayedTimeline && (isWorking || !latestRunSettled)
                }
                isCompacting={!paintOnlyDisplayedTimeline && isCompacting}
                awaitingUser={
                  paintOnlyDisplayedTimeline
                    ? null
                    : activePendingApproval !== null
                      ? "approval"
                      : activePendingUserInput !== null ||
                          // A secret request has no runtime request; the shell carries it.
                          activeThreadShell?.hasPendingUserInput === true
                        ? "input"
                        : null
                }
                awaitingRequestId={
                  paintOnlyDisplayedTimeline
                    ? null
                    : (activePendingApproval?.requestId ??
                      activePendingUserInput?.requestId ??
                      null)
                }
                activeTurnStartedAt={paintOnlyDisplayedTimeline ? null : activeWorkStartedAt}
                worktreeSetup={paintOnlyDisplayedTimeline ? null : worktreeSetup}
                onCancelWorktreeSetup={onCancelWorktreeSetupStable}
                {...(paintOnlyDisplayedTimeline
                  ? {}
                  : {
                      retryableWorkspacePreparationRunIds,
                      onRetryWorkspacePreparation: onRetryWorkspacePreparationStable,
                    })}
                {...(draftId
                  ? { onWorktreeSetupWorkLocally: onWorktreeSetupWorkLocallyStable }
                  : {})}
                {...(onOpenWorktreeSetupTerminal ? { onOpenWorktreeSetupTerminal } : {})}
                isPreparingWorktree={!paintOnlyDisplayedTimeline && isPreparingWorktree}
                footer={
                  paintOnlyDisplayedTimeline ||
                  (pendingHandoff === null &&
                    pendingGuestMessageCount === 0 &&
                    threadStatusLine === null) ? null : (
                    <>
                      {pendingHandoff === null ? null : (
                        <div className="chat-content-lane">
                          <HandoffRow
                            environmentId={environmentId}
                            endpoints={pendingHandoff}
                            providers={providerStatuses}
                            pending
                          />
                        </div>
                      )}
                      {pendingGuestMessageCount > 0 && isServerThread && activeThread ? (
                        <GuestPendingMessages
                          threadRef={scopeThreadRef(activeThread.environmentId, activeThread.id)}
                          onImageExpand={onExpandTimelineImageStable}
                          onFileOpen={openFileAttachmentStable}
                        />
                      ) : null}
                      {threadStatusLine}
                    </>
                  )
                }
                listRef={legendListRef}
                runs={paintOnlyDisplayedTimeline ? [] : (serverProjection?.runs ?? [])}
                latestRun={paintOnlyDisplayedTimeline ? null : activeActivityRun}
                announcedRun={
                  paintOnlyDisplayedTimeline
                    ? null
                    : announcedRun(activeActivityRun, serverProjection?.runs ?? [])
                }
                detailBehindShell={
                  !paintOnlyDisplayedTimeline &&
                  isDetailBehindShell(activeLatestRun, activeThreadShell?.latestRun ?? null)
                }
                runningRunId={paintOnlyDisplayedTimeline ? null : activeRunningTurnId}
                turnDiffSummaries={
                  paintOnlyDisplayedTimeline ? EMPTY_HELD_TURN_DIFF_SUMMARIES : turnDiffSummaries
                }
                activeThreadEnvironmentId={
                  displayedThreadRef?.environmentId ?? activeThread.environmentId
                }
                routeThreadKey={displayedTimelineKey}
                displayThreadKey={displayedTimelineKey}
                paintOnly={paintOnlyDisplayedTimeline}
                announceTurnStatus={!isProviderSubagent}
                onOpenTurnDiff={
                  paintOnlyDisplayedTimeline ? noopHeldTurnDiff : onOpenTurnDiffStable
                }
                onOpenThread={onOpenRelatedThreadStable}
                parentThreadLink={paintOnlyDisplayedTimeline ? null : parentThreadLink}
                workflowOpening={paintOnlyDisplayedTimeline ? null : workflowOpening}
                onForkFromRun={paintOnlyDisplayedTimeline ? async () => {} : onForkFromRunStable}
                onRollbackCheckpoint={onTimelineRollbackCheckpointStable}
                supportsConversationRollback={
                  !paintOnlyDisplayedTimeline && supportsConversationRollback
                }
                threadStartCheckpointReady={threadStartCheckpointReady}
                availableRevertTurnCounts={availableRevertTurnCounts}
                onRevertToTurnCount={
                  paintOnlyDisplayedTimeline ? noopHeldRevert : onRevertTimelineTurnStable
                }
                {...(!paintOnlyDisplayedTimeline
                  ? {
                      onUseArtifactTemplate: insertArtifactTemplateStable,
                      onSendAppMessage: sendAppMessageStable,
                    }
                  : {})}
                isRevertingCheckpoint={isRevertingCheckpoint}
                onImageExpand={onExpandTimelineImageStable}
                onFileOpen={
                  paintOnlyDisplayedTimeline ? noopHeldAttachment : openFileAttachmentStable
                }
                onFileDownload={
                  paintOnlyDisplayedTimeline ? noopHeldAttachment : downloadFileAttachmentStable
                }
                markdownCwd={
                  paintOnlyDisplayedTimeline
                    ? (heldPaintContext?.markdownCwd ?? undefined)
                    : (gitCwd ?? undefined)
                }
                resolvedTheme={resolvedTheme}
                timestampFormat={timestampFormat}
                workspaceRoot={
                  paintOnlyDisplayedTimeline
                    ? (heldPaintContext?.workspaceRoot ?? undefined)
                    : activeWorkspaceRoot
                }
                skills={timelineSkills}
                anchorMessageId={paintOnlyDisplayedTimeline ? null : timelineAnchorMessageId}
                onAnchorReady={onTimelineAnchorReadyStable}
                onAnchorSizeChanged={onTimelineAnchorSizeChangedStable}
                contentInsetEndAdjustment={composerTimelineInset}
                liveFollowEnabled={!paintOnlyDisplayedTimeline && timelineLiveFollowEnabled}
                onIsAtEndChange={onIsAtEndChangeStable}
                onContentOverflowChange={setTimelineOverflows}
                onToolOutputCollapsedAtEnd={onToolOutputCollapsedAtEndStable}
                onManualNavigation={cancelTimelineLiveFollowForUserNavigationStable}
                cancelPositionRestoreRef={cancelPositionRestoreRef}
                hideEmptyPlaceholder={isDraftHeroState || threadDetailLoading}
                emptyPlaceholderInset={composerReservedHeight}
                topFadeEnabled={!hasTimelineTopBanner}
                {...(paintOnlyDisplayedTimeline || threadHistoryControls === undefined
                  ? {}
                  : { historyControls: threadHistoryControls })}
              />

              {showScrollToBottom && !isThreadFindActive && (
                <ScrollToEndButton
                  bottom={scrollToEndClearance + 4}
                  onScrollToEnd={() => {
                    composerRef.current?.restoreAfterTimelineReachedEnd();
                    scrollToEnd(true);
                  }}
                />
              )}
            </div>

            <div
              ref={setComposerOverlayElement}
              inert={isRevertingCheckpoint}
              data-chat-composer-overlay="true"
              className={
                isDraftHeroState
                  ? "pointer-events-none absolute inset-0 z-20 flex items-center"
                  : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
              }
            >
              <div ref={draftHeroTransitionGroupRef} className="chat-composer-lane w-full">
                <div
                  data-chat-composer-stack="true"
                  className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)"
                >
                  {isDraftHeroState ? (
                    <div className="absolute inset-x-0 bottom-full">
                      <div
                        className="pb-4 group-has-data-[composer-shoulder-tab]/composer-stack:pb-0"
                        style={
                          forceExpandedMobileComposer
                            ? { viewTransitionName: MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME }
                            : undefined
                        }
                      >
                        <DraftHeroHeadline
                          draftId={draftId}
                          activeProjectRef={activeProjectRef}
                          activeProjectTitle={activeProject?.title ?? null}
                        />
                      </div>
                    </div>
                  ) : null}
                  <div
                    ref={draftHeroComposerAnchorRef}
                    className="relative z-10"
                    style={
                      forceExpandedMobileComposer
                        ? { viewTransitionName: MOBILE_COMPOSER_VIEW_TRANSITION_NAME }
                        : undefined
                    }
                  >
                    <ComposerSurface.Shell
                      contextStrip={showComposerContextStrip || showComposerModelStrip}
                    >
                      <ComposerSurface.Host
                        inert={queuedRunEdit.isSaving}
                        aria-busy={queuedRunEdit.isSaving}
                      >
                        <div className="relative z-10">
                          {showProviderSubagentBar ? (
                            <ProviderSubagentBar
                              provider={selectedProviderEntry ?? null}
                              showInstanceBadge={
                                selectedProviderEntry !== undefined &&
                                shouldShowInstanceBadge(
                                  selectedProviderEntry,
                                  providerInstanceEntries,
                                )
                              }
                              modelLabel={providerSubagentModelLabel}
                              effortLabel={providerSubagentEffortLabel}
                              status={providerSubagentStatus}
                              onOpenParent={
                                parentThreadLink
                                  ? () => onOpenRelatedThread(parentThreadLink.threadId)
                                  : null
                              }
                            />
                          ) : null}
                          {!composerMounted ? null : (
                            <ChatComposer
                              canOperateThread={canOperateThread}
                              reportedModelSelection={reportedModelSelection}
                              multipleModelSelections={multipleModelSelections}
                              supportsMultipleModels={
                                serverConfig?.environment.capabilities.requiredWorktreeBootstrap ===
                                true
                              }
                              onMultipleModelSelectionsChange={setMultipleModelSelectionsStable}
                              composerRef={composerRef}
                              composerDraftTarget={composerDraftTarget}
                              environmentId={environmentId}
                              attachmentUploadsCapabilityKnown={attachmentUploadsCapabilityKnown}
                              supportsAttachmentUploads={supportsAttachmentUploads}
                              supportsQuestionAttachments={supportsQuestionAttachments}
                              maxFileAttachmentBytes={maxFileAttachmentBytes}
                              routeKind={routeKind}
                              routeThreadRef={routeThreadRef}
                              draftId={draftId}
                              activeThreadId={activeThreadId}
                              activeThreadEnvironmentId={activeThread?.environmentId}
                              activeThread={activeThread}
                              activeThreadShell={activeThreadShell}
                              promptHistoryMessages={timelineMessages}
                              isServerThread={isServerThread}
                              isLocalDraftThread={isLocalDraftThread}
                              forceExpandedOnMobile={
                                forceExpandedMobileComposer && isDraftHeroState
                              }
                              projectSelectionRequired={
                                isLocalDraftThread && activeProject === null
                              }
                              phase={phase}
                              isCompacting={isCompacting}
                              canInterrupt={canInterruptRunningThread}
                              isConnecting={isConnecting}
                              isSendBusy={
                                (isSendBusy && !sendQueuesBehindSetup) ||
                                (setupQueueSendThreadKey !== null &&
                                  setupQueueSendThreadKey === activeThreadKey) ||
                                queuedRunEdit.isSaving ||
                                isResuming
                              }
                              canResume={resumableRunId !== null || hasHeldQueuedRuns}
                              isRevertingCheckpoint={isRevertingCheckpoint}
                              sendDisabledReason={
                                !canOperateThread
                                  ? "This connection cannot change threads."
                                  : isEnvironmentChanging
                                    ? "Preparing machine"
                                    : isRevertingCheckpoint
                                      ? "Rewinding conversation"
                                      : feedbackUploading
                                        ? "Sending feedback"
                                        : threadDetailLoading
                                          ? "Messages loading"
                                          : worktreeSetupBlocksSend
                                            ? "Preparing worktree"
                                            : projectCloneSendBlockReason
                              }
                              isPreparingWorktree={isPreparingWorktree && !sendQueuesBehindSetup}
                              queuedRunsControl={queuedRunsControl}
                              bannerItems={composerBannerItems}
                              resumeCompactionTokens={resumeCompactionTokens}
                              keepFullHistory={keepFullHistory}
                              onToggleKeepFullHistory={toggleKeepFullHistoryStable}
                              onUsageLimitsCommand={
                                usageLimitsOffered &&
                                usageLimitsKey !== null &&
                                !composerHasNonPromptContent
                                  ? openUsageLimits
                                  : undefined
                              }
                              environmentUnavailable={activeEnvironmentUnavailableState}
                              activePendingApproval={activePendingApproval}
                              pendingApprovals={pendingApprovals}
                              pendingUserInputs={pendingUserInputs}
                              activePendingProgress={activePendingProgress}
                              activePendingResolvedAnswers={activePendingResolvedAnswers}
                              activePendingIsResponding={activePendingIsResponding}
                              activePendingDraftAnswers={activePendingDraftAnswers}
                              activePendingQuestionIndex={activePendingQuestionIndex}
                              respondingRequestIds={respondingRequestIds}
                              showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                              activeProposedPlan={activeProposedPlan}
                              threadSyncPhase={
                                activeEnvironmentUnavailable ? null : threadSyncPhase
                              }
                              runtimeMode={runtimeMode}
                              interactionMode={interactionMode}
                              lockedProvider={modelPickerLockedProvider}
                              providerStatuses={providerStatuses as ServerProvider[]}
                              providerCatalogKnown={serverConfig !== null}
                              activeProjectDefaultModelSelection={
                                activeProjectDefaultModelSelection
                              }
                              activeThreadModelSelection={activeThread?.modelSelection}
                              activeProjectId={activeProject?.id ?? null}
                              activeContextWindow={activeContextWindow}
                              activeTasksProgress={activeComposerTasksProgress}
                              activeTaskSteps={activeComposerTaskSteps}
                              compactThreadUnavailable={compactThreadUnavailable}
                              compactDisabled={compactDisabled}
                              compactDisabledReason={compactDisabledReason}
                              resolvedTheme={resolvedTheme}
                              settings={settings}
                              keybindings={keybindings}
                              terminalOpen={Boolean(terminalUiState.terminalOpen)}
                              gitCwd={gitCwd}
                              pullRequestProjectId={
                                supportsPullRequests ? (activeProject?.id ?? null) : null
                              }
                              pullRequestRepository={
                                supportsPullRequests ? activeProjectRepository : null
                              }
                              threadPullRequests={(activeThreadShell ?? activeThread)?.pullRequests}
                              restingControlsHost={restingComposerControlsHost}
                              restingControlsHaveLeadingContext={
                                mountComposerContextStrip &&
                                (isGitRepo || showComposerEnvironmentIndicator)
                              }
                              onRestingControlsVisibilityChange={setRestingComposerControlsVisible}
                              getTimelineScrollableNode={getTimelineScrollableNodeStable}
                              isTimelineAtLogicalEnd={isTimelineAtLogicalEndStable}
                              timelineOverflows={timelineOverflows}
                              onComposerOverlayHeightChange={publishComposerOverlayHeightStable}
                              onRestingChange={onComposerRestingChangeStable}
                              promptRef={promptRef}
                              composerImagesRef={composerImagesRef}
                              composerFilesRef={composerFilesRef}
                              composerTerminalContextsRef={composerTerminalContextsRef}
                              onPageScrollKeyDown={onComposerPageScrollKeyDownStable}
                              onPageScrollKeyUp={onComposerPageScrollKeyUpStable}
                              onPageScrollRelease={onComposerPageScrollReleaseStable}
                              onCompactContext={onComposerCompactContextStable}
                              onSend={onComposerSendStable}
                              onResume={onComposerResumeStable}
                              onInterrupt={onInterruptStable}
                              onImplementPlanInNewThread={onImplementPlanInNewThreadStable}
                              onRespondToApproval={onRespondToApprovalStable}
                              onSelectActivePendingUserInputOption={
                                onSelectActivePendingUserInputOptionStable
                              }
                              onAdvanceActivePendingUserInput={
                                onAdvanceActivePendingUserInputStable
                              }
                              onDismissActivePendingUserInput={onDismissUserInputStable}
                              onPreviousActivePendingUserInputQuestion={
                                onPreviousActivePendingUserInputQuestionStable
                              }
                              onChangeActivePendingUserInputCustomAnswer={
                                onChangeActivePendingUserInputCustomAnswer
                              }
                              onProviderModelSelect={onProviderModelSelectStable}
                              onOpenProviderSetup={openProviderSetupStable}
                              getModelDisabledReason={getModelDisabledReason}
                              toggleInteractionMode={toggleInteractionModeStable}
                              handleRuntimeModeChange={handleRuntimeModeChangeStable}
                              handleInteractionModeChange={handleInteractionModeChangeStable}
                              focusComposer={focusComposerStable}
                              scheduleComposerFocus={scheduleComposerFocusStable}
                              setThreadError={setThreadError}
                              onExpandImage={onExpandTimelineImageStable}
                              onFileOpen={openFileAttachmentStable}
                              editingQueuedAttachments={queuedRunEdit.editingAttachments}
                              onRemoveEditingQueuedAttachment={
                                queuedRunEdit.removeEditingAttachment
                              }
                            />
                          )}
                        </div>
                      </ComposerSurface.Host>
                      <div className="min-h-0">
                        <div
                          data-terminal-open={terminalUiState.terminalOpen ? "true" : undefined}
                          className="relative z-0"
                        >
                          {mountComposerModelStrip ? (
                            <ComposerSurface.ContextStrip
                              data-composer-model-strip="true"
                              aria-hidden={showComposerModelStrip ? undefined : true}
                              inert={showComposerModelStrip ? undefined : true}
                              className={cn(
                                "group-data-model-strip-transition/composer-surface:before:backdrop-blur-(--glass-blur) group-data-model-strip-transition/composer-surface:before:bg-(--chat-composer-glass-surface)/(--glass-opacity)",
                                !showComposerModelStrip &&
                                  "pointer-events-none invisible absolute inset-x-0 top-full",
                              )}
                            >
                              <div
                                ref={setRestingComposerControlsHost}
                                className="min-w-0 flex-1"
                              />
                            </ComposerSurface.ContextStrip>
                          ) : null}
                          {mountComposerContextStrip && (
                            <div className="pointer-events-auto">
                              <BranchToolbar
                                forceNewWorktree={multipleModelSelections !== null}
                                ref={branchToolbarRef}
                                environmentId={activeThread.environmentId}
                                threadId={activeThread.id}
                                projectId={activeThread.projectId}
                                worktreePath={activeThread.worktreePath}
                                isServerThread={isServerThread}
                                showGitControls={isGitRepo}
                                {...(routeKind === "draft" && draftId ? { draftId } : {})}
                                onEnvModeChange={onEnvModeChangeStable}
                                startFromOrigin={startFromOrigin}
                                onStartFromOriginChange={onStartFromOriginChange}
                                envMode={envMode}
                                {...(canOverrideServerThreadEnvMode
                                  ? {
                                      activeThreadBranchOverride: activeThreadBranch,
                                      onActiveThreadBranchOverrideChange:
                                        setPendingServerThreadBranch,
                                    }
                                  : {})}
                                envLocked={envLocked}
                                onComposerFocusRequest={scheduleComposerFocusStable}
                                {...(canCheckoutPullRequestIntoThread
                                  ? { onCheckoutPullRequestRequest: openPullRequestDialogStable }
                                  : {})}
                                {...(canChangeEnvironment
                                  ? { onEnvironmentChange: onEnvironmentChangeStable }
                                  : {})}
                                autoEnvironmentLabel={autoEnvironmentLabel}
                                onAutoEnvironment={
                                  draftId &&
                                  !envLocked &&
                                  canAutoBalanceEnvironments &&
                                  loadBalancingSettings.loadBalancingEnabled
                                    ? onAutoEnvironmentStable
                                    : undefined
                                }
                                availableEnvironments={logicalProjectEnvironments}
                                composerControlsHostRef={setRestingComposerControlsHost}
                                contextStripVisible={showComposerContextStrip}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </ComposerSurface.Shell>
                    <div
                      aria-hidden
                      className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                    />
                  </div>
                </div>
              </div>
            </div>

            {canOperatePreview && activeThreadRef && activeEnvironmentServerBrowser ? (
              <PreviewSessionSync threadRef={activeThreadRef} />
            ) : null}
            {activeThreadRef &&
            activePreviewMiniPlayer &&
            previewMiniPlayerVisible &&
            (activePreviewMiniPlayer.source.kind === "device" || canOperatePreview) ? (
              <ThreadPreviewMiniPlayer
                key={`${activeThreadKey}:${previewMiniPlayerSourceKey(activePreviewMiniPlayer.source)}`}
                threadRef={activeThreadRef}
                miniPlayer={activePreviewMiniPlayer}
              />
            ) : null}

            <BranchRestoreConfirmHost
              threadKey={activeThreadKey}
              threadBranch={localCheckoutBranchMismatch?.threadBranch ?? ""}
              canWriteSourceControl={canWriteSourceControl}
              onConfirm={handleSwitchCheckoutToThreadStable}
            />

            <ThreadDetailsPanel
              anchor={threadPanelPopoverAnchorRef}
              handle={threadPanelPopoverHandle}
              onPresentationChange={setThreadPanelPresentation}
              forceNewWorktree={multipleModelSelections !== null}
              environmentId={activeThread.environmentId}
              threadId={activeThread.id}
              projectId={activeThread.projectId}
              worktreePath={activeThread.worktreePath}
              isServerThread={isServerThread}
              {...(draftId ? { draftId } : {})}
              activeProjectName={activeProject?.title}
              activeProjectScripts={activeProject ? activeProjectScripts : undefined}
              preferredScriptId={
                activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
              }
              keybindings={keybindings}
              availableEditors={availableEditors}
              showOpenInPicker={showOpenInPicker}
              openInShortcutEnabled={
                !(
                  rightPanelOpen &&
                  renderedRightPanelSurface?.kind === "file" &&
                  renderedRightPanelSurface.attachment === undefined
                )
              }
              gitCwd={gitCwd}
              isGitRepo={isGitRepo}
              envLocked={envLocked}
              availableEnvironments={logicalProjectEnvironments}
              autoEnvironmentLabel={autoEnvironmentLabel}
              onAutoEnvironment={
                draftId &&
                !envLocked &&
                canAutoBalanceEnvironments &&
                loadBalancingSettings.loadBalancingEnabled
                  ? onAutoEnvironmentStable
                  : undefined
              }
              {...(canChangeEnvironment ? { onEnvironmentChange: onEnvironmentChangeStable } : {})}
              onEnvModeChange={onEnvModeChangeStable}
              envMode={envMode}
              {...(canOverrideServerThreadEnvMode
                ? {
                    activeThreadBranchOverride: activeThreadBranch,
                    onActiveThreadBranchOverrideChange: setPendingServerThreadBranch,
                  }
                : {})}
              startFromOrigin={startFromOrigin}
              onStartFromOriginChange={onStartFromOriginChange}
              {...(canCheckoutPullRequestIntoThread
                ? { onCheckoutPullRequestRequest: openPullRequestDialogStable }
                : {})}
              onComposerFocusRequest={scheduleComposerFocusStable}
              {...(isServerThread && isGitRepo
                ? { onOpenChanges: openChangesFromThreadPanelStable }
                : {})}
              onRunProjectScript={runProjectScriptStable}
              onAddProjectScript={saveProjectScriptStable}
              onUpdateProjectScript={updateProjectScriptStable}
              onDeleteProjectScript={deleteProjectScriptStable}
            />

            <PullRequestThreadDialogHost
              threadKey={activeThreadKey}
              environmentId={activeThread.environmentId}
              threadId={activeThread.id}
              cwd={activeProject?.workspaceRoot ?? null}
              onPrepared={handlePreparedPullRequestThreadStable}
            />
          </ThreadFindCanvas>
        </div>

        <ChatTerminalDrawers
          activeThreadKey={activeThreadKey}
          activeTerminalOpen={Boolean(terminalUiState.terminalOpen)}
          composerHeight={composerReservedHeight}
          launchContext={activeTerminalLaunchContext ?? null}
          splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
          splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
          newShortcutLabel={newTerminalShortcutLabel ?? undefined}
          closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
          keybindings={keybindings}
          onAddTerminalContext={addTerminalContextToDraftStable}
        />
      </div>

      {rightPanelPresent && activeThreadRef ? (
        <ChatRightPanel
          sheet={shouldUsePlanSidebarSheet}
          workspaceLayoutElement={workspaceLayoutElement}
          widthStorageKey={`t3code:preview-panel-width:${activeThreadKey}`}
          sheetAnimationDurationMs={panelAnimationsActive ? panelAnimationDurationMs : 0}
          onCloseSheet={closePreviewPanelStable}
          open={rightPanelOpen}
          keybindings={keybindings}
          getShortcutContext={getShortcutContextStable}
          maximized={rightPanelMaximized}
          layoutControls={
            rightPanelOpen ? (
              <div className="mr-px flex items-center">{panelToggleControls}</div>
            ) : null
          }
          surfaces={renderedRightPanelSurfaces}
          environmentId={activeThreadRef.environmentId}
          activeSurfaceId={renderedRightPanelSurface?.id ?? null}
          pendingSurfaceIds={pendingFileSurfaceIds}
          previewSessions={activePreviewState.sessions}
          desktopByTabId={activePreviewState.desktopByTabId}
          previewRuntimeTabId={resolvePreviewRuntimeTabId}
          terminalLabelsById={activeTerminalLabelsById}
          onActivate={activateRightPanelSurfaceStable}
          onCloseSurface={closeRightPanelSurfaceStable}
          onRenameDevice={(surfaceId, title) => {
            if (activeThreadRef)
              useRightPanelStore.getState().renameDevice(activeThreadRef, surfaceId, title);
          }}
          onCloseOtherSurfaces={closeOtherRightPanelSurfacesStable}
          onCloseSurfacesToRight={closeRightPanelSurfacesToRightStable}
          onCloseAllSurfaces={closeAllRightPanelSurfacesStable}
          onMoveSurface={moveRightPanelSurfaceStable}
          onCopyFilePath={copyRightPanelFilePathStable}
          onAddBrowser={() => createBrowserSurface()}
          onAddBrowserInProfile={createBrowserSurfaceStable}
          onAddTerminal={addTerminalSurfaceStable}
          onAddDiff={addDiffSurfaceStable}
          onAddFiles={addFilesSurfaceStable}
          onAddPullRequest={addPullRequestSurfaceStable}
          onAddPullRequests={addPullRequestsSurfaceStable}
          onAddDevice={addDeviceSurfaceStable}
          browserAvailable={canOperatePreview && browserAvailable}
          terminalAvailable={activeProject !== null && canOperateTerminal}
          diffAvailable={isServerThread && isGitRepo}
          filesAvailable={activeProject !== null}
          pullRequestAvailable={pullRequestSurfaceAvailable}
          pullRequestsAvailable={pullRequestsSurfaceAvailable}
          deviceAvailable={activeThreadRef !== null}
        >
          {rightPanelContent}
        </ChatRightPanel>
      ) : null}

      <RevertConfirmHost threadKey={routeThreadKey} onConfirm={onConfirmRevertStable} />
      <LinkPullRequestDialogHost />
      <ThreadVisitWatermark threadRef={routeThreadRef} />
      <ExpandedImageDialogHost threadKey={routeThreadKey} />
    </div>
  );
  return (
    <FileMetadataThreadProvider
      threadRef={activeThreadRef}
      cwd={activeWorkspaceRoot}
      checkpoints={serverProjection?.checkpoints}
    >
      {content}
    </FileMetadataThreadProvider>
  );
}

function PreviewSessionSync(props: { readonly threadRef: ScopedThreadRef }) {
  usePreviewSession(props.threadRef);
  return null;
}

import { useSidebarWorkspaceTabs } from "../workspace/useSystemWorkspaceTabBar";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import {
  useChildThreadInputs,
  useThreadReportedModelSelection,
  useThreadShell,
} from "../../state/entities";
import { UsageLimitRecoveryCard } from "./UsageLimitRecoveryCard";
import { ChatGptUsageLimitNotice } from "./ChatGptUsageLimitNotice";
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import {
  effectiveSnoozed,
  threadWokeAt,
  isThreadWokeUnseen,
  snoozeWakeLabel,
} from "@t3tools/client-runtime/state/thread-settled";
import type { WorktreeSetupCardProps } from "./worktree-setup-card";
import type { ComposerTextPaste } from "../../native/T3ComposerEditor.types";
import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { HandoffEndpoints } from "@t3tools/client-runtime/handoff";
import {
  childThreadInputsTitle,
  type CodexFeedbackSubmission,
  type EnvironmentThreadStatus,
} from "@t3tools/client-runtime/state/threads";
import { useKeyboardChatComposerInset, useKeyboardScrollToEnd } from "@legendapp/list/keyboard";
import { resolveProviderSkillsForCwd } from "@t3tools/client-runtime/providerSkills";
import type { LegendListRef } from "@legendapp/list/react-native";
import { HeaderHeightContext } from "@react-navigation/elements";
import { NativeLayoutObserver } from "../../native/NativeLayoutObserver";
import { deriveBottomControlInsets, type NativeLayoutMetrics } from "../../lib/reserved-regions";
import type {
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  RuntimeRequestId,
  ScopedThreadRef,
  ServerConfig as T3ServerConfig,
  ThreadId,
  UsageLimitsReport,
} from "@t3tools/contracts";
import {
  appendCodexArtifactTemplateUsePrompt,
  type CodexArtifactTemplate,
} from "@t3tools/shared/codexArtifactTemplates";
import {
  declinePendingApprovals,
  sendApprovalFeedback,
  type ApprovalResponder,
  type ThreadUserInputQuestion,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  presentPendingBackgroundWork,
  presentProviderGoal,
} from "@t3tools/client-runtime/state/thread-execution";
import { resolveSubagentPillSegment } from "@t3tools/client-runtime/state/thread-subagents";
import {
  formatModelSelectionEffort,
  type ProviderSubagentStatus,
} from "@t3tools/client-runtime/state/thread-execution";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";
import { isProviderNativeSubagentThread } from "@t3tools/contracts";
import type { QueuedRunEdit } from "../../state/queued-run-edit";
import type { FollowUpBehavior } from "../../lib/followUpBehavior";
import type { ActiveTurnComposerAction } from "@t3tools/client-runtime/state/composer-dispatch";
import * as Haptics from "expo-haptics";
import {
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AppState,
  Keyboard,
  Platform,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type ViewInstance,
} from "react-native";
import {
  KeyboardController,
  KeyboardStickyView,
  useKeyboardState,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import Animated, {
  Easing,
  FadeInDown,
  FadeOut,
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useWorkspaceContentWidth } from "../layout/workspace-content-width";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import {
  useDeviceType,
  useDuoBottomBarInset,
  useNativeColumnLayoutMetrics,
  useNativeLayoutMetrics,
} from "../../native/native-layout-metrics";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { collectProviderUsageLimits } from "@t3tools/shared/usageLimits";
import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import type { StatusTone } from "../../components/StatusPill";
import { getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import {
  ANDROID_READING_MAX_WIDTH,
  CHAT_CONTENT_MAX_WIDTH,
  type LayoutVariant,
} from "../../lib/layout";
import { editPendingThreadMessage } from "../../state/edit-pending-thread-message";
import { deviceEnvironment } from "../../state/device";
import { useEnvironmentQuery } from "../../state/query";
import { threadDevicePreviews } from "../devices/threadDevicePreviews";
import { ThreadBrowserFloat } from "../browser/ThreadBrowserFloat";
import { useThreadServerBrowserTabs } from "../../state/preview";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { claimThreadOpen } from "@t3tools/client-runtime/state/thread-search";
import {
  finishThreadMessageJump,
  pendingThreadMessageJump,
  subscribeThreadMessageJump,
} from "./threadMessageJump";
import {
  clearThreadComposerError,
  threadComposerErrorsAtom,
} from "../../state/thread-composer-error";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useDelayedStatus } from "../../lib/useDelayedStatus";
import type {
  PendingApproval,
  PendingUserInput,
  PendingUserInputDraftAnswer,
  ThreadFeedEntry,
  ThreadFeedLatestRun,
} from "../../lib/threadActivity";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { ComposerErrorNotice } from "./ComposerErrorNotice";
import { ComposerFeedback } from "./ComposerFeedback";
import { ComposerUsageLimits } from "./ComposerUsageLimits";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { ProviderSubagentBar } from "./ProviderSubagentBar";
import { ThreadCreationFailedCard } from "./ThreadCreationFailedCard";
import {
  FLOATING_WORKING_CONTROL_COVERAGE,
  FloatingWorkingControl,
} from "./floating-working-control";
import { connectionFloatingStatus, type FloatingWorkingStatus } from "./floating-working-status";
import {
  derivePendingUserInputMaxHeight,
  ESTIMATED_KEYBOARD_HEIGHT,
  USER_INPUT_TOGGLE_DURATION_MS,
} from "./pendingUserInputLayout";
import {
  COMPOSER_COLLAPSED_CHROME,
  THREAD_COMPOSER_BOTTOM_GUTTER,
  ThreadComposer,
} from "./ThreadComposer";
import { ComposerPopoverHost } from "./ComposerPopoverHost";
import { ThreadFeed, type ThreadFeedHistoryControls } from "./ThreadFeed";
import { useThreadTurnSubagents } from "./ThreadAgentsSheet";
import { ComposerQueuedEditBanner } from "./ComposerQueuedEdit";
import { useThreadQueuedCount } from "./ThreadQueueControl";
import { ThreadGuestShareBar } from "./ThreadGuestShareBar";
import type { ThreadContentPresentation } from "./threadContentPresentation";
import { resolveThreadFeedSubmissionAnchor } from "./thread-feed-live-follow";
import { useOpenLinkedThread } from "./useOpenLinkedThread";
import { useGlobalVoiceInput } from "../voice-input/VoiceInputProvider";

export interface ThreadDetailScreenProps {
  readonly header?: React.ReactNode;
  readonly draftMode?: {
    readonly content: (
      headerInset: number,
      bottomInset: number,
      availableHeight: number,
    ) => React.ReactNode;
    readonly controls: React.ReactNode;
    readonly editorRef: React.RefObject<ComposerEditorHandle | null>;
    readonly sendBlockedReason: string | null;
    readonly interactionLocked: boolean;
  };
  readonly worktreeSetup?: WorktreeSetupCardProps | null;
  readonly setupWorkingStartedAt?: string | null;
  readonly canOperateThread: boolean;
  readonly selectedThread: EnvironmentThreadShell;
  /**
   * Read thread details through this, not `selectedThread.id`: it stays null until
   * a queued creation reaches the server; see `useThreadSelection`.
   */
  readonly selectedThreadDetailRef: ScopedThreadRef | null;
  readonly contentPresentation: ThreadContentPresentation;
  readonly screenTone: StatusTone;
  readonly connectionError: string | null;
  readonly environmentLabel: string | null;
  readonly feedbackSubmissions: ReadonlyArray<CodexFeedbackSubmission>;
  readonly onDismissFeedback: (id: MessageId) => void;
  readonly selectedThreadFeed: ReadonlyArray<ThreadFeedEntry>;
  readonly pendingHandoff?: HandoffEndpoints | null;
  readonly activityRun: ThreadFeedLatestRun | null;
  readonly activeWorkStartedAt: string | null;
  readonly runlessWorkActive?: boolean;
  readonly providerSubagentStatus?: ProviderSubagentStatus | null;
  readonly isCompacting: boolean;
  readonly creationState:
    | {
        readonly kind: "preparing";
        readonly preparingWorktree: boolean;
        readonly serverOwned: boolean;
      }
    | { readonly kind: "failed"; readonly reason: string; readonly onEditTask: () => void }
    | null;
  readonly activePendingApproval: PendingApproval | null;
  readonly activePendingApprovals: ReadonlyArray<PendingApproval>;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activePendingUserInputDrafts: Record<string, PendingUserInputDraftAnswer>;
  readonly activePendingUserInputAnswers: Record<string, string | ReadonlyArray<string>> | null;
  readonly respondingUserInputId: RuntimeRequestId | null;
  readonly connectionStateLabel: EnvironmentConnectionPhase;
  readonly threadSyncStatus?: EnvironmentThreadStatus;
  readonly historyControls?: ThreadFeedHistoryControls;
  readonly activeThreadBusy: boolean;
  readonly canStopThread: boolean;
  readonly queuedRunEdit: QueuedRunEdit | null;
  readonly composerDraftKey: string | null;
  readonly followUpBehavior: FollowUpBehavior;
  readonly canSteerActiveTurn: boolean;
  readonly isSavingQueuedEdit: boolean;
  readonly onCancelQueuedRunEdit: () => void;
  readonly onRemoveQueuedEditAttachment: (attachmentId: string) => void;
  readonly environmentId: EnvironmentId;
  readonly projectWorkspaceRoot: string | null;
  readonly threadCwd: string | null;
  readonly selectedThreadQueueCount: number;
  readonly queuedMessages: ReadonlyArray<QueuedThreadMessage>;
  readonly dispatchingMessageId: MessageId | null;
  readonly serverConfig: T3ServerConfig | null;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly onOpenConnectionEditor: () => void;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftMedia: () => Promise<void>;
  readonly onPickDraftFiles: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onNativePasteText: (paste: ComposerTextPaste) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  /** Present while the thread's queue is held. */
  readonly onResumeQueue: (() => Promise<void>) | null;
  readonly onSendMessage: (
    followUp?: ActiveTurnComposerAction,
    beforeDispatch?: (
      text: string,
      hasAttachmentsOrContext: boolean,
    ) => Promise<boolean | "responded">,
  ) => Promise<MessageId | null>;
  readonly onReconnectEnvironment: () => void;
  readonly canSwitchThreadProvider: boolean;
  readonly onUpdateThreadModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateThreadRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateThreadInteractionMode?: (interactionMode: ProviderInteractionMode) => void;
  readonly onRespondToApproval: ApprovalResponder;
  readonly onSelectUserInputOption: (
    requestId: RuntimeRequestId,
    question: ThreadUserInputQuestion,
    value: string,
  ) => void;
  readonly onChangeUserInputCustomAnswer: (
    requestId: RuntimeRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmitUserInput: () => Promise<unknown>;
  readonly onDismissUserInput: () => Promise<unknown>;
  readonly showContent?: boolean;
}

function latestStreamingAssistantMessage(
  feed: ReadonlyArray<ThreadFeedEntry>,
): { readonly id: string; readonly textLength: number } | null {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const entry = feed[index];
    if (entry?.type !== "message") {
      continue;
    }
    if (entry.message.role !== "assistant" || !entry.message.streaming) {
      continue;
    }
    return {
      id: entry.message.id,
      textLength: entry.message.text.length,
    };
  }

  return null;
}

function useStreamingHaptics(threadId: ThreadId, feed: ReadonlyArray<ThreadFeedEntry>) {
  const lastStreamingAssistantRef = useRef<{
    readonly id: string;
    readonly textLength: number;
  } | null>(null);
  const lastStreamHapticAtRef = useRef(0);
  const hydratedRef = useRef(false);
  const previousThreadIdRef = useRef(threadId);

  useEffect(() => {
    if (previousThreadIdRef.current !== threadId) {
      previousThreadIdRef.current = threadId;
      hydratedRef.current = false;
    }

    const latestStreamingMessage = latestStreamingAssistantMessage(feed);

    if (!hydratedRef.current) {
      hydratedRef.current = true;
      lastStreamingAssistantRef.current = latestStreamingMessage;
      return;
    }

    if (!latestStreamingMessage) {
      lastStreamingAssistantRef.current = null;
      return;
    }

    const previousStreamingMessage = lastStreamingAssistantRef.current;
    lastStreamingAssistantRef.current = latestStreamingMessage;

    const isNewStream = previousStreamingMessage?.id !== latestStreamingMessage.id;
    const textGrew =
      previousStreamingMessage?.id === latestStreamingMessage.id &&
      latestStreamingMessage.textLength > previousStreamingMessage.textLength;

    if (!isNewStream && !textGrew) {
      return;
    }

    const now = Date.now();
    if (!isNewStream && now - lastStreamHapticAtRef.current < 320) {
      return;
    }

    lastStreamHapticAtRef.current = now;
    void Haptics.selectionAsync();
  }, [threadId, feed]);
}

const USAGE_LIMITS_PANEL_GAP = 12;
const USAGE_LIMITS_PANEL_MIN_HEIGHT = 44;

const USER_INPUT_TOGGLE_TIMING = {
  duration: USER_INPUT_TOGGLE_DURATION_MS,
  easing: Easing.out(Easing.cubic),
};

// The visit watermark follows the shell's updatedAt, which ticks while a run
// streams. Keeping it in a leaf lets the screen read the quiet shell.
function ThreadVisitWatermark(props: {
  readonly environmentId: EnvironmentId;
  readonly selectedThread: EnvironmentThreadShell;
  readonly showContent: boolean;
}) {
  const liveThread = useThreadShell({
    environmentId: props.environmentId,
    threadId: props.selectedThread.id,
  });
  const thread = liveThread ?? props.selectedThread;
  const showContent = props.showContent;
  const selectedThreadKey = scopedThreadKey(props.environmentId, thread.id);
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const lastDispatchedVisitRef = useRef<string | null>(null);
  const lastVisitDispatchRef = useRef({ threadKey: selectedThreadKey, at: 0 });
  const selectedThreadId = thread.id;
  const snoozedUntil = thread.snoozedUntil;
  // Keep the clock in state so React Compiler invalidates the wake calculation.
  const [wakeNow, setWakeNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    if (!showContent || snoozedUntil == null) return;
    const delay = Date.parse(snoozedUntil) - Date.now();
    if (!Number.isFinite(delay)) return;
    const timer = setTimeout(() => setWakeNow(new Date().toISOString()), Math.max(0, delay) + 50);
    return () => clearTimeout(timer);
  }, [showContent, snoozedUntil]);
  const selectedThreadWokeAt = threadWokeAt(thread, {
    now: wakeNow,
  });
  // A scheduled wake can happen without a newer server update.
  const selectedThreadUpdatedAt =
    selectedThreadWokeAt !== null && Date.parse(selectedThreadWokeAt) > Date.parse(thread.updatedAt)
      ? selectedThreadWokeAt
      : thread.updatedAt;
  const wakeIsLatestUpdate = selectedThreadUpdatedAt === selectedThreadWokeAt;
  const selectedThreadLastVisitedAt = thread.lastVisitedAt;
  const selectedThreadCompletedAt = thread.latestRun?.completedAt;
  // Opening a thread is one visit that also counts toward search ranking; a
  // palette pick already sent it with the query. The watermark effect below
  // skips it.
  const recordedOpenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!showContent) return;
    if (recordedOpenRef.current === selectedThreadKey) return;
    recordedOpenRef.current = selectedThreadKey;
    // Recorded here even when the server cannot take opens, so recents follow it.
    const claimed = claimThreadOpen(props.environmentId, selectedThreadId, Date.now());
    if (!claimed || selectedThreadLastVisitedAt === undefined) return;
    lastDispatchedVisitRef.current = `${selectedThreadKey}:${selectedThreadUpdatedAt}`;
    lastVisitDispatchRef.current = { threadKey: selectedThreadKey, at: Date.now() };
    void visitThread({
      environmentId: props.environmentId,
      input: {
        threadId: selectedThreadId,
        visitedAt: selectedThreadUpdatedAt,
        opened: true,
      },
    });
  }, [
    props.environmentId,
    selectedThreadId,
    selectedThreadKey,
    selectedThreadLastVisitedAt,
    selectedThreadUpdatedAt,
    showContent,
    visitThread,
  ]);
  useEffect(() => {
    if (!showContent || selectedThreadLastVisitedAt === undefined) return;
    const threadUpdatedAtMs = Date.parse(selectedThreadUpdatedAt);
    if (Number.isNaN(threadUpdatedAtMs)) return;
    const lastVisitedAtMs = selectedThreadLastVisitedAt
      ? Date.parse(selectedThreadLastVisitedAt)
      : NaN;
    if (!Number.isNaN(lastVisitedAtMs) && lastVisitedAtMs >= threadUpdatedAtMs) return;
    const dispatchKey = `${selectedThreadKey}:${selectedThreadUpdatedAt}`;
    if (lastDispatchedVisitRef.current === dispatchKey) return;
    const dispatch = () => {
      lastDispatchedVisitRef.current = dispatchKey;
      lastVisitDispatchRef.current = { threadKey: selectedThreadKey, at: Date.now() };
      void visitThread({
        environmentId: props.environmentId,
        input: { threadId: selectedThreadId, visitedAt: selectedThreadUpdatedAt },
      });
    };
    const completedAtMs = selectedThreadCompletedAt ? Date.parse(selectedThreadCompletedAt) : NaN;
    const hasUnseenCompletion =
      !Number.isNaN(completedAtMs) &&
      (Number.isNaN(lastVisitedAtMs) || completedAtMs > lastVisitedAtMs);
    const previous = lastVisitDispatchRef.current;
    const elapsed = Date.now() - previous.at;
    // Like a completion, a wake the user is looking at must not wait out the throttle:
    // leaving within it would cancel the dispatch and keep Woke in the list.
    if (
      previous.threadKey !== selectedThreadKey ||
      hasUnseenCompletion ||
      wakeIsLatestUpdate ||
      elapsed >= 10_000
    ) {
      dispatch();
      return;
    }
    const timer = setTimeout(dispatch, 10_000 - elapsed);
    return () => clearTimeout(timer);
  }, [
    props.environmentId,
    selectedThreadId,
    selectedThreadKey,
    selectedThreadLastVisitedAt,
    selectedThreadCompletedAt,
    selectedThreadUpdatedAt,
    showContent,
    visitThread,
    wakeIsLatestUpdate,
  ]);
  return null;
}

export const ThreadDetailScreen = function ThreadDetailScreen(props: ThreadDetailScreenProps) {
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const deviceType = useDeviceType();
  const workspace = useWorkspaceTabs();
  const sidebarSearchActive =
    deviceType === "duo-unfolded" &&
    workspace?.state.tabs[workspace.state.selectedTab].searchMode === "active";
  // Keep the last input owner through keyboard dismissal, so closing sidebar
  // search cannot briefly lift the composer into the keyboard's closing frame.
  const [composerOwnsKeyboard, setComposerOwnsKeyboard] = useState(false);
  if (sidebarSearchActive && composerOwnsKeyboard) setComposerOwnsKeyboard(false);
  const navigation = useNavigation();
  const openLinkedThread = useOpenLinkedThread();
  const { session: voiceInputSession } = useGlobalVoiceInput();
  const reportedModelSelection = useThreadReportedModelSelection(props.selectedThreadDetailRef);
  const deviceState = useEnvironmentQuery(
    deviceEnvironment.state({ environmentId: props.environmentId, input: {} }),
  );
  const devicePreviews = threadDevicePreviews(deviceState.data, props.selectedThread.id);
  const openDevicePreview = () => {
    Keyboard.dismiss();
    navigation.navigate("ThreadDevicePreview", {
      environmentId: props.environmentId,
      threadId: props.selectedThread.id,
    });
  };
  const browserTabs = useThreadServerBrowserTabs({
    environmentId: props.environmentId,
    threadId: props.selectedThread.id,
    enabled:
      !props.draftMode && props.serverConfig?.environment.capabilities.serverBrowser === true,
  });
  const openBrowserPreview = (tabId?: string) => {
    Keyboard.dismiss();
    navigation.navigate("ThreadBrowserPreview", {
      environmentId: props.environmentId,
      threadId: props.selectedThread.id,
      ...(tabId === undefined ? {} : { tabId }),
    });
  };
  const insets = useSafeAreaInsets();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const liveKeyboardHeight = useKeyboardState((state) => state.height);
  // Android can swallow the IME hide callbacks when the app is backgrounded mid keyboard-hide
  // (the reported repro: send — which blurs and starts the hide — then Home within a second). The
  // keyboard library's height AND visibility then stay frozen open, so gating the sticky
  // translation on visibility alone still strands the composer after resume. An input that kept
  // focus through the switch is exempt: Android restores its keyboard unchanged, so no keyboard
  // or focus event would ever lift the quarantine. Hiding the keyboard with Back keeps focus, so
  // Back then Home mid-hide takes the exemption and can still strand the composer.
  const [keyboardStateSuspect, setKeyboardStateSuspect] = useState(false);
  const ownedInputFocusedRef = useRef(false);
  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setKeyboardStateSuspect(!ownedInputFocusedRef.current);
      }
    });
    return () => {
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    setKeyboardStateSuspect(false);
  }, [isKeyboardVisible, liveKeyboardHeight]);
  const handleOwnedInputFocusChange = (focused: boolean) => {
    ownedInputFocusedRef.current = focused;
    if (focused) {
      if (deviceType === "duo-folded" || deviceType === "duo-unfolded")
        setComposerOwnsKeyboard(true);
      setKeyboardStateSuspect(false);
    }
  };
  const windowHeight = useWindowDimensions().height;
  const navigationHeaderHeight = useContext(HeaderHeightContext) ?? insets.top + 44;
  const [screenMetrics, setScreenMetrics] = useState<NativeLayoutMetrics | null>(null);
  const columnMetrics = useNativeColumnLayoutMetrics();
  const windowMetrics = useNativeLayoutMetrics();
  const nativeMetrics = usesNativeWorkspaceColumns ? columnMetrics : screenMetrics;
  const controlInsets = deriveBottomControlInsets(nativeMetrics);
  const agentLabel = `${props.selectedThread.modelSelection.instanceId} agent`;
  const selectedThreadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
  const childThreadInputs = useChildThreadInputs({
    environmentId: props.environmentId,
    threadId: props.selectedThread.id,
  });
  const composerError = useAtomValue(threadComposerErrorsAtom)[selectedThreadKey]?.message ?? null;
  const queuedCount = useThreadQueuedCount(props.selectedThreadDetailRef);
  const turnSubagents = useThreadTurnSubagents(props.selectedThreadDetailRef);
  const agentsSegment = resolveSubagentPillSegment(turnSubagents);
  const defaultComposerEditorRef = useRef<ComposerEditorHandle>(null);
  const composerEditorRef = props.draftMode?.editorRef ?? defaultComposerEditorRef;
  const isProviderSubagent = isProviderNativeSubagentThread(props.selectedThread.source);
  const editingRunId = props.queuedRunEdit?.runId ?? null;
  useEffect(() => {
    if (editingRunId === null) return;
    const frame = requestAnimationFrame(() => composerEditorRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editingRunId, composerEditorRef]);
  const composerOverlayRef = useRef<ViewInstance>(null);
  const listRef = useRef<LegendListRef>(null);
  const feedTouchStartRef = useRef<{ pageX: number; pageY: number } | null>(null);
  const selectedThreadKeyRef = useRef(selectedThreadKey);
  const lastScrolledSubmittedMessageIdRef = useRef<MessageId | null>(null);
  const [composerHeight, setComposerHeight] = useState<number | null>(null);
  const [anchorMessageId, setAnchorMessageId] = useState<MessageId | null>(null);
  const [submittedMessageId, setSubmittedMessageId] = useState<MessageId | null>(null);
  const [endFollowEnabled, setEndFollowEnabled] = useState(true);
  // Keep the bottom padding fixed while the keyboard animates. Changing it at
  // keyboardDidHide makes the composer land low, then jump back above the safe area.
  const bottomBarInset = useDuoBottomBarInset();
  const hasSidebarTabBar = useSidebarWorkspaceTabs() === "picker";
  // A pushed screen temporarily inherits the outgoing tab bar's safe area.
  // Use the window edge so hiding that bar cannot move the composer mid-push.
  const bottomSafeArea =
    Platform.OS === "ios" ? (windowMetrics?.safeArea.bottom ?? insets.bottom) : insets.bottom;
  // The pill already adds its own gutter; iPad and Duo align its edge with the native bar.
  const alignedBottomInset =
    bottomBarInset ??
    (Platform.OS === "ios" && Platform.isPad
      ? Math.max(bottomSafeArea, 12) - (hasSidebarTabBar ? 5 : 0)
      : undefined);
  // The Duo's floating sidebar pill ends three points below the composer's usual gutter.
  const composerBottomInset = Math.max(
    0,
    (alignedBottomInset !== undefined
      ? alignedBottomInset - THREAD_COMPOSER_BOTTOM_GUTTER
      : Math.max(bottomSafeArea, 12)) - (hasSidebarTabBar ? 3 : 0),
  );
  const composerKeyboardOffset = composerBottomInset;
  const contentPresentationKind = props.contentPresentation.kind;
  const realThreadSyncLabel = (() => {
    switch (props.threadSyncStatus) {
      case "empty":
      case "cached":
      case "synchronizing":
        if (contentPresentationKind === "ready") {
          return "Syncing messages...";
        }
        return contentPresentationKind === "loading" ? "Loading messages..." : null;
      default:
        return null;
    }
  })();
  const threadSyncLabel = useDelayedStatus(selectedThreadKey, realThreadSyncLabel);
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const unsnoozeThread = useAtomCommand(threadEnvironment.unsnooze, { reportFailure: false });
  const unsettleThread = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const [statusRequest, setStatusRequest] = useState<{ threadKey: string } | null>(null);
  const statusPending = statusRequest?.threadKey === selectedThreadKey;
  const [lifecycleNow, setLifecycleNow] = useState(() => new Date().toISOString());
  useFocusEffect(
    useCallback(() => {
      setLifecycleNow(new Date().toISOString());
      const timer = setInterval(() => setLifecycleNow(new Date().toISOString()), 60_000);
      return () => clearInterval(timer);
    }, []),
  );
  const snoozed =
    props.serverConfig?.environment.capabilities.threadSnooze === true &&
    effectiveSnoozed(props.selectedThread, { now: lifecycleNow });
  const snoozedUntil = props.selectedThread.snoozedUntil;
  useEffect(() => {
    if (!snoozed || snoozedUntil === null) return;
    const timer = setTimeout(
      () => setLifecycleNow(new Date().toISOString()),
      Math.min(Math.max(0, Date.parse(snoozedUntil) - Date.now()) + 50, 2_147_483_647),
    );
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-arm if timer clamping fires before the wake time.
  }, [snoozed, snoozedUntil, lifecycleNow]);
  const settled =
    props.serverConfig?.environment.capabilities.threadSettlement === true &&
    props.selectedThread.settledOverride === "settled";
  const wokeAt =
    props.serverConfig?.environment.capabilities.threadSnooze === true
      ? threadWokeAt(props.selectedThread, { now: lifecycleNow })
      : null;
  const woke = isThreadWokeUnseen({
    wokeAt,
    settled,
    lastVisitedAt: props.selectedThread.lastVisitedAt,
    latestRunCompletedAt: props.selectedThread.latestRun?.completedAt ?? null,
  });
  const runStatusAction = async (action: "stop" | "wake" | "unsettle" | "dismiss") => {
    if (statusPending || !props.canOperateThread) return;
    const request = { threadKey: selectedThreadKey };
    setStatusRequest(request);
    const target = {
      environmentId: props.environmentId,
      input: { threadId: props.selectedThread.id },
    };
    const recovery = props.selectedThread.limitRecovery;
    const recoveryOwnsSnooze =
      recovery?.snooze === true &&
      recovery.runId === props.selectedThread.latestRun?.runId &&
      snoozedUntil !== null &&
      Date.parse(snoozedUntil) === Date.parse(recovery.resetAt);
    const result =
      action === "stop"
        ? await interruptThreadTurn(target)
        : action === "wake"
          ? recoveryOwnsSnooze
            ? await updateMetadata({
                ...target,
                input: {
                  ...target.input,
                  limitRecovery: {
                    runId: recovery.runId,
                    resetAt: recovery.resetAt,
                    snooze: false,
                  },
                },
              })
            : await unsnoozeThread({ ...target, input: { ...target.input, reason: "user" } })
          : action === "unsettle"
            ? await unsettleThread({ ...target, input: { ...target.input, reason: "user" } })
            : await visitThread({
                ...target,
                input: { ...target.input, visitedAt: wokeAt ?? lifecycleNow },
              });
    // An accepted interrupt can leave tasks running. Release the action for retry.
    setStatusRequest((current) => (current === request ? null : current));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not update thread",
        error instanceof Error ? error.message : "Try again.",
      );
    }
  };
  const pendingBackgroundWork = presentPendingBackgroundWork(
    props.selectedThread.pendingBackgroundTasks,
  );
  const floatingStatus = ((): FloatingWorkingStatus | null => {
    const connectionStatus = connectionFloatingStatus({
      connectionError: props.connectionError,
      connectionState: props.connectionStateLabel,
      environmentLabel: props.environmentLabel,
      onReconnect: props.onReconnectEnvironment,
    });
    if (connectionStatus !== null && !props.draftMode) {
      return connectionStatus;
    }
    if (props.activePendingApproval !== null || props.activePendingUserInput !== null) {
      return null;
    }
    if (props.creationState?.kind === "preparing") {
      if (props.worktreeSetup) return null;
      return {
        kind: "preparing",
        label: props.creationState.preparingWorktree ? "Setting up worktree…" : "Starting…",
      };
    }
    if (props.creationState?.kind === "failed") {
      return null;
    }
    if (threadSyncLabel !== null) {
      return { kind: "syncing", label: threadSyncLabel };
    }
    const childInput = childThreadInputs[0];
    if (childInput && contentPresentationKind === "ready") {
      return {
        kind: "child-input",
        label: childThreadInputsTitle(childThreadInputs),
        accessibilityLabel: `Open ${childInput.hasPendingApprovals ? "approval" : "question"} from ${childInput.title}`,
        onPress: () => {
          Keyboard.dismiss();
          navigation.dispatch(
            StackActions.push("Thread", {
              environmentId: props.environmentId,
              threadId: childInput.id,
            }),
          );
        },
      };
    }
    if (props.isCompacting && contentPresentationKind === "ready") {
      return { kind: "compacting" };
    }
    if (props.activeWorkStartedAt !== null && contentPresentationKind === "ready") {
      return { kind: "working", startedAt: props.activeWorkStartedAt };
    }
    if (pendingBackgroundWork !== null && contentPresentationKind === "ready") {
      return {
        kind: "background",
        label: pendingBackgroundWork.title,
        accessibilityLabel: `${pendingBackgroundWork.title}: ${pendingBackgroundWork.items
          .map((item) => item.label)
          .join(", ")}`,
        waiting: pendingBackgroundWork.waiting,
        onPress: () => {
          Keyboard.dismiss();
          navigation.navigate("ThreadBackgroundWork", {
            environmentId: props.environmentId,
            threadId: props.selectedThread.id,
          });
        },
        action: {
          label: statusPending ? "Stopping..." : "Stop",
          accessibilityLabel: "Stop background work",
          disabled: !props.canOperateThread || statusPending,
          onPress: () => void runStatusAction("stop"),
        },
      };
    }
    if (contentPresentationKind === "ready" && (snoozed || settled || woke)) {
      const state = snoozed ? "snoozed" : settled ? "settled" : "woke";
      const label =
        snoozed && snoozedUntil !== null
          ? `Snoozed, wakes in ${snoozeWakeLabel(snoozedUntil, { now: lifecycleNow })}`
          : settled
            ? "Settled"
            : "Woke from snooze";
      const actionLabel = snoozed ? "Wake now" : settled ? "Un-settle" : "Dismiss";
      return {
        kind: "lifecycle",
        state,
        label,
        action: {
          label: statusPending
            ? snoozed
              ? "Waking..."
              : settled
                ? "Un-settling..."
                : "Dismissing..."
            : actionLabel,
          accessibilityLabel: actionLabel,
          disabled: !props.canOperateThread || statusPending,
          onPress: () => void runStatusAction(snoozed ? "wake" : settled ? "unsettle" : "dismiss"),
        },
      };
    }
    if (props.selectedThread.goal !== null && contentPresentationKind === "ready") {
      const goal = presentProviderGoal(props.selectedThread.goal, false);
      return {
        kind: "goal",
        label: goal.title,
        accessibilityLabel: `${goal.title}: ${goal.objective}`,
      };
    }
    return null;
  })();
  const showWorkingControl = floatingStatus !== null;
  const showFloatingStatus =
    showWorkingControl ||
    queuedCount > 0 ||
    agentsSegment !== null ||
    devicePreviews.length > 0 ||
    browserTabs.tabs.length > 0 ||
    props.connectionStateLabel !== "connected" ||
    props.queuedMessages.length > 0 ||
    props.selectedThreadFeed.some(
      (entry) => "acknowledged" in entry && entry.acknowledged === true,
    );
  const selectedThreadFeed = props.selectedThreadFeed;
  // A palette message result opens the thread at that message: earlier
  // history loads until the message is in the feed, which then scrolls to it.
  const jumpMessageId = useSyncExternalStore(subscribeThreadMessageJump, () =>
    pendingThreadMessageJump(selectedThreadKey),
  );
  const jumpMessageLoaded =
    jumpMessageId !== null &&
    selectedThreadFeed.some((entry) => entry.type === "message" && entry.id === jumpMessageId);
  // A jump this screen never reached lets go when the thread closes.
  useEffect(() => () => finishThreadMessageJump(selectedThreadKey), [selectedThreadKey]);
  const historyForJump = props.historyControls;
  // History down to the message in one request; another page if it is not
  // there yet.
  const loadEarlierForJump = useEffectEvent(() => {
    if (jumpMessageId !== null) historyForJump?.onLoadThrough(jumpMessageId);
  });
  useEffect(() => {
    if (jumpMessageId === null || jumpMessageLoaded || contentPresentationKind !== "ready") return;
    if (historyForJump?.loading) return;
    if (!historyForJump?.hasMoreHistory || historyForJump.error !== null) {
      finishThreadMessageJump(selectedThreadKey);
      return;
    }
    loadEarlierForJump();
  }, [
    contentPresentationKind,
    historyForJump?.error,
    historyForJump?.hasMoreHistory,
    historyForJump?.loading,
    jumpMessageId,
    jumpMessageLoaded,
    selectedThreadKey,
  ]);
  const hasCompactableConversation =
    selectedThreadFeed.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        ((entry.message.attachments?.length ?? 0) > 0 ||
          entry.message.text.trim().toLowerCase() !== "/compact"),
    ) ||
    (props.historyControls?.hasMoreHistory === true &&
      props.selectedThread.latestUserMessageAt !== null);
  const composerOverlapHeight =
    composerHeight ?? COMPOSER_COLLAPSED_CHROME + (hasSidebarTabBar ? 14 : 0) + composerBottomInset;
  const [collapsedUserInputRequestId, setCollapsedUserInputRequestId] =
    useState<RuntimeRequestId | null>(null);
  const activeUserInputRequestId = props.activePendingUserInput?.requestId ?? null;
  const composerSlotHidden =
    activeUserInputRequestId !== null || props.creationState?.kind === "failed";
  const [usageLimitsPanel, setUsageLimitsPanel] = useState<{
    readonly key: string;
    readonly threadKey: string;
    readonly now: number;
  } | null>(null);
  // A pending approval or question is part of the key: once it is answered,
  // from this client or any other, the agent resumes and spends quota.
  const usageLimitsKey = [
    selectedThreadKey,
    props.selectedThread.modelSelection.instanceId,
    props.selectedThread.latestRun?.runId ?? "",
    props.activePendingApproval?.requestId ?? props.activePendingUserInput?.requestId ?? "",
  ].join(":");
  if (usageLimitsPanel !== null && usageLimitsPanel.key !== usageLimitsKey) {
    setUsageLimitsPanel(null);
  }
  const usageLimitsReport =
    usageLimitsPanel !== null && usageLimitsPanel.key === usageLimitsKey
      ? collectProviderUsageLimits(
          props.selectedThread.modelSelection.instanceId,
          props.serverConfig?.providers ?? [],
          props.serverConfig?.usageLimitSources ?? [],
          usageLimitsPanel.now,
        )
      : null;
  const showUsageLimits = (report: UsageLimitsReport | null) =>
    setUsageLimitsPanel(
      report === null
        ? null
        : {
            key: usageLimitsKey,
            threadKey: selectedThreadKey,
            now: Date.parse(report.createdAt),
          },
    );
  const dismissUsageLimits = () => setUsageLimitsPanel(null);
  // A send may resolve after navigating away, so only the originating
  // thread's panel is cleared; a panel opened elsewhere in the meantime stays.
  const clearUsageLimitsFor = (threadKey: string) =>
    setUsageLimitsPanel((current) =>
      current !== null && current.threadKey === threadKey ? null : current,
    );
  const userInputCollapsed =
    activeUserInputRequestId !== null && collapsedUserInputRequestId === activeUserInputRequestId;
  // A height React sets from keyboard state lags the sticky translation by a Yoga pass and
  // flashes over the nav header on the way up, so the usage panel reserves the keyboard instead.
  const [lastKnownKeyboardHeight, setLastKnownKeyboardHeight] = useState(0);
  useEffect(() => {
    if (liveKeyboardHeight > 0 && liveKeyboardHeight !== lastKnownKeyboardHeight) {
      setLastKnownKeyboardHeight(liveKeyboardHeight);
    }
  }, [lastKnownKeyboardHeight, liveKeyboardHeight]);
  const reservedKeyboardHeight =
    lastKnownKeyboardHeight > 0 ? lastKnownKeyboardHeight : ESTIMATED_KEYBOARD_HEIGHT;
  // Waiting for a visibility render misses the first keyboard frames.
  const keyboardStickyEnabled =
    Platform.OS === "ios"
      ? deviceType !== "duo-unfolded" || (composerOwnsKeyboard && !sidebarSearchActive)
      : !keyboardStateSuspect;
  const estimatedOverlayHeight = composerOverlapHeight;
  // The overlay's measured height includes the home-indicator inset (the
  // composer pads it), but contentInsetAdjustmentBehavior="automatic" makes
  // UIKit add the safe-area bottom to the content inset AGAIN — leaving a
  // dead strip between the resting content and the composer. Report the
  // overlay height minus the safe area; UIKit adds it back, and ThreadFeed
  // hands LegendList the same delta via contentInsetEndStaticAdjustment so
  // its end-scroll math matches the real resting position.
  const nativeInsetOvercount =
    props.usesAutomaticContentInsets === true && Platform.OS === "ios" ? insets.bottom : 0;
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(
    listRef,
    composerOverlayRef,
    Math.max(0, estimatedOverlayHeight - nativeInsetOvercount),
    -nativeInsetOvercount,
    // The composer already reports its animated height on each layout.
    // Easing these samples again makes the feed trail behind it.
    0,
  );
  // Android lays the screen out below its opaque header and reports a zero
  // header height, so the window height overstates the room by the header.
  const [screenHeight, setScreenHeight] = useState<number | null>(null);
  const handleScreenLayout = useCallback((event: LayoutChangeEvent) => {
    setScreenHeight(event.nativeEvent.layout.height);
  }, []);
  const screenAreaHeight = screenHeight ?? windowHeight;
  // The question card reads the keyboard frame on the UI thread, in the same frame the sticky
  // view translates, so it gets the full height while the keyboard is closed and never crosses
  // the header while the keyboard moves.
  const { height: keyboardTranslation } = useReanimatedKeyboardAnimation();
  const pendingUserInputMaxHeight = useDerivedValue(() =>
    derivePendingUserInputMaxHeight({
      windowHeight: screenAreaHeight,
      keyboardHeight: keyboardStickyEnabled ? -keyboardTranslation.value : 0,
      navigationHeaderHeight,
      composerOverlapHeight: composerBottomInset,
    }),
  );
  // The usage panel stacks with the composer and any approval card, so it gets
  // whatever room they leave below the header. Measured only while it is open
  // so typing in the composer does not re-render the screen.
  const usageLimitsOpen = usageLimitsReport !== null && activeUserInputRequestId === null;
  const [usageLimitsLayout, setUsageLimitsLayout] = useState({ overlay: 0, panel: 0 });
  const handleComposerOverlayLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onComposerLayout(event);
      if (!usageLimitsOpen) return;
      const overlay = event.nativeEvent.layout.height;
      setUsageLimitsLayout((current) =>
        current.overlay === overlay ? current : { ...current, overlay },
      );
    },
    [onComposerLayout, usageLimitsOpen],
  );
  const handleUsageLimitsLayout = useCallback((event: LayoutChangeEvent) => {
    const panel = event.nativeEvent.layout.height;
    setUsageLimitsLayout((current) => (current.panel === panel ? current : { ...current, panel }));
  }, []);
  const overlayBesideUsageLimits =
    usageLimitsLayout.overlay > 0
      ? usageLimitsLayout.overlay - usageLimitsLayout.panel
      : composerOverlapHeight;
  // The floor keeps the close row on screen when the stack below leaves no room at all.
  const usageLimitsMaxHeight = Math.max(
    USAGE_LIMITS_PANEL_MIN_HEIGHT,
    Math.min(
      Math.round(screenAreaHeight * 0.4),
      screenAreaHeight -
        navigationHeaderHeight -
        reservedKeyboardHeight -
        overlayBesideUsageLimits -
        USAGE_LIMITS_PANEL_GAP * 2,
    ),
  );
  const userInputCardProgress = useSharedValue(1);
  const userInputInsetProgress = useSharedValue(1);
  const userInputCardCoverage = useSharedValue(0);
  const composerPopoverHeight = useSharedValue(0);
  const floatingControlCoverage = useSharedValue(
    showFloatingStatus ? FLOATING_WORKING_CONTROL_COVERAGE : 0,
  );
  useEffect(() => {
    floatingControlCoverage.value = withTiming(
      showFloatingStatus ? FLOATING_WORKING_CONTROL_COVERAGE : 0,
      { duration: 180, reduceMotion: ReduceMotion.System },
    );
  }, [floatingControlCoverage, showFloatingStatus]);
  // Android renders the expanded card in-flow (it cannot hit-test the iOS
  // overlay outside the bar's bounds), so its measured overlay height already
  // includes the card — the coverage extra is iOS-only.
  const userInputCoverageApplies = Platform.OS === "ios" && activeUserInputRequestId !== null;
  const combinedContentInsetEndAdjustment = useSharedValue(
    Math.max(0, estimatedOverlayHeight - nativeInsetOvercount),
  );
  useAnimatedReaction(
    () =>
      contentInsetEndAdjustment.value +
      floatingControlCoverage.value +
      (userInputCoverageApplies ? userInputInsetProgress.value * userInputCardCoverage.value : 0),
    (value) => {
      combinedContentInsetEndAdjustment.value = value;
    },
    [userInputCoverageApplies],
  );
  const composerPopoverLift = useDerivedValue(() =>
    withTiming(
      !composerSlotHidden && composerPopoverHeight.value > 0 ? composerPopoverHeight.value + 8 : 0,
      { duration: 180, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System },
    ),
  );
  const floatingControlLift = useDerivedValue(
    () =>
      Math.max(
        userInputCoverageApplies ? userInputCardProgress.value * userInputCardCoverage.value : 0,
        composerPopoverLift.value,
      ),
    [userInputCoverageApplies],
  );
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });
  const reduceMotion = useReducedMotion();
  // Repin timers fire after the render that scheduled them, so they read follow
  // state from the ref the writers below keep in step with it.
  const endFollowEnabledRef = useRef(true);
  const overlayRepinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousWorkingControlStateRef = useRef({
    threadKey: selectedThreadKey,
    visible: false,
  });
  const handleEndFollowEnabledChange = (enabled: boolean) => {
    endFollowEnabledRef.current = enabled;
    setEndFollowEnabled(enabled);
  };
  const scheduleOverlayRepin = (delayMs: number) => {
    if (overlayRepinTimerRef.current !== null) {
      clearTimeout(overlayRepinTimerRef.current);
    }
    overlayRepinTimerRef.current = setTimeout(() => {
      overlayRepinTimerRef.current = null;
      if (!endFollowEnabledRef.current) {
        return;
      }
      void scrollMessageToEnd({ animated: false, closeKeyboard: false }).catch(() => {
        freeze.set(false);
      });
    }, delayMs);
  };
  useEffect(
    () => () => {
      if (overlayRepinTimerRef.current !== null) {
        clearTimeout(overlayRepinTimerRef.current);
      }
    },
    [],
  );
  useEffect(() => {
    const previous = previousWorkingControlStateRef.current;
    const threadChanged = previous.threadKey !== selectedThreadKey;
    const visibilityChanged = previous.visible !== showFloatingStatus;
    previousWorkingControlStateRef.current = {
      threadKey: selectedThreadKey,
      visible: showFloatingStatus,
    };
    if ((!threadChanged && !visibilityChanged) || (threadChanged && !showFloatingStatus)) {
      return;
    }
    // LegendList applies the larger inset but does not re-anchor short
    // followed conversations when this floating coverage changes after the
    // initial load. Re-pin after the finite inset transition; the callback
    // checks follow state again so a user who scrolled up stays put.
    scheduleOverlayRepin(230);
  }, [scheduleOverlayRepin, selectedThreadKey, showFloatingStatus]);
  const handleToggleUserInputCollapsed = () => {
    if (activeUserInputRequestId === null) {
      return;
    }
    if (userInputCollapsed) {
      userInputCardProgress.set(withTiming(1, USER_INPUT_TOGGLE_TIMING));
      userInputInsetProgress.set(withTiming(1, USER_INPUT_TOGGLE_TIMING));
      setCollapsedUserInputRequestId(null);
      scheduleOverlayRepin(USER_INPUT_TOGGLE_DURATION_MS + 50);
    } else {
      Keyboard.dismiss();
      userInputCardProgress.set(withTiming(0, USER_INPUT_TOGGLE_TIMING));
      // Instant: the sinking card still covers the strip being revealed, and
      // animating the inset downward is what drifted the short-content end
      // anchor.
      userInputInsetProgress.set(0);
      setCollapsedUserInputRequestId(activeUserInputRequestId);
      scheduleOverlayRepin(60);
    }
  };
  useEffect(() => {
    userInputCardProgress.set(1);
    userInputInsetProgress.set(1);
  }, [activeUserInputRequestId, userInputCardProgress, userInputInsetProgress]);
  const showContent = props.showContent ?? true;
  const layoutVariant = props.layoutVariant ?? "compact";
  const isSplitLayout = layoutVariant === "split";
  const contentMaxWidth =
    Platform.OS === "android"
      ? ANDROID_READING_MAX_WIDTH
      : isSplitLayout
        ? CHAT_CONTENT_MAX_WIDTH
        : undefined;
  const providerSubagentProvider = props.serverConfig?.providers.find(
    (provider) => provider.instanceId === props.selectedThread.modelSelection.instanceId,
  );
  const providerSubagentModelSlug = providerSubagentProvider
    ? resolveSelectableModel(
        providerSubagentProvider.driver,
        props.selectedThread.modelSelection.model,
        providerSubagentProvider.models,
      )
    : null;
  const providerSubagentCatalogModel = providerSubagentProvider?.models.find(
    (model) => model.slug === providerSubagentModelSlug,
  );
  const workspaceContentWidth = useWorkspaceContentWidth();
  // Clearing animated width can retain the unfolded width after Android resumes folded.
  const composerWidthStyle = useAnimatedStyle(() =>
    isSplitLayout && workspaceContentWidth !== null
      ? {
          width: Math.max(
            0,
            workspaceContentWidth.value - controlInsets.left - controlInsets.right,
          ),
          right: undefined,
        }
      : { width: "auto", right: controlInsets.right },
  );
  const selectedInstanceId = props.selectedThread.modelSelection.instanceId;
  useStreamingHaptics(props.selectedThread.id, props.selectedThreadFeed);
  const selectedProviderSkills = (() => {
    const provider = props.serverConfig?.providers.find(
      (candidate) => candidate.instanceId === selectedInstanceId,
    );
    return provider
      ? resolveProviderSkillsForCwd(provider, props.threadCwd ?? props.projectWorkspaceRoot)
      : [];
  })();

  useLayoutEffect(() => {
    selectedThreadKeyRef.current = selectedThreadKey;
  }, [selectedThreadKey]);

  useEffect(() => {
    setAnchorMessageId(null);
    setSubmittedMessageId(null);
    lastScrolledSubmittedMessageIdRef.current = null;
    endFollowEnabledRef.current = true;
    setEndFollowEnabled(true);
    freeze.set(false);
  }, [freeze, selectedThreadKey]);

  useEffect(() => {
    if (
      submittedMessageId === null ||
      anchorMessageId !== submittedMessageId ||
      lastScrolledSubmittedMessageIdRef.current === submittedMessageId ||
      contentPresentationKind !== "ready" ||
      (!selectedThreadFeed.some(
        (entry) => entry.type === "message" && entry.id === submittedMessageId,
      ) &&
        !props.queuedMessages.some((message) => message.messageId === submittedMessageId))
    ) {
      return;
    }

    const targetThreadKey = selectedThreadKey;
    const frame = requestAnimationFrame(() => {
      if (selectedThreadKeyRef.current !== targetThreadKey) {
        return;
      }
      lastScrolledSubmittedMessageIdRef.current = submittedMessageId;
      // Wait for the keyboard dismissal (started by blur() on send) to finish
      // before scrolling: scrollMessageToEnd freezes keyboard-driven inset
      // updates while it runs, and a close event swallowed by that freeze
      // leaves the keyboard padding permanently applied — overshooting the
      // anchor and leaving a phantom bottom inset once the reply streams in.
      void KeyboardController.dismiss()
        .then(() => {
          if (
            selectedThreadKeyRef.current !== targetThreadKey ||
            lastScrolledSubmittedMessageIdRef.current !== submittedMessageId
          ) {
            return;
          }
          return scrollMessageToEnd({
            animated: !reduceMotion,
            closeKeyboard: false,
          });
        })
        .catch(() => {
          if (
            selectedThreadKeyRef.current !== targetThreadKey ||
            lastScrolledSubmittedMessageIdRef.current !== submittedMessageId
          ) {
            return;
          }
          lastScrolledSubmittedMessageIdRef.current = null;
          freeze.set(false);
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    anchorMessageId,
    submittedMessageId,
    freeze,
    contentPresentationKind,
    props.queuedMessages,
    selectedThreadFeed,
    reduceMotion,
    scrollMessageToEnd,
    selectedThreadKey,
  ]);

  const activePendingApprovalsRef = useRef(props.activePendingApprovals);
  useLayoutEffect(() => {
    activePendingApprovalsRef.current = props.activePendingApprovals;
  }, [props.activePendingApprovals]);
  const handleSendMessage = async (
    followUp?: ActiveTurnComposerAction,
    stillSendable?: () => boolean,
  ) => {
    const targetThreadKey = selectedThreadKey;
    const hasUserMessage = selectedThreadFeed.some(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    // Runs only once the send path has validated the draft and is about to deliver it, so an
    // empty submit, a queued-message edit, or `/feedback` leaves approvals alone.
    const approvalsToDecline = props.activePendingApprovals;
    const declineBeforeDispatch =
      approvalsToDecline.length > 0 && props.activePendingUserInput === null
        ? async (text: string, hasAttachmentsOrContext: boolean) => {
            if (
              selectedThreadKeyRef.current !== targetThreadKey ||
              stillSendable?.() === false ||
              props.respondingApprovalId !== null
            )
              return false;
            const feedbackTarget = approvalsToDecline[0];
            if (feedbackTarget?.supportsFeedback) {
              if (hasAttachmentsOrContext) {
                Dialog.alert(
                  "Approval feedback",
                  "Send approval feedback without attachments or added context.",
                );
                return false;
              }
              return (await sendApprovalFeedback(feedbackTarget, text, props.onRespondToApproval))
                ? ("responded" as const)
                : false;
            }
            return (
              props.respondingApprovalId === null &&
              (await declinePendingApprovals(approvalsToDecline, props.onRespondToApproval)) &&
              selectedThreadKeyRef.current === targetThreadKey &&
              // A draft edited or pasted into during the decline isn't what the user sent.
              stillSendable?.() !== false &&
              // An approval that arrived during the decline would block the redirect; the draft
              // stays so the next send declines it too.
              !activePendingApprovalsRef.current.some(
                (approval) =>
                  !approvalsToDecline.some((declined) => declined.requestId === approval.requestId),
              )
            );
          }
        : undefined;
    const messageId = await props.onSendMessage(followUp, declineBeforeDispatch);
    if (messageId === null || selectedThreadKeyRef.current !== targetThreadKey) {
      return messageId;
    }

    clearUsageLimitsFor(targetThreadKey);

    setSubmittedMessageId(messageId);
    setAnchorMessageId(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: anchorMessageId,
        submittedMessageId: messageId,
        hasStartedTurn: props.selectedThread.latestRun !== null,
        hasUserMessage,
        queuedMessageCount: props.selectedThreadQueueCount,
        deliveryDeferred: props.connectionStateLabel !== "connected",
      }),
    );
    composerEditorRef.current?.blur();
    return messageId;
  };

  const handleEditPendingMessage = async (message: QueuedThreadMessage) => {
    const edited = await settlePromise(() => editPendingThreadMessage(message));
    if (AsyncResult.isFailure(edited)) {
      const error = squashAtomCommandFailure(edited);
      Dialog.alert(
        "Could not edit message",
        error instanceof Error ? error.message : "Please try again.",
      );
      return;
    }
    if (
      edited.value &&
      selectedThreadKeyRef.current === scopedThreadKey(message.environmentId, message.threadId)
    ) {
      composerEditorRef.current?.focus();
    }
  };

  const collapseComposer = () => {
    composerEditorRef.current?.blur();
  };

  const handleUseArtifactTemplate = (template: CodexArtifactTemplate) => {
    const draftMessage =
      props.composerDraftKey === null ? "" : getComposerDraftSnapshot(props.composerDraftKey).text;
    const nextDraft = appendCodexArtifactTemplateUsePrompt(draftMessage, template);
    if (nextDraft !== draftMessage) props.onChangeDraftMessage(nextDraft);
    requestAnimationFrame(() => {
      composerEditorRef.current?.focus();
      composerEditorRef.current?.setSelection({ start: nextDraft.length, end: nextDraft.length });
    });
  };

  const handleScrollToEnd = () => {
    void Haptics.selectionAsync();
    void scrollMessageToEnd({ animated: !reduceMotion, closeKeyboard: false }).catch(() => {
      freeze.set(false);
    });
  };

  const showScrollToEndButton =
    !props.draftMode && contentPresentationKind === "ready" && !endFollowEnabled;
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";

  const handleFeedTouchStart = (event: GestureResponderEvent) => {
    feedTouchStartRef.current = {
      pageX: event.nativeEvent.pageX,
      pageY: event.nativeEvent.pageY,
    };
  };

  const handleFeedTouchMove = (event: GestureResponderEvent) => {
    const start = feedTouchStartRef.current;
    if (!start) {
      return;
    }
    const deltaX = event.nativeEvent.pageX - start.pageX;
    const deltaY = event.nativeEvent.pageY - start.pageY;
    if (Math.hypot(deltaX, deltaY) > 8) {
      feedTouchStartRef.current = null;
    }
  };

  const handleFeedTouchEnd = () => {
    if (feedTouchStartRef.current) {
      collapseComposer();
    }
    feedTouchStartRef.current = null;
  };

  const handleFeedTouchCancel = () => {
    feedTouchStartRef.current = null;
  };

  return (
    <View className="flex-1" onLayout={handleScreenLayout}>
      {!usesNativeWorkspaceColumns ? <NativeLayoutObserver onChange={setScreenMetrics} /> : null}
      <ThreadVisitWatermark
        environmentId={props.environmentId}
        selectedThread={props.selectedThread}
        showContent={showContent && !props.draftMode}
      />
      {props.draftMode ? (
        props.draftMode.content(
          navigationHeaderHeight,
          liveKeyboardHeight + estimatedOverlayHeight + 24,
          screenAreaHeight -
            navigationHeaderHeight -
            liveKeyboardHeight -
            estimatedOverlayHeight -
            24,
        )
      ) : showContent ? (
        <View
          style={{ flex: 1 }}
          onTouchStart={handleFeedTouchStart}
          onTouchMove={handleFeedTouchMove}
          onTouchEnd={handleFeedTouchEnd}
          onTouchCancel={handleFeedTouchCancel}
        >
          <View
            pointerEvents="none"
            className={
              Platform.OS === "android"
                ? "absolute inset-0 bg-thread-canvas"
                : "absolute inset-0 bg-screen"
            }
          />
          <RenderErrorBoundary
            key={selectedThreadKey}
            resetKeys={[props.threadCwd]}
            renderFallback={(fallback) => (
              <RenderFailureView
                {...fallback}
                title="The conversation couldn't be displayed"
                bottomInset={estimatedOverlayHeight}
              />
            )}
          >
            <ThreadFeed
              environmentId={props.environmentId}
              threadId={props.selectedThread.id}
              workspaceRoot={props.threadCwd}
              feed={props.selectedThreadFeed}
              pendingHandoff={props.pendingHandoff}
              worktreeSetup={props.worktreeSetup}
              setupWorkingStartedAt={props.setupWorkingStartedAt}
              queuedMessages={props.queuedMessages}
              dispatchingMessageId={props.dispatchingMessageId}
              // A native subagent has no composer to edit a pending message in;
              // Cancel on the edit banner would discard it.
              onEditPendingMessage={isProviderSubagent ? null : handleEditPendingMessage}
              contentPresentation={props.contentPresentation}
              agentLabel={agentLabel}
              threadTitle={props.selectedThread.title}
              latestRun={props.activityRun}
              activeWorkStartedAt={props.activeWorkStartedAt}
              runlessWorkActive={props.runlessWorkActive ?? false}
              listRef={listRef}
              freeze={freeze}
              anchorMessageId={anchorMessageId}
              jumpToMessageId={jumpMessageLoaded ? jumpMessageId : null}
              onJumpedToMessage={() => finishThreadMessageJump(selectedThreadKey)}
              submittedMessageId={submittedMessageId}
              contentInsetEndAdjustment={combinedContentInsetEndAdjustment}
              keyboardOffset={composerKeyboardOffset}
              contentTopInset={0}
              contentBottomInset={
                estimatedOverlayHeight +
                (showFloatingStatus ? FLOATING_WORKING_CONTROL_COVERAGE : 0)
              }
              contentMaxWidth={contentMaxWidth}
              historyControls={props.historyControls}
              contentSideInsets={nativeMetrics?.safeArea}
              layoutVariant={layoutVariant}
              usesAutomaticContentInsets={props.usesAutomaticContentInsets}
              onHeaderMaterialVisibilityChange={props.onHeaderMaterialVisibilityChange}
              onEndFollowEnabledChange={handleEndFollowEnabledChange}
              skills={selectedProviderSkills}
              onUseArtifactTemplate={handleUseArtifactTemplate}
            />
          </RenderErrorBoundary>
        </View>
      ) : (
        <View className="flex-1" />
      )}

      {showContent ? (
        <ThreadBrowserFloat
          key={selectedThreadKey}
          environmentId={props.environmentId}
          threadId={props.selectedThread.id}
          tabs={browserTabs.tabs}
          loaded={browserTabs.loaded}
          top={navigationHeaderHeight + 8}
          onOpen={openBrowserPreview}
        />
      ) : null}

      {showContent ? (
        <KeyboardStickyView
          enabled={keyboardStickyEnabled}
          pointerEvents="box-none"
          style={{ position: "absolute", bottom: 0, left: 0, right: 0, top: 0 }}
          offset={{ closed: 0, opened: composerKeyboardOffset }}
        >
          <ComposerPopoverHost hidden={composerSlotHidden} popoverHeight={composerPopoverHeight}>
            {/* The fixed sticky host gives this bottom-anchored child a stable
              coordinate space. Its top and height can then animate together
              instead of the auto-sized host jumping to Yoga's destination. */}
            <Animated.View
              pointerEvents="box-none"
              style={[
                {
                  position: "absolute",
                  bottom: controlInsets.bottom,
                  left: controlInsets.left,
                  right: controlInsets.right,
                },
                composerWidthStyle,
              ]}
            >
              {/* No paddingTop here: the overlay's measured height becomes the
                list's bottom inset, so any padding above the pill/composer
                pushes the resting content floor up by the same amount. */}
              <View
                ref={composerOverlayRef}
                onLayout={handleComposerOverlayLayout}
                className="w-full"
              >
                <FloatingWorkingControl
                  colorScheme={isDarkMode ? "dark" : "light"}
                  status={floatingStatus}
                  lift={floatingControlLift}
                  devicePreview={
                    devicePreviews.length > 0
                      ? { count: devicePreviews.length, onPress: openDevicePreview }
                      : null
                  }
                  browserPreview={
                    browserTabs.tabs.length > 0
                      ? { count: browserTabs.tabs.length, onPress: () => openBrowserPreview() }
                      : null
                  }
                  showScrollToEnd={showScrollToEndButton}
                  onScrollToEnd={handleScrollToEnd}
                  agents={agentsSegment}
                  onOpenAgents={() => {
                    Keyboard.dismiss();
                    navigation.navigate("ThreadAgents", {
                      environmentId: props.environmentId,
                      threadId: props.selectedThread.id,
                    });
                  }}
                  queuedCount={queuedCount}
                  onOpenQueue={() => {
                    Keyboard.dismiss();
                    navigation.navigate("ThreadQueue", {
                      environmentId: props.environmentId,
                      threadId: props.selectedThread.id,
                    });
                  }}
                />
                <View className="w-full self-center" style={{ maxWidth: contentMaxWidth }}>
                  {props.queuedRunEdit !== null ? (
                    <Animated.View
                      className="shrink-0"
                      entering={FadeInDown.duration(180)}
                      exiting={FadeOut.duration(120)}
                    >
                      <ComposerQueuedEditBanner
                        saving={props.isSavingQueuedEdit}
                        onCancel={() => {
                          voiceInputSession.cancel(props.composerDraftKey);
                          props.onCancelQueuedRunEdit();
                        }}
                      />
                    </Animated.View>
                  ) : null}
                  <UsageLimitRecoveryCard
                    key={props.selectedThread.latestRun?.runId}
                    thread={props.selectedThread}
                    environmentId={props.environmentId}
                  />
                  <ChatGptUsageLimitNotice
                    key={`chatgpt-limit:${props.selectedThread.latestRun?.runId}`}
                    thread={props.selectedThread}
                  />
                  <ThreadGuestShareBar
                    threadRef={props.selectedThreadDetailRef}
                    canOperateThread={props.canOperateThread}
                  />
                  {props.feedbackSubmissions.map((submission) => (
                    <ComposerFeedback
                      key={submission.id}
                      submission={submission}
                      onDismiss={() => props.onDismissFeedback(submission.id)}
                    />
                  ))}
                  {composerError !== null ? (
                    <Animated.View
                      className="shrink-0"
                      entering={FadeInDown.duration(180)}
                      exiting={FadeOut.duration(120)}
                    >
                      <ComposerErrorNotice
                        message={composerError}
                        onDismiss={() => clearThreadComposerError(selectedThreadKey)}
                      />
                    </Animated.View>
                  ) : null}
                  {usageLimitsReport && activeUserInputRequestId === null ? (
                    <Animated.View
                      className="shrink-0 px-4"
                      style={{ paddingBottom: USAGE_LIMITS_PANEL_GAP }}
                      onLayout={handleUsageLimitsLayout}
                      entering={FadeInDown.duration(220)}
                      exiting={FadeOut.duration(140)}
                    >
                      <ComposerUsageLimits
                        report={usageLimitsReport}
                        environmentId={props.environmentId}
                        maxHeight={usageLimitsMaxHeight}
                        onClose={dismissUsageLimits}
                      />
                    </Animated.View>
                  ) : null}
                  {props.creationState?.kind === "failed" ? (
                    <Animated.View
                      className="shrink-0 px-4"
                      style={{ paddingBottom: composerBottomInset }}
                      entering={FadeInDown.duration(220)}
                      exiting={FadeOut.duration(140)}
                    >
                      <ThreadCreationFailedCard
                        reason={props.creationState.reason}
                        onEditTask={props.creationState.onEditTask}
                      />
                    </Animated.View>
                  ) : null}
                  {props.activePendingApproval || props.activePendingUserInput ? (
                    <Animated.View
                      className="shrink-0 gap-3 px-4 pb-3"
                      style={
                        activeUserInputRequestId !== null
                          ? { paddingBottom: composerBottomInset }
                          : undefined
                      }
                      entering={FadeInDown.duration(220)}
                      exiting={FadeOut.duration(140)}
                    >
                      {props.activePendingApproval ? (
                        <PendingApprovalCard
                          canOperateThread={props.canOperateThread}
                          approval={props.activePendingApproval}
                          respondingApprovalId={props.respondingApprovalId}
                          onRespond={props.onRespondToApproval}
                        />
                      ) : null}
                      {props.activePendingUserInput ? (
                        <PendingUserInputCard
                          canOperateThread={props.canOperateThread}
                          pendingUserInput={props.activePendingUserInput}
                          maxHeight={pendingUserInputMaxHeight}
                          collapsed={userInputCollapsed}
                          onToggleCollapsed={handleToggleUserInputCollapsed}
                          onStopThread={props.onStopThread}
                          cardProgress={userInputCardProgress}
                          cardCoverage={userInputCardCoverage}
                          onInputFocusChange={handleOwnedInputFocusChange}
                          drafts={props.activePendingUserInputDrafts}
                          answers={props.activePendingUserInputAnswers}
                          respondingUserInputId={props.respondingUserInputId}
                          onSelectOption={props.onSelectUserInputOption}
                          onChangeCustomAnswer={props.onChangeUserInputCustomAnswer}
                          onSubmit={props.onSubmitUserInput}
                          onDismiss={props.onDismissUserInput}
                        />
                      ) : null}
                    </Animated.View>
                  ) : null}
                </View>

                <View style={composerSlotHidden ? { display: "none" } : undefined}>
                  {isProviderSubagent ? (
                    <View
                      className="self-center px-3 pt-1.5"
                      style={{
                        width: "100%",
                        maxWidth: contentMaxWidth,
                        paddingBottom: composerBottomInset + 6,
                      }}
                    >
                      <ProviderSubagentBar
                        provider={providerSubagentProvider ?? null}
                        modelLabel={
                          providerSubagentCatalogModel?.name ??
                          formatModelSlugName(props.selectedThread.modelSelection.model)
                        }
                        effortLabel={formatModelSelectionEffort(
                          props.selectedThread.modelSelection,
                          providerSubagentProvider?.models,
                          reportedModelSelection,
                        )}
                        status={props.providerSubagentStatus ?? null}
                        onOpenParent={
                          props.selectedThread.lineage.parentThreadId === null
                            ? null
                            : () =>
                                openLinkedThread({
                                  environmentId: String(props.environmentId),
                                  threadId: String(props.selectedThread.lineage.parentThreadId),
                                })
                        }
                      />
                    </View>
                  ) : (
                    <>
                      <ThreadComposer
                        isDraft={Boolean(props.draftMode)}
                        canOperateThread={props.canOperateThread}
                        reportedModelSelection={reportedModelSelection}
                        editorRef={composerEditorRef}
                        placeholder={
                          props.activePendingApproval
                            ? props.activePendingApproval.supportsFeedback
                              ? "Send feedback to decline this request"
                              : "Send a message to decline and redirect the agent"
                            : "Ask the repo agent, or run a command…"
                        }
                        contentMaxWidth={contentMaxWidth}
                        draftControls={props.draftMode?.controls}
                        connectionState={props.connectionStateLabel}
                        environmentLabel={props.environmentLabel}
                        selectedThread={props.selectedThread}
                        hasCompactableConversation={
                          hasCompactableConversation && !props.isCompacting
                        }
                        serverConfig={props.serverConfig}
                        queueCount={props.selectedThreadQueueCount}
                        activeThreadBusy={props.activeThreadBusy}
                        canStopThread={props.canStopThread}
                        environmentId={props.environmentId}
                        projectCwd={props.threadCwd ?? props.projectWorkspaceRoot}
                        // Follow-ups typed before the server creates the thread wait in
                        // the draft: queueing them against a thread id the server may
                        // still reject would strand them in the outbox.
                        sendBlockedReason={
                          props.draftMode
                            ? props.draftMode.sendBlockedReason
                            : props.creationState?.kind === "preparing" &&
                                !props.creationState.serverOwned
                              ? "Starting the task…"
                              : null
                        }
                        interactionLocked={props.draftMode?.interactionLocked}
                        draftKey={props.composerDraftKey ?? undefined}
                        followUpBehavior={
                          props.activePendingApprovals.length > 0 &&
                          props.activePendingUserInput === null
                            ? "steer"
                            : props.followUpBehavior
                        }
                        canSteerActiveTurn={props.canSteerActiveTurn}
                        hidden={composerSlotHidden}
                        queuedEdit={
                          props.queuedRunEdit === null
                            ? null
                            : {
                                existingAttachments: props.queuedRunEdit.existingAttachments,
                                saving: props.isSavingQueuedEdit,
                                onRemoveExistingAttachment: props.onRemoveQueuedEditAttachment,
                              }
                        }
                        bottomInset={composerBottomInset}
                        onChangeDraftMessage={props.onChangeDraftMessage}
                        onPickDraftMedia={props.onPickDraftMedia}
                        onPickDraftFiles={props.onPickDraftFiles}
                        onNativePasteImages={props.onNativePasteImages}
                        onNativePasteText={props.onNativePasteText}
                        onRemoveDraftImage={props.onRemoveDraftImage}
                        onStopThread={props.onStopThread}
                        onResumeQueue={props.onResumeQueue}
                        onSendMessage={handleSendMessage}
                        onShowUsageLimits={showUsageLimits}
                        canSwitchProvider={props.canSwitchThreadProvider}
                        onUpdateModelSelection={props.onUpdateThreadModelSelection}
                        onUpdateRuntimeMode={props.onUpdateThreadRuntimeMode}
                        onUpdateInteractionMode={props.onUpdateThreadInteractionMode}
                        onHeightChange={setComposerHeight}
                        onEditorFocusChange={handleOwnedInputFocusChange}
                      />
                    </>
                  )}
                </View>
              </View>
            </Animated.View>
          </ComposerPopoverHost>
        </KeyboardStickyView>
      ) : null}
    </View>
  );
};

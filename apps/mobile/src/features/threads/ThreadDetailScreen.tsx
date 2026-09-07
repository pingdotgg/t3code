import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  appendCodexArtifactTemplateUsePrompt,
  type CodexArtifactTemplate,
} from "@t3tools/client-runtime/codex-artifact-templates";
import type {
  CodexFeedbackSubmission,
  EnvironmentThreadStatus,
} from "@t3tools/client-runtime/state/threads";
import { useKeyboardChatComposerInset, useKeyboardScrollToEnd } from "@legendapp/list/keyboard";
import { resolveProviderSkillsForCwd } from "@t3tools/client-runtime/providerSkills";
import type { LegendListRef } from "@legendapp/list/react-native";
import { HeaderHeightContext } from "@react-navigation/elements";
import type {
  ApprovalRequestId,
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationThreadShell,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
  ThreadId,
  UsageLimitsReport,
  UserInputQuestion,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppState,
  Keyboard,
  Platform,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
} from "react-native";
import {
  KeyboardController,
  KeyboardStickyView,
  useKeyboardState,
} from "react-native-keyboard-controller";
import Animated, {
  Easing,
  FadeInDown,
  FadeOut,
  ReduceMotion,
  useAnimatedReaction,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { collectProviderUsageLimits } from "@t3tools/shared/usageLimits";
import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import type { StatusTone } from "../../components/StatusPill";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import { CHAT_CONTENT_MAX_WIDTH, type LayoutVariant } from "../../lib/layout";
import { IOS_NAV_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { scopedThreadKey } from "../../lib/scopedEntities";
import type {
  PendingApproval,
  PendingUserInput,
  PendingUserInputDraftAnswer,
  ThreadFeedEntry,
} from "../../lib/threadActivity";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { ComposerFeedback } from "./ComposerFeedback";
import { ComposerUsageLimits } from "./ComposerUsageLimits";
import { PendingUserInputCard } from "./PendingUserInputCard";
import {
  FLOATING_WORKING_CONTROL_COVERAGE,
  FloatingWorkingControl,
  type FloatingWorkingStatus,
} from "./floating-working-control";
import {
  derivePendingUserInputMaxHeight,
  ESTIMATED_KEYBOARD_HEIGHT,
  USER_INPUT_TOGGLE_DURATION_MS,
} from "./pendingUserInputLayout";
import {
  COMPOSER_COLLAPSED_CHROME,
  COMPOSER_EXPANDED_CHROME,
  COMPOSER_LAYOUT_TRANSITION,
  COMPOSER_TRANSITION_DURATION_MS,
  ThreadComposer,
} from "./ThreadComposer";
import { ThreadFeed } from "./ThreadFeed";
import { resolveThreadStatus } from "./threadPresentation";
import type { ThreadContentPresentation } from "./threadContentPresentation";
import { resolveThreadFeedSubmissionAnchor } from "./thread-feed-live-follow";

export interface ThreadDetailScreenProps {
  readonly selectedThread: OrchestrationThreadShell;
  readonly contentPresentation: ThreadContentPresentation;
  readonly screenTone: StatusTone;
  readonly connectionError: string | null;
  readonly environmentLabel: string | null;
  readonly feedbackSubmissions: ReadonlyArray<CodexFeedbackSubmission>;
  readonly onDismissFeedback: (id: MessageId) => void;
  readonly selectedThreadFeed: ReadonlyArray<ThreadFeedEntry>;
  readonly activeWorkStartedAt: string | null;
  readonly isCompacting: boolean;
  readonly activePendingApproval: PendingApproval | null;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activePendingUserInputDrafts: Record<string, PendingUserInputDraftAnswer>;
  readonly activePendingUserInputAnswers: Record<string, string | ReadonlyArray<string>> | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerAttachment>;
  readonly connectionStateLabel: EnvironmentConnectionPhase;
  /** Message sync status for the selected thread (drives the composer status pill). */
  readonly threadSyncStatus?: EnvironmentThreadStatus;
  /** Non-null when older turns exist beyond the loaded window. */
  readonly loadEarlier?: { readonly loading: boolean; readonly onLoadEarlier: () => void } | null;
  readonly environmentId: EnvironmentId;
  readonly projectWorkspaceRoot: string | null;
  readonly threadCwd: string | null;
  readonly selectedThreadQueueCount: number;
  readonly serverConfig: T3ServerConfig | null;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly onOpenConnectionEditor: () => void;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftMedia: () => Promise<void>;
  readonly onPickDraftFiles: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  readonly onSendMessage: () => Promise<MessageId | null>;
  readonly onReconnectEnvironment: () => void;
  readonly onUpdateThreadModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateThreadRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateThreadInteractionMode: (interactionMode: ProviderInteractionMode) => void;
  readonly onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  readonly onSelectUserInputOption: (
    requestId: ApprovalRequestId,
    question: UserInputQuestion,
    value: string,
  ) => void;
  readonly onChangeUserInputCustomAnswer: (
    requestId: ApprovalRequestId,
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

const USER_INPUT_TOGGLE_TIMING = {
  duration: USER_INPUT_TOGGLE_DURATION_MS,
  easing: Easing.out(Easing.cubic),
};

export const ThreadDetailScreen = memo(function ThreadDetailScreen(props: ThreadDetailScreenProps) {
  const insets = useSafeAreaInsets();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const liveKeyboardHeight = useKeyboardState((state) => state.height);
  // Android can swallow the IME hide callbacks when the app is backgrounded
  // mid keyboard-hide (the reported repro: send — which blurs and starts the
  // hide — then Home within a second). The keyboard library's height AND
  // visibility then stay frozen open, so gating the sticky translation on
  // visibility alone still strands the composer after resume. Quarantine the
  // translation on every Android resume instead; any sign of a live keyboard
  // stream — an owned input gaining focus, or any visibility/height movement —
  // lifts it. A healthy resume sees no visual difference (the translation is
  // already zero while the keyboard is closed).
  const [keyboardStateSuspect, setKeyboardStateSuspect] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setKeyboardStateSuspect(true);
      }
    });
    return () => {
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    setKeyboardStateSuspect(false);
  }, [isKeyboardVisible, liveKeyboardHeight]);
  const handleOwnedInputFocusChange = useCallback((focused: boolean) => {
    if (focused) {
      setKeyboardStateSuspect(false);
    }
  }, []);
  const windowHeight = useWindowDimensions().height;
  const navigationHeaderHeight = useContext(HeaderHeightContext) || insets.top + IOS_NAV_BAR_HEIGHT;
  const agentLabel = `${props.selectedThread.modelSelection.instanceId} agent`;
  const selectedThreadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
  const composerEditorRef = useRef<ComposerEditorHandle>(null);
  const draftMessageRef = useRef(props.draftMessage);
  draftMessageRef.current = props.draftMessage;
  const composerOverlayRef = useRef<View>(null);
  const listRef = useRef<LegendListRef>(null);
  const feedTouchStartRef = useRef<{ pageX: number; pageY: number } | null>(null);
  const selectedThreadKeyRef = useRef(selectedThreadKey);
  const lastScrolledSubmittedMessageIdRef = useRef<MessageId | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const handleComposerFocusChange = useCallback(
    (focused: boolean) => {
      setComposerFocused(focused);
      handleOwnedInputFocusChange(focused);
    },
    [handleOwnedInputFocusChange],
  );
  const [anchorMessageId, setAnchorMessageId] = useState<MessageId | null>(null);
  const [submittedMessageId, setSubmittedMessageId] = useState<MessageId | null>(null);
  const [endFollowEnabled, setEndFollowEnabled] = useState(true);
  // Android keys the safe-area padding on keyboard visibility (#5988): the
  // back gesture closes the keyboard while the editor stays focused, and a
  // focus-keyed inset would leave the toolbar under the gesture bar. iOS must
  // NOT use visibility — it only flips on keyboardDidHide, after the hide
  // animation, so the composer would ride down flush to the screen edge and
  // then snap up into the inset. On iOS blur precedes the hide, so the
  // focus-keyed inset is already in place while the composer rides down.
  // Dictation keeps that focus while the composer switches to its compact pill.
  const composerBottomInset = (
    Platform.OS === "android" ? isKeyboardVisible : composerExpanded || composerFocused
  )
    ? 0
    : Math.max(insets.bottom, 12);
  const contentPresentationKind = props.contentPresentation.kind;
  // The raw sync status enters "synchronizing" on every full fetch, cached or
  // not. Whether messages are already on screen decides the pill label: no
  // data yet → "Loading messages", cached data reconciling → "Syncing".
  const threadSyncLabel = (() => {
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
  // One floating pill above the composer: it reads the sync state while
  // messages load, then the working timer once the feed is settled.
  const floatingStatus = ((): FloatingWorkingStatus | null => {
    if (
      props.connectionStateLabel !== "connected" ||
      props.activePendingApproval !== null ||
      props.activePendingUserInput !== null
    ) {
      return null;
    }
    if (threadSyncLabel !== null) {
      return { kind: "syncing", label: threadSyncLabel };
    }
    if (props.isCompacting && contentPresentationKind === "ready") {
      return { kind: "compacting" };
    }
    if (props.activeWorkStartedAt !== null && contentPresentationKind === "ready") {
      return { kind: "working", startedAt: props.activeWorkStartedAt };
    }
    if (contentPresentationKind === "ready") {
      const status = resolveThreadStatus(props.selectedThread);
      if (status?.kind === "monitoring" || status?.kind === "working") {
        return { kind: "background", label: status.label };
      }
    }
    return null;
  })();
  const showWorkingControl = floatingStatus !== null;
  const selectedThreadFeed = props.selectedThreadFeed;
  const hasCompactableConversation =
    selectedThreadFeed.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        ((entry.message.attachments?.length ?? 0) > 0 ||
          entry.message.text.trim().toLowerCase() !== "/compact"),
    ) ||
    (Boolean(props.loadEarlier) && props.selectedThread.latestUserMessageAt !== null);
  const composerChrome = composerExpanded ? COMPOSER_EXPANDED_CHROME : COMPOSER_COLLAPSED_CHROME;
  const composerOverlapHeight = composerChrome + composerBottomInset;
  // While a user-input request is pending, the questionnaire owns the
  // composer slot outright: expanded it is the full card, collapsed it is a
  // composer-style bar in the same place (with its own stop control). The
  // composer never mounts into the transition, which keeps the collapse and
  // keyboard animations coherent. Collapse state is keyed by request id so a
  // new request re-expands automatically.
  const [collapsedUserInputRequestId, setCollapsedUserInputRequestId] =
    useState<ApprovalRequestId | null>(null);
  const activeUserInputRequestId = props.activePendingUserInput?.requestId ?? null;
  // The open /usage-limits panel for this thread, model and turn. Only the open
  // moment is stored: the rows read live provider data, so a redeemed reset
  // credit or refreshed probe shows through. Anything that spends quota closes
  // it: a new turn from any source, or the agent resuming after an approval or
  // answered question.
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
    props.selectedThread.latestTurn?.turnId ?? "",
    props.activePendingApproval?.requestId ?? props.activePendingUserInput?.requestId ?? "",
  ].join(":");
  // Drop the snapshot as soon as the key changes so it cannot resurface stale.
  if (usageLimitsPanel !== null && usageLimitsPanel.key !== usageLimitsKey) {
    setUsageLimitsPanel(null);
  }
  const usageLimitsReport = useMemo(
    () =>
      usageLimitsPanel !== null && usageLimitsPanel.key === usageLimitsKey
        ? collectProviderUsageLimits(
            props.selectedThread.modelSelection.instanceId,
            props.serverConfig?.providers ?? [],
            props.serverConfig?.usageLimitSources ?? [],
            usageLimitsPanel.now,
          )
        : null,
    [
      props.selectedThread.modelSelection.instanceId,
      props.serverConfig,
      usageLimitsKey,
      usageLimitsPanel,
    ],
  );
  const showUsageLimits = useCallback(
    (report: UsageLimitsReport | null) =>
      setUsageLimitsPanel(
        report === null
          ? null
          : {
              key: usageLimitsKey,
              threadKey: selectedThreadKey,
              now: Date.parse(report.createdAt),
            },
      ),
    [selectedThreadKey, usageLimitsKey],
  );
  const dismissUsageLimits = useCallback(() => setUsageLimitsPanel(null), []);
  // A send may resolve after navigating away, so only the originating
  // thread's panel is cleared; a panel opened elsewhere in the meantime stays.
  const clearUsageLimitsFor = useCallback(
    (threadKey: string) =>
      setUsageLimitsPanel((current) =>
        current !== null && current.threadKey === threadKey ? null : current,
      ),
    [],
  );
  const userInputCollapsed =
    activeUserInputRequestId !== null && collapsedUserInputRequestId === activeUserInputRequestId;
  // The card's height RESERVES keyboard space at all times instead of
  // tracking the keyboard: transforms (the sticky translation) apply
  // same-frame on the UI thread while layout props lag a Yoga pass behind,
  // so any height that follows the keyboard flashes the card over the nav
  // header on the way up. With a constant height the keyboard transition is
  // pure translation — frame-perfect by construction — and the resting card
  // stays compact over the transcript. Before the first open the reserve is
  // an estimate; once a real height is known the card corrects once,
  // discretely.
  const [lastKnownKeyboardHeight, setLastKnownKeyboardHeight] = useState(0);
  useEffect(() => {
    if (liveKeyboardHeight > 0 && liveKeyboardHeight !== lastKnownKeyboardHeight) {
      setLastKnownKeyboardHeight(liveKeyboardHeight);
    }
  }, [lastKnownKeyboardHeight, liveKeyboardHeight]);
  const pendingUserInputMaxHeight = derivePendingUserInputMaxHeight({
    windowHeight,
    keyboardHeight:
      lastKnownKeyboardHeight > 0 ? lastKnownKeyboardHeight : ESTIMATED_KEYBOARD_HEIGHT,
    navigationHeaderHeight,
    // The questionnaire owns the composer slot, so only the composer's
    // bottom inset still overlaps.
    composerOverlapHeight: composerBottomInset,
  });
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
    Platform.OS === "ios" ? COMPOSER_TRANSITION_DURATION_MS : 0,
  );
  // The expanded questionnaire is an absolute overlay on iOS, so it never
  // changes the measured overlay height (that constancy is what keeps the
  // feed from snapping on collapse/expand). The toggle choreography runs on
  // SHARED VALUES set directly in the tap handler — one JS hop, then the
  // card's rise/sink and the feed's end-inset glide animate in lockstep on
  // the UI thread, keyboard-style, instead of waiting on React mount +
  // onLayout + state round trips. Coverage (how far the card extends above
  // the bar) is measured straight into a shared value by the card's
  // onLayout, with no re-render.
  const userInputCardProgress = useSharedValue(1);
  const userInputInsetProgress = useSharedValue(1);
  const userInputCardCoverage = useSharedValue(0);
  const floatingControlCoverage = useSharedValue(
    showWorkingControl ? FLOATING_WORKING_CONTROL_COVERAGE : 0,
  );
  useEffect(() => {
    floatingControlCoverage.value = withTiming(
      showWorkingControl ? FLOATING_WORKING_CONTROL_COVERAGE : 0,
      { duration: 180, reduceMotion: ReduceMotion.System },
    );
  }, [floatingControlCoverage, showWorkingControl]);
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
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });
  const endFollowEnabledRef = useRef(true);
  endFollowEnabledRef.current = endFollowEnabled;
  const overlayRepinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousWorkingControlStateRef = useRef({
    threadKey: selectedThreadKey,
    visible: false,
  });
  // The list's own corrections for these inset changes drift on short
  // content (and the error compounds across toggles), so deterministically
  // re-pin the end once a toggle settles: a no-op when the resting position
  // is already right, corrective when it is not. Follow state is re-checked
  // inside the callback — the user may grab the list during the settle
  // window, and yanking them back would override a live gesture.
  const scheduleOverlayRepin = useCallback(
    (delayMs: number) => {
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
    },
    [freeze, scrollMessageToEnd],
  );
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
    const visibilityChanged = previous.visible !== showWorkingControl;
    previousWorkingControlStateRef.current = {
      threadKey: selectedThreadKey,
      visible: showWorkingControl,
    };
    if ((!threadChanged && !visibilityChanged) || (threadChanged && !showWorkingControl)) {
      return;
    }
    // LegendList applies the larger inset but does not re-anchor short
    // followed conversations when this floating coverage changes after the
    // initial load. Re-pin after the finite inset transition; the callback
    // checks follow state again so a user who scrolled up stays put.
    scheduleOverlayRepin(230);
  }, [scheduleOverlayRepin, selectedThreadKey, showWorkingControl]);
  const handleToggleUserInputCollapsed = useCallback(() => {
    if (activeUserInputRequestId === null) {
      return;
    }
    if (userInputCollapsed) {
      // Expanding: card and feed glide start NOW, on the UI thread.
      userInputCardProgress.value = withTiming(1, USER_INPUT_TOGGLE_TIMING);
      userInputInsetProgress.value = withTiming(1, USER_INPUT_TOGGLE_TIMING);
      setCollapsedUserInputRequestId(null);
      scheduleOverlayRepin(USER_INPUT_TOGGLE_DURATION_MS + 50);
    } else {
      // Collapsing hides the custom-answer inputs; release the keyboard with
      // them instead of leaving it up over a dead responder.
      Keyboard.dismiss();
      userInputCardProgress.value = withTiming(0, USER_INPUT_TOGGLE_TIMING);
      // Instant: the sinking card still covers the strip being revealed, and
      // animating the inset downward is what drifted the short-content end
      // anchor.
      userInputInsetProgress.value = 0;
      setCollapsedUserInputRequestId(activeUserInputRequestId);
      scheduleOverlayRepin(60);
    }
  }, [
    activeUserInputRequestId,
    scheduleOverlayRepin,
    userInputCardProgress,
    userInputCollapsed,
    userInputInsetProgress,
  ]);
  useEffect(() => {
    // A new request always arrives expanded.
    userInputCardProgress.value = 1;
    userInputInsetProgress.value = 1;
  }, [activeUserInputRequestId, userInputCardProgress, userInputInsetProgress]);
  const showContent = props.showContent ?? true;
  const layoutVariant = props.layoutVariant ?? "compact";
  const isSplitLayout = layoutVariant === "split";
  const contentMaxWidth = isSplitLayout ? CHAT_CONTENT_MAX_WIDTH : undefined;
  const selectedInstanceId = props.selectedThread.modelSelection.instanceId;
  useStreamingHaptics(props.selectedThread.id, props.selectedThreadFeed);
  const selectedProviderSkills = useMemo(() => {
    const provider = props.serverConfig?.providers.find(
      (candidate) => candidate.instanceId === selectedInstanceId,
    );
    return provider
      ? resolveProviderSkillsForCwd(provider, props.threadCwd ?? props.projectWorkspaceRoot)
      : [];
  }, [props.projectWorkspaceRoot, props.serverConfig, props.threadCwd, selectedInstanceId]);

  useLayoutEffect(() => {
    selectedThreadKeyRef.current = selectedThreadKey;
    // A replaced or unmounted native editor may not emit a blur event.
    setComposerFocused(false);
  }, [selectedThreadKey, showContent]);

  useEffect(() => {
    setAnchorMessageId(null);
    setSubmittedMessageId(null);
    lastScrolledSubmittedMessageIdRef.current = null;
    setEndFollowEnabled(true);
    freeze.set(false);
  }, [freeze, selectedThreadKey]);

  useEffect(() => {
    if (
      submittedMessageId === null ||
      lastScrolledSubmittedMessageIdRef.current === submittedMessageId ||
      contentPresentationKind !== "ready" ||
      !selectedThreadFeed.some(
        (entry) => entry.type === "message" && entry.id === submittedMessageId,
      )
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
          return scrollMessageToEnd({ animated: true, closeKeyboard: false });
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
    submittedMessageId,
    freeze,
    contentPresentationKind,
    selectedThreadFeed,
    scrollMessageToEnd,
    selectedThreadKey,
  ]);

  const handleSendMessage = useCallback(async () => {
    const targetThreadKey = selectedThreadKey;
    const hasUserMessage = selectedThreadFeed.some(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    const messageId = await props.onSendMessage();
    if (messageId === null || selectedThreadKeyRef.current !== targetThreadKey) {
      return messageId;
    }

    // A sent message makes the snapshot stale; a refused send leaves it in place.
    clearUsageLimitsFor(targetThreadKey);

    setSubmittedMessageId(messageId);
    setAnchorMessageId(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: anchorMessageId,
        submittedMessageId: messageId,
        hasStartedTurn: props.selectedThread.latestTurn !== null,
        hasUserMessage,
        queuedMessageCount: props.selectedThreadQueueCount,
      }),
    );
    composerEditorRef.current?.blur();
    return messageId;
  }, [
    anchorMessageId,
    clearUsageLimitsFor,
    props.onSendMessage,
    props.selectedThread.latestTurn,
    props.selectedThreadQueueCount,
    selectedThreadFeed,
    selectedThreadKey,
  ]);

  const collapseComposer = useCallback(() => {
    composerEditorRef.current?.blur();
  }, []);

  const handleUseArtifactTemplate = useCallback(
    (template: CodexArtifactTemplate) => {
      const currentDraft = draftMessageRef.current;
      const nextDraft = appendCodexArtifactTemplateUsePrompt(currentDraft, template);
      if (nextDraft !== currentDraft) {
        draftMessageRef.current = nextDraft;
        props.onChangeDraftMessage(nextDraft);
      }
      requestAnimationFrame(() => {
        composerEditorRef.current?.focus();
        composerEditorRef.current?.setSelection({ start: nextDraft.length, end: nextDraft.length });
      });
    },
    [props.onChangeDraftMessage],
  );

  const handleScrollToEnd = useCallback(() => {
    void Haptics.selectionAsync();
    void scrollMessageToEnd({ animated: true, closeKeyboard: false }).catch(() => {
      freeze.set(false);
    });
  }, [freeze, scrollMessageToEnd]);

  const showScrollToEndButton = contentPresentationKind === "ready" && !endFollowEnabled;
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";

  const handleFeedTouchStart = useCallback((event: GestureResponderEvent) => {
    feedTouchStartRef.current = {
      pageX: event.nativeEvent.pageX,
      pageY: event.nativeEvent.pageY,
    };
  }, []);

  const handleFeedTouchMove = useCallback((event: GestureResponderEvent) => {
    const start = feedTouchStartRef.current;
    if (!start) {
      return;
    }
    const deltaX = event.nativeEvent.pageX - start.pageX;
    const deltaY = event.nativeEvent.pageY - start.pageY;
    if (Math.hypot(deltaX, deltaY) > 8) {
      feedTouchStartRef.current = null;
    }
  }, []);

  const handleFeedTouchEnd = useCallback(() => {
    if (feedTouchStartRef.current) {
      collapseComposer();
    }
    feedTouchStartRef.current = null;
  }, [collapseComposer]);

  const handleFeedTouchCancel = useCallback(() => {
    feedTouchStartRef.current = null;
  }, []);

  return (
    <View className="flex-1">
      {showContent ? (
        <View
          className="flex-1"
          onTouchStart={handleFeedTouchStart}
          onTouchMove={handleFeedTouchMove}
          onTouchEnd={handleFeedTouchEnd}
          onTouchCancel={handleFeedTouchCancel}
        >
          <ThreadFeed
            key={selectedThreadKey}
            environmentId={props.environmentId}
            threadId={props.selectedThread.id}
            workspaceRoot={props.threadCwd}
            feed={props.selectedThreadFeed}
            contentPresentation={props.contentPresentation}
            agentLabel={agentLabel}
            latestTurn={props.selectedThread.latestTurn}
            activeWorkStartedAt={props.activeWorkStartedAt}
            listRef={listRef}
            freeze={freeze}
            anchorMessageId={anchorMessageId}
            submittedMessageId={submittedMessageId}
            contentInsetEndAdjustment={combinedContentInsetEndAdjustment}
            contentTopInset={0}
            contentBottomInset={
              estimatedOverlayHeight + (showWorkingControl ? FLOATING_WORKING_CONTROL_COVERAGE : 0)
            }
            contentMaxWidth={contentMaxWidth}
            layoutVariant={layoutVariant}
            usesAutomaticContentInsets={props.usesAutomaticContentInsets}
            onHeaderMaterialVisibilityChange={props.onHeaderMaterialVisibilityChange}
            onEndFollowEnabledChange={setEndFollowEnabled}
            skills={selectedProviderSkills}
            onUseArtifactTemplate={handleUseArtifactTemplate}
            loadEarlier={props.loadEarlier ?? null}
          />
        </View>
      ) : (
        <View className="flex-1" />
      )}

      {/* Floating composer — sticks to keyboard via KeyboardStickyView */}
      {showContent ? (
        <KeyboardStickyView
          // iOS emits a native animated height target on both will-show and
          // will-hide, so stay subscribed for the full transition. Android
          // retains its background/resume stale-state quarantine.
          enabled={Platform.OS === "ios" || (isKeyboardVisible && !keyboardStateSuspect)}
          pointerEvents="box-none"
          style={{ position: "absolute", bottom: 0, left: 0, right: 0, top: 0 }}
          offset={{ closed: 0, opened: 0 }}
        >
          {/* The fixed sticky host gives this bottom-anchored child a stable
              coordinate space. Its top and height can then animate together
              instead of the auto-sized host jumping to Yoga's destination. */}
          <Animated.View
            layout={COMPOSER_LAYOUT_TRANSITION}
            pointerEvents="box-none"
            style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
          >
            {/* No paddingTop here: the overlay's measured height becomes the
                list's bottom inset, so any padding above the pill/composer
                pushes the resting content floor up by the same amount. */}
            <View ref={composerOverlayRef} onLayout={onComposerLayout} className="w-full">
              <FloatingWorkingControl
                colorScheme={isDarkMode ? "dark" : "light"}
                status={floatingStatus}
                showScrollToEnd={showScrollToEndButton}
                onScrollToEnd={handleScrollToEnd}
              />
              <View className="w-full self-center" style={{ maxWidth: contentMaxWidth }}>
                {props.feedbackSubmissions.map((submission) => (
                  <ComposerFeedback
                    key={submission.id}
                    submission={submission}
                    onDismiss={() => props.onDismissFeedback(submission.id)}
                  />
                ))}
                {usageLimitsReport && activeUserInputRequestId === null ? (
                  <Animated.View
                    className="shrink-0 px-4 pb-3"
                    entering={FadeInDown.duration(220)}
                    exiting={FadeOut.duration(140)}
                  >
                    <ComposerUsageLimits
                      report={usageLimitsReport}
                      environmentId={props.environmentId}
                      onClose={dismissUsageLimits}
                    />
                  </Animated.View>
                ) : null}
                {props.activePendingApproval || props.activePendingUserInput ? (
                  <Animated.View
                    className="shrink-0 gap-3 px-4 pb-3"
                    // The questionnaire replaces the composer, so it must pad
                    // the home indicator the composer normally covers.
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
                        approval={props.activePendingApproval}
                        respondingApprovalId={props.respondingApprovalId}
                        onRespond={props.onRespondToApproval}
                      />
                    ) : null}
                    {props.activePendingUserInput ? (
                      <PendingUserInputCard
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

              {/* Hidden (not unmounted) while a user-input request owns the
                composer slot, so composer drafts and editor state survive. */}
              <View style={activeUserInputRequestId !== null ? { display: "none" } : undefined}>
                <ThreadComposer
                  editorRef={composerEditorRef}
                  draftMessage={props.draftMessage}
                  draftAttachments={props.draftAttachments}
                  placeholder="Ask the repo agent, or run a command…"
                  contentMaxWidth={contentMaxWidth}
                  connectionState={props.connectionStateLabel}
                  connectionError={props.connectionError}
                  environmentLabel={props.environmentLabel}
                  selectedThread={props.selectedThread}
                  hasCompactableConversation={hasCompactableConversation && !props.isCompacting}
                  serverConfig={props.serverConfig}
                  queueCount={props.selectedThreadQueueCount}
                  environmentId={props.environmentId}
                  projectCwd={props.threadCwd ?? props.projectWorkspaceRoot}
                  bottomInset={composerBottomInset}
                  onChangeDraftMessage={props.onChangeDraftMessage}
                  onPickDraftMedia={props.onPickDraftMedia}
                  onPickDraftFiles={props.onPickDraftFiles}
                  onNativePasteImages={props.onNativePasteImages}
                  onRemoveDraftImage={props.onRemoveDraftImage}
                  onStopThread={props.onStopThread}
                  onSendMessage={handleSendMessage}
                  onShowUsageLimits={showUsageLimits}
                  onReconnectEnvironment={props.onReconnectEnvironment}
                  onUpdateModelSelection={props.onUpdateThreadModelSelection}
                  onUpdateRuntimeMode={props.onUpdateThreadRuntimeMode}
                  onUpdateInteractionMode={props.onUpdateThreadInteractionMode}
                  onExpandedChange={setComposerExpanded}
                  onEditorFocusChange={handleComposerFocusChange}
                />
              </View>
            </View>
          </Animated.View>
        </KeyboardStickyView>
      ) : null}
    </View>
  );
});

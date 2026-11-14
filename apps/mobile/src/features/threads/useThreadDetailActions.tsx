import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomMount } from "@effect/atom-react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { queuedRunEditBlockedReason } from "@t3tools/client-runtime/queued-run-edit";
import { useKeyboardChatComposerInset, useKeyboardScrollToEnd } from "@legendapp/list/keyboard";
import { resolveProviderSkillsForCwd } from "@t3tools/client-runtime/providerSkills";
import type { RuntimeRequestId, UsageLimitsReport } from "@t3tools/contracts";
import { appendCodexArtifactTemplateUsePrompt, type CodexArtifactTemplate } from "@t3tools/shared/codexArtifactTemplates";
import { declinePendingApprovals, sendApprovalFeedback } from "@t3tools/client-runtime/state/thread-requests";
import { resolveSelectableModel } from "@t3tools/shared/model";
import type { ActiveTurnComposerAction } from "@t3tools/client-runtime/state/composer-dispatch";
import * as Haptics from "expo-haptics";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { Keyboard, Platform, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import { KeyboardController, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { Easing, ReduceMotion, runOnJS, useAnimatedReaction, useAnimatedStyle, useDerivedValue, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { useWorkspaceContentWidth } from "../layout/workspace-content-width";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { collectProviderUsageLimits } from "@t3tools/shared/usageLimits";
import { getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { ANDROID_READING_MAX_WIDTH, CHAT_CONTENT_MAX_WIDTH } from "../../lib/layout";
import { editPendingThreadMessage } from "../../state/edit-pending-thread-message";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { finishThreadMessageJump, pendingThreadMessageJump, subscribeThreadMessageJump } from "./threadMessageJump";
import { environmentThreadDetails } from "../../state/threads";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadStreamHaptics } from "./threadStreamHaptics";
import { FLOATING_WORKING_CONTROL_COVERAGE } from "./floating-working-control";
import { derivePendingUserInputMaxHeight, ESTIMATED_KEYBOARD_HEIGHT, USER_INPUT_TOGGLE_DURATION_MS } from "./pendingUserInputLayout";
import { COMPOSER_COLLAPSED_CHROME } from "./ThreadComposer";
import { ThreadFeed } from "./ThreadFeed";
import { resolveThreadFeedSubmissionAnchor } from "./thread-feed-live-follow";
import type { ThreadDetailBodyProps } from "./ThreadDetailScreenParts";
import {
  USAGE_LIMITS_PANEL_GAP,
  USAGE_LIMITS_PANEL_MIN_HEIGHT,
  USER_INPUT_TOGGLE_TIMING,
  threadVisitTracker,
} from "./ThreadDetailScreenShared";
import type { useThreadDetailState } from "./useThreadDetailState";
export function useThreadDetailActions(
  input: ReturnType<typeof useThreadDetailState> & { readonly props: ThreadDetailBodyProps },
) {
  const { props } = input;
  const {
    anchorMessageId,
    composerBottomInset,
    composerEditorRef,
    composerHeight,
    composerHeightSettle,
    composerOverlayRef,
    composerOwnsKeyboard,
    contentPresentationKind,
    controlInsets,
    deviceType,
    endFollowEnabled,
    feedRef,
    feedTouchStartRef,
    hasSidebarTabBar,
    insets,
    isProviderSubagent,
    keyboardStateSuspect,
    layout,
    listRef,
    liveKeyboardHeight,
    navigationHeaderHeight,
    selectedThreadKey,
    setAnchorMessageId,
    setEndFollowEnabled,
    setSendingWithKeyboard,
    showFloatingStatus,
    sidebarSearchActive,
    threadScope,
    resetThreadScope,
    windowHeight,
  } = input;

  const selectedThreadFeed = props.selectedThreadFeed;
  // A palette message result opens the thread at that message: earlier
  // history loads until the message is in the feed, which then scrolls to it.
  const jumpMessageId = useSyncExternalStore(subscribeThreadMessageJump, () =>
    pendingThreadMessageJump(selectedThreadKey),
  );
  const jumpMessageLoaded =
    jumpMessageId !== null &&
    selectedThreadFeed.some((entry) => entry.type === "message" && entry.id === jumpMessageId);
  const historyForJump = props.historyControls;
  // History down to the message in one request; another page if it is not
  // there yet.
  const loadEarlierForJump = useEffectEvent(() => {
    if (jumpMessageId !== null) historyForJump?.onLoadThrough(jumpMessageId);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests earlier history from the server until the jump target message loads, or ends the jump
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
    composerHeight ??
    COMPOSER_COLLAPSED_CHROME +
      (!isProviderSubagent && (deviceType === "pad" || hasSidebarTabBar) ? 14 : 0) +
      composerBottomInset;
  // The last collapse toggle; it only applies to the request it was made on.
  const [userInputToggle, setUserInputToggle] = useState<{
    readonly requestId: RuntimeRequestId;
    readonly collapsed: boolean;
  } | null>(null);
  const activeUserInputRequestId = props.activePendingUserInput?.requestId ?? null;
  const questionInFlow = Platform.OS === "android" && activeUserInputRequestId !== null;
  const composerSlotHidden =
    activeUserInputRequestId !== null || props.creationState?.kind === "failed";
  const pendingMessageEditBlocked =
    queuedRunEditBlockedReason({ openQuestionCount: activeUserInputRequestId === null ? 0 : 1 }) !==
    null;
  const [usageLimitsPanel, setUsageLimitsPanel] = useState<{
    readonly key: string;
    readonly threadKey: string;
    readonly now: number;
  } | null>(null);
  // Approval/question identity invalidates quota: answering on any client resumes spending.
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
  // Late sends clear only their originating thread's limits panel.
  const clearUsageLimitsFor = (threadKey: string) =>
    setUsageLimitsPanel((current) =>
      current !== null && current.threadKey === threadKey ? null : current,
    );
  const userInputToggled =
    userInputToggle !== null && userInputToggle.requestId === activeUserInputRequestId;
  const userInputCollapsed = userInputToggled && userInputToggle.collapsed;
  // A height React sets from keyboard state lags the sticky translation by a Yoga pass and
  // flashes over the nav header on the way up, so the usage panel reserves the keyboard instead.
  const [lastKnownKeyboardHeight, setLastKnownKeyboardHeight] = useState(0);
  if (liveKeyboardHeight > 0 && liveKeyboardHeight !== lastKnownKeyboardHeight) {
    setLastKnownKeyboardHeight(liveKeyboardHeight);
  }
  const reservedKeyboardHeight =
    lastKnownKeyboardHeight > 0 ? lastKnownKeyboardHeight : ESTIMATED_KEYBOARD_HEIGHT;
  // Waiting for a visibility render misses the first keyboard frames.
  const keyboardStickyEnabled =
    Platform.OS === "ios"
      ? deviceType !== "duo-unfolded" || (composerOwnsKeyboard && !sidebarSearchActive)
      : !keyboardStateSuspect;
  const estimatedOverlayHeight = composerOverlapHeight;
  // UIKit adds safe-area bottom to overlay insets; subtract here and include it in ThreadFeed scroll math.
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
  const handleScreenLayout = (event: LayoutChangeEvent) => {
    setScreenHeight(event.nativeEvent.layout.height);
  };
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
  const composerPanelsHeightStyle = useAnimatedStyle(() => ({
    maxHeight: pendingUserInputMaxHeight.value,
    flexGrow: 0,
  }));
  // The usage panel stacks with the composer and any approval card, so it gets
  // whatever room they leave below the header. Measured only while it is open
  // so typing in the composer does not re-render the screen.
  const usageLimitsOpen = usageLimitsReport !== null && activeUserInputRequestId === null;
  const [usageLimitsLayout, setUsageLimitsLayout] = useState({ overlay: 0, panel: 0 });
  const handleComposerOverlayLayout = (event: LayoutChangeEvent) => {
    if (!questionInFlow) onComposerLayout(event);
    if (!usageLimitsOpen) return;
    const overlay = event.nativeEvent.layout.height;
    setUsageLimitsLayout((current) =>
      current.overlay === overlay ? current : { ...current, overlay },
    );
  };
  const handleUsageLimitsLayout = (event: LayoutChangeEvent) => {
    const panel = event.nativeEvent.layout.height;
    setUsageLimitsLayout((current) => (current.panel === panel ? current : { ...current, panel }));
  };
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
  // A toggle animates the card; a new request starts expanded at once.
  const userInputMotion = !userInputToggled
    ? "fresh"
    : userInputCollapsed
      ? "collapsed"
      : "expanded";
  const userInputCardProgress = useDerivedValue<number>(
    () =>
      userInputMotion === "fresh"
        ? 1
        : withTiming(userInputMotion === "collapsed" ? 0 : 1, USER_INPUT_TOGGLE_TIMING),
    [userInputMotion],
  );
  // Collapsing the inset is instant: the sinking card still covers the strip
  // being revealed, and animating the inset downward drifted the short-content
  // end anchor.
  const userInputInsetProgress = useDerivedValue<number>(() => {
    if (userInputMotion === "collapsed") return 0;
    return userInputMotion === "fresh" ? 1 : withTiming(1, USER_INPUT_TOGGLE_TIMING);
  }, [userInputMotion]);
  const userInputCardCoverage = useSharedValue(0);
  const composerPopoverHeight = useSharedValue(0);
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });
  const reduceMotion = useReducedMotion();
  // Repin timers fire after the render that scheduled them, so they read follow
  // state from the ref the writers below keep in step with it.
  const endFollowEnabledRef = useRef(true);
  const overlayRepinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleOverlayRepin = (delayMs: number) => {
    if (overlayRepinTimerRef.current !== null) {
      clearTimeout(overlayRepinTimerRef.current);
    }
    overlayRepinTimerRef.current = setTimeout(() => {
      overlayRepinTimerRef.current = null;
      const list = listRef.current;
      if (!endFollowEnabledRef.current || !list || list.getState().isAtEnd) return;
      void list.scrollToEnd({ animated: Platform.OS === "ios" && !reduceMotion });
    }, delayMs);
  };
  // LegendList does not re-anchor short followed conversations when floating
  // coverage changes after load. Re-pin each time it settles at a new value;
  // the repin checks follow state so a user who scrolled up stays put.
  const settledFloatingCoverageRef = useRef(0);
  const repinAfterCoverageSettles = (coverage: number) => {
    if (coverage === settledFloatingCoverageRef.current) return;
    settledFloatingCoverageRef.current = coverage;
    scheduleOverlayRepin(50);
  };
  const floatingCoverageTarget = showFloatingStatus ? FLOATING_WORKING_CONTROL_COVERAGE : 0;
  const floatingControlCoverage = useDerivedValue(
    () =>
      withTiming(
        floatingCoverageTarget,
        { duration: 180, reduceMotion: ReduceMotion.System },
        (finished) => {
          if (finished) runOnJS(repinAfterCoverageSettles)(floatingCoverageTarget);
        },
      ),
    [floatingCoverageTarget],
  );
  const userInputCoverageApplies = Platform.OS === "ios" && activeUserInputRequestId !== null;
  const questionStatusSpace = useAnimatedStyle(() => ({ height: floatingControlCoverage.value }));
  const combinedContentInsetEndAdjustment = useSharedValue(
    Math.max(0, estimatedOverlayHeight - nativeInsetOvercount),
  );
  useAnimatedReaction(
    () =>
      questionInFlow
        ? 0
        : contentInsetEndAdjustment.value +
          floatingControlCoverage.value +
          (userInputCoverageApplies
            ? userInputInsetProgress.value * userInputCardCoverage.value
            : 0),
    (value) => {
      combinedContentInsetEndAdjustment.set(value);
    },
    [questionInFlow, userInputCoverageApplies],
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
  const handleEndFollowEnabledChange = (enabled: boolean) => {
    endFollowEnabledRef.current = enabled;
    setEndFollowEnabled(enabled);
  };
  // A jump this thread never reached lets go when it closes.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts the thread scope, clears its timers and ends a pending message jump when the thread changes
  useEffect(() => {
    const scope = resetThreadScope();
    return () => {
      scope.abort();
      if (overlayRepinTimerRef.current !== null) clearTimeout(overlayRepinTimerRef.current);
      if (composerHeightSettle.current !== null) clearTimeout(composerHeightSettle.current);
      finishThreadMessageJump(selectedThreadKey);
    };
  }, [selectedThreadKey]);
  const handleToggleUserInputCollapsed = () => {
    if (activeUserInputRequestId === null) {
      return;
    }
    if (userInputCollapsed) {
      setUserInputToggle({ requestId: activeUserInputRequestId, collapsed: false });
      if (!questionInFlow) scheduleOverlayRepin(USER_INPUT_TOGGLE_DURATION_MS + 50);
    } else {
      Keyboard.dismiss();
      setUserInputToggle({ requestId: activeUserInputRequestId, collapsed: true });
      if (!questionInFlow) scheduleOverlayRepin(60);
    }
  };

  const showContent = props.showContent ?? true;
  // Showing the thread counts as viewing it, before its live shell arrives too.
  useAtomMount(
    threadVisitTracker(
      showContent && !props.draftMode
        ? { environmentId: props.environmentId, threadId: props.selectedThread.id }
        : null,
    ),
  );
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
  useAtomMount(threadStreamHaptics(props.selectedThreadDetailRef));
  const selectedProviderSkills = (() => {
    const provider = props.serverConfig?.providers.find(
      (candidate) => candidate.instanceId === selectedInstanceId,
    );
    return provider
      ? resolveProviderSkillsForCwd(provider, props.threadCwd ?? props.projectWorkspaceRoot)
      : [];
  })();

  const currentPendingApprovals = () =>
    props.selectedThreadDetailRef === null
      ? []
      : (appAtomRegistry.get(
          environmentThreadDetails.pendingRequestsAtom(props.selectedThreadDetailRef),
        )?.approvals ?? []);
  const handleSendMessage = async (
    followUp?: ActiveTurnComposerAction,
    stillSendable?: () => boolean,
  ) => {
    const scope = threadScope.current.signal;
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
            if (scope.aborted || stillSendable?.() === false || props.respondingApprovalId !== null)
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
              !scope.aborted &&
              // A draft edited or pasted into during the decline isn't what the user sent.
              stillSendable?.() !== false &&
              // An approval that arrived during the decline would block the redirect; the draft
              // stays so the next send declines it too.
              !currentPendingApprovals().some(
                (approval) =>
                  !approvalsToDecline.some((declined) => declined.requestId === approval.requestId),
              )
            );
          }
        : undefined;
    let dismissingKeyboard = false;
    const messageId = await props.onSendMessage(followUp, declineBeforeDispatch, () => {
      if (
        scope.aborted ||
        Platform.OS !== "ios" ||
        !hasUserMessage ||
        !KeyboardController.isVisible()
      )
        return;
      setSendingWithKeyboard(true);
      dismissingKeyboard = true;
    });
    if (messageId === null || scope.aborted) {
      return messageId;
    }

    clearUsageLimitsFor(targetThreadKey);

    const nextAnchorMessageId = resolveThreadFeedSubmissionAnchor({
      currentAnchorMessageId: anchorMessageId,
      submittedMessageId: messageId,
      hasStartedTurn: props.selectedThread.latestRun !== null,
      hasUserMessage,
      queuedMessageCount: props.selectedThreadQueueCount,
      deliveryDeferred: props.connectionStateLabel !== "connected",
    });
    feedRef.current?.resetEndFollow();
    setAnchorMessageId(nextAnchorMessageId);
    if (!dismissingKeyboard) composerEditorRef.current?.blur();
    const followSubmission =
      contentPresentationKind === "ready" &&
      (dismissingKeyboard || nextAnchorMessageId === messageId);
    if (dismissingKeyboard || followSubmission) {
      // Commit the optimistic row before UIKit chooses the closing scroll offset.
      requestAnimationFrame(() => {
        if (scope.aborted) return;
        // Scrolling freezes the keyboard inset, so wait until dismissal has removed it.
        void KeyboardController.dismiss()
          .then(() => {
            if (!followSubmission || scope.aborted || !endFollowEnabledRef.current) return;
            return scrollMessageToEnd({ animated: !reduceMotion, closeKeyboard: false });
          })
          .catch(() => {
            if (!scope.aborted) freeze.set(false);
          });
      });
    }
    return messageId;
  };

  const handleEditPendingMessage = async (message: QueuedThreadMessage) => {
    if (pendingMessageEditBlocked) return;
    const scope = threadScope.current.signal;
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
      !scope.aborted &&
      selectedThreadKey === scopedThreadKey(message.environmentId, message.threadId)
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


  return {
    ...input,
    activeUserInputRequestId,
    combinedContentInsetEndAdjustment,
    composerPanelsHeightStyle,
    composerPopoverHeight,
    composerSlotHidden,
    composerWidthStyle,
    contentInsetEndAdjustment,
    contentMaxWidth,
    dismissUsageLimits,
    estimatedOverlayHeight,
    floatingControlLift,
    freeze,
    handleComposerOverlayLayout,
    handleEditPendingMessage,
    handleEndFollowEnabledChange,
    handleFeedTouchCancel,
    handleFeedTouchEnd,
    handleFeedTouchMove,
    handleFeedTouchStart,
    handleScreenLayout,
    handleScrollToEnd,
    handleSendMessage,
    handleToggleUserInputCollapsed,
    handleUsageLimitsLayout,
    handleUseArtifactTemplate,
    hasCompactableConversation,
    isDarkMode,
    isSplitLayout,
    jumpMessageId,
    jumpMessageLoaded,
    keyboardStickyEnabled,
    layoutVariant,
    pendingMessageEditBlocked,
    pendingUserInputMaxHeight,
    providerSubagentCatalogModel,
    providerSubagentProvider,
    questionInFlow,
    questionStatusSpace,
    screenAreaHeight,
    selectedProviderSkills,
    selectedThreadFeed,
    showContent,
    showScrollToEndButton,
    showUsageLimits,
    usageLimitsMaxHeight,
    usageLimitsReport,
    userInputCardCoverage,
    userInputCardProgress,
    userInputCollapsed,
  };
}

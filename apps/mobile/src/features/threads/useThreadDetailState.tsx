import { useOpenThreadInspector } from "./thread-inspector-navigation";
import { useSidebarWorkspaceTabs } from "../workspace/useSystemWorkspaceTabBar";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { isAtomCommandInterrupted, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { useChildThreadInputs, useThreadReportedModelSelection } from "../../state/entities";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { effectiveSnoozed, threadWokeAt, isThreadWokeUnseen, snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import { childThreadInputsTitle } from "@t3tools/client-runtime/state/threads";
import type { LegendListRef } from "@legendapp/list/react-native";
import { HeaderHeightContext } from "@react-navigation/elements";
import { deriveBottomControlInsets, type NativeLayoutMetrics } from "../../lib/reserved-regions";
import type { MessageId, RunId } from "@t3tools/contracts";
import { useDeadlinePassed } from "../../lib/clock";
import { BACKGROUND_WORK_STOP_RETRY_AFTER_MS, type BackgroundWorkStopRequest, isBackgroundWorkStopPending, presentPendingBackgroundWork, presentProviderGoal } from "@t3tools/client-runtime/state/thread-execution";
import { resolveSubagentPillSegment } from "@t3tools/client-runtime/state/thread-subagents";
import { isProviderNativeSubagentThread } from "@t3tools/contracts";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { AppState, Keyboard, Platform, useWindowDimensions, type ViewInstance } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useDeviceType, useDuoBottomBarInset, useNativeColumnLayoutMetrics, useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import { deviceEnvironment } from "../../state/device";
import { useEnvironmentQuery } from "../../state/query";
import { threadDevicePreviews } from "../devices/threadDevicePreviews";
import { useThreadServerBrowserTabs } from "../../state/preview";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { threadComposerErrorsAtom } from "../../state/thread-composer-error";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useDelayedStatus } from "../../lib/useDelayedStatus";
import { connectionFloatingStatus, type FloatingWorkingStatus } from "./floating-working-status";
import { THREAD_COMPOSER_BOTTOM_GUTTER } from "./ThreadComposer";
import { type ThreadFeedHandle } from "./ThreadFeed";
import { useThreadTurnSubagents } from "./ThreadAgentsSheet";
import { useThreadQueuedCount } from "./ThreadQueueControl";
import { useOpenLinkedThread } from "./useOpenLinkedThread";
import { useGlobalVoiceInput } from "../voice-input/VoiceInputProvider";
import type { ThreadDetailBodyProps } from "./ThreadDetailScreenParts";
import {
  COMPOSER_HEIGHT_SETTLE_MS,
  NO_RUN_STOP_ATOM,
  RECONNECT_ERROR_DELAY_MS,
  USER_INPUT_TOGGLE_TIMING,
} from "./ThreadDetailScreenShared";
export function useThreadDetailState(props: ThreadDetailBodyProps) {
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const { layout } = useAdaptiveWorkspaceLayout();
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
  const openInspector = useOpenThreadInspector();
  const { session: voiceInputSession } = useGlobalVoiceInput();
  const reportedModelSelection = useThreadReportedModelSelection(props.selectedThreadDetailRef);
  const deviceState = useEnvironmentQuery(
    deviceEnvironment.state({ environmentId: props.environmentId, input: {} }),
  );
  const devicePreviews = threadDevicePreviews(deviceState.data, props.selectedThread.id);
  const openDevicePreview = () => {
    Keyboard.dismiss();
    if (
      openInspector(
        { environmentId: props.environmentId, threadId: props.selectedThread.id },
        { type: "device", environmentId: props.environmentId, threadId: props.selectedThread.id },
      )
    )
      return;
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
  // Android can lose IME hide callbacks on backgrounding. Quarantine translation on resume unless focused input retained its keyboard.
  const [keyboardStateSuspect, setKeyboardStateSuspect] = useState(false);
  const ownedInputFocusedRef = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to AppState on Android to mark keyboard state suspect when the app resumes
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the suspect flag whenever the native keyboard reports a visibility or height change
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Any native keyboard report clears the suspect flag set when the app resumed.
    setKeyboardStateSuspect(false);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Any keyboard visibility or height report clears the suspect flag set when the app resumed.
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the composer editor on the next animation frame when a queued run edit starts
  useEffect(() => {
    if (editingRunId === null) return;
    const frame = requestAnimationFrame(() => composerEditorRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editingRunId, composerEditorRef]);
  const composerOverlayRef = useRef<ViewInstance>(null);
  const listRef = useRef<LegendListRef>(null);
  const feedTouchStartRef = useRef<{ pageX: number; pageY: number } | null>(null);
  // Aborted when this thread's body unmounts, so async work started for it
  // stops touching a list or composer that now shows another thread.
  // Aborted when the screen hides or unmounts; a hidden Activity pane keeps its state but re-runs
  // effects when shown, so each show arms a fresh scope.
  const threadScope = useRef(new AbortController());
  // Mutating a ref across a module boundary trips the React Compiler's immutability
  // rule, so the owner exposes the reset instead of the raw ref.
  const resetThreadScope = (): AbortController => {
    if (threadScope.current.signal.aborted) threadScope.current = new AbortController();
    return threadScope.current;
  };
  const [composerHeight, setComposerHeight] = useState<number | null>(null);
  // The composer animates its height and reports a layout every frame. The feed follows those
  // frames on the UI thread through onComposerLayout; this is only an estimate, so committing
  // each frame would re-render the whole screen for the length of the animation.
  const composerHeightSettle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleComposerHeightChange = (height: number) => {
    setComposerHeight((current) => current ?? height);
    if (composerHeightSettle.current !== null) clearTimeout(composerHeightSettle.current);
    composerHeightSettle.current = setTimeout(() => {
      composerHeightSettle.current = null;
      setComposerHeight(height);
    }, COMPOSER_HEIGHT_SETTLE_MS);
  };
  const [anchorMessageId, setAnchorMessageId] = useState<MessageId | null>(null);
  const [sendingWithKeyboard, setSendingWithKeyboard] = useState(false);
  if (sendingWithKeyboard && !isKeyboardVisible) setSendingWithKeyboard(false);
  const feedRef = useRef<ThreadFeedHandle>(null);
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
      ? Math.max(bottomSafeArea, 12) - (layout.usesSplitView ? 5 : 0)
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
  const connectionRetrying =
    props.connectionStateLabel === "connecting" || props.connectionStateLabel === "reconnecting";
  const retryError = connectionRetrying ? props.connectionError : null;
  const retryConnectionError = useDelayedStatus(
    `${props.environmentId}:${retryError !== null}`,
    retryError,
    RECONNECT_ERROR_DELAY_MS,
  );
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const unsnoozeThread = useAtomCommand(threadEnvironment.unsnooze, { reportFailure: false });
  const unsettleThread = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const anyRunStop = useAtomValue(
    props.selectedThreadDetailRef === null
      ? NO_RUN_STOP_ATOM
      : environmentThreadDetails.runStopAtom(props.selectedThreadDetailRef),
  );
  // A background Stop matters only while that work is still pending.
  const runStop =
    anyRunStop?.background && props.selectedThread.pendingBackgroundTasks.length === 0
      ? null
      : anyRunStop;
  const forceStopThread = useAtomCommand(orchestrationEnvironment.forceStopThread, {
    reportFailure: false,
  });
  const canForceStop =
    useAtomValue(orchestrationEnvironment.forceStopThread.permissionAtom(props.environmentId)) &&
    props.serverConfig?.environment.capabilities.threadForceStop === true;
  const [forceStoppingKey, setForceStoppingKey] = useState<string | null>(null);
  // The run that ignored Stop, so a confirmation left open cannot hit a newer run.
  const forceStop = async (runId: RunId | undefined) => {
    const threadKey = selectedThreadKey;
    setForceStoppingKey(threadKey);
    const result = await forceStopThread({
      environmentId: props.environmentId,
      input:
        runId === undefined
          ? { threadId: props.selectedThread.id }
          : { threadId: props.selectedThread.id, runId },
    });
    setForceStoppingKey((current) => (current === threadKey ? null : current));
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) Dialog.alert("Could not force stop the agent");
      return;
    }
    const others = result.value.sharedWithThreadIds.length;
    if (result.value.outcome === "releasing") {
      Dialog.alert("Turn stopped; the agent is still shutting down");
    }
    if (result.value.outcome === "shared") {
      Dialog.alert(
        "Turn stopped; the agent process kept running",
        `It is shared with ${others === 0 ? "other" : others} working ${others === 1 ? "thread" : "threads"}. Stop those to free it.`,
      );
    }
  };
  const statusRequest = props.statusRequests[selectedThreadKey] ?? null;
  const statusPending = isBackgroundWorkStopPending(
    statusRequest,
    selectedThreadKey,
    props.selectedThread.pendingBackgroundTasks,
    useDeadlinePassed(statusRequest?.retryAt ?? null),
  );
  const [lifecycleNow, setLifecycleNow] = useState(() => new Date().toISOString());
  useFocusEffect(
    useCallback(() => {
      setLifecycleNow(new Date().toISOString());
      const timer = setInterval(() => setLifecycleNow(new Date().toISOString()), 60_000);
      return () => clearInterval(timer);
    }, []),
  );
  const configLoaded = props.serverConfig !== null;
  const snoozed = configLoaded && effectiveSnoozed(props.selectedThread, { now: lifecycleNow });
  const snoozedUntil = props.selectedThread.snoozedUntil;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- arms a timer that refreshes the lifecycle clock when the thread's snooze expires
  useEffect(() => {
    if (!snoozed || snoozedUntil === null) return;
    const timer = setTimeout(
      () => setLifecycleNow(new Date().toISOString()),
      Math.min(Math.max(0, Date.parse(snoozedUntil) - Date.now()) + 50, 2_147_483_647),
    );
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-arm if timer clamping fires before the wake time.
  }, [snoozed, snoozedUntil, lifecycleNow]);
  const settled = configLoaded && props.selectedThread.settledOverride === "settled";
  const wokeAt = configLoaded ? threadWokeAt(props.selectedThread, { now: lifecycleNow }) : null;
  const woke = isThreadWokeUnseen({
    wokeAt,
    settled,
    lastVisitedAt: props.selectedThread.lastVisitedAt,
    latestRunCompletedAt: props.selectedThread.latestRun?.completedAt ?? null,
  });

  const runStatusAction = async (action: "stop" | "wake" | "unsettle" | "dismiss") => {
    if (statusPending || !props.canOperateThread) return;
    const request: BackgroundWorkStopRequest = {
      threadKey: selectedThreadKey,
      taskIds:
        action === "stop"
          ? props.selectedThread.pendingBackgroundTasks.map((task) => task.taskId)
          : [],
      retryAt: null,
    };
    props.setStatusRequests((current) => ({ ...current, [request.threadKey]: request }));
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
    props.setStatusRequests((current) =>
      current[request.threadKey] !== request
        ? current
        : {
            ...current,
            [request.threadKey]:
              action === "stop" && result._tag !== "Failure"
                ? { ...request, retryAt: Date.now() + BACKGROUND_WORK_STOP_RETRY_AFTER_MS }
                : undefined,
          },
    );
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
      connectionError: connectionRetrying ? retryConnectionError : props.connectionError,
      connectionState: props.connectionStateLabel,
      environmentLabel: props.environmentLabel,
      onReconnect: props.onReconnectEnvironment,
    });
    if (connectionStatus !== null && !props.draftMode) {
      return connectionStatus;
    }
    // Before the request check: an agent stuck on an approval may also ignore Stop.
    if (runStop !== null && contentPresentationKind === "ready") {
      const unresponsive = runStop.state === "unresponsive";
      return {
        kind: "stop",
        unresponsive,
        label: unresponsive ? "Not responding to Stop" : "Stopping…",
        action:
          unresponsive && canForceStop
            ? {
                label: forceStoppingKey === selectedThreadKey ? "Force stopping..." : "Force stop",
                accessibilityLabel: "Force stop the agent",
                disabled: forceStoppingKey === selectedThreadKey,
                onPress: () =>
                  Dialog.confirm({
                    title: "Force stop the agent?",
                    message:
                      "It has not answered Stop. Force stop ends the turn and kills the agent's processes, unless other working threads share them.",
                    confirmText: "Force stop",
                    destructive: true,
                    onConfirm: () => void forceStop(runStop.runId),
                  }),
              }
            : null,
      };
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
          openLinkedThread({ environmentId: childInput.environmentId, threadId: childInput.id });
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

  return {
    agentsSegment,
    anchorMessageId,
    browserTabs,
    composerBottomInset,
    composerEditorRef,
    composerError,
    composerHeight,
    composerHeightSettle,
    composerKeyboardOffset,
    composerOverlayRef,
    composerOwnsKeyboard,
    contentPresentationKind,
    controlInsets,
    devicePreviews,
    deviceType,
    endFollowEnabled,
    feedRef,
    feedTouchStartRef,
    floatingStatus,
    handleComposerHeightChange,
    handleOwnedInputFocusChange,
    hasSidebarTabBar,
    insets,
    isKeyboardVisible,
    isProviderSubagent,
    keyboardStateSuspect,
    layout,
    listRef,
    liveKeyboardHeight,
    nativeMetrics,
    navigation,
    navigationHeaderHeight,
    openBrowserPreview,
    openDevicePreview,
    openLinkedThread,
    queuedCount,
    reportedModelSelection,
    selectedThreadKey,
    sendingWithKeyboard,
    setAnchorMessageId,
    setEndFollowEnabled,
    setScreenMetrics,
    setSendingWithKeyboard,
    showFloatingStatus,
    sidebarSearchActive,
    threadScope,
    resetThreadScope,
    usesNativeWorkspaceColumns,
    voiceInputSession,
    windowHeight,
  };
}

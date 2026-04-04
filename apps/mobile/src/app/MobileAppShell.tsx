import type { OrchestrationThread } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { StatusBar, useWindowDimensions, View } from "react-native";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { ConnectionSheet } from "../features/connection/ConnectionSheet";
import { ThreadDetailScreen } from "../features/threads/ThreadDetailScreen";
import { ThreadListScreen, type TransitionSourceFrame } from "../features/threads/ThreadListScreen";
import type { RemoteAppModel } from "./useRemoteAppState";

function revealCenter(
  sourceFrame: TransitionSourceFrame | null,
  width: number,
  height: number,
): { readonly x: number; readonly y: number } {
  "worklet";
  if (!sourceFrame) {
    return {
      x: width / 2,
      y: height / 2,
    };
  }

  return {
    x: sourceFrame.x + sourceFrame.width / 2,
    y: sourceFrame.y + sourceFrame.height / 2,
  };
}

function revealRadius(centerX: number, centerY: number, width: number, height: number): number {
  "worklet";
  const distances = [
    Math.hypot(centerX, centerY),
    Math.hypot(width - centerX, centerY),
    Math.hypot(centerX, height - centerY),
    Math.hypot(width - centerX, height - centerY),
  ];

  return Math.max(...distances);
}

function useRevealTransition(
  selectedThread: OrchestrationThread | null,
  onSelectThread: (threadId: OrchestrationThread["id"]) => void,
  onBackFromThread: () => void,
  width: number,
  height: number,
) {
  const [transitionSource, setTransitionSource] = useState<TransitionSourceFrame | null>(null);
  const [transitionPhase, setTransitionPhase] = useState<"idle" | "opening" | "closing">("idle");
  const revealProgress = useSharedValue(1);
  const openingAnimationFrameRef = useRef<number | null>(null);

  const revealMaskStyle = useAnimatedStyle(() => {
    const center = revealCenter(transitionSource, width, height);
    const startRadius = transitionSource
      ? Math.max(transitionSource.width, transitionSource.height) * 0.3
      : 20;
    const endRadius = revealRadius(center.x, center.y, width, height);
    const radius = startRadius + (endRadius - startRadius) * revealProgress.value;

    return {
      position: "absolute",
      left: center.x - radius,
      top: center.y - radius,
      width: radius * 2,
      height: radius * 2,
      borderRadius: radius,
      overflow: "hidden",
      opacity: interpolate(revealProgress.value, [0, 0.12, 1], [0, 1, 1]),
    };
  });

  const revealContentStyle = useAnimatedStyle(() => {
    const center = revealCenter(transitionSource, width, height);
    const startRadius = transitionSource
      ? Math.max(transitionSource.width, transitionSource.height) * 0.3
      : 20;
    const endRadius = revealRadius(center.x, center.y, width, height);
    const radius = startRadius + (endRadius - startRadius) * revealProgress.value;

    return {
      width,
      height,
      transform: [{ translateX: -(center.x - radius) }, { translateY: -(center.y - radius) }],
    };
  });

  const handleSelectThread = useCallback(
    (threadId: OrchestrationThread["id"], sourceFrame: TransitionSourceFrame | null): void => {
      setTransitionSource(sourceFrame);
      setTransitionPhase("opening");
      revealProgress.value = 0;
      onSelectThread(threadId);
    },
    [onSelectThread, revealProgress],
  );

  const handleBackFromThread = useCallback((): void => {
    if (!selectedThread) {
      return;
    }

    setTransitionPhase("closing");
    revealProgress.value = withTiming(
      0,
      {
        duration: 260,
        easing: Easing.inOut(Easing.cubic),
      },
      (finished) => {
        if (!finished) {
          return;
        }
        runOnJS(onBackFromThread)();
        runOnJS(setTransitionPhase)("idle");
        runOnJS(setTransitionSource)(null);
        revealProgress.value = 1;
      },
    );
  }, [onBackFromThread, revealProgress, selectedThread]);

  useEffect(() => {
    if (transitionPhase !== "opening" || !selectedThread) {
      return;
    }

    if (openingAnimationFrameRef.current !== null) {
      cancelAnimationFrame(openingAnimationFrameRef.current);
    }

    openingAnimationFrameRef.current = requestAnimationFrame(() => {
      openingAnimationFrameRef.current = null;
      revealProgress.value = withTiming(
        1,
        {
          duration: 420,
          easing: Easing.out(Easing.cubic),
        },
        (finished) => {
          if (!finished) {
            return;
          }
          runOnJS(setTransitionPhase)("idle");
        },
      );
    });

    return () => {
      if (openingAnimationFrameRef.current !== null) {
        cancelAnimationFrame(openingAnimationFrameRef.current);
        openingAnimationFrameRef.current = null;
      }
    };
  }, [selectedThread, revealProgress, transitionPhase]);

  return {
    transitionPhase,
    revealMaskStyle,
    revealContentStyle,
    handleSelectThread,
    handleBackFromThread,
  };
}

export function MobileAppShell(props: {
  readonly app: RemoteAppModel;
  readonly isDarkMode: boolean;
}) {
  const { app } = props;
  const { width, height } = useWindowDimensions();
  const backgroundColor = props.isDarkMode ? "#020617" : "#f8fafc";

  const {
    transitionPhase,
    revealMaskStyle,
    revealContentStyle,
    handleSelectThread,
    handleBackFromThread,
  } = useRevealTransition(
    app.selectedThread,
    app.onSelectThread,
    app.onBackFromThread,
    width,
    height,
  );

  const sharedDetailProps = app.selectedThread
    ? {
        selectedThread: app.selectedThread,
        screenTone: app.screenTone,
        connectionError: app.connectionError,
        httpOrigin: app.httpOrigin,
        resolvedAuthToken: app.resolvedAuthToken,
        selectedThreadFeed: app.selectedThreadFeed,
        selectedThreadFeedLoadingInitial: app.selectedThreadFeedLoadingInitial,
        selectedThreadFeedLoadingMore: app.selectedThreadFeedLoadingMore,
        selectedThreadFeedHasMore: app.selectedThreadFeedHasMore,
        activeWorkDurationLabel: app.activeWorkDurationLabel,
        activePendingApproval: app.activePendingApproval,
        respondingApprovalId: app.respondingApprovalId,
        activePendingUserInput: app.activePendingUserInput,
        activePendingUserInputDrafts: app.activePendingUserInputDrafts,
        activePendingUserInputAnswers: app.activePendingUserInputAnswers,
        respondingUserInputId: app.respondingUserInputId,
        draftMessage: app.draftMessage,
        draftAttachments: app.draftAttachments,
        connectionStateLabel: app.connectionState,
        activeThreadBusy: app.activeThreadBusy,
        selectedThreadQueueCount: app.selectedThreadQueueCount,
        onBack: handleBackFromThread,
        onOpenConnectionEditor: app.onOpenConnectionEditor,
        onChangeDraftMessage: app.onChangeDraftMessage,
        onPickDraftImages: app.onPickDraftImages,
        onPasteIntoDraft: app.onPasteIntoDraft,
        onRemoveDraftImage: app.onRemoveDraftImage,
        onRefresh: app.onRefresh,
        onLoadMoreFeed: app.onLoadMoreSelectedThreadFeed,
        onRenameThread: app.onRenameThread,
        onStopThread: app.onStopThread,
        onSendMessage: app.onSendMessage,
        onRespondToApproval: app.onRespondToApproval,
        onSelectUserInputOption: app.onSelectUserInputOption,
        onChangeUserInputCustomAnswer: app.onChangeUserInputCustomAnswer,
        onSubmitUserInput: app.onSubmitUserInput,
      }
    : null;

  return (
    <View style={{ flex: 1, backgroundColor }}>
      <StatusBar
        barStyle={props.isDarkMode ? "light-content" : "dark-content"}
        backgroundColor={backgroundColor}
        translucent
      />

      <View style={{ flex: 1 }} pointerEvents={app.selectedThread ? "none" : "auto"}>
        <ThreadListScreen
          heroTitle={app.heroTitle}
          showBrandWordmark={app.showBrandWordmark}
          screenTone={app.screenTone}
          connectionState={app.connectionState}
          connectionPulse={app.hasRemoteActivity}
          projects={app.projects}
          threads={app.threads}
          hasClient={app.hasClient}
          hasServerConfig={app.serverConfig !== null}
          hiddenThreadId={app.selectedThread?.id ?? null}
          connectionError={app.connectionError}
          onOpenConnectionEditor={app.onOpenConnectionEditor}
          onRefresh={app.onRefresh}
          onCreateThread={app.onCreateThread}
          onSelectThread={handleSelectThread}
        />
      </View>

      {app.selectedThread && sharedDetailProps ? (
        <View className="absolute inset-0">
          <ThreadDetailScreen {...sharedDetailProps} showContent={transitionPhase === "idle"} />
          {transitionPhase !== "idle" ? (
            <Animated.View
              className="absolute inset-0"
              pointerEvents="none"
              style={revealMaskStyle}
            >
              <Animated.View style={revealContentStyle}>
                <ThreadDetailScreen {...sharedDetailProps} showHeader={false} />
              </Animated.View>
            </Animated.View>
          ) : null}
        </View>
      ) : null}

      <ConnectionSheet
        visible={app.connectionSheetRequired}
        hasClient={app.hasClient}
        connectionInput={app.connectionInput}
        connectionState={app.connectionState}
        connectionError={app.connectionError}
        onRequestClose={app.onRequestCloseConnectionEditor}
        onChangeServerUrl={app.onChangeConnectionServerUrl}
        onChangeAuthToken={app.onChangeConnectionAuthToken}
        onConnect={app.onConnectPress}
        onClose={app.onCloseConnectionEditor}
        onDisconnect={app.onDisconnectPress}
        onForgetSavedLink={app.onForgetConnectionPress}
      />
    </View>
  );
}

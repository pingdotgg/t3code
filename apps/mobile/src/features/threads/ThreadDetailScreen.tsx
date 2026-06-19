import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type {
  ApprovalRequestId,
  EnvironmentId,
  ModelSelection,
  OrchestrationThreadShell,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
  ThreadId,
} from "@t3tools/contracts";
import { formatElapsed } from "@t3tools/shared/orchestrationTiming";
import * as Haptics from "expo-haptics";
import { useHeaderHeight } from "expo-router/build/react-navigation/elements";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { runOnJS } from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import type { StatusTone } from "../../components/StatusPill";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import type { LayoutVariant } from "../../lib/layout";
import { resolveThreadFeedBottomInset } from "../../lib/threadFeedLayout";
import type {
  PendingApproval,
  PendingUserInput,
  PendingUserInputDraftAnswer,
  ThreadFeedEntry,
} from "../../lib/threadActivity";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { PendingUserInputCard } from "./PendingUserInputCard";
import {
  COMPOSER_COLLAPSED_CHROME,
  COMPOSER_EXPANDED_CHROME,
  ThreadComposer,
} from "./ThreadComposer";
import { ThreadFeed } from "./ThreadFeed";
import type { ThreadContentPresentation } from "./threadContentPresentation";

export interface ThreadDetailScreenProps {
  readonly selectedThread: OrchestrationThreadShell;
  readonly contentPresentation: ThreadContentPresentation;
  readonly screenTone: StatusTone;
  readonly connectionError: string | null;
  readonly environmentLabel: string | null;
  readonly selectedThreadFeed: ReadonlyArray<ThreadFeedEntry>;
  readonly activeWorkStartedAt: string | null;
  readonly activePendingApproval: PendingApproval | null;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activePendingUserInputDrafts: Record<string, PendingUserInputDraftAnswer>;
  readonly activePendingUserInputAnswers: Record<string, string> | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly connectionStateLabel: EnvironmentConnectionPhase;
  readonly activeThreadBusy: boolean;
  readonly environmentId: EnvironmentId;
  readonly projectWorkspaceRoot: string | null;
  readonly threadCwd: string | null;
  readonly selectedThreadQueueCount: number;
  readonly serverConfig: T3ServerConfig | null;
  readonly layoutVariant?: LayoutVariant;
  readonly onOpenDrawer: () => void;
  readonly onOpenConnectionEditor: () => void;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftImages: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  readonly onSendMessage: () => Promise<void>;
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
    questionId: string,
    label: string,
  ) => void;
  readonly onChangeUserInputCustomAnswer: (
    requestId: ApprovalRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmitUserInput: () => Promise<unknown>;
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

const WORKING_INDICATOR_HEIGHT = 44;

const WorkingDurationPill = memo(function WorkingDurationPill(props: {
  readonly startedAt: string;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => clearInterval(intervalId);
  }, [props.startedAt]);

  const durationLabel = formatElapsed(props.startedAt, new Date(nowMs).toISOString()) ?? "0s";

  return (
    <View className="px-4 pb-2" style={{ flexShrink: 0 }}>
      <View className="self-start rounded-full border border-neutral-200/80 bg-neutral-50/90 px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.04]">
        <View className="flex-row items-center gap-2">
          <View className="flex-row items-center gap-1">
            <View className="h-1.5 w-1.5 rounded-full bg-neutral-400 dark:bg-neutral-500" />
            <View className="h-1.5 w-1.5 rounded-full bg-neutral-400/80 dark:bg-neutral-500/80" />
            <View className="h-1.5 w-1.5 rounded-full bg-neutral-400/60 dark:bg-neutral-500/60" />
          </View>
          <Text className="font-t3-medium text-xs text-neutral-600 dark:text-neutral-400">
            Working for {durationLabel}
          </Text>
        </View>
      </View>
    </View>
  );
});

export const ThreadDetailScreen = memo(function ThreadDetailScreen(props: ThreadDetailScreenProps) {
  const { onOpenDrawer } = props;

  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const agentLabel = `${props.selectedThread.modelSelection.instanceId} agent`;
  const composerRef = useRef<ComposerEditorHandle>(null);
  const feedTouchStartRef = useRef<{ pageX: number; pageY: number } | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const composerBottomInset = composerExpanded ? 0 : Math.max(insets.bottom, 12);
  const composerChrome = composerExpanded ? COMPOSER_EXPANDED_CHROME : COMPOSER_COLLAPSED_CHROME;
  const composerOverlapHeight = composerChrome + composerBottomInset;
  const activeWorkIndicatorHeight = props.activeWorkStartedAt ? WORKING_INDICATOR_HEIGHT : 0;
  const estimatedOverlayHeight = composerOverlapHeight + activeWorkIndicatorHeight;
  const [measuredOverlayHeight, setMeasuredOverlayHeight] = useState(0);
  const showContent = props.showContent ?? true;
  const layoutVariant = props.layoutVariant ?? "compact";
  const isSplitLayout = layoutVariant === "split";
  const selectedInstanceId = props.selectedThread.modelSelection.instanceId;
  useStreamingHaptics(props.selectedThread.id, props.selectedThreadFeed);
  const feedBottomInset = resolveThreadFeedBottomInset({
    estimatedOverlayHeight,
    measuredOverlayHeight,
    gap: 8,
  });
  const selectedProviderSkills = useMemo(
    () =>
      props.serverConfig?.providers.find((provider) => provider.instanceId === selectedInstanceId)
        ?.skills ?? [],
    [props.serverConfig, selectedInstanceId],
  );

  const completeDrawerGesture = useCallback(() => {
    void Haptics.selectionAsync();
    onOpenDrawer();
  }, [onOpenDrawer]);

  const drawerGestureThreshold = 80;
  const headerDrawerGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!isSplitLayout)
        .hitSlop({ left: 0, width: 40 })
        .activeOffsetX([10, 999])
        .failOffsetY([-24, 24])
        .onEnd((event) => {
          const translationX = Math.max(event.translationX, 0);
          if (event.y < drawerGestureThreshold && translationX > 56) {
            runOnJS(completeDrawerGesture)();
          }
        }),
    [completeDrawerGesture, isSplitLayout],
  );

  const handleOverlayLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = Math.ceil(event.nativeEvent.layout.height);
    setMeasuredOverlayHeight((current) =>
      Math.abs(current - nextHeight) > 1 ? nextHeight : current,
    );
  }, []);

  const collapseComposer = useCallback(() => {
    composerRef.current?.blur();
  }, []);

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
    <GestureDetector gesture={headerDrawerGesture}>
      <View className="flex-1">
        {showContent ? (
          <View
            style={{ flex: 1 }}
            onTouchStart={handleFeedTouchStart}
            onTouchMove={handleFeedTouchMove}
            onTouchEnd={handleFeedTouchEnd}
            onTouchCancel={handleFeedTouchCancel}
          >
            <ThreadFeed
              key={props.selectedThread.id}
              environmentId={props.environmentId}
              threadId={props.selectedThread.id}
              workspaceRoot={props.threadCwd}
              feed={props.selectedThreadFeed}
              contentPresentation={props.contentPresentation}
              agentLabel={agentLabel}
              latestTurn={props.selectedThread.latestTurn}
              contentTopInset={headerHeight}
              contentBottomInset={feedBottomInset}
              layoutVariant={layoutVariant}
              composerExpanded={composerExpanded}
              skills={selectedProviderSkills}
            />
          </View>
        ) : (
          <View style={{ flex: 1 }} />
        )}

        {/* Floating composer — sticks to keyboard via KeyboardStickyView */}
        {showContent ? (
          <KeyboardStickyView
            style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
            offset={{ closed: 0, opened: 0 }}
          >
            <View onLayout={handleOverlayLayout}>
              {props.activeWorkStartedAt ? (
                <WorkingDurationPill startedAt={props.activeWorkStartedAt} />
              ) : null}

              {props.activePendingApproval || props.activePendingUserInput ? (
                <View className="gap-3 px-4 pb-3" style={{ flexShrink: 0 }}>
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
                      drafts={props.activePendingUserInputDrafts}
                      answers={props.activePendingUserInputAnswers}
                      respondingUserInputId={props.respondingUserInputId}
                      onSelectOption={props.onSelectUserInputOption}
                      onChangeCustomAnswer={props.onChangeUserInputCustomAnswer}
                      onSubmit={props.onSubmitUserInput}
                    />
                  ) : null}
                </View>
              ) : null}

              <ThreadComposer
                editorRef={composerRef}
                draftMessage={props.draftMessage}
                draftAttachments={props.draftAttachments}
                placeholder="Ask the repo agent, or run a command…"
                connectionState={props.connectionStateLabel}
                connectionError={props.connectionError}
                environmentLabel={props.environmentLabel}
                selectedThread={props.selectedThread}
                serverConfig={props.serverConfig}
                queueCount={props.selectedThreadQueueCount}
                activeThreadBusy={props.activeThreadBusy}
                environmentId={props.environmentId}
                projectCwd={props.projectWorkspaceRoot}
                bottomInset={composerBottomInset}
                onChangeDraftMessage={props.onChangeDraftMessage}
                onPickDraftImages={props.onPickDraftImages}
                onNativePasteImages={props.onNativePasteImages}
                onRemoveDraftImage={props.onRemoveDraftImage}
                onStopThread={props.onStopThread}
                onSendMessage={props.onSendMessage}
                onReconnectEnvironment={props.onReconnectEnvironment}
                onUpdateModelSelection={props.onUpdateThreadModelSelection}
                onUpdateRuntimeMode={props.onUpdateThreadRuntimeMode}
                onUpdateInteractionMode={props.onUpdateThreadInteractionMode}
                onExpandedChange={setComposerExpanded}
              />
            </View>
          </KeyboardStickyView>
        ) : null}
      </View>
    </GestureDetector>
  );
});

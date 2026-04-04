import type {
  ApprovalRequestId,
  OrchestrationThread,
  ProviderApprovalDecision,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { GlassSafeAreaView } from "../../components/GlassSafeAreaView";
import type { StatusTone } from "../../components/StatusPill";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import type {
  PendingApproval,
  PendingUserInput,
  PendingUserInputDraftAnswer,
  ThreadFeedEntry,
} from "../../lib/threadActivity";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { ThreadComposer } from "./ThreadComposer";
import { ThreadFeed } from "./ThreadFeed";

export interface ThreadDetailScreenProps {
  readonly selectedThread: OrchestrationThread;
  readonly screenTone: StatusTone;
  readonly connectionError: string | null;
  readonly httpOrigin: string | null;
  readonly resolvedAuthToken: string | null;
  readonly selectedThreadFeed: ReadonlyArray<ThreadFeedEntry>;
  readonly selectedThreadFeedLoadingInitial: boolean;
  readonly selectedThreadFeedLoadingMore: boolean;
  readonly selectedThreadFeedHasMore: boolean;
  readonly activeWorkDurationLabel: string | null;
  readonly activePendingApproval: PendingApproval | null;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activePendingUserInputDrafts: Record<string, PendingUserInputDraftAnswer>;
  readonly activePendingUserInputAnswers: Record<string, string> | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly connectionStateLabel: "ready" | "connecting" | "reconnecting" | "disconnected" | "idle";
  readonly activeThreadBusy: boolean;
  readonly selectedThreadQueueCount: number;
  readonly onBack: () => void;
  readonly onOpenConnectionEditor: () => void;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftImages: () => Promise<void>;
  readonly onPasteIntoDraft: () => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onRefresh: () => Promise<void>;
  readonly onLoadMoreFeed: () => Promise<void>;
  readonly onRenameThread: (title: string) => Promise<void>;
  readonly onStopThread: () => Promise<void>;
  readonly onSendMessage: () => void;
  readonly onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  readonly onSelectUserInputOption: (requestId: string, questionId: string, label: string) => void;
  readonly onChangeUserInputCustomAnswer: (
    requestId: string,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmitUserInput: () => Promise<void>;
  readonly showHeader?: boolean;
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

function useRenameDraftSync(threadId: string, threadTitle: string) {
  const [renameDraft, setRenameDraft] = useState(threadTitle);

  useEffect(() => {
    setRenameDraft(threadTitle);
  }, [threadId, threadTitle]);

  return [renameDraft, setRenameDraft] as const;
}

function useStreamingHaptics(threadId: string, feed: ReadonlyArray<ThreadFeedEntry>) {
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

export function ThreadDetailScreen(props: ThreadDetailScreenProps) {
  const isDarkMode = useColorScheme() === "dark";
  const insets = useSafeAreaInsets();
  const agentLabel = `${props.selectedThread.modelSelection.provider} agent`;
  const headerOverlayHeight = insets.top + 70;
  const composerBottomInset = Math.max(insets.bottom, 12);
  const screenBackgroundColor = isDarkMode ? "#020617" : "#f8fafc";
  const modalBackdropColor = isDarkMode ? "rgba(2,6,23,0.68)" : "rgba(15,23,42,0.22)";
  const modalPanelColor = isDarkMode ? "#111827" : "#ffffff";
  const modalBorderColor = isDarkMode ? "rgba(255,255,255,0.08)" : "#e2e8f0";
  const modalMutedColor = isDarkMode ? "#94a3b8" : "#64748b";
  const modalPrimaryColor = isDarkMode ? "#f8fafc" : "#020617";
  const connectionPulse = props.activeThreadBusy;
  const [renameVisible, setRenameVisible] = useState(false);
  const [renameDraft, setRenameDraft] = useRenameDraftSync(
    props.selectedThread.id,
    props.selectedThread.title,
  );
  const showHeader = props.showHeader ?? true;
  const showContent = props.showContent ?? true;

  useStreamingHaptics(props.selectedThread.id, props.selectedThreadFeed);

  async function handleSubmitRename(): Promise<void> {
    const trimmed = renameDraft.trim();
    if (trimmed.length === 0) {
      return;
    }

    await props.onRenameThread(trimmed);
    setRenameVisible(false);
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: screenBackgroundColor }}
    >
      {showHeader ? (
        <View className="absolute inset-x-0 top-0 z-20">
          <GlassSafeAreaView
            leftSlot={
              <Pressable
                className="min-w-[76px] items-center rounded-[14px] bg-slate-200 px-2.5 py-2.5 dark:bg-slate-800"
                onPress={props.onBack}
              >
                <Text className="font-t3-bold text-[13px] text-slate-950 dark:text-slate-50">
                  Back
                </Text>
              </Pressable>
            }
            centerSlot={
              <View className="items-center gap-1">
                <Pressable onLongPress={() => setRenameVisible(true)}>
                  <Animated.Text
                    numberOfLines={1}
                    style={{
                      color: isDarkMode ? "#f8fafc" : "#020617",
                      fontSize: 18,
                      fontWeight: "800",
                      lineHeight: 22,
                    }}
                  >
                    {props.selectedThread.title}
                  </Animated.Text>
                </Pressable>
                <Text
                  className="text-[11px] font-bold uppercase"
                  style={{ color: modalMutedColor, letterSpacing: 1.05 }}
                >
                  {props.activeWorkDurationLabel ? props.activeWorkDurationLabel : ""}
                </Text>
              </View>
            }
            rightSlot={
              <Pressable className="rounded-full px-3 py-2" onPress={props.onOpenConnectionEditor}>
                <ConnectionStatusDot state={props.connectionStateLabel} pulse={connectionPulse} />
              </Pressable>
            }
          />
        </View>
      ) : null}

      {showContent && props.connectionError ? (
        <View
          className="mx-4 mt-3"
          style={{
            paddingTop: props.activeWorkDurationLabel
              ? headerOverlayHeight + 12
              : headerOverlayHeight + 6,
          }}
        >
          <ErrorBanner message={props.connectionError} />
        </View>
      ) : null}

      {showContent ? (
        <>
          <View style={{ flex: 1, minHeight: 0 }}>
            <ThreadFeed
              threadId={props.selectedThread.id}
              feed={props.selectedThreadFeed}
              loadingInitial={props.selectedThreadFeedLoadingInitial}
              loadingMore={props.selectedThreadFeedLoadingMore}
              hasMore={props.selectedThreadFeedHasMore}
              httpOrigin={props.httpOrigin}
              authToken={props.resolvedAuthToken}
              agentLabel={agentLabel}
              contentTopInset={headerOverlayHeight + 20}
              contentBottomInset={composerBottomInset + 20}
              onLoadMore={props.onLoadMoreFeed}
            />
          </View>

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
            draftMessage={props.draftMessage}
            draftAttachments={props.draftAttachments}
            placeholder="Ask the repo agent, or run a command…"
            connectionState={props.connectionStateLabel}
            selectedThread={props.selectedThread}
            queueCount={props.selectedThreadQueueCount}
            activeThreadBusy={props.activeThreadBusy}
            bottomInset={composerBottomInset}
            onChangeDraftMessage={props.onChangeDraftMessage}
            onPickDraftImages={props.onPickDraftImages}
            onPasteIntoDraft={props.onPasteIntoDraft}
            onRemoveDraftImage={props.onRemoveDraftImage}
            onRefresh={props.onRefresh}
            onStopThread={props.onStopThread}
            onSendMessage={props.onSendMessage}
          />
        </>
      ) : (
        <View style={{ flex: 1 }} />
      )}

      <Modal
        transparent
        animationType="fade"
        visible={renameVisible}
        onRequestClose={() => setRenameVisible(false)}
      >
        <View
          className="flex-1 items-center justify-center px-5"
          style={{ backgroundColor: modalBackdropColor }}
        >
          <View
            className="w-full gap-4 px-4 py-4"
            style={{
              maxWidth: 420,
              borderWidth: 1,
              borderColor: modalBorderColor,
              backgroundColor: modalPanelColor,
            }}
          >
            <View className="gap-2">
              <Text
                className="text-[11px] font-bold uppercase"
                style={{ color: modalMutedColor, letterSpacing: 1.2 }}
              >
                Thread name
              </Text>
              <Text
                className="text-[20px] font-extrabold leading-[24px]"
                style={{ color: modalPrimaryColor }}
              >
                Rename thread
              </Text>
            </View>

            <TextInput
              autoFocus
              value={renameDraft}
              onChangeText={setRenameDraft}
              placeholder="Thread title"
              className="min-h-[56px] px-4 py-3 text-[15px]"
              style={{
                borderWidth: 1,
                borderColor: modalBorderColor,
                backgroundColor: isDarkMode ? "#0f172a" : "#ffffff",
                color: modalPrimaryColor,
              }}
              onSubmitEditing={() => {
                void handleSubmitRename();
              }}
            />

            <View className="flex-row gap-3">
              <Pressable
                className="min-h-[48px] flex-1 items-center justify-center px-4 py-3"
                style={{
                  borderWidth: 1,
                  borderColor: modalBorderColor,
                  backgroundColor: isDarkMode ? "#1f2937" : "#f8fafc",
                }}
                onPress={() => {
                  setRenameDraft(props.selectedThread.title);
                  setRenameVisible(false);
                }}
              >
                <Text
                  className="text-sm font-extrabold uppercase"
                  style={{ color: modalPrimaryColor, letterSpacing: 1 }}
                >
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                className="min-h-[48px] flex-1 items-center justify-center px-4 py-3"
                style={{ backgroundColor: modalPrimaryColor }}
                onPress={() => {
                  void handleSubmitRename();
                }}
              >
                <Text
                  className="text-sm font-extrabold uppercase"
                  style={{ color: isDarkMode ? "#020617" : "#f8fafc", letterSpacing: 1 }}
                >
                  Save
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

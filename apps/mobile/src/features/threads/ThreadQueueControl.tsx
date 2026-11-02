import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import {
  makeQueuedRunsAtom,
  queuedRunEditBlockedReason,
} from "@t3tools/client-runtime/queued-run-edit";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import {
  ComposerContextId,
  type ChatAttachment,
  type ChatImageAttachment,
  type ChatFileAttachment,
  type EnvironmentId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "../../components/ui/Button";
import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { useAssetUrl } from "../../state/assets";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { assetImageSource } from "../../lib/assetImageSource";
import {
  prepareQueuedRunEditDraft,
  queuedEditDraftKey,
  recoverQueuedRunEdit,
  watchQueuedRunEdit,
  useQueuedRunEdit,
} from "../../state/queued-run-edit";
import { getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { importAttachment } from "../../lib/composerContextClipboard";
import * as Dialog from "../../components/ui/Dialog";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import {
  REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
  buildCancelQueuedRunCommand,
  resolveThreadQueueRowControls,
} from "./threadQueueControlPresentation";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
const REMOVE_ACTION_WIDTH = 76;
const THUMBNAIL_LIMIT = 3;
const EMPTY_QUEUED_COUNT_ATOM = Atom.make(0).pipe(
  Atom.withLabel("mobile-thread-queue-count:empty"),
);

type QueueTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
type QueueAction = "steer" | "edit" | "remove";

function useThreadQueueWorkflow(target: QueueTarget) {
  return useAtomValue(environmentThreadDetails.queueWorkflowAtom(target));
}

export function useThreadQueuedCount(target: QueueTarget | null) {
  return useAtomValue(
    target === null ? EMPTY_QUEUED_COUNT_ATOM : environmentThreadDetails.queuedCountAtom(target),
  );
}

type QueuedRunMessage = NonNullable<
  NonNullable<ReturnType<typeof useThreadQueueWorkflow>>["queuedRuns"][number]["message"]
>;

/** Who sent a queued message, as its sent form shows it in the thread. */
function QueuedRunSender(props: {
  readonly environmentId: EnvironmentId;
  readonly message: QueuedRunMessage;
}) {
  const { attribution, scheduledTaskId } = resolveUserMessagePresentation(props.message);
  const senderThreadId = attribution === "agent" ? props.message.senderThreadId : undefined;
  const senderShell = useQuietThreadShell(
    senderThreadId ? scopeThreadRef(props.environmentId, senderThreadId) : null,
  );
  const tasks = useEnvironmentQuery(
    scheduledTaskId
      ? serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const sender =
    attribution === "automation"
      ? {
          icon: "calendar.badge.clock" as const,
          label:
            tasks.data?.tasks.find((task) => task.id === scheduledTaskId)?.title ?? "Automation",
        }
      : attribution === "agent"
        ? {
            icon: "bubble.left.and.bubble.right" as const,
            label: senderShell?.title.trim() || "Agent",
          }
        : attribution === "t3code"
          ? { icon: null, label: "Sent by T3 Code" }
          : null;
  if (sender === null) return null;
  return (
    <View className="flex-row items-center gap-1">
      {sender.icon ? (
        <SymbolView
          name={sender.icon}
          size={11}
          weight="medium"
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
      ) : null}
      <Text
        numberOfLines={1}
        className="min-w-0 shrink font-t3-medium text-2xs text-foreground-muted"
      >
        {sender.label}
      </Text>
    </View>
  );
}

export function ThreadQueueSheet({ route }: StaticScreenProps<QueueTarget>) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const workflow = useThreadQueueWorkflow(target);
  const threadKey = scopedThreadKey(target.environmentId, target.threadId);
  const editing = useQueuedRunEdit(threadKey);
  const pendingRequests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(target));
  const editBlockedReason = queuedRunEditBlockedReason({
    openQuestionCount: pendingRequests?.userInputs.length ?? 0,
  });
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun, "promote queued message");
  const acquireEdit = useAtomCommand(threadEnvironment.beginQueuedRunEdit, "edit queued message");
  const releaseEdit = useAtomCommand(threadEnvironment.cancelQueuedRunEdit, "finish queued edit");
  const releaseFailedPreparation = useAtomCommand(threadEnvironment.cancelQueuedRunEdit, {
    reportFailure: false,
  });
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun, "remove queued message");
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue, "resume queue");
  const [resuming, setResuming] = useState(false);
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const busyRef = useRef(false);
  const queuedRuns = workflow?.queuedRuns ?? [];

  const hadQueuedRuns = useRef(queuedRuns.length > 0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops the navigator once the server-side queue empties after it had runs
  useEffect(() => {
    if (queuedRuns.length > 0) {
      hadQueuedRuns.current = true;
      return;
    }
    if (hadQueuedRuns.current) navigation.goBack();
  }, [navigation, queuedRuns.length]);

  const act = async (runId: RunId, action: QueueAction) => {
    if (busyRef.current) return;
    const index = queuedRuns.findIndex(({ run }) => run.id === runId);
    if (index < 0) return;
    if (action === "edit") {
      if (editBlockedReason !== null) return;
      const entry = queuedRuns[index]!;
      const previousEditId = entry.run.queueEditId ?? null;
      if (editing?.runId === runId && editing.editId === previousEditId) {
        navigation.goBack();
        return;
      }
      if (previousEditId !== null) {
        const confirmed = await new Promise<boolean>((resolve) =>
          Dialog.confirm({
            title: "Take over editing?",
            message:
              "This message is being edited elsewhere. The other editor will keep their unsaved changes.",
            confirmText: "Take over",
            onConfirm: () => resolve(true),
            onCancel: () => resolve(false),
          }),
        );
        if (!confirmed) return;
      }
      busyRef.current = true;
      setBusyRunId(runId);
      const openEdit = async () => {
        if (editing !== null) {
          const released = await releaseEdit({
            environmentId: target.environmentId,
            input: { threadId: target.threadId, runId: editing.runId, editId: editing.editId },
          });
          if (released._tag !== "Success") return;
          recoverQueuedRunEdit(threadKey);
        }
        const acquired = await acquireEdit({
          environmentId: target.environmentId,
          input: { threadId: target.threadId, runId, previousEditId },
        });
        if (acquired._tag !== "Success") return;
        const preparation = prepareQueuedRunEditDraft(
          threadKey,
          {
            ...acquired.value,
            runId,
            messageId: entry.messageId,
            originalText: entry.text,
            originalAttachmentIds: entry.attachments.map((attachment) => attachment.id),
            ...(entry.context ? { context: entry.context } : {}),
          },
          async () => {
            if (
              entry.attachments.some(
                (attachment) => attachment.type !== "image" && attachment.type !== "file",
              )
            )
              throw new Error("This attachment cannot be edited.");
            return await Promise.all(
              entry.attachments
                .filter(
                  (attachment): attachment is ChatImageAttachment | ChatFileAttachment =>
                    attachment.type === "image" || attachment.type === "file",
                )
                .map(async (attachment) => {
                  const local = await importAttachment(
                    {
                      version: 1,
                      kind: attachment.type,
                      contextId: ComposerContextId.make(attachment.id),
                      label: attachment.name,
                      attachmentId: attachment.id,
                      name: attachment.name,
                      mimeType: attachment.mimeType,
                      sizeBytes: attachment.sizeBytes,
                    },
                    target.environmentId,
                    new AbortController().signal,
                  );
                  const restored = {
                    ...local,
                    id: attachment.id,
                    uploadedAttachmentId: attachment.id,
                    uploadEnvironmentId: target.environmentId,
                  };
                  if (restored.type === "image" && attachment.type === "image")
                    return {
                      ...restored,
                      ...(attachment.source ? { source: attachment.source } : {}),
                    };
                  if (restored.type === "file" && attachment.type === "file")
                    return {
                      ...restored,
                      ...(attachment.source ? { source: attachment.source } : {}),
                    };
                  return restored;
                }),
            );
          },
        );
        const preparedEdit = getComposerDraftSnapshot(
          queuedEditDraftKey(threadKey, runId),
        ).queuedEdit;
        try {
          await preparation;
          watchQueuedRunEdit(
            threadKey,
            makeQueuedRunsAtom({
              threadId: target.threadId,
              snapshot: threadEnvironment.snapshotAtom(target.environmentId),
              detailStatus: environmentThreadDetails.statusAtom(target),
              runs: Atom.make(
                (get) =>
                  get(environmentThreadDetails.quietThreadAtom(target))?.projection.runs ?? null,
              ),
            }),
          );
        } catch (error) {
          const released = await releaseFailedPreparation({
            environmentId: target.environmentId,
            input: { threadId: target.threadId, runId, editId: acquired.value.editId },
          });
          if (released._tag === "Success" && preparedEdit?.ownership)
            recoverQueuedRunEdit(threadKey, preparedEdit);
          Dialog.alert(
            "Could not open queued edit",
            error instanceof Error ? error.message : "Could not restore attachments.",
          );
          return;
        }
        void Haptics.selectionAsync();
        navigation.goBack();
      };
      await openEdit()
        .catch((error: unknown) => {
          Dialog.alert(
            "Could not open queued edit",
            error instanceof Error ? error.message : "Please try again.",
          );
        })
        .finally(() => {
          busyRef.current = false;
          setBusyRunId(null);
        });
      return;
    }
    if (action !== "steer" && action !== "remove") return;
    busyRef.current = true;
    setBusyRunId(runId);
    void Haptics.selectionAsync();
    if (action === "remove") {
      await cancel(buildCancelQueuedRunCommand({ ...target, runId }));
    } else if (workflow?.canSendNow && queuedRuns[index]?.run.queueEditId == null) {
      await resume({ ...target, input: { threadId: target.threadId, runId } });
    } else if (
      workflow?.activeRun &&
      workflow.canPromoteToSteer &&
      queuedRuns[index]?.run.queueEditId == null
    ) {
      await promote({
        ...target,
        input: {
          threadId: target.threadId,
          queuedRunId: runId,
          targetRunId: workflow.activeRun.id,
        },
      });
    }
    busyRef.current = false;
    setBusyRunId(null);
  };

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      // UIKit must inset content beneath the floating translucent iOS header.
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {workflow?.isHeld && queuedRuns.length > 0 ? (
        <View className="gap-2 py-3">
          <Text className="text-sm text-foreground-muted">Queue paused</Text>
          <Button
            label="Resume queue"
            disabled={resuming || busyRunId !== null}
            onPress={async () => {
              if (busyRef.current) return;
              busyRef.current = true;
              setResuming(true);
              await resume({ ...target, input: { threadId: target.threadId } });
              busyRef.current = false;
              setResuming(false);
            }}
          />
        </View>
      ) : null}
      {editBlockedReason !== null && queuedRuns.length > 0 ? (
        <Text className="py-3 text-sm text-foreground-muted">{editBlockedReason}</Text>
      ) : null}
      {queuedRuns.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          No messages waiting in this queue.
        </Text>
      ) : null}
      {queuedRuns.map(({ run, text, attachments, context, message }, index) => {
        const controls = resolveThreadQueueRowControls({
          busy: busyRunId !== null,
          canPromoteToSteer: (workflow?.canPromoteToSteer ?? false) && run.queueEditId == null,
          canSendNow: (workflow?.canSendNow ?? false) && run.queueEditId == null,
          editBlocked: editBlockedReason !== null,
          isEditing: editing?.runId === run.id,
          isGuestMessage: context?.guest !== undefined,
          text,
        });
        const title =
          controls.displayText || (attachments.length > 0 ? "Attachments" : "Queued message");
        return (
          <View key={run.id} className="flex-row items-center border-b border-border bg-sheet">
            <QueueRowSwipeable
              enabled={busyRunId === null && controls.canDismiss}
              background={theme["--color-sheet"]}
              onRemove={() => void act(run.id, "remove")}
            >
              <View className="flex-row items-center">
                <Menu
                  accessibilityLabel={`Actions for queued message ${index + 1}`}
                  shouldOpenOnLongPress
                  style={{ flex: 1 }}
                  actions={[
                    ...(workflow?.canPromoteToSteer || workflow?.canSendNow
                      ? [
                          {
                            id: "steer",
                            title: "Send now",
                            attributes: { disabled: !controls.canSend },
                            image: Platform.OS === "ios" ? "arrow.up" : "arrow_upward",
                          },
                        ]
                      : []),
                    {
                      id: "edit",
                      title: "Edit",
                      attributes: { disabled: !controls.canEdit },
                      image: Platform.OS === "ios" ? "pencil" : "edit",
                    },
                    {
                      id: "remove",
                      title: "Remove",
                      attributes: { disabled: !controls.canDismiss, destructive: true },
                    },
                  ]}
                  onPressAction={({ nativeEvent }) =>
                    void act(run.id, nativeEvent.event as QueueAction)
                  }
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={title}
                    accessibilityHint={
                      controls.canEdit
                        ? "Opens this message in the composer for editing"
                        : (editBlockedReason ?? undefined)
                    }
                    disabled={!controls.canEdit}
                    onPress={() => void act(run.id, "edit")}
                    className="min-h-14 flex-row items-center gap-2.5 py-2.5 active:opacity-70"
                  >
                    <QueueAttachmentThumbnails
                      environmentId={target.environmentId}
                      attachments={attachments}
                    />
                    <View className="min-w-0 flex-1 gap-0.5">
                      {message ? (
                        <QueuedRunSender environmentId={target.environmentId} message={message} />
                      ) : null}
                      <Text
                        className={
                          controls.isEditing
                            ? "text-sm text-foreground-muted"
                            : "text-sm text-foreground"
                        }
                        numberOfLines={1}
                      >
                        {context?.guest === undefined ? null : (
                          <Text className="font-t3-medium text-adaptive-fuchsia-600-300">
                            {`${context.guest.name}  `}
                          </Text>
                        )}
                        {title}
                      </Text>
                    </View>
                    {controls.isEditing || run.queueEditId != null ? (
                      <Text className="shrink-0 text-2xs uppercase tracking-wide text-primary">
                        {controls.isEditing ? "Editing" : "Editing elsewhere"}
                      </Text>
                    ) : null}
                  </Pressable>
                </Menu>
                {workflow?.canPromoteToSteer || workflow?.canSendNow ? (
                  // Outside the edit row and full row height, so a near miss never opens the editor.
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Send now, queued message ${index + 1}`}
                    disabled={!controls.canSend}
                    onPress={() => void act(run.id, "steer")}
                    className="shrink-0 justify-center self-stretch pl-4 active:opacity-70 disabled:opacity-40"
                  >
                    <View className="min-h-9 flex-row items-center gap-1.5 rounded-full bg-primary px-4">
                      <SymbolView
                        name="arrow.up"
                        size={13}
                        tintColorClassName="accent-primary-foreground"
                      />
                      <Text className="font-t3-medium text-sm text-primary-foreground">
                        Send now
                      </Text>
                    </View>
                  </Pressable>
                ) : null}
              </View>
            </QueueRowSwipeable>
          </View>
        );
      })}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // Plain formSheets lack stack headers; host one in a nested native stack.
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View collapsable={false} className="flex-1 bg-sheet">
          <ScreenStack style={{ flex: 1 }}>
            <Screen
              activityState={2}
              enabled
              isNativeStack
              screenId="thread-queue-sheet-native"
              scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
              style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
            >
              {content}
              <ScreenStackHeaderConfig
                backgroundColor="rgba(0,0,0,0)"
                color={theme["--color-foreground"]}
                hideBackButton
                hideShadow={false}
                title="Queued"
                titleColor={theme["--color-foreground"]}
                titleFontSize={18}
                titleFontWeight="800"
                translucent
              />
            </Screen>
          </ScreenStack>
        </View>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View collapsable={false} className="flex-1 bg-sheet">
        <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
        <AndroidSheetHeader title="Queued" onBack={() => navigation.goBack()} />
        <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
      </View>
    </GestureHandlerRootView>
  );
}

function QueueRowSwipeable(props: {
  readonly enabled: boolean;
  readonly background: string;
  readonly onRemove: () => void;
  readonly children: React.ReactNode;
}) {
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  return (
    <ReanimatedSwipeable
      ref={swipeableRef}
      enabled={props.enabled}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      // Require a clearly sideways swipe to avoid competing with sheet scroll.
      failOffsetY={[-12, 12]}
      containerStyle={{ backgroundColor: props.background, flex: 1 }}
      childrenContainerStyle={{ backgroundColor: props.background }}
      onSwipeableOpen={(direction) => {
        if (direction !== "right") return;
        swipeableRef.current?.close();
        props.onRemove();
      }}
      renderRightActions={() => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL}
          disabled={!props.enabled}
          onPress={() => {
            swipeableRef.current?.close();
            props.onRemove();
          }}
          className="items-center justify-center bg-danger active:opacity-70 disabled:opacity-40"
          style={{ width: REMOVE_ACTION_WIDTH }}
        >
          <SymbolView name="trash" size={16} tintColorClassName="accent-danger-foreground" />
          <Text className="pt-1 text-2xs font-t3-medium text-danger-foreground">Remove</Text>
        </Pressable>
      )}
    >
      {props.children}
    </ReanimatedSwipeable>
  );
}

function QueueAttachmentThumbnails(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}) {
  const images = props.attachments.filter((attachment) => attachment.mimeType.startsWith("image/"));
  const shown = images.slice(0, THUMBNAIL_LIMIT);
  const overflow = props.attachments.length - shown.length;
  if (props.attachments.length === 0) return null;
  return (
    <View className="shrink-0 flex-row items-center gap-1">
      {shown.map((attachment) => (
        <QueueAttachmentThumbnail
          key={attachment.id}
          environmentId={props.environmentId}
          attachment={attachment}
        />
      ))}
      {overflow > 0 ? (
        <View className="h-6 min-w-6 items-center justify-center rounded bg-subtle px-1">
          <Text className="text-2xs tabular-nums text-foreground-muted">
            {shown.length === 0 ? `${overflow}` : `+${overflow}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function QueueAttachmentThumbnail(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatAttachment;
}) {
  const resource = {
    _tag: "attachment",
    attachmentId: props.attachment.id,
    fileName: props.attachment.name,
    mimeType: props.attachment.mimeType,
    disposition: "inline",
  } as const;
  const url = useAssetUrl(props.environmentId, resource);
  if (url === null) {
    return <View className="h-6 w-6 rounded bg-subtle" />;
  }
  return (
    <Image
      source={assetImageSource(props.environmentId, resource, url)}
      cachePolicy="memory-disk"
      contentFit="cover"
      style={{ width: 24, height: 24, borderRadius: 4 }}
      accessibilityIgnoresInvertColors
    />
  );
}

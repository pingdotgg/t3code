import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { useAtomValue } from "@effect/atom-react";
import {
  makeQueuedRunsAtom,
  queuedRunEditBlockedReason,
} from "@t3tools/client-runtime/queued-run-edit";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import type { ChatAttachment, EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { msg, useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useAssetUrl } from "../../state/assets";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { assetImageSource } from "../../lib/assetImageSource";
import { appAtomRegistry } from "../../state/atom-registry";
import { beginQueuedRunEdit, useQueuedRunEdit } from "../../state/queued-run-edit";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildCancelQueuedRunCommand,
  resolveThreadQueueRowControls,
} from "./threadQueueControlPresentation";

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
  const gt = useGT();
  const { attribution, scheduledTaskId } = resolveUserMessagePresentation(props.message);
  const senderThreadId = attribution === "agent" ? props.message.senderThreadId : undefined;
  // A linked environment's agent sent it from a thread there.
  const linkedSender = attribution === "agent" ? props.message.linkedSender : undefined;
  const senderShell = useQuietThreadShell(
    linkedSender ?? (senderThreadId ? scopeThreadRef(props.environmentId, senderThreadId) : null),
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
            tasks.data?.tasks.find((task) => task.id === scheduledTaskId)?.title ??
            gt("Automation"),
        }
      : attribution === "agent"
        ? {
            icon: "bubble.left.and.bubble.right" as const,
            label: senderShell?.title.trim() || linkedSender?.title.trim() || gt("Agent"),
          }
        : attribution === "t3code"
          ? { icon: null, label: gt("Sent by T3 Code") }
          : null;
  if (sender === null) return null;
  return (
    <View className="mb-1 flex-row items-center gap-1 pr-1">
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

/**
 * Messages waiting for the current turn, at the end of the feed as on web. Each waits as a dashed
 * bubble until it is sent now, edited in the composer, or removed.
 */
export function ThreadQueuedRuns(props: {
  readonly target: QueueTarget;
  readonly bubbleMaxWidth: number | `${number}%`;
}) {
  const { target } = props;
  const gt = useGT();
  const m = useMessages();
  const workflow = useThreadQueueWorkflow(target);
  const threadKey = scopedThreadKey(target.environmentId, target.threadId);
  const editing = useQueuedRunEdit(threadKey);
  const pendingRequests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(target));
  const editBlockedReason = queuedRunEditBlockedReason(
    {
      openQuestionCount: pendingRequests?.userInputs.length ?? 0,
    },
    m,
  );
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun, "promote queued message");
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun, "remove queued message");
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue, "resume queue");
  const resumeHeldQueue = useAtomCommand(threadEnvironment.resumeThreadQueue, {
    label: "resume queue",
    reportFailure: false,
  });
  const [resuming, setResuming] = useState(false);
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const busyRef = useRef(false);
  const queuedRuns = workflow?.queuedRuns ?? [];
  if (queuedRuns.length === 0) return null;

  const act = async (runId: RunId, action: QueueAction) => {
    if (busyRef.current) return;
    const entry = queuedRuns.find(({ run }) => run.id === runId);
    if (entry === undefined) return;
    if (action === "edit") {
      if (editBlockedReason !== null) return;
      void Haptics.selectionAsync();
      beginQueuedRunEdit(
        threadKey,
        {
          runId,
          messageId: entry.messageId,
          originalText: entry.text,
          modelSelection: entry.message?.followsThreadSelection
            ? (appAtomRegistry.get(environmentThreadDetails.quietThreadAtom(target))?.projection
                .thread.modelSelection ?? entry.run.modelSelection)
            : entry.run.modelSelection,
          followsThreadSelection: entry.message?.followsThreadSelection === true,
          existingAttachments: entry.attachments,
          ...(entry.context ? { context: entry.context } : {}),
        },
        makeQueuedRunsAtom({
          threadId: target.threadId,
          snapshot: threadEnvironment.snapshotAtom(target.environmentId),
          detailStatus: environmentThreadDetails.statusAtom(target),
          runs: Atom.make(
            (get) => get(environmentThreadDetails.quietThreadAtom(target))?.projection.runs ?? null,
          ),
        }),
      );
      return;
    }
    busyRef.current = true;
    setBusyRunId(runId);
    void Haptics.selectionAsync();
    const result =
      action === "remove"
        ? await cancel(buildCancelQueuedRunCommand({ ...target, runId }))
        : workflow?.canSendNow
          ? await resume({ ...target, input: { threadId: target.threadId, runId } })
          : workflow?.activeRun && workflow.canPromoteToSteer
            ? await promote({
                ...target,
                input: {
                  threadId: target.threadId,
                  queuedRunId: runId,
                  targetRunId: workflow.activeRun.id,
                },
              })
            : null;
    busyRef.current = false;
    setBusyRunId(null);
    if (action === "steer" && result?._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        m(msg("Could not send queued message")),
        errorDisplayMessage(error, m) ?? m(msg("Try again.")),
      );
    }
  };

  const resumeQueue = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setResuming(true);
    const result = await resumeHeldQueue({ ...target, input: { threadId: target.threadId } });
    busyRef.current = false;
    setResuming(false);
    // A usage limit holds the queue until the composer's Resume thread continues the run.
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(gt("Could not resume queue"), errorDisplayMessage(error, m) ?? gt("Try again."));
    }
  };

  return (
    <View className="gap-4 pb-4">
      {workflow?.isHeld ? (
        <View className="flex-row items-center justify-end gap-1 pl-2">
          <SymbolView
            name="tray.and.arrow.up"
            size={11}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
          />
          <Text className="mr-1 text-2xs text-foreground-muted">
            {gt("Queue paused", { $context: "status of the thread's queued messages" })}
          </Text>
          <QueueAction
            label={gt("Resume queue")}
            accessibilityLabel={gt("Resume queue")}
            disabled={resuming || busyRunId !== null}
            onPress={() => void resumeQueue()}
          />
        </View>
      ) : null}
      {editBlockedReason !== null ? (
        <Text className="text-right text-sm text-foreground-muted">{editBlockedReason}</Text>
      ) : null}
      {queuedRuns.map(({ run, text, attachments, context, message }, index) => {
        const controls = resolveThreadQueueRowControls({
          busy: busyRunId !== null,
          // A fresh message starts its own turn: it may skip compaction, but not steer into a turn.
          canPromoteToSteer:
            (workflow?.canPromoteToSteer ?? false) &&
            (run.freshContext !== true || workflow?.promoteSkipsCompaction === true),
          canSendNow: workflow?.canSendNow ?? false,
          editBlocked: editBlockedReason !== null,
          isEditing: editing?.runId === run.id,
          isGuestMessage: context?.guest !== undefined,
          text,
        });
        const canOfferSend = workflow?.canPromoteToSteer || workflow?.canSendNow;
        return (
          <View key={run.id} className="items-end">
            {message ? (
              <QueuedRunSender environmentId={target.environmentId} message={message} />
            ) : null}
            <View
              className="min-w-0 gap-2 rounded-[20px] border border-dashed border-border bg-transparent px-3.5 py-2.5"
              style={{ maxWidth: props.bubbleMaxWidth }}
            >
              {controls.displayText ? (
                <Text
                  selectable
                  numberOfLines={6}
                  className={
                    controls.isEditing
                      ? "text-base text-foreground-muted"
                      : "text-base text-foreground"
                  }
                >
                  {context?.guest === undefined ? null : (
                    <Text className="font-t3-medium text-adaptive-fuchsia-600-300">
                      {`${context.guest.name}  `}
                    </Text>
                  )}
                  {controls.displayText}
                </Text>
              ) : null}
              <QueueAttachmentThumbnails
                environmentId={target.environmentId}
                attachments={attachments}
                onPressPreview={setPreviewFile}
              />
            </View>
            <View className="mt-1 flex-row items-center gap-1 pl-2">
              <SymbolView
                name="tray.and.arrow.up"
                size={11}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
              />
              <Text className="mr-1 text-2xs text-foreground-muted">
                {controls.isEditing
                  ? gt("Editing in the composer")
                  : gt("Queued", { $context: "status of a message waiting for the current turn" })}
              </Text>
              <QueueAction
                label={gt("Remove", { $context: "verb, menu action" })}
                accessibilityLabel={gt("Remove queued message {number}", { number: index + 1 })}
                disabled={!controls.canDismiss}
                onPress={() => void act(run.id, "remove")}
              />
              <QueueAction
                label={gt("Edit", { $context: "verb, menu action" })}
                accessibilityLabel={gt("Edit queued message {number}", { number: index + 1 })}
                accessibilityHint={editBlockedReason ?? undefined}
                disabled={!controls.canEdit}
                onPress={() => void act(run.id, "edit")}
              />
              {canOfferSend ? (
                <QueueAction
                  icon="arrow.up"
                  label={gt("Send now")}
                  accessibilityLabel={gt("Send now, queued message {number}", {
                    number: index + 1,
                  })}
                  disabled={!controls.canSend || busyRunId === run.id}
                  onPress={() => void act(run.id, "steer")}
                />
              ) : null}
            </View>
          </View>
        );
      })}
      <FilePreviewModal source={previewFile} onRequestClose={() => setPreviewFile(null)} />
    </View>
  );
}

/** A small action under a queued bubble, sized like the sent message's own footer actions. */
function QueueAction(props: {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly accessibilityHint?: string;
  readonly disabled: boolean;
  readonly icon?: "arrow.up";
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={8}
      onPress={props.onPress}
      className="h-7 flex-row items-center gap-0.5 rounded-full px-2 active:opacity-70 disabled:opacity-40"
    >
      {props.icon ? (
        <SymbolView name={props.icon} size={10} tintColorClassName="accent-foreground-muted" />
      ) : null}
      <Text className="font-t3-medium text-xs text-foreground-muted">{props.label}</Text>
    </Pressable>
  );
}

function QueueAttachmentThumbnails(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const images = props.attachments.filter((attachment) => attachment.mimeType.startsWith("image/"));
  const gallery = images.map((attachment) => queueImagePreview(props.environmentId, attachment));
  const shown = images.slice(0, THUMBNAIL_LIMIT);
  const overflow = props.attachments.length - shown.length;
  if (props.attachments.length === 0) return null;
  return (
    <View className="flex-row items-center gap-1">
      {shown.map((attachment) => (
        <QueueAttachmentThumbnail
          key={attachment.id}
          environmentId={props.environmentId}
          attachment={attachment}
          onPress={() =>
            props.onPressPreview({
              ...queueImagePreview(props.environmentId, attachment),
              gallery,
            })
          }
        />
      ))}
      {overflow > 0 ? (
        <View className="h-10 min-w-10 items-center justify-center rounded-md bg-subtle px-1">
          <Text className="text-xs tabular-nums text-foreground-muted">
            {shown.length === 0 ? `${overflow}` : `+${overflow}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function queueAttachmentResource(attachment: ChatAttachment) {
  return {
    _tag: "attachment",
    attachmentId: attachment.id,
    fileName: attachment.name,
    mimeType: attachment.mimeType,
    disposition: "inline",
  } as const;
}

function queueImagePreview(environmentId: EnvironmentId, attachment: ChatAttachment) {
  const resource = queueAttachmentResource(attachment);
  return {
    kind: "image",
    environmentId,
    resource,
    name: attachment.name,
    mimeType: attachment.mimeType,
    actionsSource: {
      name: attachment.name,
      mimeType: attachment.mimeType,
      environmentId,
      resource,
    },
  } as const;
}

function QueueAttachmentThumbnail(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatAttachment;
  readonly onPress: () => void;
}) {
  const resource = queueAttachmentResource(props.attachment);
  const url = useAssetUrl(props.environmentId, resource);
  const gt = useGT();
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={gt("Open {name}", { name: props.attachment.name })}
      hitSlop={6}
      onPress={props.onPress}
      className="active:opacity-70"
    >
      {url === null ? (
        <View className="h-10 w-10 rounded-md bg-subtle" />
      ) : (
        <Image
          source={assetImageSource(props.environmentId, resource, url)}
          cachePolicy="memory-disk"
          contentFit="cover"
          style={{ width: 40, height: 40, borderRadius: 6 }}
          accessibilityIgnoresInvertColors
        />
      )}
    </Pressable>
  );
}

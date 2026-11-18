import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import type {
  ChatAttachment as ContractChatAttachment,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  Clock3Icon,
  MessagesSquareIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import * as DateTime from "effect/DateTime";
import { msg, T, useGT, useMessages } from "gt-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { threadEnvironment } from "../../state/threads";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { isImageAttachment, type ChatImageAttachment, type ChatMessage } from "../../types";
import { cn } from "~/lib/utils";
import { Button, InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import { m } from "../../i18n/messages";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { GuestMessageName } from "./guestMessageStyle";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import { FoldedMessageHeader, useScheduledTaskTitle } from "./TimelineUserMessageRow";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";

export interface EditQueuedRunRequest {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ContractChatAttachment>;
}

// A longer queue shows its first messages and a button that shows the rest.
const QUEUE_VISIBLE_ROWS = 3;

export interface QueuedRunsControlHandle {
  steerNext: (repeat: boolean) => boolean;
  editLatest: (repeat: boolean) => boolean;
}

type ThreadQueueProjection = Parameters<typeof deriveThreadQueueWorkflowState>[0];

function queuedImageResources(projection: ThreadQueueProjection | undefined) {
  if (!projection) return [];
  return deriveThreadQueueWorkflowState(projection).queuedRuns.flatMap(({ attachments }) =>
    attachments.flatMap((attachment) =>
      isImageAttachment(attachment)
        ? [{ _tag: "attachment" as const, attachmentId: attachment.id }]
        : [],
    ),
  );
}

export function QueuedRunsControl({
  ref,
  ...props
}: {
  readonly ref?: Ref<QueuedRunsControlHandle>;
  readonly steerShortcutLabel?: string | null;
  readonly editShortcutLabel?: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly optimisticMessages: ReadonlyArray<
    Pick<ChatMessage, "id" | "inputIntent" | "text" | "attachments">
  >;
  readonly editingRunId: RunId | null;
  /** Set while something else holds the composer, such as an open question. */
  readonly editBlockedReason: string | null;
  readonly onEditQueuedRun: (request: EditQueuedRunRequest) => void;
  readonly onCancelEdit: () => void;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const projection = useQuietThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.projection;
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue);
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const [showAll, setShowAll] = useState(false);
  const queueListId = useId();
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const steerInFlightRef = useRef(false);
  // Run-only acknowledgements can resurrect pending rows after cancellation or startup.
  const acknowledgedMessageIds = new Set((projection?.messages ?? []).map((message) => message.id));
  const queuedImageAttachmentResources = queuedImageResources(projection);
  const queuedImageAttachmentUrls = useAssetUrls(
    props.environmentId,
    queuedImageAttachmentResources,
  );
  const workflow = projection ? deriveThreadQueueWorkflowState(projection, messages) : null;
  const queued = workflow?.queuedRuns ?? [];
  const activeRun = workflow?.activeRun ?? null;
  // A fresh message starts its own turn: it may skip compaction, but not steer into a turn.
  const canSendRun = (freshContext: boolean) =>
    workflow?.canSendNow === true ||
    (workflow?.canPromoteToSteer === true &&
      (!freshContext || workflow.promoteSkipsCompaction === true));
  const queuedImageUrlById = new Map(
    queuedImageAttachmentUrls.flatMap((url, index) => {
      const resource = queuedImageAttachmentResources[index];
      return url && resource ? [[resource.attachmentId, url] as const] : [];
    }),
  );
  const optimisticQueued = props.optimisticMessages.filter(
    (message) => message.inputIntent === "queued_turn" && !acknowledgedMessageIds.has(message.id),
  );
  const items = [
    ...queued.map(({ run, text, attachments, context, message }, serverIndex) => ({
      key: run.id,
      message,
      runId: run.id,
      messageId: run.userMessageId,
      freshContext: run.freshContext === true,
      serverIndex,
      text,
      // A guest's message keeps the guest's words; the owner can cancel it, not rewrite it.
      editable: context?.guest === undefined,
      attachments,
      thumbnails: attachments.filter(isImageAttachment).map<ChatImageAttachment>((attachment) => {
        const previewUrl = queuedImageUrlById.get(attachment.id);
        return {
          ...attachment,
          type: "image",
          ...(previewUrl ? { previewUrl } : {}),
        };
      }),
      pending: false,
    })),
    ...optimisticQueued.map((message) => ({
      key: message.id,
      message: undefined,
      runId: null,
      messageId: null,
      freshContext: false,
      serverIndex: null,
      text: message.text,
      editable: true,
      attachments: [] as ReadonlyArray<ContractChatAttachment>,
      thumbnails: (message.attachments ?? []).filter(isImageAttachment),
      pending: true,
    })),
  ];

  const sendQueuedMessage = async (queuedRunId: RunId) => {
    const freshContext = queued.some(
      ({ run }) => run.id === queuedRunId && run.freshContext === true,
    );
    if (!canSendRun(freshContext) || steerInFlightRef.current) return;
    steerInFlightRef.current = true;
    setBusyRunId(queuedRunId);
    const result = workflow?.canSendNow
      ? await resume({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, runId: queuedRunId },
        })
      : activeRun !== null
        ? await promote({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, queuedRunId, targetRunId: activeRun.id },
          })
        : null;
    steerInFlightRef.current = false;
    setBusyRunId(null);
    if (result?._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: m(msg("Could not send queued message")),
        description:
          error instanceof Error
            ? (thrownErrorMessage(error, m) ?? error.message)
            : m(msg("An error occurred.")),
      });
    }
  };

  useImperativeHandle(ref, () => ({
    steerNext(repeat) {
      const next = queued[0];
      if (!next || !canSendRun(next.run.freshContext === true)) return false;
      if (!repeat && busyRunId === null) void sendQueuedMessage(next.run.id);
      return true;
    },
    // Leave the key to caret navigation while editing.
    editLatest(repeat) {
      const latest = queued.at(-1);
      if (
        !latest ||
        latest.context?.guest !== undefined ||
        props.editingRunId !== null ||
        props.editBlockedReason !== null ||
        busyRunId !== null
      ) {
        return false;
      }
      if (!repeat) {
        setShowAll(true);
        props.onEditQueuedRun({
          runId: latest.run.id,
          messageId: latest.run.userMessageId,
          text: latest.text,
          attachments: latest.attachments,
        });
      }
      return true;
    },
  }));

  if (items.length === 0) return null;

  const remove = async (runId: RunId) => {
    setBusyRunId(runId);
    await cancel({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId },
    });
    setBusyRunId(null);
  };

  const collapsible = items.length > QUEUE_VISIBLE_ROWS;
  const visibleItems = collapsible && !showAll ? items.slice(0, QUEUE_VISIBLE_ROWS - 1) : items;

  return (
    <section
      aria-label={gt(
        "{count, plural, one {{count} queued message} other {{count} queued messages}}",
        { count: items.length },
      )}
      data-thread-queue="true"
      // Anchors the sr-only live region; unanchored, it escapes the timeline scroller and makes the chat column scroll.
      className="relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 pb-4"
    >
      <span className="sr-only" aria-live="polite">
        {gt("{count, plural, one {{count} queued} other {{count} queued}}", {
          count: items.length,
        })}
      </span>
      <ol className="flex flex-col items-end gap-3" id={queueListId}>
        {visibleItems.map((item, position) => {
          const previewText = isAttachmentOnlyBootstrapPrompt(item.text)
            ? ""
            : assistantCitationsToPlainText(
                replaceComposerContextReferences(item.text, (reference) => reference.label),
              ).trim();
          const isEditing = item.runId !== null && item.runId === props.editingRunId;
          return (
            <li
              key={item.key}
              aria-label={gt("Queued message {position} of {total}, not sent", {
                position: position + 1,
                total: items.length,
              })}
              aria-posinset={position + 1}
              aria-setsize={items.length}
              aria-current={isEditing ? "true" : undefined}
              className="group/queued flex w-full flex-col items-end gap-1"
            >
              <QueuedMessage
                environmentId={props.environmentId}
                message={item.message}
                previewText={previewText}
                thumbnails={item.thumbnails}
                isEditing={isEditing}
                timestampFormat={props.timestampFormat}
                onOpenThread={props.onOpenThread}
                onImageExpand={props.onImageExpand}
              >
                {canSendRun(item.freshContext) && !isEditing ? (
                  <>
                    <Tooltip>
                      <TooltipTrigger render={<span className="flex shrink-0" />}>
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          disabled={item.runId === null || busyRunId !== null}
                          onClick={() => {
                            if (item.runId !== null) {
                              void sendQueuedMessage(item.runId);
                            }
                          }}
                        >
                          <ArrowUpIcon />
                          <T>Send now</T>
                        </Button>
                      </TooltipTrigger>
                      <TooltipPopup>
                        {item.serverIndex === 0 && props.steerShortcutLabel
                          ? workflow?.canSendNow
                            ? gt("Start a turn with this message ({shortcut})", {
                                shortcut: props.steerShortcutLabel,
                              })
                            : workflow?.promoteSkipsCompaction
                              ? gt("Skip compaction and send this message ({shortcut})", {
                                  shortcut: props.steerShortcutLabel,
                                })
                              : gt("Send into the current turn ({shortcut})", {
                                  shortcut: props.steerShortcutLabel,
                                })
                          : workflow?.canSendNow
                            ? gt("Start a turn with this message")
                            : workflow?.promoteSkipsCompaction
                              ? gt("Skip compaction and send this message")
                              : gt("Send into the current turn")}
                      </TooltipPopup>
                    </Tooltip>
                  </>
                ) : null}
                {item.pending ? (
                  <span className="flex items-center gap-1 px-1">
                    <Clock3Icon aria-hidden className="size-3" />
                    <T>Saving</T>
                  </span>
                ) : null}
                {isEditing ? (
                  <>
                    <span className="px-1 text-foreground">
                      <T>Editing in the composer</T>
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={gt("Cancel editing queued message")}
                      onClick={props.onCancelEdit}
                    >
                      <T>Cancel</T>
                    </Button>
                  </>
                ) : (
                  <>
                    <Tooltip>
                      {/* The span keeps the tooltip, and its reason, on a disabled button. */}
                      <TooltipTrigger render={<span className="flex shrink-0" />}>
                        <Button
                          size="icon-xs"
                          variant="ghost-muted"
                          aria-label={gt("Edit queued message")}
                          disabled={
                            item.runId === null ||
                            !item.editable ||
                            busyRunId !== null ||
                            props.editBlockedReason !== null
                          }
                          onClick={() => {
                            if (item.runId !== null && item.messageId !== null) {
                              props.onEditQueuedRun({
                                runId: item.runId,
                                messageId: item.messageId,
                                text: item.text,
                                attachments: item.attachments,
                              });
                            }
                          }}
                        >
                          <PencilIcon />
                        </Button>
                      </TooltipTrigger>
                      <TooltipPopup>
                        {props.editBlockedReason ??
                          (item.serverIndex === queued.length - 1 && props.editShortcutLabel
                            ? gt("Edit in the composer ({shortcut})", {
                                shortcut: props.editShortcutLabel,
                              })
                            : gt("Edit in the composer"))}
                      </TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label={gt("Remove queued message")}
                            disabled={item.runId === null || busyRunId !== null}
                            onClick={() => {
                              if (item.runId !== null) void remove(item.runId);
                            }}
                          />
                        }
                      >
                        <XIcon />
                      </TooltipTrigger>
                      <TooltipPopup>
                        <T>Remove from queue</T>
                      </TooltipPopup>
                    </Tooltip>
                  </>
                )}
              </QueuedMessage>
            </li>
          );
        })}
      </ol>
      {collapsible ? (
        <div className="self-end pe-1 text-xs pointer-coarse:[&_[data-slot=inline-button]]:relative pointer-coarse:[&_[data-slot=inline-button]]:after:absolute pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-x-1.5 pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-y-3.5">
          <InlineButton
            tone="muted"
            aria-expanded={showAll}
            aria-controls={queueListId}
            // Keep the composer focused; keyboard activation still works.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll
              ? gt("Show fewer")
              : gt(
                  "{count, plural, one {Show all {count} queued} other {Show all {count} queued}}",
                  { count: items.length },
                )}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                showAll && "rotate-180",
              )}
            />
          </InlineButton>
        </div>
      ) : null}
    </section>
  );
}

type QueuedRunMessage = NonNullable<ThreadQueueProjection["messages"][number]>;

/** A queued turn wears its sent form's attribution; only the dashed edge and controls differ. */
function QueuedMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly message: QueuedRunMessage | undefined;
  readonly previewText: string;
  readonly thumbnails: ReadonlyArray<ChatImageAttachment>;
  readonly isEditing: boolean;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
  readonly children: ReactNode;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const gt = useGT();
  const presentation = props.message ? resolveUserMessagePresentation(props.message) : null;
  const attribution = presentation?.attribution ?? null;
  const scheduledTaskId = presentation?.scheduledTaskId;
  const senderThreadId = props.message?.senderThreadId;
  // A linked environment's agent sent it from a thread there.
  const senderRef =
    props.message?.linkedSender ??
    (senderThreadId === undefined ? null : scopeThreadRef(props.environmentId, senderThreadId));
  const [expanded, setExpanded] = useState(false);
  const taskTitle = useScheduledTaskTitle(props.environmentId, scheduledTaskId);
  const senderShell = useQuietThreadShell(attribution === "agent" ? senderRef : null);
  const linkedSenderEnvironment = useEnvironment(
    props.message?.linkedSender?.environmentId ?? null,
  );
  const senderTitle = senderShell?.title.trim() || props.message?.linkedSender?.title.trim();
  const fold =
    attribution === "automation"
      ? {
          icon: CalendarClockIcon,
          label: gt("Automation"),
          fitLabel: true,
          summary: taskTitle ?? props.previewText.split(/\r?\n/, 1)[0] ?? "",
        }
      : attribution === "agent"
        ? {
            icon: MessagesSquareIcon,
            label:
              senderTitle ||
              gt("Agent", { $context: "fallback name of the agent that sent a message" }),
            fitLabel: !senderTitle,
            summary: props.previewText.split(/\r?\n/).find((line) => line.trim()) ?? "",
          }
        : null;
  const bodyVisible = fold === null || expanded;

  return (
    <>
      {attribution === "t3code" ? (
        <p className="me-1 text-2xs text-muted-foreground/70">
          <T>Sent by T3 Code</T>
        </p>
      ) : null}
      {presentation?.guestName === undefined ? null : (
        <GuestMessageName name={presentation.guestName} />
      )}
      {/* Dashed and unfilled: a turn that has not been sent yet. */}
      <div
        className={cn(
          "flex min-w-0 max-w-[80%] flex-col rounded-2xl border border-dashed text-sm",
          props.isEditing
            ? "border-primary/60 text-foreground"
            : attribution === "guest"
              ? "border-guest/50 text-muted-foreground"
              : "border-muted-foreground/40 text-muted-foreground",
          fold === null && "px-3 py-2",
          fold !== null && expanded && "w-full",
        )}
      >
        {fold ? (
          <FoldedMessageHeader
            icon={fold.icon}
            label={fold.label}
            fitLabel={fold.fitLabel}
            summary={fold.summary}
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
          />
        ) : null}
        {bodyVisible ? (
          <div
            className={cn(
              "flex flex-col gap-2",
              fold !== null && "max-h-96 overflow-auto px-3 pb-2",
            )}
          >
            {props.thumbnails.length > 0 ? (
              <span className="flex flex-wrap items-center gap-1">
                {props.thumbnails.map((thumbnail) => (
                  <button
                    key={thumbnail.id}
                    type="button"
                    aria-label={gt("Preview {name}", { name: thumbnail.name })}
                    disabled={!thumbnail.previewUrl}
                    className="size-8 overflow-hidden rounded-md border border-(--shell-divider)! bg-background enabled:cursor-zoom-in"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => {
                      const preview = buildExpandedImagePreview(props.thumbnails, thumbnail.id);
                      if (preview) props.onImageExpand(preview);
                    }}
                  >
                    {thumbnail.previewUrl ? (
                      <img
                        src={thumbnail.previewUrl}
                        alt={thumbnail.name}
                        className="size-full object-cover"
                      />
                    ) : (
                      <span aria-label={thumbnail.name} className="block size-full bg-muted/60" />
                    )}
                  </button>
                ))}
              </span>
            ) : null}
            {/* In full, like a sent turn: a queued message is read before it is sent. */}
            {props.previewText ? (
              <p className="whitespace-pre-wrap wrap-anywhere">{props.previewText}</p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-0.5 pe-1 text-xs text-muted-foreground">
        {props.message ? (
          <span className="me-1 flex items-center gap-2 px-1 opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/queued:opacity-100">
            {attribution === "agent" &&
            senderRef &&
            // Only an environment this client is connected to can open the sender's thread there.
            (props.message?.linkedSender === undefined || linkedSenderEnvironment !== null) ? (
              <InlineButton
                tone="muted"
                onClick={() => props.onOpenThread(senderRef.threadId, senderRef.environmentId)}
              >
                <T>Open thread</T>
              </InlineButton>
            ) : null}
            {scheduledTaskId ? (
              <InlineButton
                tone="muted"
                render={
                  <Link
                    to="/settings/scheduled-tasks"
                    search={{ environmentId: props.environmentId, taskId: scheduledTaskId }}
                  />
                }
              >
                <T>Open automation</T>
              </InlineButton>
            ) : null}
            <TimelineRowTimestamp
              createdAt={DateTime.formatIso(props.message.createdAt)}
              timestampFormat={props.timestampFormat}
              alwaysVisible
            />
          </span>
        ) : null}
        {props.children}
      </div>
    </>
  );
}

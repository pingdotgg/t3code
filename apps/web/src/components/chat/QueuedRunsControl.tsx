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
  GripVerticalIcon,
  CornerUpRightIcon,
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
import {
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { threadEnvironment } from "../../state/threads";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { isImageAttachment, type ChatImageAttachment, type ChatMessage } from "../../types";
import { cn } from "~/lib/utils";
import { Button, InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import { AttachmentImage } from "../media/AttachmentImage";
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
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun);
  // The row being dragged and the row it would land before (null: the end).
  const [drag, setDrag] = useState<{ runId: RunId; beforeRunId: RunId | null } | null>(null);
  const draggedRunId = drag?.runId ?? null;
  const [showAll, setShowAll] = useState(false);
  const queueListId = useId();
  const queueListRef = useRef<HTMLOListElement>(null);
  const previousRowTops = useRef(new Map<string, number>());
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- animates queue rows from their previous layout after a drag preview or persisted reorder
  useLayoutEffect(() => {
    const nextTops = new Map<string, number>();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const row of queueListRef.current?.querySelectorAll<HTMLElement>("[data-queue-key]") ??
      []) {
      const key = row.dataset.queueKey!;
      const nextTop = row.offsetTop;
      const previousTop = previousRowTops.current.get(key);
      nextTops.set(key, nextTop);
      if (!reducedMotion && previousTop !== undefined && previousTop !== nextTop) {
        row.animate(
          [{ transform: `translateY(${previousTop - nextTop}px)` }, { transform: "translateY(0)" }],
          { duration: 160, easing: "ease-out" },
        );
      }
    }
    previousRowTops.current = nextTops;
  });

  if (items.length === 0) return null;

  const remove = async (runId: RunId) => {
    setBusyRunId(runId);
    await cancel({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId },
    });
    setBusyRunId(null);
  };

  const previewItems = [...items];
  const draggedIndex = previewItems.findIndex((item) => item.runId === draggedRunId);
  if (draggedRunId !== null && draggedIndex >= 0) {
    const [dragged] = previewItems.splice(draggedIndex, 1);
    const beforeIndex = previewItems.findIndex((item) => item.runId === drag?.beforeRunId);
    previewItems.splice(beforeIndex < 0 ? previewItems.length : beforeIndex, 0, dragged!);
  }
  const collapsible = items.length > QUEUE_VISIBLE_ROWS;
  const visibleItems =
    collapsible && !showAll ? previewItems.slice(0, QUEUE_VISIBLE_ROWS - 1) : previewItems;

  return (
    <section
      aria-label={gt(
        "{count, plural, one {{count} queued message} other {{count} queued messages}}",
        { count: items.length },
      )}
      data-thread-queue="true"
      // Anchors the sr-only live region; unanchored, it escapes the timeline scroller and makes the chat column scroll.
      className="relative flex w-full min-w-0 flex-col px-2 py-1 text-meta"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setDrag(null);
        }
      }}
      onDragOver={(event) => {
        if (draggedRunId) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (drag && drag.runId !== drag.beforeRunId)
          void reorder({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, runId: drag.runId, beforeRunId: drag.beforeRunId },
          });
        setDrag(null);
      }}
    >
      <span className="sr-only" aria-live="polite">
        {gt("{count, plural, one {{count} queued} other {{count} queued}}", {
          count: items.length,
        })}
      </span>
      <ol ref={queueListRef} className="flex flex-col" id={queueListId}>
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
              data-queue-key={item.key}
              aria-label={gt("Queued message {position} of {total}, not sent", {
                position: position + 1,
                total: items.length,
              })}
              aria-posinset={position + 1}
              aria-setsize={items.length}
              aria-current={isEditing ? "true" : undefined}
              className={cn(
                "group/queued flex min-h-7 w-full min-w-0 items-center gap-1 rounded-control px-1 text-dim-foreground hover:bg-foreground/5 hover:text-muted-foreground focus-within:text-muted-foreground",
                draggedRunId === item.runId && "bg-foreground/8 shadow-md",
              )}
              onDragOver={(event) => {
                if (drag && item.runId !== drag.runId) {
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setDrag({
                    runId: drag.runId,
                    beforeRunId:
                      event.clientY < bounds.top + bounds.height / 2
                        ? item.runId
                        : (previewItems
                            .slice(position + 1)
                            .find((next) => next.runId !== drag.runId)?.runId ?? null),
                  });
                }
              }}
            >
              <Button
                size="icon-xs"
                variant="ghost-muted"
                // Puts the grip's ink, not its padding, on the composer's text line.
                className="-ms-2 sm:-ms-1.5"
                aria-label={gt("Reorder queued message {position}", { position: position + 1 })}
                disabled={item.runId === null || busyRunId !== null}
                draggable={item.runId !== null}
                onDragStart={(event) => {
                  if (!item.runId) return;
                  event.dataTransfer.setData("text/plain", item.runId);
                  event.dataTransfer.effectAllowed = "move";
                  setShowAll(true);
                  setDrag({ runId: item.runId, beforeRunId: items[position + 1]?.runId ?? null });
                }}
                onDragEnd={() => setDrag(null)}
                onKeyDown={(event) => {
                  if (!item.runId || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                  event.preventDefault();
                  const next = position + (event.key === "ArrowUp" ? -1 : 2);
                  if (next < 0 || (position === items.length - 1 && event.key === "ArrowDown"))
                    return;
                  void reorder({
                    environmentId: props.environmentId,
                    input: {
                      threadId: props.threadId,
                      runId: item.runId,
                      beforeRunId: items[next]?.runId ?? null,
                    },
                  });
                }}
              >
                <GripVerticalIcon />
              </Button>
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
                          <CornerUpRightIcon />
                          {workflow?.canSendNow ? (
                            <T>Send now</T>
                          ) : (
                            gt("Steer", {
                              $context: "verb, steers the running turn with this message",
                            })
                          )}
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
                            className="-me-1 sm:-me-[3px]"
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
        <div className="self-end pe-2.25 text-meta pointer-coarse:[&_[data-slot=inline-button]]:relative pointer-coarse:[&_[data-slot=inline-button]]:after:absolute pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-x-1.5 pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-y-3.5">
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
  const thumbnail = props.thumbnails[0];

  return (
    <>
      {attribution === "t3code" ? (
        <p className="me-1 text-micro text-dim-foreground">
          <T>Sent by T3 Code</T>
        </p>
      ) : null}
      {presentation?.guestName === undefined ? null : (
        <GuestMessageName name={presentation.guestName} />
      )}
      {/* Dashed: a turn that has not been sent yet. */}
      <div
        className={cn(
          "min-w-0 flex-1 text-body",
          props.isEditing
            ? "border-primary/60 text-foreground"
            : attribution === "guest"
              ? "border-guest/50 text-muted-foreground"
              : "border-muted-foreground/40 text-muted-foreground",
          fold === null && "py-1",
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
              "flex min-w-0 items-center gap-2",
              fold !== null && "max-h-96 overflow-auto px-3 pb-2",
            )}
          >
            {thumbnail ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={gt("Preview {name}", { name: thumbnail.name })}
                      disabled={!thumbnail.previewUrl}
                      className="flex shrink-0 enabled:cursor-zoom-in"
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => {
                        const preview = buildExpandedImagePreview(props.thumbnails, thumbnail.id);
                        if (preview) props.onImageExpand(preview);
                      }}
                    />
                  }
                >
                  <span className="flex items-center gap-1">
                    <span className="size-[1lh] shrink-0 overflow-hidden rounded-md border border-border/70 bg-background">
                      {thumbnail.previewUrl ? (
                        <AttachmentImage
                          src={thumbnail.previewUrl}
                          name={thumbnail.name}
                          alt={thumbnail.name}
                          className="size-full object-cover"
                        />
                      ) : (
                        <span aria-label={thumbnail.name} className="block size-full bg-muted/60" />
                      )}
                    </span>
                    {props.thumbnails.length > 1 ? (
                      <span>+{props.thumbnails.length - 1}</span>
                    ) : null}
                  </span>
                </TooltipTrigger>
                <TooltipPopup className="whitespace-pre-wrap">
                  {props.thumbnails.map((image) => image.name).join("\n")}
                </TooltipPopup>
              </Tooltip>
            ) : null}
            {/* In full, like a sent turn: a queued message is read before it is sent. */}
            {props.previewText ? (
              <p
                className={
                  fold && expanded ? "min-w-0 whitespace-pre-wrap wrap-anywhere" : "truncate"
                }
              >
                {props.previewText}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 text-meta text-dim-foreground">
        {props.message ? (
          <span className="flex items-center gap-1">
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
                Open automation
              </InlineButton>
            ) : null}
            <span className="sr-only">
              <TimelineRowTimestamp
                createdAt={DateTime.formatIso(props.message.createdAt)}
                timestampFormat={props.timestampFormat}
                alwaysVisible
              />
            </span>
          </span>
        ) : null}
        {props.children}
      </div>
    </>
  );
}

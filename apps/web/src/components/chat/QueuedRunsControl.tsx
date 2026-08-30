import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import type {
  ChatAttachment as ContractChatAttachment,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  Clock3Icon,
  CornerUpRightIcon,
  GripVerticalIcon,
  ListOrderedIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { threadEnvironment } from "../../state/threads";
import { useThreadProjection } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { isImageAttachment, type ChatMessage } from "../../types";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface EditQueuedRunRequest {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ContractChatAttachment>;
}

interface QueuedRowThumbnail {
  readonly key: string;
  readonly name: string;
  readonly url: string | null;
}

const QUEUED_RUN_DRAG_TYPE = "application/x-t3code-queued-run";

export function QueuedRunsControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly optimisticMessages: ReadonlyArray<
    Pick<ChatMessage, "id" | "inputIntent" | "text" | "attachments">
  >;
  /** Row currently loaded into the composer for editing; hidden from the list. */
  readonly editingRunId: RunId | null;
  readonly onEditQueuedRun: (request: EditQueuedRunRequest) => void;
}) {
  const projection = useThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.projection;
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun);
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const [expanded, setExpanded] = useState(true);
  const queueListId = useId();
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  // Live drag-reorder state: the dragged run and the queue index the row
  // would be inserted at (0..queued.length) as of the latest dragover.
  const [dragState, setDragState] = useState<{
    readonly runId: RunId;
    readonly insertIndex: number | null;
  } | null>(null);
  // Drags must start from the grip, not from an accidental text-drag on the
  // row. The grip arms its run id on pointerdown; dragstart verifies it.
  const dragArmedRunIdRef = useRef<RunId | null>(null);
  const workflow = useMemo(
    () => (projection ? deriveThreadQueueWorkflowState(projection) : null),
    [projection],
  );
  const queued = workflow?.queuedRuns ?? [];
  const activeRun = workflow?.activeRun ?? null;
  const canReorder = workflow?.canReorder === true;
  const queuedImageAttachmentIds = useMemo(() => {
    const ids: string[] = [];
    for (const { attachments } of workflow?.queuedRuns ?? []) {
      for (const attachment of attachments) {
        if (attachment.type === "image") ids.push(attachment.id);
      }
    }
    return ids;
  }, [workflow]);
  const queuedImageAttachmentResources = useMemo(
    () =>
      queuedImageAttachmentIds.map((attachmentId) => ({
        _tag: "attachment" as const,
        attachmentId,
      })),
    [queuedImageAttachmentIds],
  );
  const queuedImageAttachmentUrls = useAssetUrls(
    props.environmentId,
    queuedImageAttachmentResources,
  );
  const queuedImageUrlById = useMemo(
    () =>
      new Map(
        queuedImageAttachmentIds.flatMap((attachmentId, index) => {
          const url = queuedImageAttachmentUrls[index];
          return url ? [[attachmentId, url] as const] : [];
        }),
      ),
    [queuedImageAttachmentIds, queuedImageAttachmentUrls],
  );
  // Once the projection holds the message the optimistic copy is stale no
  // matter what happened to its run — keying on still-queued runs alone would
  // resurrect a phantom "pending" row after the run is cancelled or started.
  const acknowledgedMessageIds = useMemo(
    () => new Set((projection?.messages ?? []).map((message) => message.id)),
    [projection],
  );
  const optimisticQueued = props.optimisticMessages.filter(
    (message) => message.inputIntent === "queued_turn" && !acknowledgedMessageIds.has(message.id),
  );
  const items = [
    ...queued.map(({ run, text, attachments }, serverIndex) => ({
      key: run.id,
      runId: run.id,
      messageId: run.userMessageId,
      serverIndex,
      text,
      attachments,
      thumbnails: attachments
        .filter((attachment) => attachment.type === "image")
        .map<QueuedRowThumbnail>((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          url: queuedImageUrlById.get(attachment.id) ?? null,
        })),
      pending: false,
    })),
    ...optimisticQueued.map((message) => ({
      key: message.id,
      runId: null,
      messageId: null,
      serverIndex: null,
      text: message.text,
      attachments: [] as ReadonlyArray<ContractChatAttachment>,
      thumbnails: (message.attachments ?? [])
        .filter(isImageAttachment)
        .map<QueuedRowThumbnail>((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          url: attachment.previewUrl ?? null,
        })),
      pending: true,
    })),
  ].filter((item) => item.runId === null || item.runId !== props.editingRunId);

  if (items.length === 0) return null;

  const move = async (runId: RunId, beforeRunId: RunId | null) => {
    setBusyRunId(runId);
    try {
      await reorder({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId, beforeRunId },
      });
    } finally {
      setBusyRunId(null);
    }
  };

  const completeDrag = (runId: RunId, insertIndex: number | null) => {
    setDragState(null);
    dragArmedRunIdRef.current = null;
    if (insertIndex === null || busyRunId !== null) return;
    const draggedIndex = queued.findIndex(({ run }) => run.id === runId);
    if (draggedIndex === -1) return;
    // Inserting immediately before or after itself is a no-op.
    if (insertIndex === draggedIndex || insertIndex === draggedIndex + 1) return;
    void move(runId, queued[insertIndex]?.run.id ?? null);
  };

  const steer = async (queuedRunId: RunId) => {
    if (activeRun === null) return;
    setBusyRunId(queuedRunId);
    try {
      await promote({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, queuedRunId, targetRunId: activeRun.id },
      });
    } finally {
      setBusyRunId(null);
    }
  };

  const remove = async (runId: RunId) => {
    setBusyRunId(runId);
    try {
      await cancel({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId },
      });
    } finally {
      setBusyRunId(null);
    }
  };

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        role="region"
        aria-label={`${items.length} queued message${items.length === 1 ? "" : "s"}`}
        aria-live="polite"
        className="relative z-0"
      >
        <ComposerBanner.Row
          render={<button type="button" />}
          aria-label={expanded ? "Collapse queued messages" : "Expand queued messages"}
          aria-expanded={expanded}
          aria-controls={queueListId}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setExpanded((value) => !value)}
        >
          <ComposerBanner.Icon>
            <ListOrderedIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="text-muted-foreground">Queued</ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Count>{items.length}</ComposerBanner.Count>
            <ComposerBanner.ToggleIcon expanded={expanded} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        <ComposerBanner.Scroll className={cn("max-h-32", !expanded && "hidden")}>
          <ol id={queueListId}>
            {items.map((item, index) => {
              const rowRunId = item.runId;
              const rowServerIndex = item.serverIndex;
              const rowDraggable =
                rowRunId !== null && rowServerIndex !== null && canReorder && busyRunId === null;
              return (
                <li
                  key={item.key}
                  className={cn(
                    "relative flex min-w-0 items-center gap-1 border-border/45 border-t py-1 first:border-t-0",
                    dragState !== null && dragState.runId === item.runId && "opacity-50",
                  )}
                  draggable={rowDraggable}
                  onDragStart={(event) => {
                    if (item.runId === null || dragArmedRunIdRef.current !== item.runId) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.setData(QUEUED_RUN_DRAG_TYPE, item.runId);
                    event.dataTransfer.effectAllowed = "move";
                    setDragState({ runId: item.runId, insertIndex: null });
                  }}
                  onDragEnd={() => {
                    dragArmedRunIdRef.current = null;
                    setDragState(null);
                  }}
                  onDragOver={(event) => {
                    if (dragState === null || item.serverIndex === null) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const rect = event.currentTarget.getBoundingClientRect();
                    const insertIndex =
                      event.clientY < rect.top + rect.height / 2
                        ? item.serverIndex
                        : item.serverIndex + 1;
                    if (dragState.insertIndex !== insertIndex) {
                      setDragState({ runId: dragState.runId, insertIndex });
                    }
                  }}
                  onDrop={(event) => {
                    if (dragState === null) return;
                    event.preventDefault();
                    completeDrag(dragState.runId, dragState.insertIndex);
                  }}
                >
                  {item.serverIndex !== null && dragState?.insertIndex === item.serverIndex ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded bg-primary/70"
                    />
                  ) : null}
                  {item.serverIndex === queued.length - 1 &&
                  dragState?.insertIndex === queued.length ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded bg-primary/70"
                    />
                  ) : null}
                  {canReorder && rowRunId !== null && rowServerIndex !== null ? (
                    <button
                      type="button"
                      aria-label="Reorder queued message (drag, or press the arrow keys)"
                      className="flex size-5 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground focus-visible:outline-2 active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
                      disabled={busyRunId !== null}
                      onPointerDown={() => {
                        dragArmedRunIdRef.current = rowRunId;
                      }}
                      onKeyDown={(event) => {
                        if (busyRunId !== null) return;
                        if (event.key === "ArrowUp" && rowServerIndex > 0) {
                          event.preventDefault();
                          void move(rowRunId, queued[rowServerIndex - 1]?.run.id ?? null);
                        }
                        if (event.key === "ArrowDown" && rowServerIndex < queued.length - 1) {
                          event.preventDefault();
                          void move(rowRunId, queued[rowServerIndex + 2]?.run.id ?? null);
                        }
                      }}
                    >
                      <GripVerticalIcon className="size-3" />
                    </button>
                  ) : (
                    <span className="w-5 shrink-0" />
                  )}
                  <span className="w-4 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground/65">
                    {index + 1}
                  </span>
                  {item.pending ? (
                    <Clock3Icon
                      aria-label="Saving queued message"
                      className="size-3 shrink-0 text-muted-foreground/60"
                    />
                  ) : null}
                  {item.thumbnails.length > 0 ? (
                    <span className="flex shrink-0 items-center gap-0.5">
                      {item.thumbnails.map((thumbnail) => (
                        <span
                          key={thumbnail.key}
                          className="size-5 overflow-hidden rounded border border-border/70 bg-background"
                        >
                          {thumbnail.url ? (
                            <img
                              src={thumbnail.url}
                              alt={thumbnail.name}
                              className="size-full object-cover"
                            />
                          ) : (
                            <span
                              aria-label={thumbnail.name}
                              className="block size-full bg-muted/60"
                            />
                          )}
                        </span>
                      ))}
                    </span>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger render={<span className="min-w-0 flex-1 truncate text-xs" />}>
                      {item.text}
                    </TooltipTrigger>
                    <TooltipPopup side="top" className="max-w-96 break-words">
                      {item.text}
                    </TooltipPopup>
                  </Tooltip>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Edit queued message"
                    className="size-6 text-muted-foreground"
                    disabled={item.runId === null || busyRunId !== null}
                    title="Edit in the composer"
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
                    <PencilIcon className="size-3" />
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                    disabled={
                      item.runId === null || busyRunId !== null || !workflow?.canPromoteToSteer
                    }
                    title={
                      activeRun === null
                        ? "There is no active run to steer"
                        : "Send as a steer instead"
                    }
                    onClick={() => {
                      if (item.runId !== null) {
                        void steer(item.runId);
                      }
                    }}
                  >
                    <CornerUpRightIcon className="size-3" />
                    Steer
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Remove queued message"
                    className="size-6 text-muted-foreground"
                    disabled={item.runId === null || busyRunId !== null}
                    title="Remove from queue"
                    onClick={() => {
                      if (item.runId !== null) void remove(item.runId);
                    }}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </li>
              );
            })}
          </ol>
        </ComposerBanner.Scroll>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

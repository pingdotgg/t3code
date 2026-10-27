import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import type {
  ChatAttachment as ContractChatAttachment,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, Clock3Icon, ArrowUpIcon, PencilIcon, XIcon } from "lucide-react";
import { useId, useImperativeHandle, useRef, useState, type Ref } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { threadEnvironment } from "../../state/threads";
import { useThreadProjection } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { isImageAttachment, type ChatMessage } from "../../types";
import { cn } from "~/lib/utils";
import { Button, InlineButton } from "../ui/button";
import { Separator } from "../ui/separator";
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
      attachment.type === "image"
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
}) {
  const projection = useThreadProjection(
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
  const workflow = projection ? deriveThreadQueueWorkflowState(projection) : null;
  const queued = workflow?.queuedRuns ?? [];
  const activeRun = workflow?.activeRun ?? null;
  const canSend = workflow?.canSendNow === true || workflow?.canPromoteToSteer === true;
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
    ...queued.map(({ run, text, attachments, context }, serverIndex) => ({
      key: run.id,
      runId: run.id,
      messageId: run.userMessageId,
      serverIndex,
      text,
      // A guest's message keeps the guest's words; the owner can cancel it, not rewrite it.
      editable: context?.guest === undefined,
      guestName: context?.guest?.name,
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
      editable: true,
      guestName: undefined,
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
  ];

  const sendQueuedMessage = async (queuedRunId: RunId) => {
    if (!canSend || steerInFlightRef.current) return;
    steerInFlightRef.current = true;
    setBusyRunId(queuedRunId);
    if (workflow?.canSendNow) {
      await resume({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId: queuedRunId },
      });
    } else if (activeRun !== null) {
      await promote({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, queuedRunId, targetRunId: activeRun.id },
      });
    }
    steerInFlightRef.current = false;
    setBusyRunId(null);
  };

  useImperativeHandle(ref, () => ({
    steerNext(repeat) {
      const next = queued[0];
      if (!next || !canSend) return false;
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
      aria-label={`${items.length} queued message${items.length === 1 ? "" : "s"}`}
      data-thread-queue="true"
      className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 pb-4"
    >
      <span className="sr-only" aria-live="polite">
        {items.length} queued
      </span>
      <ol className="flex flex-col items-end gap-3" id={queueListId}>
        {visibleItems.map((item, position) => {
          const previewText = assistantCitationsToPlainText(
            replaceComposerContextReferences(item.text, (reference) =>
              reference.kind === "image" && item.thumbnails.length > 0 ? "" : reference.label,
            ),
          ).trim();
          const isEditing = item.runId !== null && item.runId === props.editingRunId;
          return (
            <li
              key={item.key}
              aria-label={`Queued message ${position + 1} of ${items.length}, not sent`}
              aria-posinset={position + 1}
              aria-setsize={items.length}
              aria-current={isEditing ? "true" : undefined}
              className="flex w-full flex-col items-end gap-1 transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none"
            >
              {/* Dashed and unfilled: a turn that has not been sent yet. */}
              <div
                className={cn(
                  "flex min-w-0 max-w-[80%] flex-col gap-2 rounded-2xl border border-dashed px-3 py-2 text-sm",
                  isEditing
                    ? "border-primary/60 text-foreground"
                    : "border-muted-foreground/40 text-muted-foreground",
                )}
              >
                {item.thumbnails.length > 0 ? (
                  <span className="flex flex-wrap items-center gap-1">
                    {item.thumbnails.map((thumbnail) => (
                      <span
                        key={thumbnail.key}
                        className="size-8 overflow-hidden rounded-md border border-border/70 bg-background"
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
                {/* In full, like a sent turn: a queued message is read before it is sent. */}
                {previewText ? (
                  <p className="whitespace-pre-wrap wrap-anywhere">
                    {item.guestName === undefined ? null : (
                      <span className="text-guest-foreground">{item.guestName} </span>
                    )}
                    {previewText}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-0.5 pe-1 text-xs text-muted-foreground">
                {canSend && !isEditing ? (
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
                          Send now
                        </Button>
                      </TooltipTrigger>
                      <TooltipPopup>
                        {`${workflow?.canSendNow ? "Start a turn with this message" : workflow?.promoteSkipsCompaction ? "Skip compaction and send this message" : "Send into the current turn"}${item.serverIndex === 0 && props.steerShortcutLabel ? ` (${props.steerShortcutLabel})` : ""}`}
                      </TooltipPopup>
                    </Tooltip>
                    <Separator orientation="vertical" className="mx-2 h-4" />
                  </>
                ) : null}
                {item.pending ? (
                  <span className="flex items-center gap-1 px-1">
                    <Clock3Icon aria-hidden className="size-3" />
                    Saving
                  </span>
                ) : null}
                {isEditing ? (
                  <>
                    <span className="px-1 text-foreground">Editing in the composer</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label="Cancel editing queued message"
                      onClick={props.onCancelEdit}
                    >
                      Cancel
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
                          aria-label="Edit queued message"
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
                          `Edit in the composer${item.serverIndex === queued.length - 1 && props.editShortcutLabel ? ` (${props.editShortcutLabel})` : ""}`}
                      </TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label="Remove queued message"
                            disabled={item.runId === null || busyRunId !== null}
                            onClick={() => {
                              if (item.runId !== null) void remove(item.runId);
                            }}
                          />
                        }
                      >
                        <XIcon />
                      </TooltipTrigger>
                      <TooltipPopup>Remove from queue</TooltipPopup>
                    </Tooltip>
                  </>
                )}
              </div>
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
            {showAll ? "Show fewer" : `Show all ${items.length} queued`}
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

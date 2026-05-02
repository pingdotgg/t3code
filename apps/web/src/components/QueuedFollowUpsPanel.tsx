import {
  BookmarkPlusIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CheckIcon,
  PencilIcon,
  SendHorizontalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "../lib/utils";
import type { QueuedTurnDraft } from "../queuedTurnStore";
import { Button } from "./ui/button";

interface QueuedFollowUpsPanelProps {
  queuedItems: readonly QueuedTurnDraft[];
  canSendNow: boolean;
  onSendNow: (draft: QueuedTurnDraft) => void;
  onSaveAsSnippet: (draft: QueuedTurnDraft) => void;
  onDelete: (draft: QueuedTurnDraft) => void;
  onClearAll: () => void;
  onMove: (draft: QueuedTurnDraft, nextIndex: number) => void;
  onReplaceText: (draft: QueuedTurnDraft, nextText: string) => void;
}

const PREVIEW_MAX_CHARS = 120;

function summarizeQueuedTurn(turn: QueuedTurnDraft): string {
  const normalized = turn.text.trim().replace(/\s+/g, " ");
  if (normalized.length > 0) {
    return normalized.length <= PREVIEW_MAX_CHARS
      ? normalized
      : `${normalized.slice(0, PREVIEW_MAX_CHARS - 1)}…`;
  }
  if (turn.images.length > 0) {
    return turn.images.length === 1
      ? "1 image attachment"
      : `${turn.images.length} image attachments`;
  }
  if (turn.terminalContexts.length > 0) {
    return turn.terminalContexts.length === 1
      ? "1 terminal context"
      : `${turn.terminalContexts.length} terminal contexts`;
  }
  return "Queued follow-up";
}

export function QueuedFollowUpsPanel({
  queuedItems,
  canSendNow,
  onSendNow,
  onSaveAsSnippet,
  onDelete,
  onClearAll,
  onMove,
  onReplaceText,
}: QueuedFollowUpsPanelProps) {
  const rowRefs = useRef(new Map<string, HTMLLIElement | null>());

  const focusRowAtIndex = useCallback(
    (index: number) => {
      const target = queuedItems[index];
      if (!target) {
        return;
      }
      rowRefs.current.get(target.id)?.focus();
    },
    [queuedItems],
  );

  if (queuedItems.length === 0) {
    return null;
  }

  return (
    <div
      className="mb-2 rounded-xl border border-border/70 bg-muted/20 p-2"
      data-testid="queued-follow-ups-panel"
      aria-label="Queued follow-up messages"
    >
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">
            {queuedItems.length === 1
              ? "1 queued follow-up"
              : `${queuedItems.length} queued follow-ups`}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {canSendNow ? "Ready to dispatch in order." : "Waiting for the current turn to settle."}
          </p>
          <p className="text-[11px] text-muted-foreground/80">
            `Alt+Up/Down` switches rows. `Alt+Shift+Up/Down` reorders them.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 rounded-full px-3 text-[11px] text-muted-foreground"
          onClick={onClearAll}
        >
          Clear all
        </Button>
      </div>

      <ul className="flex flex-col gap-1">
        {queuedItems.map((item, index) => (
          <QueuedFollowUpRow
            key={item.id}
            item={item}
            isNext={index === 0}
            canSendNow={canSendNow}
            onSendNow={() => onSendNow(item)}
            onSaveAsSnippet={() => onSaveAsSnippet(item)}
            onDelete={() => onDelete(item)}
            onMoveToIndex={(nextIndex) => {
              onMove(item, nextIndex);
              queueMicrotask(() => focusRowAtIndex(nextIndex));
            }}
            onFocusRowIndex={focusRowAtIndex}
            rowRef={(node) => {
              if (node) {
                rowRefs.current.set(item.id, node);
              } else {
                rowRefs.current.delete(item.id);
              }
            }}
            onReplaceText={(nextText) => onReplaceText(item, nextText)}
            index={index}
            totalRows={queuedItems.length}
          />
        ))}
      </ul>
    </div>
  );
}

function QueuedFollowUpRow(props: {
  item: QueuedTurnDraft;
  isNext: boolean;
  canSendNow: boolean;
  onSendNow: () => void;
  onSaveAsSnippet: () => void;
  onDelete: () => void;
  onMoveToIndex: (nextIndex: number) => void;
  onFocusRowIndex: (index: number) => void;
  rowRef: (node: HTMLLIElement | null) => void;
  onReplaceText: (nextText: string) => void;
  index: number;
  totalRows: number;
}) {
  const {
    item,
    isNext,
    canSendNow,
    onSendNow,
    onSaveAsSnippet,
    onDelete,
    onMoveToIndex,
    onFocusRowIndex,
    rowRef,
    onReplaceText,
    index,
    totalRows,
  } = props;
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(item.text);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canSaveAsSnippet = item.text.trim().length > 0;
  const canMoveUp = index > 0;
  const canMoveDown = index < totalRows - 1;

  useEffect(() => {
    if (!editing) {
      setDraftText(item.text);
    }
  }, [editing, item.text]);

  useEffect(() => {
    if (!editing || !textareaRef.current) {
      return;
    }
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(
      textareaRef.current.value.length,
      textareaRef.current.value.length,
    );
  }, [editing]);

  const handleSave = useCallback(() => {
    onReplaceText(draftText);
    setEditing(false);
  }, [draftText, onReplaceText]);

  const handleCancel = useCallback(() => {
    setDraftText(item.text);
    setEditing(false);
  }, [item.text]);

  return (
    <li
      ref={rowRef}
      className={cn(
        "rounded-lg border border-transparent bg-background/70 px-2 py-2 focus-visible:border-border/70 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60",
        isNext && "border-border/70 bg-background",
      )}
      data-testid={`queued-follow-up-${item.id}`}
      tabIndex={editing ? -1 : 0}
      aria-label={`Queued follow-up ${index + 1} of ${totalRows}${isNext ? ", next up" : ""}`}
      onKeyDown={(event) => {
        if (editing || !event.altKey || event.metaKey || event.ctrlKey) {
          return;
        }
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
          return;
        }
        event.preventDefault();
        const nextIndex = event.key === "ArrowUp" ? index - 1 : index + 1;
        if (nextIndex < 0 || nextIndex >= totalRows) {
          return;
        }
        if (event.shiftKey) {
          onMoveToIndex(nextIndex);
          return;
        }
        onFocusRowIndex(nextIndex);
      }}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-0.5 inline-flex min-w-[2.75rem] items-center justify-center rounded-full px-2 py-0.5 text-[10px] font-medium",
            isNext ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
          )}
        >
          {isNext ? "Next up" : "Queued"}
        </span>

        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex flex-col gap-2">
              <textarea
                ref={textareaRef}
                className="min-h-[4rem] w-full resize-y rounded-md border border-border bg-background p-2 text-xs text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                value={draftText}
                onChange={(event) => setDraftText(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    handleSave();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    handleCancel();
                  }
                }}
              />
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full px-3 text-xs"
                  onClick={handleSave}
                >
                  <CheckIcon className="size-3" />
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 rounded-full px-3 text-xs text-muted-foreground"
                  onClick={handleCancel}
                >
                  <XIcon className="size-3" />
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <p className="truncate text-sm text-foreground" title={item.text}>
                {summarizeQueuedTurn(item)}
              </p>
              {(item.images.length > 0 || item.terminalContexts.length > 0) && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {[
                    item.images.length > 0
                      ? `${item.images.length} image${item.images.length === 1 ? "" : "s"}`
                      : null,
                    item.terminalContexts.length > 0
                      ? `${item.terminalContexts.length} terminal context${item.terminalContexts.length === 1 ? "" : "s"}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
            </>
          )}
        </div>

        {!editing ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full text-muted-foreground"
              aria-label="Move queued follow-up up"
              disabled={!canMoveUp}
              onClick={() => onMoveToIndex(index - 1)}
            >
              <ChevronUpIcon className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full text-muted-foreground"
              aria-label="Move queued follow-up down"
              disabled={!canMoveDown}
              onClick={() => onMoveToIndex(index + 1)}
            >
              <ChevronDownIcon className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full text-muted-foreground"
              aria-label="Edit queued follow-up"
              onClick={() => setEditing(true)}
            >
              <PencilIcon className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full text-muted-foreground"
              aria-label="Save queued follow-up as snippet"
              disabled={!canSaveAsSnippet}
              onClick={onSaveAsSnippet}
            >
              <BookmarkPlusIcon className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full text-muted-foreground"
              aria-label="Send queued follow-up now"
              disabled={!canSendNow}
              onClick={onSendNow}
            >
              <SendHorizontalIcon className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full text-muted-foreground hover:text-destructive"
              aria-label="Remove queued follow-up"
              onClick={onDelete}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

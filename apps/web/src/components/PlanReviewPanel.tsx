import { memo, useCallback, useEffect, useMemo, useRef, useState, type Ref } from "react";
import {
  ArrowLeftIcon,
  CheckIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";

import type { ProposedPlan } from "../types";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "../proposedPlan";
import { normalizePlanReviewSelectionText, type PlanReviewAnnotation } from "../proposedPlanReview";
import { randomUUID } from "../lib/utils";
import ChatMarkdown from "./ChatMarkdown";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";
import { stackedThreadToast, toastManager } from "./ui/toast";

const MAX_PLAN_REVIEW_QUOTE_LENGTH = 8_000;

interface SelectionActionState {
  quote: string;
  x: number;
  y: number;
}

interface CommentEditorState {
  mode: "create" | "edit";
  quote: string;
  annotationId?: string;
  comment: string;
  position?: {
    x: number;
    y: number;
  };
}

interface PlanReviewPanelProps {
  proposedPlan: ProposedPlan;
  markdownCwd: string | undefined;
  annotations: readonly PlanReviewAnnotation[];
  onAnnotationsChange: (annotations: PlanReviewAnnotation[]) => void;
  onDone: () => void;
  onBack: () => void;
}

function isSelectionInsideRoot(selection: Selection, root: HTMLElement): boolean {
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) {
    return false;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;

  return (
    root.contains(anchorNode) &&
    root.contains(focusNode) &&
    commonAncestor !== null &&
    root.contains(commonAncestor)
  );
}

function getSelectionActionPosition(range: Range): { x: number; y: number } | null {
  const primaryRect = range.getBoundingClientRect();
  const rect =
    primaryRect.width > 0 || primaryRect.height > 0
      ? primaryRect
      : (Array.from(range.getClientRects())[0] ?? null);
  if (!rect) {
    return null;
  }

  return {
    x: Math.min(window.innerWidth - 96, Math.max(12, rect.right - 16)),
    y: Math.min(window.innerHeight - 52, Math.max(12, rect.bottom + 8)),
  };
}

function getCommentEditorPosition(position: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.max(12, Math.min(window.innerWidth - 372, position.x - 272)),
    y: Math.max(12, Math.min(window.innerHeight - 260, position.y)),
  };
}

export const PlanReviewPanel = memo(function PlanReviewPanel({
  proposedPlan,
  markdownCwd,
  annotations,
  onAnnotationsChange,
  onDone,
  onBack,
}: PlanReviewPanelProps) {
  const markdownRootRef = useRef<HTMLDivElement>(null);
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [selectionAction, setSelectionAction] = useState<SelectionActionState | null>(null);
  const [commentEditor, setCommentEditor] = useState<CommentEditorState | null>(null);
  const displayedPlanMarkdown = useMemo(
    () => stripDisplayedPlanMarkdown(proposedPlan.planMarkdown),
    [proposedPlan.planMarkdown],
  );
  const title = proposedPlanTitle(proposedPlan.planMarkdown) ?? "Proposed plan";

  const readSelection = useCallback(() => {
    const root = markdownRootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setSelectionAction(null);
      return;
    }
    if (!isSelectionInsideRoot(selection, root)) {
      setSelectionAction(null);
      return;
    }

    const quote = normalizePlanReviewSelectionText(selection.toString());
    if (quote.length === 0) {
      setSelectionAction(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const position = getSelectionActionPosition(range);
    if (!position) {
      setSelectionAction(null);
      return;
    }

    const cappedQuote =
      quote.length > MAX_PLAN_REVIEW_QUOTE_LENGTH
        ? quote.slice(0, MAX_PLAN_REVIEW_QUOTE_LENGTH).trimEnd()
        : quote;
    if (cappedQuote.length !== quote.length) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Selection shortened",
          description: "Plan review quotes are limited to 8,000 characters.",
        }),
      );
    }

    setSelectionAction({
      quote: cappedQuote,
      x: position.x,
      y: position.y,
    });
  }, []);

  const scheduleSelectionRead = useCallback(() => {
    window.setTimeout(readSelection, 0);
  }, [readSelection]);

  const handleStartComment = useCallback(() => {
    if (!selectionAction) {
      return;
    }
    setCommentEditor({
      mode: "create",
      quote: selectionAction.quote,
      comment: "",
      position: getCommentEditorPosition(selectionAction),
    });
    setSelectionAction(null);
    window.getSelection()?.removeAllRanges();
  }, [selectionAction]);

  useEffect(() => {
    if (!commentEditor) {
      return;
    }
    window.requestAnimationFrame(() => {
      commentTextareaRef.current?.focus();
    });
  }, [commentEditor?.annotationId, commentEditor?.mode]);

  const handleSaveComment = useCallback(() => {
    if (!commentEditor) {
      return;
    }
    const quote = normalizePlanReviewSelectionText(commentEditor.quote);
    const comment = commentEditor.comment.trim();
    if (quote.length === 0 || comment.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    if (commentEditor.mode === "edit" && commentEditor.annotationId) {
      onAnnotationsChange(
        annotations.map((annotation) =>
          annotation.id === commentEditor.annotationId
            ? {
                ...annotation,
                comment,
                updatedAt: now,
              }
            : annotation,
        ),
      );
    } else {
      onAnnotationsChange([
        ...annotations,
        {
          id: randomUUID(),
          quote,
          comment,
          createdAt: now,
          updatedAt: now,
        },
      ]);
    }
    setCommentEditor(null);
  }, [annotations, commentEditor, onAnnotationsChange]);

  const handleEditAnnotation = useCallback((annotation: PlanReviewAnnotation) => {
    setSelectionAction(null);
    setCommentEditor({
      mode: "edit",
      annotationId: annotation.id,
      quote: annotation.quote,
      comment: annotation.comment,
    });
  }, []);

  const handleDeleteAnnotation = useCallback(
    (annotationId: string) => {
      onAnnotationsChange(annotations.filter((annotation) => annotation.id !== annotationId));
      if (commentEditor?.annotationId === annotationId) {
        setCommentEditor(null);
      }
    },
    [annotations, commentEditor?.annotationId, onAnnotationsChange],
  );

  const commentEditorPanel = commentEditor ? (
    <div className="rounded-lg border border-border/70 bg-background/95 p-3 shadow-lg">
      <div className="mb-2 max-h-32 overflow-y-auto rounded-md border-l-2 border-blue-400/70 bg-blue-500/5 px-2.5 py-2 text-[12px] leading-relaxed text-muted-foreground">
        {commentEditor.quote}
      </div>
      <Textarea
        ref={commentTextareaRef}
        value={commentEditor.comment}
        onChange={(event) =>
          setCommentEditor((existing) =>
            existing ? { ...existing, comment: event.target.value } : existing,
          )
        }
        placeholder="Add a comment"
        size="sm"
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button size="xs" variant="outline" onClick={() => setCommentEditor(null)}>
          Cancel
        </Button>
        <Button
          size="xs"
          onClick={handleSaveComment}
          disabled={commentEditor.comment.trim().length === 0}
        >
          Save
        </Button>
      </div>
    </div>
  ) : null;

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-card/50">
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onBack}
            aria-label="Back to plan sidebar"
            className="text-muted-foreground/60 hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3.5" />
          </Button>
          <Badge
            variant="secondary"
            className="rounded-md bg-blue-500/10 px-1.5 py-0 text-[10px] font-semibold tracking-wide text-blue-400 uppercase"
          >
            Review
          </Badge>
          <span className="truncate text-xs font-medium text-foreground/80">{title}</span>
        </div>
        <Button size="xs" onClick={onDone} disabled={annotations.length === 0}>
          <CheckIcon className="size-3.5" />
          Done
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="grid min-w-0 grid-cols-1 gap-3 p-3 2xl:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-3">
            <div
              ref={markdownRootRef}
              data-testid="plan-review-markdown"
              className="rounded-lg border border-border/50 bg-background/50 p-3 selection:bg-blue-400/25"
              onMouseUp={scheduleSelectionRead}
              onKeyUp={scheduleSelectionRead}
            >
              <ChatMarkdown text={displayedPlanMarkdown} cwd={markdownCwd} isStreaming={false} />
            </div>
          </div>

          <div className="min-w-0 space-y-2 2xl:sticky 2xl:top-3 2xl:self-start">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
                Comments
              </p>
              <span className="text-[11px] text-muted-foreground/45">{annotations.length}</span>
            </div>
            {annotations.length > 0 ? (
              <div className="space-y-2">
                {annotations.map((annotation, index) => (
                  <AnnotationCard
                    key={annotation.id}
                    annotation={annotation}
                    index={index}
                    editing={commentEditor?.annotationId === annotation.id}
                    commentValue={
                      commentEditor?.annotationId === annotation.id ? commentEditor.comment : ""
                    }
                    textareaRef={commentTextareaRef}
                    onCommentChange={(comment) =>
                      setCommentEditor((existing) =>
                        existing?.annotationId === annotation.id
                          ? { ...existing, comment }
                          : existing,
                      )
                    }
                    onCancelEdit={() => setCommentEditor(null)}
                    onSaveEdit={handleSaveComment}
                    onEdit={() => handleEditAnnotation(annotation)}
                    onDelete={() => handleDeleteAnnotation(annotation.id)}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border/60 bg-background/35 p-3 text-center text-[12px] text-muted-foreground/45">
                No comments yet.
              </div>
            )}
          </div>
        </div>
      </ScrollArea>

      {selectionAction ? (
        <Button
          size="xs"
          className="fixed z-50 shadow-lg"
          style={{ left: selectionAction.x, top: selectionAction.y }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={handleStartComment}
        >
          <MessageSquarePlusIcon className="size-3.5" />
          Comment
        </Button>
      ) : null}
      {commentEditor?.position ? (
        <div
          className="fixed z-50 w-[min(22rem,calc(100vw-1.5rem))]"
          style={{ left: commentEditor.position.x, top: commentEditor.position.y }}
        >
          {commentEditorPanel}
        </div>
      ) : null}
    </div>
  );
});

interface AnnotationCardProps {
  annotation: PlanReviewAnnotation;
  index: number;
  editing: boolean;
  commentValue: string;
  textareaRef: Ref<HTMLTextAreaElement>;
  onCommentChange: (comment: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function AnnotationCard({
  annotation,
  index,
  editing,
  commentValue,
  textareaRef,
  onCommentChange,
  onCancelEdit,
  onSaveEdit,
  onEdit,
  onDelete,
}: AnnotationCardProps) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/65 p-2.5">
      <div className="mb-2 flex items-start justify-between gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-blue-500/12 text-[11px] font-semibold text-blue-400">
          {index + 1}
        </span>
        {editing ? null : (
          <div className="flex items-center gap-1">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Edit comment"
              onClick={onEdit}
              className="text-muted-foreground/50 hover:text-foreground"
            >
              <PencilIcon className="size-3.5" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Delete comment"
              onClick={onDelete}
              className="text-muted-foreground/50 hover:text-destructive-foreground"
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        )}
      </div>
      <blockquote className="border-l-2 border-blue-400/60 pl-2 text-[12px] leading-relaxed text-muted-foreground">
        {annotation.quote}
      </blockquote>
      {editing ? (
        <div className="mt-2">
          <Textarea
            ref={textareaRef}
            value={commentValue}
            onChange={(event) => onCommentChange(event.target.value)}
            placeholder="Add a comment"
            size="sm"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="xs" variant="outline" onClick={onCancelEdit}>
              Cancel
            </Button>
            <Button size="xs" onClick={onSaveEdit} disabled={commentValue.trim().length === 0}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/85">
          {annotation.comment}
        </p>
      )}
    </div>
  );
}

export type { PlanReviewPanelProps };

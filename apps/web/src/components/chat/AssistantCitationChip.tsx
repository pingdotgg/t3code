import type { AssistantCitation } from "@t3tools/contracts";
import {
  assistantCitationLabel,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, PencilIcon, QuoteIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  findAssistantCitationSourceAnchor,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  assistantCitationHash,
  assistantCitationNavigation,
} from "../../lib/assistantCitationNavigation";
import { cn } from "~/lib/utils";
import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { ContextChipPopover } from "../contextChipParts";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import { resolveAssistantCitationCommentDismissal } from "./assistantCitationCommentDismissal";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";
import { composerFloatingLayerProps } from "./composerEventScope";
import { observeResize } from "~/lib/observeResize";

export function AssistantCitationChip({
  citation,
  commentEditor,
}: {
  citation: AssistantCitation;
  /** Present in the composer draft, where the comment can still change. */
  commentEditor?: {
    open: boolean;
    sourceAnchor?: AssistantCitationSourceAnchor | undefined;
    onOpenChange: (open: boolean) => void;
    onCancel?: () => void;
    onSave: (comment: string) => boolean;
    onSaveAndSend?: (comment: string) => boolean;
    onDraftChange?: (comment: string) => void;
    onRestoreFocus?: () => void;
  };
}) {
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const commentPopupRef = useRef<HTMLDivElement>(null);
  const draftCommentRef = useRef<string | null>(null);
  const [unavailableSourceAnchor, setUnavailableSourceAnchor] =
    useState<AssistantCitationSourceAnchor | null>(null);
  const commentOpen = commentEditor?.open ?? false;
  const sourceAnchor = commentEditor?.sourceAnchor;
  const activeSourceAnchor = sourceAnchor === unavailableSourceAnchor ? undefined : sourceAnchor;
  useEffect(() => {
    if (!commentOpen) draftCommentRef.current = null;
  }, [commentOpen]);
  const settleDraftOnClose = (reason: string): boolean => {
    const dismissal = resolveAssistantCitationCommentDismissal({
      reason,
      draft: draftCommentRef.current,
      savedComment: citation.comment,
    });
    if (dismissal.kind === "commit") return commentEditor?.onSave(dismissal.comment) ?? true;
    return dismissal.kind !== "keep-open";
  };
  const onSourceUnavailable = useEffectEvent(() => {
    if (!sourceAnchor) return;
    if (settleDraftOnClose("none")) {
      commentEditor?.onOpenChange(false);
    } else {
      setUnavailableSourceAnchor(sourceAnchor);
    }
  });
  useEffect(() => {
    if (!commentOpen || sourceAnchor === unavailableSourceAnchor) return;
    const anchor = sourceAnchor ?? findAssistantCitationSourceAnchor(document, citation);
    if (!anchor) return;
    return observeAssistantCitationCommentSource({
      anchor,
      citation,
      onUnavailable: onSourceUnavailable,
    });
  }, [citation, commentOpen, sourceAnchor, unavailableSourceAnchor]);
  const popupAnchor = activeSourceAnchor
    ? {
        contextElement: activeSourceAnchor.source,
        getBoundingClientRect: () => {
          const rects = activeSourceAnchor.range.getClientRects();
          const rect =
            rects.item(rects.length - 1) ?? activeSourceAnchor.range.getBoundingClientRect();
          // Code blocks and tables scroll sideways inside the message, so the cited
          // text can end in their hidden overflow. Base UI only shifts the popup while
          // it still touches the anchor, so clamp the anchor to the message's width.
          const bounds = activeSourceAnchor.source.getBoundingClientRect();
          const left = Math.min(Math.max(rect.left, bounds.left), bounds.right);
          const right = Math.max(Math.min(rect.right, bounds.right), left);
          return new DOMRect(left, rect.top, right - left, rect.height);
        },
      }
    : undefined;
  const label = assistantCitationLabel(citation);
  if (!commentEditor) {
    return (
      <ContextChipPopover
        kind="citation"
        icon={<QuoteIcon />}
        label={label}
        accessibleLabel={`Quoted assistant text: ${label}`}
        copyMarkdown={serializeAssistantCitation(citation)}
      >
        <AssistantCitationDetails citation={citation} />
      </ContextChipPopover>
    );
  }
  const cancelComment = () => {
    if (commentEditor.onCancel) {
      commentEditor.onCancel();
    } else {
      commentEditor.onOpenChange(false);
    }
  };
  const editor = (
    <AssistantCitationCommentEditor
      key={serializeAssistantCitation(citation)}
      citation={citation}
      inline={!activeSourceAnchor}
      inputRef={commentInputRef}
      onDraftChange={(comment) => {
        draftCommentRef.current = comment;
        commentEditor.onDraftChange?.(comment);
      }}
      onSubmit={(comment) => {
        if (!commentEditor.onSave(comment)) return false;
        commentEditor.onOpenChange(false);
        return true;
      }}
      {...(commentEditor.onSaveAndSend
        ? {
            onSubmitAndSend: (comment: string) => {
              if (!commentEditor.onSaveAndSend?.(comment)) return false;
              commentEditor.onOpenChange(false);
              return true;
            },
          }
        : {})}
      onCancel={cancelComment}
    />
  );
  return (
    <Popover
      open={commentEditor.open}
      onOpenChange={(open, eventDetails) => {
        if (!open && !settleDraftOnClose(eventDetails.reason)) {
          eventDetails.cancel();
          return;
        }
        commentEditor.onOpenChange(open);
      }}
    >
      <PopoverTrigger
        render={
          <ContextChip
            kind="citation"
            render={<button type="button" />}
            contentEditable={false}
            data-assistant-citation-chip="true"
            data-markdown-copy={serializeAssistantCitation(citation)}
            data-citation-comment-trigger="true"
            aria-label={`${citation.comment ? "Edit citation comment" : "Add comment to citation"}: ${label}`}
          />
        }
      >
        <QuoteIcon aria-hidden="true" />
        <ContextChipLabel className="max-w-[16em]">{label}</ContextChipLabel>
        <ContextChipAction render={<span aria-hidden="true" />}>
          <PencilIcon />
        </ContextChipAction>
      </PopoverTrigger>
      {commentEditor.open ? (
        <PopoverPopup
          {...composerFloatingLayerProps}
          side={activeSourceAnchor ? "bottom" : "top"}
          align="end"
          anchor={popupAnchor}
          initialFocus={() => {
            const input = commentInputRef.current;
            input?.focus({ preventScroll: true });
            if (input) {
              input.setSelectionRange(input.value.length, input.value.length);
              input.scrollTop = input.scrollHeight;
            }
            return false;
          }}
          finalFocus={
            commentEditor.onRestoreFocus
              ? () => {
                  const activeElement = document.activeElement;
                  if (
                    activeElement === document.body ||
                    (activeElement !== null && commentPopupRef.current?.contains(activeElement))
                  ) {
                    commentEditor.onRestoreFocus?.();
                  }
                  return false;
                }
              : undefined
          }
          ref={commentPopupRef}
          aria-label={`Edit citation comment: ${label}`}
          width={activeSourceAnchor ? "md" : "lg"}
          padding="compact"
          onPointerDown={(event) => event.stopPropagation()}
          // On the whole popup, so Escape from Go to source also removes a just-inserted quote.
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Escape") {
              event.preventDefault();
              cancelComment();
            }
          }}
        >
          {/* Right after a selection the popup sits under the highlighted text, so the quote
              and its source link would repeat it. The editor keeps its place in the tree either
              way, so a draft survives the source scrolling away. */}
          <AssistantCitationDetails
            citation={citation}
            editor={editor}
            // Save before leaving. A draft that cannot be saved keeps the popup open, so the
            // page must stay too.
            canLeave={() => {
              const settled = settleDraftOnClose("close-press");
              if (settled) draftCommentRef.current = null;
              return settled;
            }}
            showQuote={!activeSourceAnchor}
          />
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}

function AssistantCitationDetails({
  citation,
  editor,
  showQuote = true,
  canLeave,
}: {
  citation: AssistantCitation;
  editor?: ReactNode;
  showQuote?: boolean;
  canLeave?: () => boolean;
}) {
  const navigate = useNavigate();
  return (
    <div
      className={cn(
        "flex max-h-[calc(var(--available-height)_-_1rem_-_2px)] flex-col items-start",
        showQuote && "gap-3 p-1 text-sm",
      )}
    >
      {showQuote ? <AssistantCitationQuote citation={citation} showComment={!editor} /> : null}
      {/* Outside the quote's scroll area, so a long quote cannot hide the focused field. */}
      {editor ? <div className="self-stretch">{editor}</div> : null}
      {showQuote ? (
        <PopoverClose
          render={
            <Button
              variant="outline"
              size="sm"
              render={
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId: citation.environmentId, threadId: citation.threadId }}
                  hash={assistantCitationHash(citation)}
                  data-markdown-copy={serializeAssistantCitation(citation)}
                  resetScroll={false}
                  onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
                    if (
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    ) {
                      return;
                    }
                    event.preventDefault();
                    if (canLeave && !canLeave()) return;
                    void navigate(assistantCitationNavigation(citation));
                  }}
                />
              }
            />
          }
        >
          <ArrowUpRightIcon aria-hidden="true" />
          Go to source
        </PopoverClose>
      ) : null}
    </div>
  );
}

function AssistantCitationQuote({
  citation,
  showComment,
}: {
  citation: AssistantCitation;
  showComment: boolean;
}) {
  const [fade, setFade] = useState({ top: false, bottom: false });
  const updateFade = (element: HTMLElement) => {
    const top = element.scrollTop > 1;
    const bottom = element.scrollHeight - element.clientHeight - element.scrollTop > 1;
    setFade((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  };
  const observeFade = (element: HTMLDivElement | null) =>
    element ? observeResize(element, () => updateFade(element)) : undefined;
  return (
    <div
      ref={observeFade}
      onScroll={(event) => updateFade(event.currentTarget)}
      className={cn(
        "max-h-64 min-h-0 space-y-3 self-stretch overflow-y-auto whitespace-pre-wrap wrap-break-word",
        getVirtualizedScrollFadeClassName(fade),
      )}
    >
      <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
        {citation.text}
      </blockquote>
      {showComment && citation.comment ? <p>{citation.comment}</p> : null}
    </div>
  );
}

import type { AssistantCitation } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { Link, useNavigate } from "@tanstack/react-router";
import { PencilIcon, QuoteIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, type MouseEvent as ReactMouseEvent } from "react";
import {
  findAssistantCitationSourceAnchor,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import { cn } from "~/lib/utils";
import {
  assistantCitationHash,
  assistantCitationNavigation,
} from "../../lib/assistantCitationNavigation";
import {
  CHAT_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";

const CITATION_ACTION_BUTTON_CLASS_NAME = cn(
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  "text-primary/80 hover:bg-primary/10 hover:text-primary",
);

export function AssistantCitationChip({
  citation,
  onRemove,
  commentEditor,
}: {
  citation: AssistantCitation;
  onRemove?: () => void;
  commentEditor?: {
    open: boolean;
    sourceAnchor?: AssistantCitationSourceAnchor | undefined;
    onOpenChange: (open: boolean) => void;
    onSave: (comment: string) => boolean;
  };
}) {
  const navigate = useNavigate();
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const commentOpen = commentEditor?.open ?? false;
  const sourceAnchor = commentEditor?.sourceAnchor;
  const onSourceUnavailable = useEffectEvent(() => {
    if (sourceAnchor) commentEditor?.onOpenChange(false);
  });
  useEffect(() => {
    if (!commentOpen) return;
    const anchor = sourceAnchor ?? findAssistantCitationSourceAnchor(document, citation);
    if (!anchor) return;
    return observeAssistantCitationCommentSource({
      anchor,
      citation,
      onUnavailable: onSourceUnavailable,
    });
  }, [citation, commentOpen, sourceAnchor]);
  // A multi-line selection's bounding box spans the full message width; anchor
  // the bubble to the selection's last line, where the pointer released.
  const popupAnchor = sourceAnchor
    ? {
        contextElement: sourceAnchor.source,
        getBoundingClientRect: () => {
          const rects = sourceAnchor.range.getClientRects();
          return rects.item(rects.length - 1) ?? sourceAnchor.range.getBoundingClientRect();
        },
      }
    : undefined;
  const preview = (citation.comment?.trim() || citation.text).replace(/\s+/g, " ");
  const label = preview.length > 64 ? `${preview.slice(0, 64)}…` : preview;
  const sourceLinkProps = {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId: citation.environmentId, threadId: citation.threadId },
    hash: assistantCitationHash(citation),
    "data-markdown-copy": serializeAssistantCitation(citation),
    resetScroll: false,
    onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      void navigate(assistantCitationNavigation(citation));
    },
  };
  const composerSourceLink = (
    <Link
      {...sourceLinkProps}
      className="inline-flex h-full min-w-0 items-center gap-[0.33em] rounded-sm text-inherit no-underline focus-visible:outline-2 focus-visible:outline-primary"
      aria-label={`View cited assistant text: ${label}`}
    >
      <QuoteIcon aria-hidden="true" className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
      <span className={cn(COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME, "max-w-[16em]")}>{label}</span>
    </Link>
  );
  const chatSourceLink = (
    <Link
      {...sourceLinkProps}
      className="inline-flex h-full min-w-0 items-center gap-[0.33em] rounded-sm text-inherit no-underline hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-primary"
      aria-label={`View cited assistant text: ${label}`}
    >
      <QuoteIcon aria-hidden="true" className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
      <span className={cn(COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME, "max-w-[16em]")}>{label}</span>
    </Link>
  );
  return (
    <span
      className={cn(
        onRemove ? COMPOSER_INLINE_CHIP_CLASS_NAME : CHAT_INLINE_CHIP_CLASS_NAME,
        "border-primary/20 bg-primary/8 text-primary",
      )}
      contentEditable={false}
      data-assistant-citation-chip="true"
      data-markdown-copy={serializeAssistantCitation(citation)}
    >
      {onRemove ? (
        composerSourceLink
      ) : (
        <Tooltip>
          <TooltipTrigger render={chatSourceLink} />
          <TooltipPopup side="top">View source</TooltipPopup>
        </Tooltip>
      )}
      {commentEditor ? (
        <Popover open={commentEditor.open} onOpenChange={commentEditor.onOpenChange}>
          <PopoverTrigger
            aria-label={citation.comment ? "Edit citation comment" : "Add comment to citation"}
            className={CITATION_ACTION_BUTTON_CLASS_NAME}
          >
            <PencilIcon aria-hidden="true" className="size-[0.85em]" />
          </PopoverTrigger>
          {commentEditor.open ? (
            <PopoverPopup
              side={sourceAnchor ? "bottom" : "top"}
              align="end"
              anchor={popupAnchor}
              initialFocus={() => {
                commentInputRef.current?.focus({ preventScroll: true });
                return false;
              }}
              aria-label="Edit citation comment"
              className="w-72 max-w-[calc(100vw-1rem)]"
              viewportClassName="p-3"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <AssistantCitationCommentEditor
                key={serializeAssistantCitation(citation)}
                citation={citation}
                inputRef={commentInputRef}
                onSubmit={(comment) => {
                  if (!commentEditor.onSave(comment)) return false;
                  commentEditor.onOpenChange(false);
                  return true;
                }}
                onCancel={() => commentEditor.onOpenChange(false)}
              />
            </PopoverPopup>
          ) : null}
        </Popover>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove assistant citation"
          className={cn(
            COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
            "text-primary/85 hover:bg-primary/10 hover:text-primary",
          )}
        >
          <XIcon aria-hidden="true" className="size-[0.85em]" />
        </button>
      ) : null}
    </span>
  );
}

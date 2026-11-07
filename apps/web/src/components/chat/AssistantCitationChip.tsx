import type { AssistantCitation } from "@t3tools/contracts";
import {
  assistantCitationLabel,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, QuoteIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
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
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { ContextChipPopover } from "../contextChipParts";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import { resolveAssistantCitationCommentDismissal } from "./assistantCitationCommentDismissal";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";
import { composerFloatingLayerProps } from "./composerEventScope";
import { observeResize } from "~/lib/observeResize";
import { textDirection } from "~/textDirection";

export function AssistantCitationChip({
  citation,
  composer = false,
  commentEditor,
}: {
  citation: AssistantCitation;
  composer?: boolean;
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
  const navigate = useNavigate();
  const chipRef = useRef<HTMLSpanElement>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const commentPopupRef = useRef<HTMLDivElement>(null);
  const draftCommentRef = useRef<string | null>(null);
  const [voiceSetupOpen, setVoiceSetupOpen] = useState(false);
  const [unavailableSourceAnchor, setUnavailableSourceAnchor] =
    useState<AssistantCitationSourceAnchor | null>(null);
  const commentOpen = commentEditor?.open ?? false;
  const [resolvedSource, setResolvedSource] = useState<{
    citation: AssistantCitation;
    anchor: AssistantCitationSourceAnchor;
  } | null>(null);
  if (!commentOpen && resolvedSource !== null) setResolvedSource(null);
  const sourceAnchor =
    commentEditor?.sourceAnchor ??
    (resolvedSource?.citation === citation ? resolvedSource.anchor : undefined);
  const activeSourceAnchor = sourceAnchor === unavailableSourceAnchor ? undefined : sourceAnchor;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops the uncommitted comment draft held in a ref once the parent closes the comment editor
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- waits for the navigated source to mount, then observes its lifetime while editing
  useEffect(() => {
    if (!commentOpen) return;
    let stopObservingSource: (() => void) | undefined;
    const observer = new MutationObserver(resolveSource);
    function resolveSource() {
      const anchor =
        commentEditor?.sourceAnchor ?? findAssistantCitationSourceAnchor(document, citation);
      if (!anchor || anchor === unavailableSourceAnchor) return;
      observer.disconnect();
      setResolvedSource({ citation, anchor });
      stopObservingSource = observeAssistantCitationCommentSource({
        anchor,
        citation,
        onUnavailable: onSourceUnavailable,
      });
    }
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    resolveSource();
    return () => {
      observer.disconnect();
      stopObservingSource?.();
    };
  }, [citation, commentOpen, commentEditor?.sourceAnchor, unavailableSourceAnchor]);
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
    <ContextChip
      kind="citation"
      shape="pill"
      ref={chipRef}
      render={<Link {...sourceLinkProps} />}
      data-citation-comment-trigger={commentEditor ? "true" : undefined}
      onKeyDownCapture={(event) => {
        if (event.key === "Enter") event.stopPropagation();
        if (
          (event.key !== " " && event.key !== "Enter") ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.click();
      }}
      aria-label={`View cited assistant text: ${label}`}
    >
      <QuoteIcon aria-hidden="true" />
      <ContextChipLabel className="max-w-[16em]" dir={textDirection(label)}>
        {label}
      </ContextChipLabel>
    </ContextChip>
  );
  if (!composer) {
    return (
      <ContextChipPopover
        kind="citation"
        icon={<QuoteIcon />}
        label={label}
        accessibleLabel={`Quoted assistant text: ${label}`}
        copyMarkdown={serializeAssistantCitation(citation)}
      >
        <div className="flex max-h-[calc(var(--available-height)_-_1rem_-_2px)] flex-col items-start gap-3 p-1 text-sm">
          <AssistantCitationQuote citation={citation} />
          <PopoverClose
            render={<Button variant="outline" size="sm" render={<Link {...sourceLinkProps} />} />}
          >
            <ArrowUpRightIcon aria-hidden="true" />
            Go to source
          </PopoverClose>
        </div>
      </ContextChipPopover>
    );
  }
  return (
    <span
      contentEditable={false}
      data-assistant-citation-chip="true"
      data-markdown-copy={serializeAssistantCitation(citation)}
    >
      {commentEditor ? (
        <Popover
          open={commentEditor.open && !voiceSetupOpen}
          onOpenChange={(open, eventDetails) => {
            if (!open && eventDetails.reason === "trigger-press") {
              eventDetails.cancel();
              return;
            }
            if (!open && !settleDraftOnClose(eventDetails.reason)) {
              eventDetails.cancel();
              return;
            }
            commentEditor.onOpenChange(open);
          }}
        >
          <PopoverTrigger
            nativeButton={false}
            role="link"
            render={composerSourceLink}
            onKeyUp={(event) => {
              if (event.key === " ") event.preventBaseUIHandler();
            }}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              ) {
                event.preventBaseUIHandler();
              }
            }}
          />
          {commentEditor.open ? (
            <PopoverPopup
              // The editor stays mounted while its voice setup dialog replaces the popover.
              keepMounted
              {...composerFloatingLayerProps}
              side={activeSourceAnchor ? "bottom" : "top"}
              align="end"
              anchor={popupAnchor ?? chipRef}
              initialFocus={() => {
                commentInputRef.current?.focus({ preventScroll: true });
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
              aria-label="Edit citation comment"
              width="md"
              padding="compact"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <AssistantCitationCommentEditor
                key={serializeAssistantCitation(citation)}
                citation={citation}
                inputRef={commentInputRef}
                onVoiceSetupOpenChange={setVoiceSetupOpen}
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
                onCancel={() => {
                  if (commentEditor.onCancel) {
                    commentEditor.onCancel();
                  } else {
                    commentEditor.onOpenChange(false);
                  }
                }}
              />
            </PopoverPopup>
          ) : null}
        </Popover>
      ) : (
        composerSourceLink
      )}
    </span>
  );
}

function AssistantCitationQuote({ citation }: { citation: AssistantCitation }) {
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
      <blockquote
        className="border-l-2 border-border pl-3 text-muted-foreground"
        dir={textDirection(citation.text)}
      >
        {citation.text}
      </blockquote>
      {citation.comment ? <p dir={textDirection(citation.comment)}>{citation.comment}</p> : null}
    </div>
  );
}

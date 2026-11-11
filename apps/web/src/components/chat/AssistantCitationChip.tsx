import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AssistantCitation } from "@t3tools/contracts";
import {
  assistantCitationLabel,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { QuoteIcon } from "lucide-react";
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
  assistantCitationNavigation,
  assistantCitationRoute,
} from "../../lib/assistantCitationNavigation";
import { cn } from "~/lib/utils";
import { useQuietThreadShell } from "~/state/entities";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import { resolveAssistantCitationCommentDismissal } from "./assistantCitationCommentDismissal";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";
import { composerFloatingLayerProps } from "./composerEventScope";
import { textDirection } from "~/textDirection";

function useCitationSourceLinkProps(citation: AssistantCitation, editComment = false) {
  const navigate = useNavigate();
  const { environmentId, threadId } = useParams({ strict: false });
  const sourceThread = useQuietThreadShell(
    scopeThreadRef(citation.environmentId, citation.threadId),
  );
  return {
    ...assistantCitationRoute(citation, sourceThread),
    "data-markdown-copy": serializeAssistantCitation(citation),
    onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      // Keep the draft editor mounted when editing a quote from another scope.
      if (
        editComment &&
        (citation.environmentId !== environmentId || citation.threadId !== threadId)
      )
        return;
      void navigate(assistantCitationNavigation(citation, sourceThread));
    },
  };
}

/**
 * A quoted response inside a message. Clicking it goes to the source; its comment follows as
 * text. `leading` and `trailing` say it starts or ends its block, which already has spacing.
 */
export function AssistantCitationEmbed({
  citation,
  leading,
  trailing,
}: {
  citation: AssistantCitation;
  leading: boolean;
  trailing: boolean;
}) {
  const wholeResponse = citation.prefix === "" && citation.suffix === "";
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const { comment, ...quoted } = citation;
  const linkProps = useCitationSourceLinkProps(citation);
  return (
    // One copy boundary for the card and its comment, so a copied quote carries the comment once.
    <span
      data-markdown-copy={linkProps["data-markdown-copy"]}
      className={cn("block", !leading && "mt-[0.65rem]", !trailing && "mb-[0.65rem]")}
    >
      <Link
        {...linkProps}
        // A selection inside the card's boundary copies the quote here and the comment as text.
        data-markdown-copy={serializeAssistantCitation(quoted)}
        // The quote is findable in its source message; here it is clamped and mostly hidden.
        data-thread-find-ignore
        aria-label={`Go to quoted response: ${assistantCitationLabel(quoted)}`}
        // The message's markdown styles colour and underline links; a quote is neither.
        className="block min-w-0 rounded-lg bg-black/10 px-2.5 py-1.5 text-start text-sm text-muted-foreground! no-underline! wrap-break-word hover:bg-black/14 focus-visible:outline-2 focus-visible:outline-ring dark:bg-black/35 dark:hover:bg-black/50"
      >
        <span className="line-clamp-2" dir={textDirection(citation.text)}>
          {wholeResponse ? (
            flat(citation.text)
          ) : (
            <>
              {citation.prefix ? `…${flat(citation.prefix)}` : null}
              <mark className="rounded-sm bg-foreground/12 px-0.5 text-foreground">
                {flat(citation.text)}
              </mark>
              {citation.suffix ? `${flat(citation.suffix)}…` : null}
            </>
          )}
        </span>
      </Link>
      {comment ? (
        <span className="mt-1.5 block whitespace-pre-wrap" dir={textDirection(comment)}>
          {comment}
        </span>
      ) : null}
    </span>
  );
}

/** The citation chip in the composer, with its comment editor. */
export function AssistantCitationChip({
  citation,
  commentEditor,
}: {
  citation: AssistantCitation;
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
  const sourceLinkProps = useCitationSourceLinkProps(citation, Boolean(commentEditor));
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
                const input = commentInputRef.current;
                if (input) {
                  input.focus({ preventScroll: true });
                  input.setSelectionRange(input.value.length, input.value.length);
                  // Moving the caret doesn't scroll a long comment to it.
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

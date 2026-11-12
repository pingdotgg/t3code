import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AssistantCitation, ResponseContextRecord } from "@t3tools/contracts";
import {
  assistantCitationLabel,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { Link, useNavigate } from "@tanstack/react-router";
import { MessageSquarePlusIcon, TextQuoteIcon } from "lucide-react";
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
  assistantCitationNavigation,
  assistantCitationRoute,
} from "../../lib/assistantCitationNavigation";
import { cn } from "~/lib/utils";
import { useQuietThreadShell } from "~/state/entities";
import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import { resolveAssistantCitationCommentDismissal } from "./assistantCitationCommentDismissal";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";
import { composerFloatingLayerProps } from "./composerEventScope";
import { textDirection } from "~/textDirection";

function useCitationSourceLinkProps(citation: AssistantCitation) {
  const navigate = useNavigate();
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
      void navigate(assistantCitationNavigation(citation, sourceThread));
    },
  };
}

const flat = (text: string) => text.replace(/\s+/g, " ");

/**
 * The card a response shows as inside a message. Clicking it goes to the source; a comment follows
 * as text. `leading` and `trailing` say it starts or ends its block, which already has spacing.
 */
function ResponseCard({
  citation,
  copyMarkdown,
  cardCopyMarkdown = copyMarkdown,
  label,
  title,
  preview,
  comment,
  leading,
  trailing,
}: {
  citation: AssistantCitation;
  copyMarkdown: string;
  cardCopyMarkdown?: string;
  label: string;
  title?: string | undefined;
  preview: ReactNode;
  comment?: string | undefined;
  leading: boolean;
  trailing: boolean;
}) {
  const linkProps = useCitationSourceLinkProps(citation);
  return (
    // One copy boundary for the card and its comment, so a copied card carries the comment once.
    <span
      data-markdown-copy={copyMarkdown}
      className={cn("block", !leading && "mt-[0.65rem]", !trailing && "mb-[0.65rem]")}
    >
      <Link
        {...linkProps}
        // A selection inside the card's boundary copies the card here and the comment as text.
        data-markdown-copy={cardCopyMarkdown}
        // The response is findable in its own message; here it is clamped and mostly hidden.
        data-thread-find-ignore
        aria-label={label}
        // The message's markdown styles colour and underline links; a card is neither.
        className="block min-w-0 rounded-lg bg-black/10 px-2.5 py-1.5 text-start text-body text-muted-foreground! no-underline! wrap-break-word hover:bg-black/14 focus-visible:outline-2 focus-visible:outline-ring dark:bg-black/35 dark:hover:bg-black/50"
      >
        {title ? (
          <span className="block truncate text-meta text-foreground/80" dir="auto">
            {title}
          </span>
        ) : null}
        <span className="line-clamp-2" dir={textDirection(citation.text)}>
          {preview}
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

/** A passage quoted from a response, with its surrounding context and the user's comment. */
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
  const { comment, ...quoted } = citation;
  return (
    <ResponseCard
      citation={citation}
      copyMarkdown={serializeAssistantCitation(citation)}
      cardCopyMarkdown={serializeAssistantCitation(quoted)}
      label={`Go to quoted response: ${assistantCitationLabel(quoted)}`}
      comment={comment}
      leading={leading}
      trailing={trailing}
      preview={
        wholeResponse ? (
          flat(citation.text)
        ) : (
          <>
            {citation.prefix ? `…${flat(citation.prefix)}` : null}
            <mark className="rounded-sm bg-foreground/12 px-0.5 text-foreground">
              {flat(citation.text)}
            </mark>
            {citation.suffix ? `${flat(citation.suffix)}…` : null}
          </>
        )
      }
    />
  );
}

/** The response a message replies to: its subagents, when it had any, and how it starts. */
export function ResponseReplyCard({
  record,
  copyMarkdown,
  leading,
  trailing,
}: {
  record: ResponseContextRecord;
  copyMarkdown: string;
  leading: boolean;
  trailing: boolean;
}) {
  return (
    <ResponseCard
      citation={record.citation}
      copyMarkdown={copyMarkdown}
      label={`Go to the response this replies to: ${record.label}`}
      title={record.subagents?.map((subagent) => subagent.title).join(", ")}
      preview={flat(record.citation.text)}
      leading={leading}
      trailing={trailing}
    />
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
  const navigate = useNavigate();
  const sourceThread = useQuietThreadShell(
    scopeThreadRef(citation.environmentId, citation.threadId),
  );
  const sourceLinkProps = useCitationSourceLinkProps(citation);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const commentPopupRef = useRef<HTMLDivElement>(null);
  const draftCommentRef = useRef<string | null>(null);
  const [voiceSetupOpen, setVoiceSetupOpen] = useState(false);
  const [unavailableSourceAnchor, setUnavailableSourceAnchor] =
    useState<AssistantCitationSourceAnchor | null>(null);
  const commentOpen = commentEditor?.open ?? false;
  const sourceAnchor = commentEditor?.sourceAnchor;
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
      // Keep the draft mounted and stop tracking the detached range.
      setUnavailableSourceAnchor(sourceAnchor);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the cited DOM source while the comment editor is open and reacts when it disappears
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
          // A quote can end inside horizontally clipped code or a table.
          const bounds = activeSourceAnchor.source.getBoundingClientRect();
          const left = Math.min(Math.max(rect.left, bounds.left), bounds.right);
          const right = Math.max(Math.min(rect.right, bounds.right), left);
          return new DOMRect(left, rect.top, right - left, rect.height);
        },
      }
    : undefined;
  const label = assistantCitationLabel(citation);
  const composerSourceLink = (
    <Link
      {...sourceLinkProps}
      className="inline-flex min-w-0 items-center gap-[0.2em] self-baseline text-inherit no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current rounded-sm"
      aria-label={`View cited assistant text: ${label}`}
    >
      <TextQuoteIcon aria-hidden="true" />
      <ContextChipLabel className="max-w-[16em]" dir={textDirection(label)}>
        {label}
      </ContextChipLabel>
    </Link>
  );
  return (
    <ContextChip
      kind="citation"
      contentEditable={false}
      data-assistant-citation-chip="true"
      data-markdown-copy={serializeAssistantCitation(citation)}
    >
      {composerSourceLink}
      {commentEditor ? (
        <Popover
          open={commentEditor.open && !voiceSetupOpen}
          onOpenChange={(open, eventDetails) => {
            if (!open && !settleDraftOnClose(eventDetails.reason)) {
              eventDetails.cancel();
              return;
            }
            commentEditor.onOpenChange(open);
          }}
        >
          <PopoverTrigger
            aria-label={citation.comment ? "Edit citation comment" : "Add comment to citation"}
            data-citation-comment-trigger="true"
            render={<ContextChipAction />}
          >
            <MessageSquarePlusIcon aria-hidden="true" />
          </PopoverTrigger>
          {commentEditor.open ? (
            <PopoverPopup
              // The editor stays mounted while its voice setup dialog replaces the popover.
              keepMounted
              {...composerFloatingLayerProps}
              side={activeSourceAnchor ? "bottom" : "top"}
              align="end"
              anchor={popupAnchor}
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
                onViewSource={() => {
                  void navigate(assistantCitationNavigation(citation, sourceThread));
                }}
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
      ) : null}
    </ContextChip>
  );
}

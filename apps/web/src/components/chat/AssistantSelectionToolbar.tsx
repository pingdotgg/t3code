import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  SIDE_CHAT_EXCERPT_MAX_CHARS,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { MessageCircleQuestionIcon, QuoteIcon } from "lucide-react";
import { use, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  isSelectionRectVisible,
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import { registerSideChatSelectionOwner } from "../sideChat/sideChatSelectionRegistry";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BackgroundThreadContext } from "./backgroundThread";

/** The selection as a citation, when it is text in one of `viewport`'s replies. */
function captureCitation(viewport: HTMLElement, threadRef: ScopedThreadRef) {
  const captured = captureAssistantTextSelection(viewport, window.getSelection());
  const messageId = captured?.source.dataset.assistantCitationSource;
  if (!captured || !messageId) return null;
  const citation: AssistantCitation = {
    version: 1,
    ...threadRef,
    messageId: MessageId.make(messageId),
    ...captured.selector,
  };
  const sourceAnchor: AssistantCitationSourceAnchor = {
    source: captured.source,
    range: captured.range,
    viewport,
  };
  return { citation, sourceAnchor };
}

export function AssistantSelectionToolbar({
  viewport,
  threadRef,
  onCite,
  onAskInSideChat,
  askPending = false,
  streamingMessageId = null,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
  onCite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
  /** Renders the Ask action. Callers omit it when the environment has no side chats. */
  onAskInSideChat?:
    | ((citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean)
    | undefined;
  /** Another side chat is still starting. */
  askPending?: boolean;
  /** The reply still being written; Ask waits until it finishes. */
  streamingMessageId?: MessageId | null;
}) {
  const [selection, setSelection] = useState<{
    citation: AssistantCitation;
    position: SelectionActionPoint;
    sourceAnchor: AssistantCitationSourceAnchor;
  } | null>(null);
  const [focusedAction, setFocusedAction] = useState<"cite" | "ask">("cite");
  const toolbarRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
  // A sheet traps focus and dismisses on outside presses, so the toolbar must live inside it.
  const sheet = viewport?.closest<HTMLElement>('[data-slot="sheet-popup"]') ?? null;
  const backgroundThread = use(BackgroundThreadContext);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the toolbar DOM node and clamps its position inside the window before paint
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    // The sheet is transformed, so it is the toolbar's containing block: measure from its padding edge.
    const sheetRect = sheet?.getBoundingClientRect();
    const origin = {
      x: sheet && sheetRect ? sheetRect.left + sheet.clientLeft : 0,
      y: sheet && sheetRect ? sheetRect.top + sheet.clientTop : 0,
    };
    const x = Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8));
    toolbar.style.left = `${x - origin.x}px`;
    toolbar.style.top = `${y - origin.y}px`;
  }, [selection, sheet]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to document selectionchange and keydown to track text selections in the viewport
  useEffect(() => {
    if (!viewport) return;
    const clear = () => setSelection(null);
    const update = (pointer: SelectionActionPoint | null) => {
      const target = captureCitation(viewport, threadRef);
      if (!target) {
        clear();
        return;
      }
      const captured = target.sourceAnchor;
      const rect = captured.range.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      if (!isSelectionRectVisible(rect, [viewportRect])) {
        clear();
        return;
      }
      // A selection can cross blocks with different clipping ancestors.
      const common = captured.range.commonAncestorContainer;
      const walker = document.createTreeWalker(common, NodeFilter.SHOW_TEXT);
      let node = common.nodeType === Node.TEXT_NODE ? common : walker.nextNode();
      let visible = false;
      for (; node && !visible; node = walker.nextNode()) {
        if (!captured.range.intersectsNode(node)) continue;
        if (node.parentElement && getComputedStyle(node.parentElement).userSelect === "none")
          continue;
        const fragment = document.createRange();
        fragment.selectNodeContents(node);
        if (node === captured.range.startContainer) {
          fragment.setStart(node, captured.range.startOffset);
        }
        if (node === captured.range.endContainer) {
          fragment.setEnd(node, captured.range.endOffset);
        }
        if (!fragment.toString().trim()) continue;
        const lines = Array.from(fragment.getClientRects());
        if (!lines.some((line) => isSelectionRectVisible(line, [viewportRect]))) continue;
        const clips: Pick<DOMRect, "left" | "right" | "top" | "bottom">[] = [viewportRect];
        for (
          let element = node.parentElement;
          element && element !== viewport;
          element = element.parentElement
        ) {
          const style = getComputedStyle(element);
          const clipX = style.overflowX !== "visible";
          const clipY = style.overflowY !== "visible";
          if (!clipX && !clipY) continue;
          const bounds = element.getBoundingClientRect();
          const left = bounds.left + element.clientLeft;
          const top = bounds.top + element.clientTop;
          clips.push({
            left: clipX ? left : -Infinity,
            right: clipX ? left + element.clientWidth : Infinity,
            top: clipY ? top : -Infinity,
            bottom: clipY ? top + element.clientHeight : Infinity,
          });
        }
        visible = lines.some((line) => isSelectionRectVisible(line, clips));
      }
      if (!visible) {
        clear();
        return;
      }
      const rects = captured.range.getClientRects();
      const pointerOnText =
        pointer !== null &&
        Array.from(rects).some(
          (line) =>
            pointer.x >= line.left - 8 &&
            pointer.x <= line.right + 8 &&
            pointer.y >= line.top - 8 &&
            pointer.y <= line.bottom + 8,
        );
      setSelection({
        ...target,
        position: resolveSelectionActionPosition({
          bounds: viewportRect,
          selectionRect: rects.item(rects.length - 1) ?? rect,
          pointer: pointerOnText ? pointer : null,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      });
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => toolbarRef.current,
      restoreAfterScroll: true,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const focusActions = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        toolbar.contains(event.target as Node)
      ) {
        return;
      }
      const first = toolbar.querySelector<HTMLButtonElement>("button:not(:disabled)");
      if (!first) return;
      event.preventDefault();
      event.stopPropagation();
      first.focus({ preventScroll: true });
    };
    // Tab belongs to the foreground chat; a background timeline only follows its selection.
    if (!backgroundThread) document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [backgroundThread, threadRef, viewport]);

  const askBlockedReasonOf = (citation: AssistantCitation) =>
    citation.text.length > SIDE_CHAT_EXCERPT_MAX_CHARS
      ? `Side chats take up to ${SIDE_CHAT_EXCERPT_MAX_CHARS.toLocaleString("en-US")} characters`
      : streamingMessageId === citation.messageId
        ? "Available when this reply finishes"
        : askPending
          ? "Starting side chat…"
          : null;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const askAbout = (target: ReturnType<typeof captureCitation>) => {
    if (
      !target ||
      askBlockedReasonOf(target.citation) !== null ||
      !onAskInSideChat?.(target.citation, target.sourceAnchor)
    ) {
      return false;
    }
    window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  // Escape, a scroll or a resize hides the toolbar but keeps the selection, and the
  // shortcut still asks about it, so it reads the live selection, not the toolbar's.
  const askFromShortcut = useEffectEvent(() =>
    askAbout(viewport ? captureCitation(viewport, threadRef) : null),
  );
  const offersAsk = onAskInSideChat !== undefined;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this viewport as the owner of the Ask in side chat shortcut while it is mounted
  useEffect(() => {
    if (!viewport || !offersAsk) return;
    return registerSideChatSelectionOwner({
      contains: (node) => viewport.contains(node),
      ask: () => askFromShortcut(),
    });
  }, [offersAsk, viewport]);

  if (!selection) return null;
  const askTooLong = selection.citation.text.length > SIDE_CHAT_EXCERPT_MAX_CHARS;
  const askBlockedReason = askBlockedReasonOf(selection.citation);
  const ask = () => askAbout(selection);
  const citeTooLong = selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  // One action is in the tab order; the arrow keys move between them.
  const rovingAction = onAskInSideChat && (focusedAction === "ask" || citeTooLong) ? "ask" : "cite";
  const cite = () => {
    if (citeTooLong || !onCite(selection.citation, selection.sourceAnchor)) return false;
    window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Selection actions"
      className={`${sheet ? "absolute" : "fixed"} z-50 flex max-w-[calc(100vw-1rem)] items-center gap-1`}
      style={{ left: selection.position.x, top: selection.position.y }}
      onPointerDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          dismiss();
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        );
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        if (index === -1) return;
        event.preventDefault();
        const step = event.key === "ArrowRight" ? 1 : -1;
        buttons[(index + step + buttons.length) % buttons.length]?.focus({ preventScroll: true });
      }}
    >
      <Button
        type="button"
        size="xs"
        variant="glass"
        disabled={citeTooLong}
        tabIndex={rovingAction === "cite" ? 0 : -1}
        aria-label={citeTooLong ? "Selection is too long to cite" : "Cite selection in composer"}
        onFocus={() => setFocusedAction("cite")}
        onClick={cite}
      >
        <QuoteIcon aria-hidden="true" className="size-3.5" />
        {citeTooLong ? "Shorten selection" : "Cite"}
      </Button>
      {onAskInSideChat ? (
        <Tooltip
          onOpenChange={(_open, details) => {
            // Focus opens the tooltip, which would otherwise swallow the Escape that dismisses.
            if (details.reason === "escape-key") details.allowPropagation();
          }}
        >
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="glass"
                tabIndex={rovingAction === "ask" ? 0 : -1}
                aria-disabled={askBlockedReason !== null || undefined}
                aria-description={askBlockedReason ?? undefined}
                aria-label={
                  askTooLong ? "Shorten selection to ask in side chat" : "Ask in side chat"
                }
                onFocus={() => setFocusedAction("ask")}
                onClick={ask}
              />
            }
          >
            <MessageCircleQuestionIcon aria-hidden="true" className="size-3.5" />
            {askTooLong ? "Shorten selection" : "Ask in side chat"}
          </TooltipTrigger>
          {askBlockedReason ? <TooltipPopup side="top">{askBlockedReason}</TooltipPopup> : null}
        </Tooltip>
      ) : null}
    </div>,
    sheet ?? document.body,
  );
}

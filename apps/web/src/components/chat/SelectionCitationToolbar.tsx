import { ASSISTANT_CITATION_MAX_TEXT_LENGTH, type Citation } from "@lathe/contracts";
import { MessageSquarePlusIcon, QuoteIcon } from "lucide-react";
import { use, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
  type AssistantTextSelector,
} from "~/lib/assistantTextSelection";
import {
  isSelectionRectVisible,
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { BackgroundThreadContext } from "./backgroundThread";

export type CapturedSelection = {
  source: HTMLElement;
  selector: AssistantTextSelector;
  range: Range;
};

/**
 * Floating actions for text selected inside `viewport`: Cite, and Comment when
 * the surface takes comments. Each surface says which elements it quotes
 * (`sourceSelector`) and how a selection becomes a citation (`toCitation`,
 * which must be stable across renders).
 */
export function SelectionCitationToolbar({
  viewport,
  sourceSelector,
  toCitation,
  onCite,
  onComment,
  contextMenu = false,
}: {
  viewport: HTMLElement | null;
  sourceSelector?: string;
  toCitation: (captured: CapturedSelection) => Citation | null;
  onCite: (citation: Citation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
  onComment?:
    | ((citation: Citation, sourceAnchor: AssistantCitationSourceAnchor) => void)
    | undefined;
  /** Offer the same actions, plus Copy, when the selection is right-clicked. */
  contextMenu?: boolean;
}) {
  // The menu reads the latest callbacks without re-subscribing on each render.
  const hasCommentAction = useEffectEvent(() => onComment !== undefined);
  const runMenuChoice = useEffectEvent(
    (
      choice: "cite" | "comment" | "copy" | null,
      citation: Citation,
      sourceAnchor: AssistantCitationSourceAnchor,
    ) => {
      if (choice === "cite") onCite(citation, sourceAnchor);
      else if (choice === "comment") onComment?.(citation, sourceAnchor);
      // Copying through the document keeps the surface's markdown-aware copy handler.
      else if (choice === "copy") document.execCommand("copy");
    },
  );

  // oxlint-disable-next-line lathe/no-unreasoned-state-sync -- listens for contextmenu on the viewport to offer the selection actions in the native menu
  useEffect(() => {
    if (!viewport || !contextMenu) return;
    const onContextMenu = (event: MouseEvent) => {
      const captured = captureAssistantTextSelection(
        viewport,
        window.getSelection(),
        sourceSelector,
      );
      const citation = captured ? toCitation(captured) : null;
      if (!captured || !citation || !captured.range.intersectsNode(event.target as Node)) return;
      event.preventDefault();
      const sourceAnchor = { source: captured.source, range: captured.range, viewport };
      const tooLong = citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
      void readLocalApi()
        ?.contextMenu.show(
          [
            { id: "cite" as const, label: "Cite in chat", disabled: tooLong },
            ...(hasCommentAction()
              ? [{ id: "comment" as const, label: "Add comment", disabled: tooLong }]
              : []),
            { id: "copy" as const, label: "Copy" },
          ],
          { x: event.clientX, y: event.clientY },
        )
        .then((choice) => runMenuChoice(choice, citation, sourceAnchor));
    };
    viewport.addEventListener("contextmenu", onContextMenu);
    return () => viewport.removeEventListener("contextmenu", onContextMenu);
  }, [contextMenu, sourceSelector, toCitation, viewport]);
  const [selection, setSelection] = useState<{
    citation: Citation;
    position: SelectionActionPoint;
    sourceAnchor: AssistantCitationSourceAnchor;
  } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
  const backgroundThread = use(BackgroundThreadContext);

  // oxlint-disable-next-line lathe/no-unreasoned-state-sync -- measures the toolbar DOM node and clamps its position inside the window before paint
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8))}px`;
  }, [selection]);

  // oxlint-disable-next-line lathe/no-unreasoned-state-sync -- subscribes to document selectionchange and keydown to track text selections in the viewport
  useEffect(() => {
    if (!viewport) return;
    const clear = () => setSelection(null);
    const update = (pointer: SelectionActionPoint | null) => {
      const captured = captureAssistantTextSelection(
        viewport,
        window.getSelection(),
        sourceSelector,
      );
      const citation = captured ? toCitation(captured) : null;
      if (!captured || !citation) {
        clear();
        return;
      }
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
        sourceAnchor: { source: captured.source, range: captured.range, viewport },
        citation,
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
      immediateMultiClick: true,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const focusActions = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      const first = toolbar?.querySelector<HTMLButtonElement>("button:not(:disabled)");
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        !first ||
        toolbar.contains(event.target as Node)
      ) {
        return;
      }
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
  }, [backgroundThread, sourceSelector, toCitation, viewport]);

  if (!selection) return null;
  const tooLong = selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const cite = () => {
    if (tooLong || !onCite(selection.citation, selection.sourceAnchor)) return false;
    window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  const comment = () => {
    if (tooLong || !onComment) return;
    onComment(selection.citation, selection.sourceAnchor);
    window.getSelection()?.removeAllRanges();
    dismiss();
  };
  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Selection actions"
      className="fixed z-50 flex max-w-[calc(100vw-1rem)] gap-1"
      style={{ left: selection.position.x, top: selection.position.y }}
      onPointerDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      <Button
        type="button"
        size="xs"
        variant="glass"
        disabled={tooLong}
        aria-label={tooLong ? "Selection is too long to cite" : "Cite selection in composer"}
        onClick={cite}
      >
        <QuoteIcon aria-hidden="true" className="size-3.5" />
        {tooLong ? "Shorten selection" : "Cite"}
      </Button>
      {onComment && !tooLong ? (
        <Button
          type="button"
          size="xs"
          variant="glass"
          aria-label="Comment on selection"
          onClick={comment}
        >
          <MessageSquarePlusIcon aria-hidden="true" className="size-3.5" />
          Comment
        </Button>
      ) : null}
    </div>,
    document.body,
  );
}

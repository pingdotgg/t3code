import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { QuoteIcon } from "lucide-react";
import { use, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  isSelectionRectVisible,
  observeSelectionActions,
  resolveChatSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import { Button } from "../ui/button";
import { BackgroundThreadContext } from "./backgroundThread";

export function AssistantSelectionToolbar({
  viewport,
  threadRef,
  onCite,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
  onCite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
}) {
  const [selection, setSelection] = useState<{
    pointer: SelectionActionPoint | null;
    citation: AssistantCitation;
    rect: { left: number; top: number; right: number; bottom: number };
    bounds: { left: number; top: number; right: number; bottom: number };
    sourceAnchor: AssistantCitationSourceAnchor;
  } | null>(null);
  const toolbarRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
  const backgroundThread = use(BackgroundThreadContext);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the toolbar DOM node and clamps its position inside the window before paint
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection || !viewport) return;
    const rect = toolbar.getBoundingClientRect();
    const position = resolveChatSelectionActionPosition({
      selectionRect: selection.rect,
      bounds: selection.bounds,
      outerBounds: viewport.getBoundingClientRect(),
      pointer: selection.pointer,
      actionSize: rect,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    toolbar.style.left = `${position.x}px`;
    toolbar.style.top = `${position.y}px`;
  }, [selection, viewport]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to document selectionchange and keydown to track text selections in the viewport
  useEffect(() => {
    if (!viewport) return;
    const clear = () => setSelection(null);
    const update = (pointer: SelectionActionPoint | null) => {
      const nativeSelection = window.getSelection();
      const captured = captureAssistantTextSelection(viewport, nativeSelection);
      const messageId = captured?.source.dataset.assistantCitationSource;
      if (!captured || !messageId) {
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
      const visibleLines: {
        left: number;
        top: number;
        right: number;
        bottom: number;
        clipTop: number;
        clipBottom: number;
      }[] = [];
      for (; node; node = walker.nextNode()) {
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
        for (const line of lines) {
          if (!isSelectionRectVisible(line, clips)) continue;
          const visibleLine = {
            clipTop: Math.max(0, ...clips.map((clip) => clip.top)),
            clipBottom: Math.min(window.innerHeight, ...clips.map((clip) => clip.bottom)),
            left: Math.max(line.left, 0, ...clips.map((clip) => clip.left)),
            right: Math.min(line.right, window.innerWidth, ...clips.map((clip) => clip.right)),
            top: Math.max(line.top, 0, ...clips.map((clip) => clip.top)),
            bottom: Math.min(line.bottom, window.innerHeight, ...clips.map((clip) => clip.bottom)),
          };
          if (visibleLine.right > visibleLine.left && visibleLine.bottom > visibleLine.top)
            visibleLines.push(visibleLine);
        }
      }
      if (visibleLines.length === 0) {
        clear();
        return;
      }
      const firstLine = visibleLines.reduce((first, line) => (line.top < first.top ? line : first));
      const lastLine = visibleLines.reduce((last, line) =>
        line.bottom > last.bottom ? line : last,
      );
      setSelection({
        pointer,
        bounds: {
          left: viewportRect.left,
          right: viewportRect.right,
          top: firstLine.clipTop,
          bottom: lastLine.clipBottom,
        },
        sourceAnchor: { source: captured.source, range: captured.range, viewport },
        citation: {
          version: 1,
          ...threadRef,
          messageId: MessageId.make(messageId),
          ...captured.selector,
        },
        rect: {
          left: Math.min(...visibleLines.map((line) => line.left)),
          right: Math.max(...visibleLines.map((line) => line.right)),
          top: Math.min(...visibleLines.map((line) => line.top)),
          bottom: Math.max(...visibleLines.map((line) => line.bottom)),
        },
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
      if (toolbar.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      toolbar.focus({ preventScroll: true });
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
  return createPortal(
    <Button
      ref={toolbarRef}
      type="button"
      size="sm"
      variant="default"
      disabled={tooLong}
      aria-label={tooLong ? "Selection is too long to cite" : "Cite selection in composer"}
      className="fixed z-50 max-w-[calc(100vw-1rem)]"
      onPointerDown={(event) => event.preventDefault()}
      onClick={cite}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      <QuoteIcon aria-hidden="true" className="size-3.5" />
      {tooLong ? "Shorten selection" : "Cite"}
    </Button>,
    document.body,
  );
}

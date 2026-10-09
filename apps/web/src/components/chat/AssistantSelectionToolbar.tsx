import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { QuoteIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import { Button } from "../ui/button";
import {
  htmlSelectionClientRect,
  htmlSelectionCommand,
  htmlSelectionParams,
  readHtmlSelection,
  readHtmlSelectionRect,
} from "~/lib/htmlRenderSelection";

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
    citation: AssistantCitation;
    position: SelectionActionPoint;
    sourceAnchor: AssistantCitationSourceAnchor;
    tooLong?: boolean;
  } | null>(null);
  const toolbarRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8))}px`;
  }, [selection]);

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
      if (rect.bottom < viewportRect.top || rect.top > viewportRect.bottom || rect.width === 0) {
        clear();
        return;
      }
      const rects = captured.range.getClientRects();
      setSelection({
        sourceAnchor: { source: captured.source, range: captured.range, viewport },
        citation: {
          version: 1,
          ...threadRef,
          messageId: MessageId.make(messageId),
          ...captured.selector,
        },
        position: resolveSelectionActionPosition({
          bounds: viewportRect,
          selectionRect: rects.item(rects.length - 1) ?? rect,
          pointer,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      });
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => toolbarRef.current,
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
    document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    const htmlSelection = (event: MessageEvent) => {
      const params = htmlSelectionParams(event.data);
      if (params === undefined) return;
      const frame = [
        ...viewport.querySelectorAll<HTMLIFrameElement>("iframe[data-html-selection-bridge]"),
      ].find((frame) => frame.contentWindow === event.source);
      const source = frame?.closest<HTMLElement>("[data-assistant-citation-source]");
      const messageId = source?.dataset.assistantCitationSource;
      if (!frame || !source || !messageId) return;
      if (params === null) {
        setSelection((previous) =>
          document.activeElement === frame || previous?.sourceAnchor.htmlRender === frame
            ? null
            : previous,
        );
        return;
      }
      if (params.focus === true) {
        if (document.activeElement === frame) toolbarRef.current?.focus({ preventScroll: true });
        return;
      }
      if ("target" in params) return;
      if (document.activeElement !== frame) return;
      const captured = readHtmlSelection(event.data);
      const localRect =
        captured?.rect ?? (params.tooLong === true ? readHtmlSelectionRect(params.rect) : null);
      if (!localRect) {
        clear();
        return;
      }
      const rect = htmlSelectionClientRect(frame, localRect);
      const bounds = viewport.getBoundingClientRect();
      const frameBounds = frame.getBoundingClientRect();
      if (
        rect.bottom < bounds.top ||
        rect.top > bounds.bottom ||
        rect.bottom < frameBounds.top ||
        rect.top > frameBounds.bottom
      ) {
        clear();
        return;
      }
      const selector = captured?.selector ?? { text: "", start: 0, end: 1, prefix: "", suffix: "" };
      let currentRect = localRect;
      const sourceRect = () => htmlSelectionClientRect(frame, currentRect);
      setSelection({
        tooLong: params.tooLong === true,
        citation: { version: 1, ...threadRef, messageId: MessageId.make(messageId), ...selector },
        sourceAnchor: {
          source,
          viewport,
          htmlRender: frame,
          updateRange: (next) => {
            const changed = (["left", "top", "width", "height"] as const).some(
              (key) => next[key] !== currentRect[key],
            );
            currentRect = next;
            return changed;
          },
          range: {
            getBoundingClientRect: sourceRect,
            getClientRects: () =>
              Object.assign([sourceRect()], {
                item: (index: number) => (index === 0 ? sourceRect() : null),
              }),
          },
        },
        position: resolveSelectionActionPosition({
          bounds,
          selectionRect: rect,
          pointer: captured?.pointer
            ? { x: frameBounds.left + captured.pointer.x, y: frameBounds.top + captured.pointer.y }
            : null,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      });
    };
    window.addEventListener("message", htmlSelection);
    return () => {
      window.removeEventListener("message", htmlSelection);
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [threadRef, viewport]);

  if (!selection) return null;
  const tooLong =
    selection.tooLong || selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const cite = () => {
    if (tooLong || !onCite(selection.citation, selection.sourceAnchor)) return false;
    if (selection.sourceAnchor.htmlRender) {
      htmlSelectionCommand(selection.sourceAnchor.htmlRender, "clear");
    } else window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  return createPortal(
    <Button
      ref={toolbarRef}
      type="button"
      size="xs"
      variant="glass"
      disabled={tooLong}
      aria-label={tooLong ? "Selection is too long to cite" : "Cite selection in composer"}
      className="fixed z-50 max-w-[calc(100vw-1rem)]"
      style={{ left: selection.position.x, top: selection.position.y }}
      onPointerDown={(event) => event.preventDefault()}
      onClick={cite}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (selection.sourceAnchor.htmlRender)
            htmlSelectionCommand(selection.sourceAnchor.htmlRender, "dismiss");
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

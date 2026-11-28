import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import { QuoteIcon } from "lucide-react";
import { use, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  effectiveShortcutsForCommand,
  formatAriaKeyshortcut,
  formatShortcutLabel,
  resolveShortcutCommand,
} from "~/keybindings";
import { registerAssistantSelectionProbe } from "~/lib/assistantSelectionState";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import { isEditableFocused } from "~/lib/editableFocus";
import {
  isSelectionRectVisible,
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import { getTerminalFocusOwner } from "~/lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { BackgroundThreadContext } from "./backgroundThread";
import { ChatShortcutContext } from "./chatShortcutContext";
import { TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR } from "./composerFocusRedirect";

type AssistantSelection = {
  citation: AssistantCitation;
  position: SelectionActionPoint;
  sourceAnchor: AssistantCitationSourceAnchor;
};

/** The viewport's visible assistant text selection as it is now, or null. */
function readAssistantSelection(
  viewport: HTMLElement,
  threadRef: ScopedThreadRef,
  pointer: SelectionActionPoint | null,
): AssistantSelection | null {
  const captured = captureAssistantTextSelection(viewport, window.getSelection());
  const messageId = captured?.source.dataset.assistantCitationSource;
  if (!captured || !messageId) return null;
  const rect = captured.range.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  if (!isSelectionRectVisible(rect, [viewportRect])) return null;
  // A selection can cross blocks with different clipping ancestors.
  const common = captured.range.commonAncestorContainer;
  const walker = document.createTreeWalker(common, NodeFilter.SHOW_TEXT);
  let node = common.nodeType === Node.TEXT_NODE ? common : walker.nextNode();
  let visible = false;
  for (; node && !visible; node = walker.nextNode()) {
    if (!captured.range.intersectsNode(node)) continue;
    if (node.parentElement && getComputedStyle(node.parentElement).userSelect === "none") continue;
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
  if (!visible) return null;
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
  return {
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
      pointer: pointerOnText ? pointer : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }),
  };
}

function isTooLongToCite(selection: AssistantSelection) {
  return selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
}

export function AssistantSelectionToolbar({
  viewport,
  threadRef,
  onCite,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
  onCite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
}) {
  const [selection, setSelection] = useState<AssistantSelection | null>(null);
  const toolbarRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
  const backgroundThread = use(BackgroundThreadContext);
  const chatShortcutContext = use(ChatShortcutContext);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const gt = useGT();

  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const cite = (target: AssistantSelection) => {
    if (!onCite(target.citation, target.sourceAnchor)) return;
    window.getSelection()?.removeAllRanges();
    dismiss();
  };
  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !viewport || event.isComposing || event.defaultPrevented || event.repeat)
      return;
    if (event.target instanceof Element && event.target.closest("[data-keybinding-capture]"))
      return;
    if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) return;
    if (isEditableFocused(event.target)) return;
    const context = chatShortcutContext
      ? chatShortcutContext.getShortcutContext(event.target)
      : { terminalFocus: getTerminalFocusOwner() !== null };
    const command = resolveShortcutCommand(event, keybindings, {
      context,
    });
    if (command === "chat.citeSelection") {
      // The selection can change before observeSelectionActions' scheduled refresh shows it.
      const live = readAssistantSelection(viewport, threadRef, null);
      if (!live || isTooLongToCite(live)) {
        setSelection(live);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      cite(live);
      return;
    }
    if (
      event.key === "Tab" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !toolbar.disabled &&
      !toolbar.contains(event.target as Node)
    ) {
      event.preventDefault();
      event.stopPropagation();
      toolbar.focus({ preventScroll: true });
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the toolbar DOM node and clamps its position inside the window before paint
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8))}px`;
  }, [selection]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to document selectionchange and keydown to track text selections in the viewport
  useEffect(() => {
    if (!viewport) return;
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => toolbarRef.current,
      restoreAfterScroll: true,
      immediateMultiClick: true,
      onSelection: (pointer) => setSelection(readAssistantSelection(viewport, threadRef, pointer)),
      onDismiss: () => setSelection(null),
    });
    actionsRef.current = actions;
    const onKeyDown = (event: KeyboardEvent) => handleShortcut(event);
    const unregisterProbe = !backgroundThread
      ? registerAssistantSelectionProbe(() => {
          if (
            !toolbarRef.current ||
            document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)
          ) {
            return false;
          }
          const live = readAssistantSelection(viewport, threadRef, null);
          return live !== null && !isTooLongToCite(live);
        })
      : null;
    // A background timeline only follows its selection; its keys belong to the foreground chat.
    if (!backgroundThread) document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      unregisterProbe?.();
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [backgroundThread, threadRef, viewport]);

  if (!selection) return null;
  const tooLong = isTooLongToCite(selection);
  const citeShortcut =
    tooLong || backgroundThread
      ? null
      : (effectiveShortcutsForCommand(keybindings, "chat.citeSelection", {
          context: {
            ...chatShortcutContext?.hintContext,
            assistantSelection: true,
            editableFocus: false,
            terminalFocus: false,
          },
        })[0] ?? null);
  return createPortal(
    <Button
      ref={toolbarRef}
      type="button"
      size="xs"
      variant="glass"
      disabled={tooLong}
      aria-label={tooLong ? gt("Selection is too long to cite") : gt("Cite selection in composer")}
      aria-keyshortcuts={citeShortcut ? formatAriaKeyshortcut(citeShortcut) : undefined}
      className="fixed z-50 max-w-[calc(100vw-1rem)]"
      style={{ left: selection.position.x, top: selection.position.y }}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        if (!tooLong) cite(selection);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      <QuoteIcon aria-hidden="true" className="size-3.5" />
      {tooLong
        ? gt("Shorten selection")
        : gt("Cite", { $context: "verb, button that quotes the selected text" })}
      {citeShortcut ? <Kbd>{formatShortcutLabel(citeShortcut)}</Kbd> : null}
    </Button>,
    document.body,
  );
}

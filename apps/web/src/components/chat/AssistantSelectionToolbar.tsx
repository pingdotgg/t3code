import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CopyIcon, TextQuoteIcon } from "lucide-react";
import { use, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import { shortcutLabelForCommand } from "~/keybindings";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import { isSelectionRectVisible, observeSelectionActions } from "~/lib/selectionActions";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { toastManager } from "../ui/toast";
import { BackgroundThreadContext } from "./backgroundThread";

// The one visible selection toolbar registers its cite action here so the
// chat.citeSelection shortcut can reach it from the thread's key handler.
let activeCiteSelection: (() => boolean) | null = null;

/** True while an assistant passage is selected and citable; the `assistantSelection` when-context. */
export function hasCitableAssistantSelection(): boolean {
  return activeCiteSelection !== null;
}

/** Cites the selected assistant passage in the composer. Returns false when nothing was cited. */
export function citeAssistantSelection(): boolean {
  return activeCiteSelection?.() ?? false;
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
  const backgroundThread = use(BackgroundThreadContext);
  const [selection, setSelection] = useState<{
    citation: AssistantCitation;
    /** The selection's box; the toolbar centers above it, or below when the top is clipped. */
    anchor: { centerX: number; top: number; bottom: number };
    sourceAnchor: AssistantCitationSourceAnchor;
  } | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);

  const attachToolbar = (toolbar: HTMLDivElement | null) => {
    toolbarRef.current = toolbar;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    const { anchor } = selection;
    const above = anchor.top - rect.height - 6;
    const top = above >= 8 ? above : anchor.bottom + 6;
    toolbar.style.left = `${Math.max(8, Math.min(anchor.centerX - rect.width / 2, window.innerWidth - rect.width - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(top, window.innerHeight - rect.height - 8))}px`;
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to document selectionchange and keydown to track text selections in the viewport
  useEffect(() => {
    if (!viewport || backgroundThread) return;
    const clear = () => setSelection(null);
    const update = () => {
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
      setSelection({
        sourceAnchor: { source: captured.source, range: captured.range, viewport },
        citation: {
          version: 1,
          ...threadRef,
          messageId: MessageId.make(messageId),
          ...captured.selector,
        },
        anchor: {
          centerX: rect.left + rect.width / 2,
          top: Math.max(rect.top, viewportRect.top),
          bottom: Math.min(rect.bottom, viewportRect.bottom),
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
      const firstAction = toolbar.querySelector<HTMLButtonElement>("button:enabled");
      if (!firstAction) return;
      event.preventDefault();
      event.stopPropagation();
      firstAction.focus({ preventScroll: true });
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

  const tooLong = selection
    ? selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH
    : false;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const cite = () => {
    if (!selection || tooLong || !onCite(selection.citation, selection.sourceAnchor)) return false;
    window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  const citeStable = useStableCallback(cite);
  const citable = selection !== null && !tooLong && !backgroundThread;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the foreground selection's cite action for the chat keyboard shortcut and releases it on cleanup
  useEffect(() => {
    if (!citable) return;
    const action = () => citeStable();
    activeCiteSelection = action;
    return () => {
      if (activeCiteSelection === action) activeCiteSelection = null;
    };
  }, [citable, citeStable]);

  if (!selection || backgroundThread) return null;
  const copy = () => {
    const text = window.getSelection()?.toString() || selection.citation.text;
    // The native copy runs the chat's copy handlers, so markdown and citations copy like Mod+C.
    const copied = (() => {
      try {
        return document.execCommand("copy");
      } catch {
        return false;
      }
    })();
    const done = () => {
      toastManager.add({ type: "success", title: "Copied to clipboard" });
      dismiss();
    };
    if (copied) {
      done();
      return;
    }
    void writeTextToClipboard(text, "selection").then(done, (error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not copy selection",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };
  const citeShortcut = shortcutLabelForCommand(keybindings, "chat.citeSelection", {
    context: { assistantSelection: true },
  });
  return createPortal(
    <div
      ref={attachToolbar}
      role="toolbar"
      aria-label="Selection actions"
      className="fixed z-50 flex h-8 max-w-[calc(100vw-1rem)] items-center gap-0.5 rounded-project-icon surface-popover p-0.75"
      style={{ left: selection.anchor.centerX, top: selection.anchor.top }}
      onPointerDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      {/* Cite is the toolbar's primary action, so it sits on the selected fill. */}
      <span className={tooLong ? "flex" : "flex rounded-control surface-selected-soft"}>
        <Button
          variant="ghost"
          size="xs"
          disabled={tooLong}
          aria-label={tooLong ? "Selection is too long to cite" : "Cite selection in composer"}
          aria-keyshortcuts={citeShortcut ?? undefined}
          onClick={cite}
        >
          <TextQuoteIcon aria-hidden="true" />
          {tooLong ? "Shorten selection" : "Cite in composer"}
          {!tooLong && citeShortcut ? <Kbd>{citeShortcut}</Kbd> : null}
        </Button>
      </span>
      <span aria-hidden="true" className="h-4 w-px shrink-0 bg-divider" />
      <Button variant="ghost" size="xs" onClick={copy}>
        <CopyIcon aria-hidden="true" />
        Copy
      </Button>
    </div>,
    document.body,
  );
}

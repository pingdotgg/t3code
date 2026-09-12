"use client";

import * as React from "react";

import { toastManager } from "../components/ui/toast";
import {
  getCopyableDomSelectionText,
  isCopyOnSelectEditableTarget,
  sameDomSelectionSnapshot,
  shouldAutoCopyOnMouseUp,
  snapshotDomSelection,
  type DomSelectionSnapshot,
} from "../lib/copyOnSelect";
import { SELECTION_MULTI_CLICK_INTERVAL_MS } from "../lib/selectionActions";
import { writeTextToClipboard } from "./useCopyToClipboard";
import { useClientSettings } from "./useSettings";

/**
 * Herdr-style copy-on-select for DOM surfaces (the chat timeline): releasing
 * a left-button drag or double-click copies the selection and shows the
 * "copied to clipboard" toast.
 *
 * The gesture may end anywhere (composer, sidebar, another panel): as long
 * as the press started on chat text and the released selection sits inside
 * `container`, it copies — mirroring the terminal path, which also accepts
 * release outside its surface. Keyboard selections never trigger it (no
 * mouseup), editable targets never arm it, and only a gesture that created
 * or changed the selection may copy — a plain click over an existing
 * selection leaves the clipboard alone. Multi-click releases wait out the
 * click sequence so a triple-click copies the paragraph once instead of
 * the word and then the paragraph, mirroring the terminal path. The copied
 * text is reserved before the async write starts so a repeated gesture
 * can't double-copy while the first write is pending; the reservation is
 * released if the write fails. The toast only fires after a successful
 * clipboard write — never optimistically.
 */
export function useCopyOnSelect(container: HTMLElement | null): void {
  const copyOnSelect = useClientSettings((settings) => settings.copyOnSelect);
  const showToast = useClientSettings((settings) => settings.copyOnSelectToast);
  const lastCopiedRef = React.useRef<string | null>(null);
  const gestureStartRef = React.useRef<{ snapshot: DomSelectionSnapshot; armed: boolean }>({
    snapshot: null,
    armed: false,
  });
  const readSettings = React.useEffectEvent(() => ({ copyOnSelect, showToast }));

  React.useEffect(() => {
    if (!container) return;
    const view = container.ownerDocument.defaultView ?? window;
    let pendingMultiClickTimer: number | null = null;
    const cancelPendingCopy = () => {
      if (pendingMultiClickTimer !== null) {
        view.clearTimeout(pendingMultiClickTimer);
        pendingMultiClickTimer = null;
      }
    };
    const pressStartedInContainer = (target: EventTarget | null): boolean =>
      target instanceof Node && container.contains(target);
    const onMouseDown = (event: MouseEvent) => {
      gestureStartRef.current = { snapshot: null, armed: false };
      // A new press in the sequence supersedes a deferred multi-click copy.
      cancelPendingCopy();
      if (event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (!pressStartedInContainer(event.target)) return;
      if (isCopyOnSelectEditableTarget(event.target)) return;
      gestureStartRef.current = {
        snapshot: snapshotDomSelection(view.getSelection()),
        armed: true,
      };
    };
    const onMouseUp = (event: MouseEvent) => {
      const { snapshot: startSnapshot, armed } = gestureStartRef.current;
      gestureStartRef.current = { snapshot: null, armed: false };
      if (!armed) return;
      if (!readSettings().copyOnSelect) return;
      if (!shouldAutoCopyOnMouseUp(event)) return;
      const selection = view.getSelection();
      if (sameDomSelectionSnapshot(startSnapshot, snapshotDomSelection(selection))) return;
      const text = getCopyableDomSelectionText(selection, container);
      if (text === null || text === lastCopiedRef.current) return;
      const fireCopy = () => {
        pendingMultiClickTimer = null;
        if (!readSettings().copyOnSelect) return;
        if (text === lastCopiedRef.current) return;
        // Reserve before the await so a repeated gesture while this write is
        // pending can't issue a second write and toast.
        lastCopiedRef.current = text;
        void writeTextToClipboard(text, "selection").then(
          (didCopy) => {
            if (!didCopy) {
              if (lastCopiedRef.current === text) lastCopiedRef.current = null;
              return;
            }
            if (readSettings().showToast) {
              toastManager.add({ type: "success", title: "Copied to clipboard" });
            }
          },
          () => {
            // Silent on failure: no false toast when the clipboard API is
            // unavailable (e.g. plain-HTTP remote sessions).
            if (lastCopiedRef.current === text) lastCopiedRef.current = null;
          },
        );
      };
      if (event.detail >= 2) {
        // Double/triple-click: hold the copy so the next press in the
        // sequence can supersede it; only the final selection copies once.
        cancelPendingCopy();
        pendingMultiClickTimer = view.setTimeout(fireCopy, SELECTION_MULTI_CLICK_INTERVAL_MS);
        return;
      }
      fireCopy();
    };
    view.addEventListener("mousedown", onMouseDown);
    view.addEventListener("mouseup", onMouseUp);
    return () => {
      cancelPendingCopy();
      view.removeEventListener("mousedown", onMouseDown);
      view.removeEventListener("mouseup", onMouseUp);
    };
  }, [container]);
}

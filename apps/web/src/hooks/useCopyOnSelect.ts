"use client";

import * as React from "react";

import { toastManager } from "../components/ui/toast";
import {
  getCopyableDomSelectionText,
  isCopyOnSelectInteractiveTarget,
  sameDomSelectionSnapshot,
  shouldAutoCopyOnMouseUp,
  snapshotDomSelection,
  type DomSelectionSnapshot,
} from "../lib/copyOnSelect";
import { writeTextToClipboard } from "./useCopyToClipboard";
import { useClientSettings } from "./useSettings";

/**
 * Herdr-style copy-on-select for DOM surfaces (the chat timeline): releasing
 * a left-button drag or double-click inside `container` copies the selection
 * and shows the "copied to clipboard" toast.
 *
 * Keyboard selections never trigger it (no mouseup), editable and
 * interactive targets are skipped, and only a gesture that created or
 * changed the selection may copy — a plain click over an existing selection
 * leaves the clipboard alone. Consecutive copies of identical text are
 * deduplicated so clicking around a stable selection stays quiet. The toast
 * only fires after a successful clipboard write — never optimistically.
 */
export function useCopyOnSelect(container: HTMLElement | null): void {
  const copyOnSelect = useClientSettings((settings) => settings.copyOnSelect);
  const showToast = useClientSettings((settings) => settings.copyOnSelectToast);
  const lastCopiedRef = React.useRef<string | null>(null);
  const gestureStartRef = React.useRef<{ snapshot: DomSelectionSnapshot; armed: boolean }>({
    snapshot: null,
    armed: false,
  });
  const settingsRef = React.useRef({ copyOnSelect, showToast });
  settingsRef.current = { copyOnSelect, showToast };

  React.useEffect(() => {
    if (!container) return;
    const onMouseDown = (event: MouseEvent) => {
      gestureStartRef.current = { snapshot: null, armed: false };
      if (event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isCopyOnSelectInteractiveTarget(event.target)) return;
      gestureStartRef.current = {
        snapshot: snapshotDomSelection(window.getSelection()),
        armed: true,
      };
    };
    const onMouseUp = (event: MouseEvent) => {
      const { snapshot: startSnapshot, armed } = gestureStartRef.current;
      gestureStartRef.current = { snapshot: null, armed: false };
      if (!armed) return;
      if (!settingsRef.current.copyOnSelect) return;
      if (!shouldAutoCopyOnMouseUp(event)) return;
      if (isCopyOnSelectInteractiveTarget(event.target)) return;
      const selection = window.getSelection();
      if (sameDomSelectionSnapshot(startSnapshot, snapshotDomSelection(selection))) return;
      const text = getCopyableDomSelectionText(selection, container);
      if (text === null || text === lastCopiedRef.current) return;
      void writeTextToClipboard(text, "selection").then(
        (didCopy) => {
          if (!didCopy) return;
          lastCopiedRef.current = text;
          if (settingsRef.current.showToast) {
            toastManager.add({ type: "success", title: "Copied to clipboard" });
          }
        },
        () => {
          // Silent on failure: no false toast when the clipboard API is
          // unavailable (e.g. plain-HTTP remote sessions).
        },
      );
    };
    container.addEventListener("mousedown", onMouseDown);
    container.addEventListener("mouseup", onMouseUp);
    return () => {
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("mouseup", onMouseUp);
    };
  }, [container]);
}

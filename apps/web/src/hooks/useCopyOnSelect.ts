"use client";

import * as React from "react";

import { toastManager } from "../components/ui/toast";
import {
  getCopyableDomSelectionText,
  isCopyOnSelectInteractiveTarget,
  shouldAutoCopyOnMouseUp,
} from "../lib/copyOnSelect";
import { writeTextToClipboard } from "./useCopyToClipboard";
import { useClientSettings } from "./useSettings";

/**
 * Herdr-style copy-on-select for DOM surfaces (the chat timeline): releasing
 * a left-button drag or double-click inside `container` copies the selection
 * and shows the "copied to clipboard" toast.
 *
 * Keyboard selections never trigger it (no mouseup), editable and
 * interactive targets are skipped, and consecutive copies of identical text
 * are deduplicated so clicking around a stable selection stays quiet. The
 * toast only fires after a successful clipboard write — never optimistically.
 */
export function useCopyOnSelect(container: HTMLElement | null): void {
  const copyOnSelect = useClientSettings((settings) => settings.copyOnSelect);
  const showToast = useClientSettings((settings) => settings.copyOnSelectToast);
  const lastCopiedRef = React.useRef<string | null>(null);
  const settingsRef = React.useRef({ copyOnSelect, showToast });
  settingsRef.current = { copyOnSelect, showToast };

  React.useEffect(() => {
    if (!container) return;
    const onMouseUp = (event: MouseEvent) => {
      if (!settingsRef.current.copyOnSelect) return;
      if (!shouldAutoCopyOnMouseUp(event)) return;
      if (isCopyOnSelectInteractiveTarget(event.target)) return;
      const text = getCopyableDomSelectionText(window.getSelection(), container);
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
    container.addEventListener("mouseup", onMouseUp);
    return () => {
      container.removeEventListener("mouseup", onMouseUp);
    };
  }, [container]);
}

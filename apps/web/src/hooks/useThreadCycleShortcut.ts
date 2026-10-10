import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { resolveShortcutCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { threadSwitcher, type ThreadCyclePreview } from "../threadSwitching";
import { useClientSettings } from "./useSettings";

export function useThreadCycleShortcut(input: {
  keybindings: ResolvedKeybindingsConfig;
  threadKeys: readonly string[];
  currentThreadKey: string | null;
  terminalOpen: boolean;
  navigateToThread: (key: string) => void;
}) {
  const order = useClientSettings((settings) => settings.threadCycleOrder);
  const heldModifiers = useRef<string[]>([]);
  const requestedThreadKey = useRef<string | null>(null);
  const pending = useRef<ThreadCyclePreview | null>(null);
  const [preview, setPreview] = useState<ThreadCyclePreview | null>(null);

  const cancel = useCallback(() => {
    heldModifiers.current = [];
    pending.current = null;
    setPreview(null);
    threadSwitcher.cancel();
  }, []);
  const commit = (key = pending.current?.selectedKey) => {
    cancel();
    if (key === undefined || !input.threadKeys.includes(key)) return;
    threadSwitcher.visit(key);
    requestedThreadKey.current = key;
    input.navigateToThread(key);
  };

  useEffect(() => {
    const requested = requestedThreadKey.current;
    requestedThreadKey.current = null;
    // A previous gesture's navigation can finish while the next preview is open.
    if (requested !== null && requested === input.currentThreadKey) return;
    if (pending.current !== null) cancel();
    threadSwitcher.visit(input.currentThreadKey);
  }, [input.currentThreadKey, cancel]);

  useEffect(() => {
    if (order === "sidebar" && pending.current !== null) cancel();
  }, [order, cancel]);

  useEffect(() => {
    if (pending.current !== null && !input.threadKeys.includes(pending.current.selectedKey)) {
      cancel();
    }
  }, [input.threadKeys, cancel]);

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      isCommandPaletteOpen() ||
      isModelPickerOpen() ||
      (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
    ) {
      cancel();
      return;
    }
    if (pending.current !== null && (event.key === "Escape" || event.key === "Enter")) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Enter") commit();
      else cancel();
      return;
    }
    const command = resolveShortcutCommand(event, input.keybindings, {
      context: {
        terminalFocus: isTerminalFocused(),
        terminalOpen: input.terminalOpen,
        previewFocus: isPreviewFocused(),
        editableFocus: isEditableFocused(event.target),
      },
    });
    const arrow =
      pending.current !== null &&
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key);
    if (!arrow && command !== "thread.cycleNext" && command !== "thread.cyclePrevious") {
      if (!["Control", "Meta", "Alt", "Shift"].includes(event.key)) cancel();
      return;
    }
    const next = threadSwitcher.next(
      input.threadKeys,
      (
        arrow
          ? event.key === "ArrowRight" || event.key === "ArrowDown"
          : command === "thread.cycleNext"
      )
        ? 1
        : -1,
      order,
    );
    if (next === null) {
      cancel();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!arrow) {
      heldModifiers.current = [
        ...(event.ctrlKey ? ["Control"] : []),
        ...(event.metaKey ? ["Meta"] : []),
        ...(event.altKey ? ["Alt"] : []),
      ];
    }
    if (order === "sidebar" || heldModifiers.current.length === 0) {
      commit(next.selectedKey);
    } else {
      pending.current = next;
      setPreview(next);
    }
  });
  const onKeyUp = useEffectEvent((event: KeyboardEvent) => {
    if (!heldModifiers.current.includes(event.key)) return;
    heldModifiers.current = heldModifiers.current.filter((key) => key !== event.key);
    if (heldModifiers.current.length === 0) commit();
  });

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", cancel);
      threadSwitcher.cancel();
    };
  }, [cancel]);

  return { preview, cancel, commit };
}

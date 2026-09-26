import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { resolveShortcutCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "../state/server";
import {
  commitModifiersForShortcutEvent,
  cycleSwitcherCommandInfo,
  cycleSwitcherCommitModifiersReleased,
  resolveCycleSwitcherIndex,
  type CycleSwitcherDirection,
  type CycleSwitcherMode,
  type CycleSwitcherModifierKey,
} from "./CycleSwitcher.logic";
import type { CycleSwitcherEntry } from "./useCycleSwitcherEntries";

export function useCycleSwitcherController() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [mode, setMode] = useState<CycleSwitcherMode | null>(null);
  const [stepOffset, setStepOffset] = useState(0);
  const [initialDirection, setInitialDirection] = useState<CycleSwitcherDirection>(1);
  const commitModifiersRef = useRef<ReadonlyArray<CycleSwitcherModifierKey>>([]);

  const closeSwitcher = () => {
    commitModifiersRef.current = [];
    setMode(null);
    setStepOffset(0);
    setInitialDirection(1);
  };

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return;

    if (mode !== null) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeSwitcher();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }

    if (mode === null && event.defaultPrevented) return;
    if (isCommandPaletteOpen()) return;

    const command = resolveShortcutCommand(event, keybindings, {
      context: {
        terminalFocus: isTerminalFocused(),
        terminalOpen: document.querySelector("[data-terminal-owner]") !== null,
        previewFocus: isPreviewFocused(),
        previewOpen: document.querySelector("[data-preview-panel-mode]") !== null,
        editableFocus: isEditableFocused(event.target),
        modelPickerOpen: isModelPickerOpen(),
      },
    });
    const commandInfo = cycleSwitcherCommandInfo(command);
    if (commandInfo === null) return;

    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;

    if (mode === null || commandInfo.mode !== mode) {
      const commitModifiers = commitModifiersForShortcutEvent(event);
      // A hold gesture needs a primary modifier whose release can commit it.
      if (commitModifiers.length === 0) return;
      commitModifiersRef.current = commitModifiers;
      setMode(commandInfo.mode);
      setStepOffset(commandInfo.direction);
      setInitialDirection(commandInfo.direction);
      return;
    }

    setStepOffset((offset) => offset + commandInfo.direction);
  });

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  return {
    mode,
    stepOffset,
    initialDirection,
    selectIndex: setStepOffset,
    closeSwitcher,
    commitModifiersReleased: (event: KeyboardEvent) =>
      cycleSwitcherCommitModifiersReleased(event, commitModifiersRef.current),
  };
}

interface CycleSwitcherSessionOptions {
  readonly liveEntries: ReadonlyArray<CycleSwitcherEntry>;
  readonly stepOffset: number;
  readonly initialDirection: CycleSwitcherDirection;
  readonly closeSwitcher: () => void;
  readonly commitModifiersReleased: (event: KeyboardEvent) => boolean;
}

/** Owns one hold gesture, including its immutable entry snapshot. */
export function useCycleSwitcherSession({
  liveEntries,
  stepOffset,
  initialDirection,
  closeSwitcher,
  commitModifiersReleased,
}: CycleSwitcherSessionOptions) {
  const [entries] = useState(liveEntries);
  const activeIndex = resolveCycleSwitcherIndex({
    stepOffset,
    length: entries.length,
    currentIndex: entries.findIndex((entry) => entry.isCurrent),
    initialDirection,
  });

  const commitSelection = useEffectEvent(() => {
    const entry = entries[activeIndex];
    closeSwitcher();
    entry?.commit();
  });

  const handleKeyUp = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (!commitModifiersReleased(event)) return;
    event.preventDefault();
    event.stopPropagation();
    commitSelection();
  });

  const handleWindowBlur = useEffectEvent(closeSwitcher);

  useEffect(() => {
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  return { entries, activeIndex };
}

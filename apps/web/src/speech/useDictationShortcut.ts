import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useClientSettings } from "../hooks/useSettings";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { getTerminalFocusOwner } from "../lib/terminalFocus";

const HOLD_THRESHOLD_MS = 300;

export function shouldFinishDictationOnRelease(
  mode: "auto" | "hold" | "toggle",
  elapsedMs: number,
) {
  return mode === "hold" || (mode === "auto" && elapsedMs >= HOLD_THRESHOLD_MS);
}

type SpeechActions = {
  available: boolean;
  state: VoiceInputState<true>;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(): void;
};

export function useDictationShortcut(input: {
  keybindings: ResolvedKeybindingsConfig;
  speech: SpeechActions;
  disabled: boolean;
  terminalOpen: boolean;
  modelPickerOpen: boolean;
}) {
  const mode = useClientSettings((settings) => settings.voiceShortcutMode);
  const current = useRef(input);
  useEffect(() => {
    current.current = input;
  });
  const pressed = useRef<{
    code: string;
    startedAt: number;
    mode: typeof mode;
    starting: Promise<void>;
  } | null>(null);

  useEffect(() => {
    const finish = (event: KeyboardEvent | null) => {
      const press = pressed.current;
      if (!press || (event && (event.code || event.key) !== press.code)) return;
      pressed.current = null;
      if (shouldFinishDictationOnRelease(press.mode, performance.now() - press.startedAt)) {
        void press.starting.then(() => current.current.speech.stop());
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      const { speech } = current.current;
      if (event.key === "Escape" && (pressed.current !== null || speech.state.phase !== "idle")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        pressed.current = null;
        speech.cancel();
        return;
      }
      if (event.defaultPrevented || isCommandPaletteOpen()) return;
      const { keybindings, terminalOpen, modelPickerOpen, disabled } = current.current;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: getTerminalFocusOwner() !== null,
          terminalOpen,
          modelPickerOpen,
        },
      });
      if (command !== "composer.dictation") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || pressed.current) return;
      if (speech.state.phase === "recording") {
        void speech.stop();
        return;
      }
      if (speech.state.phase !== "idle" && speech.state.phase !== "error") return;
      if (!speech.available || disabled) return;
      pressed.current = {
        code: event.code || event.key,
        startedAt: performance.now(),
        mode,
        starting: speech.start(),
      };
    };
    const onBlur = () => finish(null);

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", finish, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", finish, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [mode]);

  return shortcutLabelForCommand(input.keybindings, "composer.dictation", {
    context: { terminalFocus: false, terminalOpen: input.terminalOpen },
  });
}

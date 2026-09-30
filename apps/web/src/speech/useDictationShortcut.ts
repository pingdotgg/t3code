import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect, useRef, type RefObject } from "react";

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

export type DictationKeyHandlers = {
  keydown(event: KeyboardEvent): void;
  keyup(event: KeyboardEvent): void;
  blur(): void;
};

type ShortcutInput = {
  keybindings: ResolvedKeybindingsConfig;
  speech: SpeechActions;
  disabled: boolean;
  terminalOpen: boolean;
  modelPickerOpen: boolean;
  subscribeKeys?: (handlers: DictationKeyHandlers) => () => void;
  previewFocus?: boolean;
  ownsFocus?: () => boolean;
  targetRef?: RefObject<HTMLElement | null>;
};

const shortcutTargets = new Map<symbol, () => ShortcutInput>();

function ownsShortcut(id: symbol) {
  const entries = [...shortcutTargets];
  const busy = entries.find(([, read]) => {
    const phase = read().speech.state.phase;
    return phase !== "idle" && phase !== "error";
  });
  if (busy) return busy[0] === id;
  const focused = entries.find(
    ([, read]) =>
      read().ownsFocus?.() || read().targetRef?.current?.contains(document.activeElement),
  );
  if (focused) return focused[0] === id;
  return entries.find(([, read]) => !read().targetRef && !read().ownsFocus)?.[0] === id;
}

export function useDictationShortcut(input: ShortcutInput) {
  const id = useRef(Symbol("dictation-target"));
  const subscribeKeys = input.subscribeKeys;
  const mode = useClientSettings((settings) => settings.voiceShortcutMode);
  const current = useRef(input);
  useEffect(() => {
    current.current = input;
  });
  const generation = useRef(0);
  const pressed = useRef<{
    generation: number;
    code: string;
    startedAt: number;
    mode: typeof mode;
    starting: Promise<void>;
  } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let disposed = false;
    shortcutTargets.set(id.current, () => current.current);
    const finish = (event: KeyboardEvent | null) => {
      const press = pressed.current;
      if (!press || (event && (event.code || event.key) !== press.code)) return;
      pressed.current = null;
      if (shouldFinishDictationOnRelease(press.mode, performance.now() - press.startedAt)) {
        void press.starting.then(() => {
          if (!disposed && generation.current === press.generation)
            return current.current.speech.stop();
        });
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!ownsShortcut(id.current)) return;
      if (event.isComposing || event.keyCode === 229) return;
      const { speech } = current.current;
      if (event.key === "Escape" && (pressed.current !== null || speech.state.phase !== "idle")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        pressed.current = null;
        generation.current += 1;
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
          previewFocus: current.current.previewFocus ?? false,
          previewOpen: current.current.previewFocus ?? false,
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
        generation: ++generation.current,
        code: event.code || event.key,
        startedAt: performance.now(),
        mode,
        starting: speech.start(),
      };
    };
    const onBlur = () => finish(null);

    const unsubscribe = subscribeKeys?.({ keydown: onKeyDown, keyup: finish, blur: onBlur });
    if (!subscribeKeys) {
      window.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("keyup", finish, true);
      window.addEventListener("blur", onBlur);
    }
    return () => {
      disposed = true;
      pressed.current = null;
      shortcutTargets.delete(id.current);
      unsubscribe?.();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", finish, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [mode, subscribeKeys]);

  return shortcutLabelForCommand(input.keybindings, "composer.dictation", {
    context: { terminalFocus: false, terminalOpen: input.terminalOpen },
  });
}

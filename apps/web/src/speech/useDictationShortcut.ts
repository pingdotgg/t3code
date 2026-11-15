import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect, useRef, type RefObject } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useClientSettings } from "../hooks/useSettings";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { getTerminalFocusOwner } from "../lib/terminalFocus";

const HOLD_THRESHOLD_MS = 300;

function shouldFinishDictationOnRelease(mode: "auto" | "hold" | "toggle", elapsedMs: number) {
  return mode === "hold" || (mode === "auto" && elapsedMs >= HOLD_THRESHOLD_MS);
}

type SpeechActions = {
  available: boolean;
  state: VoiceInputState;
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
  /** Resolve the chord as if the preview had focus; the keys arrive relayed from its guest. */
  previewFocus?: boolean;
  /** When set, the chord targets this editor only while it has focus. */
  targetRef?: RefObject<HTMLElement | null>;
  /** An editor outside this document reports whether it holds the keyboard. */
  ownsFocus?: () => boolean;
  /** Receives handlers that replay keys an outside editor relayed, as if typed here. */
  subscribeKeys?: (handlers: DictationKeyHandlers) => () => void;
};

// Several editors can bind the chord; the busy one, then the focused one, then the untargeted one wins.
const shortcutTargets = new Map<symbol, () => ShortcutInput>();

function ownsShortcut(id: symbol) {
  const entries = [...shortcutTargets];
  const busy = entries.find(([, read]) => {
    const phase = read().speech.state.phase;
    return phase !== "idle" && phase !== "error";
  });
  if (busy) return busy[0] === id;
  const focused =
    entries.find(([, read]) => read().ownsFocus?.()) ??
    entries.find(([, read]) => read().targetRef?.current?.contains(document.activeElement));
  if (focused) return focused[0] === id;
  return entries.find(([, read]) => !read().targetRef && !read().ownsFocus)?.[0] === id;
}

const targetScope = (field: HTMLElement | null | undefined) =>
  field?.closest('[role="dialog"]') ?? field;

// Keys an outside editor (the preview guest) relays arrive on window, so remember their editor.
const relayedFrom = new WeakMap<Event, symbol>();

// Escape inside another shown dictation editor, or the dialog hosting it, belongs to that editor.
// The editor itself is checked before dialogs, since one dialog can host several editors.
function inOtherShortcutTarget(id: symbol, event: Event) {
  const source = relayedFrom.get(event);
  if (source) return source !== id;
  const target = event.target;
  if (!(target instanceof Node)) return false;
  const own = shortcutTargets.get(id)?.().targetRef?.current;
  const others = [...shortcutTargets]
    .filter(([other]) => other !== id)
    .map(([, read]) => read().targetRef?.current)
    .filter((field): field is HTMLElement => !!field?.getClientRects().length);
  for (const scope of [(field?: HTMLElement | null) => field, targetScope]) {
    if (scope(own)?.contains(target)) return false;
    if (others.some((field) => scope(field)?.contains(target))) return true;
  }
  return false;
}

export function useDictationShortcut(input: ShortcutInput) {
  const id = useRef(Symbol("dictation-target"));
  const subscribeKeys = input.subscribeKeys;
  const mode = useClientSettings((settings) => settings.voiceShortcutMode);
  const current = useRef(input);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed actions to the window keyboard listener and shortcut registry
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the window keyboard listeners and dictation target registry entry
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
      if (event.defaultPrevented || isCommandPaletteOpen()) return;
      if (
        event.key === "Escape" &&
        (pressed.current !== null ||
          (speech.state.phase !== "idle" && speech.state.phase !== "error")) &&
        !inOtherShortcutTarget(id.current, event)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        pressed.current = null;
        generation.current += 1;
        speech.cancel();
        return;
      }
      const { keybindings, terminalOpen, modelPickerOpen, disabled } = current.current;
      const previewFocus = current.current.previewFocus ?? false;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: getTerminalFocusOwner() !== null,
          terminalOpen,
          modelPickerOpen,
          previewFocus,
          previewOpen: previewFocus,
          ...(previewFocus ? { editableFocus: true } : {}),
        },
      });
      if (command !== "composer.dictation") return;
      const canStart = speech.state.phase === "idle" || speech.state.phase === "error";
      if (canStart && (!speech.available || disabled)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || (!canStart && speech.state.phase !== "recording")) return;
      // macOS may omit the previous non-modifier keyup while Command is held.
      pressed.current = null;
      generation.current += 1;
      if (speech.state.phase === "recording") {
        void speech.stop();
        return;
      }
      pressed.current = {
        generation: generation.current,
        code: event.code || event.key,
        startedAt: performance.now(),
        mode,
        starting: speech.start(),
      };
    };
    const onBlur = () => finish(null);
    const relay = (event: KeyboardEvent) => {
      relayedFrom.set(event, id.current);
      window.dispatchEvent(event);
    };
    const unsubscribe = subscribeKeys?.({
      keydown: relay,
      keyup: relay,
      blur: onBlur,
    });
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", finish, true);
    window.addEventListener("blur", onBlur);
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

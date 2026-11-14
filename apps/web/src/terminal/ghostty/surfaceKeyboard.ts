import { GhosttyTerminalSurface } from "./surface";
import { isMacPlatform } from "../../lib/utils";
import {
  applyTerminalCopyEvent,
  clearPrimedTerminalCopyInput,
  isTerminalAltGraphText,
  isTerminalCompositionCommitInput,
  isTerminalCompositionKey,
  isTerminalCopyShortcut,
  isTerminalPasteShortcut,
  primeTerminalCopyInput,
} from "./surfaceInput";

export function surfaceOnKeyDown(surface: GhosttyTerminalSurface, event: KeyboardEvent) {
  // A consumed repeat still owes the original encoded press a release.
  if (!event.repeat) surface.encodedKeyCodes.delete(event.code);
  if (isTerminalAltGraphText(event) || !surface.options.beforeKey(event)) return;
  // IME candidates belong to the textarea, even if the key also resembles
  // a local shortcut. Safari signals the initial composition with code 229.
  if (isTerminalCompositionKey(event, surface.composing)) {
    return;
  }
  const mac = isMacPlatform(navigator.platform);
  const primaryModifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const selectAllShortcut =
    event.key.toLowerCase() === "a" &&
    primaryModifier &&
    !event.altKey &&
    (mac ? !event.shiftKey : event.shiftKey);
  if (selectAllShortcut) {
    event.preventDefault();
    event.stopPropagation();
    surface.selectAll();
    return;
  }
  const pageHistory =
    event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    (event.key === "PageUp" || event.key === "PageDown");
  const jumpHistory =
    event.shiftKey &&
    !event.altKey &&
    primaryModifier &&
    (event.key === "Home" || event.key === "End");
  if ((pageHistory || jumpHistory) && !surface.core.isAlternateScreen()) {
    const state = surface.readScrollbarState();
    if (state !== null) {
      event.preventDefault();
      event.stopPropagation();
      const delta =
        event.key === "Home"
          ? -state.offset
          : event.key === "End"
            ? state.total - state.len - state.offset
            : Math.max(1, state.len) * (event.key === "PageUp" ? -1 : 1);
      surface.scrollViewport(delta);
      return;
    }
  }
  if (isTerminalCopyShortcut(event) && surface.hasSelection()) {
    // WebKit can omit copy without DOM selection. Ctrl+Shift+C and Ctrl+Insert need synthesized copy events.
    const selection = surface.getSelection();
    surface.primeCopy(selection);
    if (event.shiftKey || event.key.toLowerCase() === "insert") {
      event.preventDefault();
      document.execCommand("copy");
    } else {
      // Clear after plain non-mac Ctrl+C so the next press sends SIGINT.
      surface.clearSelectionAfterCopy = !event.shiftKey && !isMacPlatform(navigator.platform);
      const clipboard = navigator.clipboard;
      if (typeof clipboard?.writeText === "function") {
        // Defer fallback writes until native copy can claim the token; browsers may omit copy events.
        const token = ++surface.copyShortcutToken;
        void Promise.resolve().then(() => {
          if (surface.disposed || surface.copyShortcutToken !== token) return;
          void clipboard.writeText(selection).then(
            () => {
              if (surface.disposed || surface.copyShortcutToken !== token) return;
              if (surface.clearSelectionAfterCopy) {
                surface.clearSelectionAfterCopy = false;
                surface.clearSelection();
              }
            },
            () => {
              if (surface.copyShortcutToken === token) {
                surface.clearSelectionAfterCopy = false;
              }
            },
          );
        });
      }
    }
    return;
  }
  if (isTerminalPasteShortcut(event)) {
    const gesture = { code: event.code, readText: "" };
    surface.pasteShortcutGesture = gesture;
    const clipboard = navigator.clipboard;
    if (typeof clipboard?.readText === "function") {
      // Keep native paste available if the read is denied. The token drops
      // a late read; the gesture drops a native duplicate when the read wins.
      const token = ++surface.pasteShortcutToken;
      void clipboard.readText().then(
        (text) => {
          if (surface.disposed || surface.pasteShortcutToken !== token) return;
          surface.pasteShortcutToken += 1;
          if (text.length === 0) return;
          if (surface.pasteShortcutGesture === gesture) gesture.readText = text;
          surface.options.onData(surface.core.encodePaste(text));
        },
        () => {},
      );
    }
    return;
  }
  surface.clearPrimedCopy();
  const data = surface.core.encodeKey(event);
  if (data.length === 0) return;
  surface.encodedKeyCodes.add(event.code);
  event.preventDefault();
  event.stopPropagation();
  surface.options.onData(data);
}

export function surfaceOnKeyUp(surface: GhosttyTerminalSurface, event: KeyboardEvent) {
  // macOS can omit V keyup while Command is held.
  if (
    event.code === surface.pasteShortcutGesture?.code ||
    event.key === "Meta" ||
    event.key === "Control" ||
    event.key === "Shift"
  ) {
    surface.pasteShortcutGesture = null;
  }
  if (!surface.encodedKeyCodes.delete(event.code)) return;
  if (isTerminalCompositionKey(event, surface.composing)) {
    return;
  }
  // Ghostty emits release codes only for Kitty report-event-types sessions.
  const data = surface.core.encodeKey(event, "release");
  if (data.length === 0) return;
  event.preventDefault();
  event.stopPropagation();
  surface.options.onData(data);
}

// A release elsewhere must not leave a press for a later app shortcut to inherit.
export function surfaceOnWindowKeyUp(surface: GhosttyTerminalSurface, event: KeyboardEvent) {
  if (event.composedPath().includes(surface.input)) return;
  surface.encodedKeyCodes.delete(event.code);
}

// A fresh press proves a release was missed; repeats can span a focus round trip.
export function surfaceOnWindowKeyDown(surface: GhosttyTerminalSurface, event: KeyboardEvent) {
  if (!event.repeat) surface.encodedKeyCodes.delete(event.code);
}

export function surfaceOnFocus(surface: GhosttyTerminalSurface) {
  surface.focused = true;
  surface.cursorOn = true;
  surface.requestRender();
}

export function surfaceOnBlur(surface: GhosttyTerminalSurface) {
  surface.focused = false;
  surface.pasteShortcutGesture = null;
  surface.refreshHoveredLink();
  surface.cursorOn = true;
  surface.requestRender();
}

export function surfacePrimeCopy(surface: GhosttyTerminalSurface, selection: string) {
  surface.primedCopySelection = selection;
  primeTerminalCopyInput(surface.input, selection);
}

export function surfaceClearPrimedCopy(surface: GhosttyTerminalSurface) {
  clearPrimedTerminalCopyInput(surface.input, surface.primedCopySelection);
  surface.primedCopySelection = "";
}

export function surfaceOnCopyEvent(surface: GhosttyTerminalSurface, event: ClipboardEvent) {
  const selection = surface.hasSelection() ? surface.getSelection() : surface.input.value;
  // Menu Copy skips keydown; prime the textarea even without clipboardData for the native action.
  surface.primeCopy(selection);
  const result = applyTerminalCopyEvent(selection, event.clipboardData);
  if (result.preventDefault) event.preventDefault();
  if (result.claimWriteFallback) {
    // Native copy wrote successfully; invalidate writeText so it cannot overwrite a later copy.
    surface.copyShortcutToken += 1;
    if (surface.clearSelectionAfterCopy) {
      surface.clearSelectionAfterCopy = false;
      surface.clearSelection();
    }
  }
}

export function surfaceOnPaste(surface: GhosttyTerminalSurface, event: ClipboardEvent) {
  // Default textarea insertion would bypass bracketed-paste encoding through onInput.
  event.preventDefault();
  const data = event.clipboardData?.getData("text/plain") ?? "";
  if (data.length === 0) return;
  if (data === surface.pasteShortcutGesture?.readText) {
    // The shortcut's clipboard read already sent this paste.
    surface.pasteShortcutGesture = null;
    return;
  }
  // The native paste won the race with actual text; a pending clipboard read
  // must not double. An empty native paste leaves the read as the only path.
  surface.pasteShortcutToken += 1;
  surface.options.onData(surface.core.encodePaste(data));
}

export function surfaceOnCompositionStart(surface: GhosttyTerminalSurface) {
  surface.clearPrimedCopy();
  surface.clearCompositionInputSuppression();
  surface.composing = true;
}

export function surfaceOnCompositionEnd(surface: GhosttyTerminalSurface, event: CompositionEvent) {
  surface.composing = false;
  const data = surface.input.value || event.data;
  if (data.length > 0) surface.options.onData(data);
  surface.input.value = "";
  surface.compositionInputToSuppress = data;
  surface.compositionSuppressionTimer = window.setTimeout(() => {
    surface.compositionInputToSuppress = null;
    surface.compositionSuppressionTimer = null;
  }, 100);
}

export function surfaceOnInput(surface: GhosttyTerminalSurface, event: Event) {
  const inputEvent = event as InputEvent;
  if (surface.composing || inputEvent.isComposing) return;
  const data = surface.input.value || inputEvent.data || "";
  if (data === surface.compositionInputToSuppress && isTerminalCompositionCommitInput(inputEvent)) {
    surface.clearCompositionInputSuppression();
    surface.input.value = "";
    return;
  }
  surface.clearCompositionInputSuppression();
  if (data.length > 0) surface.options.onData(data);
  surface.input.value = "";
}

export function surfaceClearCompositionInputSuppression(surface: GhosttyTerminalSurface) {
  if (surface.compositionSuppressionTimer !== null) {
    window.clearTimeout(surface.compositionSuppressionTimer);
    surface.compositionSuppressionTimer = null;
  }
  surface.compositionInputToSuppress = null;
}

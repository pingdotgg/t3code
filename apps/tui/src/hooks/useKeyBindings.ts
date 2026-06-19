import { useKeyboard } from "@opentui/react";

// Maps key presses to actions for the three input modes. Pure key→action routing;
// all conditional logic (e.g. "only interrupt when a thread is selected") lives in
// the action callbacks ChatView passes in. OpenTUI's useKeyboard wraps the handler
// in an effect-event, so reading the latest `actions` each press is safe.

export interface KeyBindingActions {
  readonly mode: "terminal" | "new" | "compose";
  readonly onExit: () => void;
  // Terminal mode
  readonly onTerminalKey: (sequence: string) => void;
  readonly onCloseTerminal: () => void;
  // New-thread mode
  readonly onCancelNew: () => void;
  readonly onProjectPrev: () => void;
  readonly onProjectNext: () => void;
  readonly onSubmitNew: () => void;
  // Compose mode
  readonly onNavUp: () => void;
  readonly onNavDown: () => void;
  readonly onScrollUp: () => void;
  readonly onScrollDown: () => void;
  readonly onNewThread: () => void;
  readonly onOpenTerminal: () => void;
  readonly onInterrupt: () => void;
  readonly onApprove: () => void;
  readonly onDecline: () => void;
  readonly onCycleMode: () => void;
  readonly onSend: () => void;
  readonly onEscape: () => void;
}

export function useKeyBindings(actions: KeyBindingActions): void {
  useKeyboard((key) => {
    // ── Embedded terminal: forward keystrokes to the PTY ────────────────────
    if (actions.mode === "terminal") {
      if (key.ctrl && key.name === "q") {
        actions.onCloseTerminal();
        return;
      }
      if (key.sequence) actions.onTerminalKey(key.sequence);
      return;
    }

    // Ctrl+C always exits cleanly.
    if (key.ctrl && key.name === "c") {
      actions.onExit();
      return;
    }

    // ── New-thread dialog ───────────────────────────────────────────────────
    if (actions.mode === "new") {
      if (key.name === "escape") return actions.onCancelNew();
      if (key.name === "up") return actions.onProjectPrev();
      if (key.name === "down") return actions.onProjectNext();
      if (key.name === "return" || key.name === "enter") return actions.onSubmitNew();
      return;
    }

    // ── Compose mode (default) ──────────────────────────────────────────────
    // The composer <input> owns typed characters; here we only handle
    // navigation, scrolling, action shortcuts, and submit.
    if (key.name === "up") return actions.onNavUp();
    if (key.name === "down") return actions.onNavDown();
    if (key.name === "pageup") return actions.onScrollUp();
    if (key.name === "pagedown") return actions.onScrollDown();
    if (key.ctrl && key.name === "n") return actions.onNewThread();
    if (key.ctrl && key.name === "e") return actions.onOpenTerminal();
    if (key.ctrl && key.name === "g") return actions.onInterrupt();
    if (key.ctrl && key.name === "a") return actions.onApprove();
    if (key.ctrl && key.name === "r") return actions.onDecline();
    if (key.ctrl && key.name === "o") return actions.onCycleMode();
    if (key.name === "return" || key.name === "enter") return actions.onSend();
    if (key.name === "escape") return actions.onEscape();
  });
}

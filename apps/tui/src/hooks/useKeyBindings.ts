import { useKeyboard } from "@opentui/react";

// Maps key presses to actions for the input modes. Pure key→action routing; all
// conditional logic lives in the action callbacks ChatView passes in. OpenTUI's
// useKeyboard wraps the handler in an effect-event, so reading the latest
// `actions` each press is safe.
//
// The terminal drawer coexists with the prompt. Two keys control it and are
// ALWAYS intercepted (never forwarded to the shell), so they behave the same
// whichever pane has focus:
//   ^E  show / hide the terminal drawer (opening focuses it)
//   ^P  toggle focus between the prompt and the terminal
//   ^↑ / ^↓  grow / shrink the drawer

export interface KeyBindingActions {
  readonly mode: "terminal" | "new" | "compose";
  readonly onExit: () => void;
  // Terminal / prompt switching (work in both panes)
  readonly onToggleTerminal: () => void;
  readonly onToggleFocus: () => void;
  readonly onGrowTerminal: () => void;
  readonly onShrinkTerminal: () => void;
  // Terminal-focused
  readonly onTerminalKey: (sequence: string) => void;
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
  readonly onInterrupt: () => void;
  readonly onApprove: () => void;
  readonly onDecline: () => void;
  readonly onCycleMode: () => void;
  readonly onSend: () => void;
  readonly onEscape: () => void;
}

export function useKeyBindings(actions: KeyBindingActions): void {
  useKeyboard((key) => {
    // ── Terminal focused: ^E/^P/^↑/^↓ are intercepted; everything else → PTY ──
    if (actions.mode === "terminal") {
      if (key.ctrl && key.name === "e") return actions.onToggleTerminal();
      if (key.ctrl && key.name === "p") return actions.onToggleFocus();
      if (key.ctrl && key.name === "up") return actions.onGrowTerminal();
      if (key.ctrl && key.name === "down") return actions.onShrinkTerminal();
      if (key.sequence) actions.onTerminalKey(key.sequence);
      return;
    }

    // Ctrl+C always exits cleanly (outside the terminal).
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
    // The composer <input> owns typed characters; here we handle navigation,
    // scrolling, terminal switch/resize, action shortcuts, and submit.
    if (key.ctrl && key.name === "e") return actions.onToggleTerminal();
    if (key.ctrl && key.name === "p") return actions.onToggleFocus();
    if (key.name === "up") return key.ctrl ? actions.onGrowTerminal() : actions.onNavUp();
    if (key.name === "down") return key.ctrl ? actions.onShrinkTerminal() : actions.onNavDown();
    if (key.name === "pageup") return actions.onScrollUp();
    if (key.name === "pagedown") return actions.onScrollDown();
    if (key.ctrl && key.name === "n") return actions.onNewThread();
    if (key.ctrl && key.name === "g") return actions.onInterrupt();
    if (key.ctrl && key.name === "a") return actions.onApprove();
    if (key.ctrl && key.name === "r") return actions.onDecline();
    if (key.ctrl && key.name === "o") return actions.onCycleMode();
    if (key.name === "return" || key.name === "enter") return actions.onSend();
    if (key.name === "escape") return actions.onEscape();
  });
}

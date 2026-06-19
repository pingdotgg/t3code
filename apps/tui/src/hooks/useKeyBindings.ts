import { useKeyboard } from "@opentui/react";

// Maps key presses to actions for the input modes. Pure key→action routing; all
// conditional logic lives in the action callbacks ChatView passes in. OpenTUI's
// useKeyboard wraps the handler in an effect-event, so reading the latest
// `actions` each press is safe.
//
// The terminal drawer coexists with the prompt; two keys control it from both the
// terminal and the prompt (intercepted there, never forwarded to the shell):
//   ^E  show / hide the terminal drawer (opening focuses it)
//   ^P  toggle focus between the prompt and the terminal
//   ^↑ / ^↓  grow / shrink the drawer
// Thread shortcuts from the prompt: ^B plan/build · ^O runtime mode · ^N new ·
//   ^K thread actions (rename/archive/delete/stop) · ^F find/filter.

export type KeyBindingMode =
  | "terminal"
  | "actions"
  | "confirmDelete"
  | "new"
  | "rename"
  | "filter"
  | "compose";

export interface KeyBindingActions {
  readonly mode: KeyBindingMode;
  readonly onExit: () => void;
  // Terminal
  readonly onToggleTerminal: () => void;
  readonly onToggleFocus: () => void;
  readonly onGrowTerminal: () => void;
  readonly onShrinkTerminal: () => void;
  readonly onTerminalKey: (sequence: string) => void;
  // Thread-actions overlay (^K)
  readonly onOpenActions: () => void;
  readonly onActionRename: () => void;
  readonly onActionArchive: () => void;
  readonly onActionDelete: () => void;
  readonly onActionStop: () => void;
  readonly onCloseOverlay: () => void;
  readonly onConfirmDelete: () => void;
  // Rename / filter input modes
  readonly onSubmitRename: () => void;
  readonly onCancelRename: () => void;
  readonly onOpenFilter: () => void;
  readonly onCommitFilter: () => void;
  readonly onCancelFilter: () => void;
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
  readonly onTogglePlanMode: () => void;
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
    if (key.ctrl && key.name === "c") return actions.onExit();

    // ── Thread-actions overlay (mnemonic keys) ──────────────────────────────
    if (actions.mode === "actions") {
      if (key.name === "r") return actions.onActionRename();
      if (key.name === "a") return actions.onActionArchive();
      if (key.name === "d") return actions.onActionDelete();
      if (key.name === "s") return actions.onActionStop();
      if (key.name === "escape") return actions.onCloseOverlay();
      return;
    }
    if (actions.mode === "confirmDelete") {
      if (key.name === "y") return actions.onConfirmDelete();
      if (key.name === "n" || key.name === "escape") return actions.onCloseOverlay();
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

    // ── Rename / filter single-line inputs (the <input> owns typed chars) ────
    if (actions.mode === "rename") {
      if (key.name === "return" || key.name === "enter") return actions.onSubmitRename();
      if (key.name === "escape") return actions.onCancelRename();
      return;
    }
    if (actions.mode === "filter") {
      if (key.name === "return" || key.name === "enter") return actions.onCommitFilter();
      if (key.name === "escape") return actions.onCancelFilter();
      return;
    }

    // ── Compose mode (default) ──────────────────────────────────────────────
    if (key.ctrl && key.name === "e") return actions.onToggleTerminal();
    if (key.ctrl && key.name === "p") return actions.onToggleFocus();
    if (key.name === "up") return key.ctrl ? actions.onGrowTerminal() : actions.onNavUp();
    if (key.name === "down") return key.ctrl ? actions.onShrinkTerminal() : actions.onNavDown();
    if (key.name === "pageup") return actions.onScrollUp();
    if (key.name === "pagedown") return actions.onScrollDown();
    if (key.ctrl && key.name === "n") return actions.onNewThread();
    if (key.ctrl && key.name === "b") return actions.onTogglePlanMode();
    if (key.ctrl && key.name === "k") return actions.onOpenActions();
    if (key.ctrl && key.name === "f") return actions.onOpenFilter();
    if (key.ctrl && key.name === "g") return actions.onInterrupt();
    if (key.ctrl && key.name === "a") return actions.onApprove();
    if (key.ctrl && key.name === "r") return actions.onDecline();
    if (key.ctrl && key.name === "o") return actions.onCycleMode();
    if (key.name === "return" || key.name === "enter") return actions.onSend();
    if (key.name === "escape") return actions.onEscape();
  });
}

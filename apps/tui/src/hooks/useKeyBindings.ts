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
  | "revert"
  | "diff"
  | "select"
  | "userInput"
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
  readonly onTerminalCopy: () => void;
  readonly onTerminalKey: (sequence: string) => void;
  // Thread-actions overlay (^K)
  readonly onOpenActions: () => void;
  readonly onActionRename: () => void;
  readonly onActionArchive: () => void;
  readonly onActionDelete: () => void;
  readonly onActionStop: () => void;
  readonly onActionRevert: () => void;
  readonly onActionDiff: () => void;
  readonly onActionModel: () => void;
  readonly onActionReasoning: () => void;
  readonly onCloseOverlay: () => void;
  // Model picker
  // Select pickers (model / runtime / reasoning): ↑/↓ move, Enter applies, Esc
  // closes; rows are also clickable.
  readonly onSelectPrev: () => void;
  readonly onSelectNext: () => void;
  readonly onSelectConfirm: () => void;
  readonly onCloseSelect: () => void;
  readonly onOpenRuntime: () => void;
  // Turn diff viewer
  readonly onDiffPrev: () => void;
  readonly onDiffNext: () => void;
  readonly onDiffScrollUp: () => void;
  readonly onDiffScrollDown: () => void;
  readonly onDiffToggleView: () => void;
  readonly onDiffClose: () => void;
  readonly onConfirmDelete: () => void;
  // Checkpoint-revert picker
  readonly onRevertPrev: () => void;
  readonly onRevertNext: () => void;
  readonly onRevertConfirm: () => void;
  // Pending user-input form
  readonly onUserInputPrev: () => void;
  readonly onUserInputNext: () => void;
  readonly onUserInputToggle: () => void;
  readonly onUserInputConfirm: () => void;
  readonly onUserInputDefer: () => void;
  readonly onReopenUserInput: () => void;
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
  readonly onNewCycleRuntime: () => void;
  readonly onNewTogglePlan: () => void;
  readonly onNewCycleField: () => void;
  readonly onSubmitNew: () => void;
  // Compose mode
  readonly onNavUp: () => void;
  readonly onNavDown: () => void;
  readonly onScrollUp: () => void;
  readonly onScrollDown: () => void;
  readonly onNewThread: () => void;
  readonly onTogglePlanMode: () => void;
  readonly onImplementPlan: () => void;
  readonly onGrowPrompt: () => void;
  readonly onShrinkPrompt: () => void;
  readonly onEditInEditor: () => void;
  readonly onInterrupt: () => void;
  readonly onApprove: () => void;
  readonly onDecline: () => void;
  readonly onSend: () => void;
  readonly onEscape: () => void;
}

export function useKeyBindings(actions: KeyBindingActions): void {
  useKeyboard((key) => {
    // ── Terminal focused: ^E/^P/^↑/^↓/^O are intercepted; everything else → PTY ──
    if (actions.mode === "terminal") {
      if (key.ctrl && key.name === "e") return actions.onToggleTerminal();
      if (key.ctrl && key.name === "p") return actions.onToggleFocus();
      if (key.ctrl && key.name === "up") return actions.onGrowTerminal();
      if (key.ctrl && key.name === "down") return actions.onShrinkTerminal();
      if (key.ctrl && key.name === "o") return actions.onTerminalCopy();
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
      if (key.name === "v") return actions.onActionRevert();
      if (key.name === "g") return actions.onActionDiff();
      if (key.name === "m") return actions.onActionModel();
      if (key.name === "e") return actions.onActionReasoning();
      if (key.name === "escape") return actions.onCloseOverlay();
      return;
    }
    if (actions.mode === "select") {
      if (key.name === "up") return actions.onSelectPrev();
      if (key.name === "down") return actions.onSelectNext();
      if (key.name === "return" || key.name === "enter") return actions.onSelectConfirm();
      if (key.name === "escape") return actions.onCloseSelect();
      return;
    }
    if (actions.mode === "diff") {
      if (key.name === "up") return actions.onDiffPrev();
      if (key.name === "down") return actions.onDiffNext();
      if (key.name === "pageup") return actions.onDiffScrollUp();
      if (key.name === "pagedown") return actions.onDiffScrollDown();
      if (key.name === "s") return actions.onDiffToggleView();
      if (key.name === "escape") return actions.onDiffClose();
      return;
    }
    if (actions.mode === "confirmDelete") {
      if (key.name === "y") return actions.onConfirmDelete();
      if (key.name === "n" || key.name === "escape") return actions.onCloseOverlay();
      return;
    }
    if (actions.mode === "revert") {
      if (key.name === "up") return actions.onRevertPrev();
      if (key.name === "down") return actions.onRevertNext();
      if (key.name === "return" || key.name === "enter") return actions.onRevertConfirm();
      if (key.name === "escape") return actions.onCloseOverlay();
      return;
    }
    if (actions.mode === "userInput") {
      if (key.name === "up") return actions.onUserInputPrev();
      if (key.name === "down") return actions.onUserInputNext();
      if (key.name === "space") return actions.onUserInputToggle();
      if (key.name === "return" || key.name === "enter") return actions.onUserInputConfirm();
      if (key.name === "escape") return actions.onUserInputDefer();
      return;
    }

    // ── New-thread dialog ───────────────────────────────────────────────────
    if (actions.mode === "new") {
      if (key.name === "escape") return actions.onCancelNew();
      if (key.name === "up") return actions.onProjectPrev();
      if (key.name === "down") return actions.onProjectNext();
      if (key.ctrl && key.name === "o") return actions.onNewCycleRuntime();
      if (key.ctrl && key.name === "b") return actions.onNewTogglePlan();
      if (key.name === "tab") return actions.onNewCycleField();
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
    // ^↑/^↓ resize the prompt you're focused on; arrows navigate the sidebar.
    if (key.name === "up") return key.ctrl ? actions.onGrowPrompt() : actions.onNavUp();
    if (key.name === "down") return key.ctrl ? actions.onShrinkPrompt() : actions.onNavDown();
    if (key.name === "pageup") return actions.onScrollUp();
    if (key.name === "pagedown") return actions.onScrollDown();
    if (key.ctrl && key.name === "n") return actions.onNewThread();
    // ^B and Shift+Tab both toggle plan/build — Shift+Tab matches the web composer.
    if (key.ctrl && key.name === "b") return actions.onTogglePlanMode();
    if (key.shift && key.name === "tab") return actions.onTogglePlanMode();
    if (key.ctrl && key.name === "y") return actions.onImplementPlan();
    if (key.ctrl && key.name === "u") return actions.onReopenUserInput();
    if (key.ctrl && key.name === "k") return actions.onOpenActions();
    if (key.ctrl && key.name === "f") return actions.onOpenFilter();
    // ^G opens the draft in $EDITOR (interrupt is on Esc).
    if (key.ctrl && key.name === "g") return actions.onEditInEditor();
    if (key.ctrl && key.name === "a") return actions.onApprove();
    if (key.ctrl && key.name === "r") return actions.onDecline();
    if (key.ctrl && key.name === "o") return actions.onOpenRuntime();
    // Enter/Shift+Enter are owned by the reply <textarea> (send / newline); it
    // drives sending through its onSubmit, so the global handler stays out of it.
    if (key.name === "escape") return actions.onEscape();
  });
}

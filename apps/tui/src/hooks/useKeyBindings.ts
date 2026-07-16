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
  | "imagePreview"
  | "command"
  | "files"
  | "settings"
  | "confirmDelete"
  | "revert"
  | "diff"
  | "select"
  | "userInput"
  | "new"
  | "rename"
  | "filter"
  | "commit"
  | "panel"
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
  readonly onTerminalScroll: (
    action: "line-up" | "line-down" | "page-up" | "page-down" | "bottom",
  ) => void;
  // Expanded image preview: Escape closes without affecting the draft/session.
  readonly onImagePreviewClose: () => void;
  // Command palette (^K): a fuzzy filter input (owns typed chars) over commands;
  // ↑/↓ move the highlight, Enter runs, Esc closes.
  readonly onOpenCommandPalette: () => void;
  readonly onCommandPrev: () => void;
  readonly onCommandNext: () => void;
  readonly onCommandRun: () => void;
  readonly onCommandClose: () => void;
  // File browser: ↑/↓ select (or scroll a viewed file), Enter open/expand, Esc back/close.
  readonly onFilesUp: () => void;
  readonly onFilesDown: () => void;
  readonly onFilesActivate: () => void;
  readonly onFilesBack: () => void;
  readonly onFilesScrollUp: () => void;
  readonly onFilesScrollDown: () => void;
  // Settings / reference overlay: scroll + close.
  readonly onSettingsScrollUp: () => void;
  readonly onSettingsScrollDown: () => void;
  readonly onSettingsClose: () => void;
  readonly onCloseOverlay: () => void;
  // Model picker
  // Select pickers (model / runtime / reasoning): ↑/↓ move, Enter applies, Esc
  // closes; rows are also clickable.
  readonly onSelectPrev: () => void;
  readonly onSelectNext: () => void;
  readonly onSelectConfirm: () => void;
  readonly onCloseSelect: () => void;
  readonly onOpenRuntime: () => void;
  readonly onOpenModel: () => void;
  readonly onOpenReasoning: () => void;
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
  /** True while a single-select custom-answer field is focused — Space then types. */
  readonly answerTyping: boolean;
  readonly onUserInputConfirm: () => void;
  readonly onUserInputDefer: () => void;
  readonly onReopenUserInput: () => void;
  // Rename / filter input modes
  readonly onSubmitRename: () => void;
  readonly onCancelRename: () => void;
  readonly onOpenFilter: () => void;
  readonly onCommitFilter: () => void;
  readonly onCancelFilter: () => void;
  readonly onSubmitCommit: () => void;
  readonly onCancelCommit: () => void;
  // New-thread mode
  readonly onCancelNew: () => void;
  /** Whether ↑/↓ own the selected non-text new-thread control. */
  readonly newNavigation: boolean;
  readonly onNewPrev: () => void;
  readonly onNewNext: () => void;
  readonly onNewCycleRuntime: () => void;
  readonly onNewTogglePlan: () => void;
  readonly onNewCycleField: () => void;
  readonly onSubmitNew: () => void;
  // Compose mode
  /** True when unmodified ↑/↓ should choose between multiple pending approvals. */
  readonly approvalNavigation: boolean;
  readonly onApprovalPrev: () => void;
  readonly onApprovalNext: () => void;
  readonly onScrollUp: () => void;
  readonly onScrollDown: () => void;
  readonly onNewThread: () => void;
  readonly onTogglePlanMode: () => void;
  readonly onToggleRightPanel: () => void;
  readonly onPanelPrev: () => void;
  readonly onPanelNext: () => void;
  readonly onPanelActivate: () => void;
  readonly onPanelClose: () => void;
  /** Alt+↑ / Alt+↓ — move to the prev/next thread (skipping project headers). */
  readonly onThreadPrev: () => void;
  readonly onThreadNext: () => void;
  /** Alt+1…9 — jump to the Nth visible thread (web's thread-jump). */
  readonly onThreadJump: (index: number) => void;
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
      // Scrollback (emulator, not the program): Shift+PageUp/PageDown by a page,
      // Shift+Up/Down by a line — plain PageUp/arrows still reach the running
      // program. Any other keystroke snaps back to the live tail first, so typing
      // a command always shows it.
      if (key.shift && key.name === "pageup") return actions.onTerminalScroll("page-up");
      if (key.shift && key.name === "pagedown") return actions.onTerminalScroll("page-down");
      if (key.shift && key.name === "up") return actions.onTerminalScroll("line-up");
      if (key.shift && key.name === "down") return actions.onTerminalScroll("line-down");
      if (key.sequence) {
        actions.onTerminalScroll("bottom");
        actions.onTerminalKey(key.sequence);
      }
      return;
    }

    // Ctrl+C always exits cleanly (outside the terminal).
    if (key.ctrl && key.name === "c") return actions.onExit();

    if (actions.mode === "imagePreview") {
      if (key.name === "escape") return actions.onImagePreviewClose();
      return;
    }

    // ── Command palette (filter input owns typed chars) ─────────────────────
    if (actions.mode === "command") {
      if (key.name === "up") return actions.onCommandPrev();
      if (key.name === "down") return actions.onCommandNext();
      if (key.name === "return" || key.name === "enter") return actions.onCommandRun();
      if (key.name === "escape") return actions.onCommandClose();
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
    if (actions.mode === "files") {
      if (key.name === "up") return actions.onFilesUp();
      if (key.name === "down") return actions.onFilesDown();
      if (key.name === "pageup") return actions.onFilesScrollUp();
      if (key.name === "pagedown") return actions.onFilesScrollDown();
      if (key.name === "return" || key.name === "enter") return actions.onFilesActivate();
      if (key.name === "escape") return actions.onFilesBack();
      return;
    }
    if (actions.mode === "settings") {
      if (key.name === "up" || key.name === "pageup") return actions.onSettingsScrollUp();
      if (key.name === "down" || key.name === "pagedown") return actions.onSettingsScrollDown();
      if (key.name === "escape") return actions.onSettingsClose();
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
      // While typing a free-text answer, Space belongs to the input (not toggle).
      if (key.name === "space" && !actions.answerTyping) return actions.onUserInputToggle();
      if (key.name === "return" || key.name === "enter") return actions.onUserInputConfirm();
      if (key.name === "escape") return actions.onUserInputDefer();
      return;
    }
    if (actions.mode === "panel") {
      if (key.name === "up") return actions.onPanelPrev();
      if (key.name === "down") return actions.onPanelNext();
      if (key.name === "return" || key.name === "enter") return actions.onPanelActivate();
      if (key.name === "escape") return actions.onPanelClose();
      if (key.ctrl && key.name === "l") return actions.onToggleRightPanel();
      return;
    }

    // ── New-thread dialog ───────────────────────────────────────────────────
    if (actions.mode === "new") {
      if (key.name === "escape") return actions.onCancelNew();
      if (key.ctrl && key.shift && key.name.toLowerCase() === "m") return actions.onOpenModel();
      if (key.ctrl && key.shift && key.name.toLowerCase() === "e") {
        return actions.onOpenReasoning();
      }
      if (actions.newNavigation && key.name === "up") {
        key.preventDefault();
        return actions.onNewPrev();
      }
      if (actions.newNavigation && key.name === "down") {
        key.preventDefault();
        return actions.onNewNext();
      }
      if (key.ctrl && key.name === "o") return actions.onNewCycleRuntime();
      if (key.ctrl && key.name === "b") return actions.onNewTogglePlan();
      if (key.name === "tab") {
        key.preventDefault();
        return actions.onNewCycleField();
      }
      if (key.name === "return" || key.name === "enter") {
        key.preventDefault();
        return actions.onSubmitNew();
      }
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
    if (actions.mode === "commit") {
      if (key.name === "return" || key.name === "enter") return actions.onSubmitCommit();
      if (key.name === "escape") return actions.onCancelCommit();
      return;
    }

    // ── Compose mode (default) ──────────────────────────────────────────────
    if (key.ctrl && key.shift && key.name.toLowerCase() === "m") return actions.onOpenModel();
    if (key.ctrl && key.shift && key.name.toLowerCase() === "e") {
      return actions.onOpenReasoning();
    }
    if (key.ctrl && key.name === "e") return actions.onToggleTerminal();
    if (key.ctrl && key.name === "p") return actions.onToggleFocus();
    // Alt+↑/↓ jump thread-to-thread; ^↑/^↓ resize the prompt. Unmodified arrows
    // belong to the focused textarea. This is also important under tmux: when a
    // client cannot forward a wheel event it may translate it to arrow keys, and
    // scrolling the conversation must never change the selected thread.
    if (key.option && key.name === "up") return actions.onThreadPrev();
    if (key.option && key.name === "down") return actions.onThreadNext();
    if (key.option && /^[1-9]$/.test(key.name)) return actions.onThreadJump(Number(key.name));
    if (key.ctrl && key.name === "up") return actions.onGrowPrompt();
    if (key.ctrl && key.name === "down") return actions.onShrinkPrompt();
    if (actions.approvalNavigation && key.name === "up") {
      key.preventDefault();
      return actions.onApprovalPrev();
    }
    if (actions.approvalNavigation && key.name === "down") {
      key.preventDefault();
      return actions.onApprovalNext();
    }
    if (key.name === "pageup") return actions.onScrollUp();
    if (key.name === "pagedown") return actions.onScrollDown();
    if (key.ctrl && key.name === "n") return actions.onNewThread();
    // ^B and Shift+Tab both toggle plan/build — Shift+Tab matches the web composer.
    if (key.ctrl && key.name === "b") return actions.onTogglePlanMode();
    if (key.shift && key.name === "tab") return actions.onTogglePlanMode();
    if (key.ctrl && key.name === "y") return actions.onImplementPlan();
    if (key.ctrl && key.name === "u") return actions.onReopenUserInput();
    if (key.ctrl && key.name === "k") return actions.onOpenCommandPalette();
    if (key.ctrl && key.name === "f") return actions.onOpenFilter();
    if (key.ctrl && key.name === "l") return actions.onToggleRightPanel();
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

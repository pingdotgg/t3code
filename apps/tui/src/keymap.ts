// The canonical keybinding reference, grouped by context — the single source for
// the Settings overlay's "keybindings" section (and checkable in tests). This is
// documentation of what useKeyBindings.ts wires; keep the two in sync.

export interface KeyBinding {
  readonly keys: string;
  readonly description: string;
}

export interface KeyBindingGroup {
  readonly title: string;
  readonly bindings: ReadonlyArray<KeyBinding>;
}

export const KEYBINDING_GROUPS: ReadonlyArray<KeyBindingGroup> = [
  {
    title: "Global",
    bindings: [
      { keys: "^C", description: "Quit" },
      { keys: "^K", description: "Command palette" },
      { keys: "^N", description: "New thread" },
      { keys: "^F", description: "Filter threads" },
      { keys: "^L", description: "Toggle source-control panel" },
    ],
  },
  {
    title: "Conversation",
    bindings: [
      { keys: "↑/↓", description: "Navigate the sidebar" },
      { keys: "Alt+↑/↓", description: "Previous / next thread" },
      { keys: "Alt+1…9", description: "Jump to the Nth thread" },
      { keys: "PgUp/PgDn", description: "Scroll the conversation" },
      { keys: "Enter", description: "Send the reply" },
      { keys: "^G", description: "Edit the prompt in $EDITOR" },
      { keys: "^↑/^↓", description: "Resize the prompt" },
      { keys: "^B / Shift+Tab", description: "Toggle plan / build mode" },
      { keys: "^O", description: "Runtime access picker" },
      { keys: "^Y", description: "Implement the proposed plan" },
      { keys: "^A / ^R", description: "Approve / decline a request" },
      { keys: "^U", description: "Reopen a pending question" },
      { keys: "Esc", description: "Clear the draft / stop the turn" },
    ],
  },
  {
    title: "Terminal",
    bindings: [
      { keys: "^E", description: "Show / hide the terminal" },
      { keys: "^P", description: "Focus prompt ⇄ terminal" },
      { keys: "^↑/^↓", description: "Resize the terminal" },
      { keys: "^O", description: "Copy the terminal viewport" },
      { keys: "tabs", description: "Click a number to switch · ✕ close · + new" },
    ],
  },
  {
    title: "Overlays (palette / diff / files / pickers)",
    bindings: [
      { keys: "↑/↓", description: "Move the selection" },
      { keys: "Enter", description: "Run / open / apply" },
      { keys: "Esc", description: "Back / close" },
      { keys: "s", description: "Diff: toggle split / stacked" },
    ],
  },
];

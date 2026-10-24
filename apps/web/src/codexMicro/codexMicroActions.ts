import {
  STATIC_KEYBINDING_COMMANDS,
  type CodexMicroAction,
  type CodexMicroControlId,
  type CodexMicroKnobMode,
  type KeybindingCommand,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";

import { effectiveShortcutsForCommand } from "../keybindings";
import { commandLabel } from "../components/settings/KeybindingsSettings.logic";

export interface CodexMicroActionOption {
  readonly key: string;
  readonly action: CodexMicroAction;
  readonly label: string;
}

export interface CodexMicroActionGroup {
  readonly title: string;
  readonly options: ReadonlyArray<CodexMicroActionOption>;
}

// Plain names for the commands people put on a desk controller; the rest use
// the Keybindings settings label.
const COMMAND_LABELS: Partial<Record<KeybindingCommand, string>> = {
  "chat.new": "New thread",
  "chat.newLocal": "New local thread",
  "chat.newWithoutProject": "New thread without project",
  "chat.find": "Find in thread",
  "terminal.toggle": "Toggle terminal",
  "diff.toggle": "Toggle diff",
  "sidebar.toggle": "Toggle sidebar",
  "rightPanel.toggle": "Toggle right panel",
  "commandPalette.toggle": "Command palette",
  "filePicker.toggle": "Go to file",
  "projectSearch.toggle": "Search project",
  "thread.previous": "Previous thread",
  "thread.next": "Next thread",
  "thread.pin": "Pin thread",
  "thread.settle": "Settle thread",
  "navigation.back": "Back",
  "navigation.forward": "Forward",
  "modelPicker.toggle": "Model picker",
  "composer.effort": "Reasoning effort",
  "composer.mode": "Interaction mode",
};

const DEVICE_ACTION_LABELS = {
  none: "None",
  approve: "Approve",
  approveForSession: "Approve for session",
  decline: "Decline",
  stop: "Stop thread",
  nextSlot: "Open next agent key",
  previousSlot: "Open previous agent key",
  focusApp: "Bring T3 Code forward",
} as const satisfies Record<Exclude<CodexMicroAction["type"], "command">, string>;

const option = (action: CodexMicroAction): CodexMicroActionOption => ({
  key: codexMicroActionKey(action),
  action,
  label: describeCodexMicroAction(action),
});

// Commands that depend on a focused picker or page make no sense from a desk controller.
const HIDDEN_COMMAND_PREFIXES = [
  "modelPicker.jump.",
  "usage.",
  "thread.jump.",
  "preview.",
  "terminal.split",
];

export const CODEX_MICRO_ACTION_GROUPS: ReadonlyArray<CodexMicroActionGroup> = [
  {
    title: "Agent",
    options: (["approve", "approveForSession", "decline", "stop"] as const).map((type) =>
      option({ type }),
    ),
  },
  {
    title: "Agent keys",
    options: (["nextSlot", "previousSlot", "focusApp"] as const).map((type) => option({ type })),
  },
  {
    title: "Commands",
    options: STATIC_KEYBINDING_COMMANDS.filter(
      (command) => !HIDDEN_COMMAND_PREFIXES.some((prefix) => command.startsWith(prefix)),
    )
      .map((command) => option({ type: "command", command }))
      .toSorted((a, b) => a.label.localeCompare(b.label)),
  },
  { title: "Other", options: [option({ type: "none" })] },
];

export function codexMicroActionKey(action: CodexMicroAction): string {
  return action.type === "command" ? `command:${action.command}` : action.type;
}

export function describeCodexMicroAction(action: CodexMicroAction): string {
  if (action.type !== "command") return DEVICE_ACTION_LABELS[action.type];
  return COMMAND_LABELS[action.command] ?? commandLabel(action.command);
}

const KNOB_PRESETS: Record<
  Exclude<CodexMicroKnobMode, "custom">,
  Partial<Record<CodexMicroControlId, CodexMicroAction>>
> = {
  agents: {
    ENC_CW: { type: "nextSlot" },
    ENC_CC: { type: "previousSlot" },
    ENC: { type: "focusApp" },
  },
  threads: {
    ENC_CW: { type: "command", command: "thread.next" },
    ENC_CC: { type: "command", command: "thread.previous" },
    ENC: { type: "command", command: "commandPalette.toggle" },
  },
};

/** The action a control runs, with the knob preset applied. */
export function resolveCodexMicroControl(
  control: CodexMicroControlId,
  knobMode: CodexMicroKnobMode,
  controls: Readonly<Record<CodexMicroControlId, CodexMicroAction>>,
): CodexMicroAction {
  return (knobMode === "custom" ? undefined : KNOB_PRESETS[knobMode][control]) ?? controls[control];
}

/** Codex's mapping: angle 0 = right, 0.25 = down, 0.5 = left, 0.75 = up. */
export function codexMicroJoystickControl(angle: number): CodexMicroControlId {
  if (angle >= 0.625 && angle < 0.875) return "JOY_UP";
  if (angle >= 0.125 && angle < 0.375) return "JOY_DOWN";
  if (angle >= 0.375 && angle < 0.625) return "JOY_LEFT";
  return "JOY_RIGHT";
}

/**
 * Commands are handled by per-feature keydown listeners, so the device replays
 * the user's own shortcut for the command, like the HTML render frame does.
 * That keeps every command, rebinding and `when` clause working unchanged.
 */
export function codexMicroShortcutEvent(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  platform: string,
): KeyboardEventInit | null {
  const shortcut = effectiveShortcutsForCommand(keybindings, command, { platform })[0];
  if (!shortcut) return null;
  const mac = isMacPlatform(platform);
  return {
    key: shortcut.key,
    metaKey: shortcut.metaKey || (shortcut.modKey && mac),
    ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !mac),
    shiftKey: shortcut.shiftKey,
    altKey: shortcut.altKey,
    bubbles: true,
    cancelable: true,
  };
}

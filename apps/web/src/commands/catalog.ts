import { STATIC_KEYBINDING_COMMANDS, type KeybindingCommand } from "@t3tools/contracts";

import type { CommandCategory, CommandContribution } from "./types";

const CATEGORY_BY_PREFIX: ReadonlyArray<{
  readonly category: CommandCategory;
  readonly prefixes: ReadonlyArray<string>;
}> = [
  {
    category: "Navigation",
    prefixes: [
      "workspace",
      "sidebar",
      "navigation",
      "rightPanel",
      "threadPanel",
      "commandPalette",
      "filePicker",
      "projectSearch",
      "editor",
      "view",
    ],
  },
  { category: "Threads", prefixes: ["thread", "chat", "pullRequest"] },
  { category: "Composer", prefixes: ["composer", "modelPicker"] },
  { category: "Terminal", prefixes: ["terminal"] },
  { category: "Preview & diff", prefixes: ["preview", "diff"] },
  { category: "Appearance", prefixes: ["theme", "appearance", "themeEditor"] },
  { category: "Usage", prefixes: ["usage"] },
  { category: "Project scripts", prefixes: ["script"] },
];

const TITLE_OVERRIDES: Partial<Record<KeybindingCommand, string>> = {
  "workspace.focusNext": "Focus Next Workspace Area",
  "workspace.focusPrevious": "Focus Previous Workspace Area",
  "composer.sendAlternate": "Composer: Opposite Queue or Steer Action",
  "composer.sendBackground": "Composer: Start in Background",
  "composer.sendAndNewThread": "Composer: Send and Start New Thread",
  "composer.dictation": "Composer: Start or Finish Dictation",
  "thread.steerQueuedMessage": "Queue: Send First Queued Message",
  "thread.editQueuedMessage": "Queue: Edit Last Queued Message",
  "thread.copyReference": "Pull Request: Copy Link or Thread",
  "view.reopenClosed": "Reopen Closed Tab",
  "preview.focusUrl": "Preview: Focus URL",
  "usage.cost": "Usage: Cost",
  "usage.tokens": "Usage: Tokens",
  "usage.limits": "Usage: Limits",
  "usage.period.day": "Usage: Period: Past 24h",
  "usage.period.week": "Usage: Period: 7 days",
  "usage.period.month": "Usage: Period: 30 days",
  "usage.period.quarter": "Usage: Period: 90 days",
};

/**
 * Palette enablement. Key chords keep their own `when` on the keybinding rule;
 * this only gates whether the palette row is enabled.
 */
const WHEN_OVERRIDES: Partial<Record<KeybindingCommand, string>> = {
  "terminal.split": "terminalOpen",
  "terminal.splitVertical": "terminalOpen",
  "terminal.new": "terminalOpen",
  "terminal.close": "terminalOpen",
  "rightPanel.new": "rightPanelOpen",
  "preview.refresh": "previewOpen",
  "preview.focusUrl": "previewOpen",
  "preview.zoomIn": "previewOpen",
  "preview.zoomOut": "previewOpen",
  "preview.resetZoom": "previewOpen",
  "usage.cost": "usagePageOpen",
  "usage.tokens": "usagePageOpen",
  "usage.limits": "usagePageOpen",
  "usage.period.day": "usagePageOpen",
  "usage.period.week": "usagePageOpen",
  "usage.period.month": "usagePageOpen",
  "usage.period.quarter": "usagePageOpen",
  "modelPicker.previousProvider": "modelPickerOpen",
  "modelPicker.nextProvider": "modelPickerOpen",
  "modelPicker.jump.1": "modelPickerOpen",
  "modelPicker.jump.2": "modelPickerOpen",
  "modelPicker.jump.3": "modelPickerOpen",
  "modelPicker.jump.4": "modelPickerOpen",
  "modelPicker.jump.5": "modelPickerOpen",
  "modelPicker.jump.6": "modelPickerOpen",
  "modelPicker.jump.7": "modelPickerOpen",
  "modelPicker.jump.8": "modelPickerOpen",
  "modelPicker.jump.9": "modelPickerOpen",
};

const PALETTE_HIDDEN = new Set<KeybindingCommand>([
  // Opening the palette from inside the palette is noise; Esc / the chord still work.
  "commandPalette.toggle",
  // These need a focused composer; the palette steals focus, so the rows would always
  // be disabled (composerFocus is never true while the palette input is focused).
  "composer.sendAlternate",
  "composer.sendBackground",
  "composer.sendAndNewThread",
  "thread.editQueuedMessage",
]);

function titleCaseSegment(segment: string): string {
  const words: Array<string> = [];
  for (const part of segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[-_\s]+/)) {
    if (part.length > 0) {
      words.push(part.slice(0, 1).toUpperCase() + part.slice(1));
    }
  }
  return words.join(" ");
}

export function defaultCommandTitle(command: KeybindingCommand): string {
  const override = TITLE_OVERRIDES[command];
  if (override) return override;
  const raw = String(command);
  if (raw.startsWith("script.") && raw.endsWith(".run")) {
    return `Run Script: ${titleCaseSegment(raw.slice("script.".length, -".run".length))}`;
  }
  return raw.split(".").map(titleCaseSegment).join(": ");
}

function commandCategory(command: KeybindingCommand): CommandCategory {
  const prefix = String(command).split(".")[0] ?? "";
  return CATEGORY_BY_PREFIX.find((group) => group.prefixes.includes(prefix))?.category ?? "Other";
}

function searchTermsFor(command: KeybindingCommand, title: string): string[] {
  const parts = String(command).split(".");
  return [...new Set([title, String(command), ...parts, ...title.toLowerCase().split(/\s+/)])];
}

function contributionFor(command: KeybindingCommand): CommandContribution {
  const title = defaultCommandTitle(command);
  const when = WHEN_OVERRIDES[command];
  return {
    id: command,
    title,
    category: commandCategory(command),
    searchTerms: searchTermsFor(command, title),
    ...(when ? { when } : {}),
    ...(PALETTE_HIDDEN.has(command) ? { palette: false as const } : {}),
  };
}

const STATIC_CONTRIBUTIONS: ReadonlyMap<KeybindingCommand, CommandContribution> = new Map(
  STATIC_KEYBINDING_COMMANDS.map((command) => [command, contributionFor(command)]),
);

export function staticCommandContribution(
  command: KeybindingCommand,
): CommandContribution | undefined {
  return STATIC_CONTRIBUTIONS.get(command);
}

export function allStaticCommandContributions(): ReadonlyArray<CommandContribution> {
  return STATIC_KEYBINDING_COMMANDS.map((command) => STATIC_CONTRIBUTIONS.get(command)!);
}

/** Dynamic script commands get a contribution when a handler registers. */
export function scriptCommandContribution(command: KeybindingCommand): CommandContribution {
  const existing = STATIC_CONTRIBUTIONS.get(command);
  if (existing) return existing;
  const title = defaultCommandTitle(command);
  return {
    id: command,
    title,
    category: "Project scripts",
    searchTerms: searchTermsFor(command, title),
  };
}

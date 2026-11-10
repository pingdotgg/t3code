import { createTranslator, type MessageKey, type TranslateFn } from "@t3tools/client-runtime/i18n";
import {
  STATIC_KEYBINDING_COMMANDS,
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  parseKeybindingShortcut,
  parseKeybindingWhenExpression,
  US_SHIFTED_TO_UNSHIFTED_KEYS,
} from "@t3tools/shared/keybindings";

import { shortcutConflictKey, shortcutKeyFromEvent } from "../../keybindings";
import { isMacPlatform } from "../../lib/utils";
import { METRIC_OPTIONS, WINDOW_OPTIONS } from "../usage/usageShortcuts";

// Rank every usage command; mixing rank and alphabetical comparisons makes order input-dependent.
const usageCommandOrder = new Map<KeybindingCommand, number>(
  [
    "usage.open" as const,
    ...[...METRIC_OPTIONS, ...WINDOW_OPTIONS].map((option) => option.command),
  ].map((command, index) => [command, index]),
);

const firstUsageCommand = METRIC_OPTIONS[0].command;

// Command names come from contracts; translate them with these keys.
const COMMAND_SEGMENT_KEYS: Readonly<Record<string, MessageKey>> = {
  workspace: "settings.providers.keybindings.segment.workspace",
  sidebar: "settings.providers.keybindings.segment.sidebar",
  navigation: "settings.providers.keybindings.segment.navigation",
  terminal: "settings.providers.keybindings.segment.terminal",
  rightPanel: "settings.providers.keybindings.segment.rightPanel",
  threadPanel: "settings.providers.keybindings.segment.threadPanel",
  view: "settings.providers.keybindings.segment.view",
  pullRequest: "settings.providers.keybindings.segment.pullRequest",
  diff: "settings.providers.keybindings.segment.diff",
  preview: "settings.providers.keybindings.segment.preview",
  commandPalette: "settings.providers.keybindings.segment.commandPalette",
  filePicker: "settings.providers.keybindings.segment.filePicker",
  projectSearch: "settings.providers.keybindings.segment.projectSearch",
  usage: "settings.providers.keybindings.segment.usage",
  theme: "settings.providers.keybindings.segment.theme",
  appearance: "settings.providers.keybindings.segment.appearance",
  themeEditor: "settings.providers.keybindings.segment.themeEditor",
  composer: "settings.providers.keybindings.segment.composer",
  chat: "settings.providers.keybindings.segment.chat",
  editor: "settings.providers.keybindings.segment.editor",
  modelPicker: "settings.providers.keybindings.segment.modelPicker",
  thread: "settings.providers.keybindings.segment.thread",
  script: "settings.providers.keybindings.segment.script",
  toggle: "settings.providers.keybindings.segment.toggle",
  split: "settings.providers.keybindings.segment.split",
  splitVertical: "settings.providers.keybindings.segment.splitVertical",
  new: "settings.providers.keybindings.segment.new",
  close: "settings.providers.keybindings.segment.close",
  back: "settings.providers.keybindings.segment.back",
  forward: "settings.providers.keybindings.segment.forward",
  toggleMaximized: "settings.providers.keybindings.segment.toggleMaximized",
  copyNumber: "settings.providers.keybindings.segment.copyNumber",
  refresh: "settings.providers.keybindings.segment.refresh",
  zoomIn: "settings.providers.keybindings.segment.zoomIn",
  zoomOut: "settings.providers.keybindings.segment.zoomOut",
  resetZoom: "settings.providers.keybindings.segment.resetZoom",
  open: "settings.providers.keybindings.segment.open",
  select: "settings.providers.keybindings.segment.select",
  cycle: "settings.providers.keybindings.segment.cycle",
  stash: "settings.providers.keybindings.segment.stash",
  host: "settings.providers.keybindings.segment.host",
  cycleHost: "settings.providers.keybindings.segment.cycleHost",
  effort: "settings.providers.keybindings.segment.effort",
  increaseEffort: "settings.providers.keybindings.segment.increaseEffort",
  decreaseEffort: "settings.providers.keybindings.segment.decreaseEffort",
  mode: "settings.providers.keybindings.segment.mode",
  branch: "settings.providers.keybindings.segment.branch",
  newLocal: "settings.providers.keybindings.segment.newLocal",
  newWithoutProject: "settings.providers.keybindings.segment.newWithoutProject",
  find: "settings.providers.keybindings.segment.find",
  openFavorite: "settings.providers.keybindings.segment.openFavorite",
  cost: "settings.providers.keybindings.segment.cost",
  tokens: "settings.providers.keybindings.segment.tokens",
  limits: "settings.providers.keybindings.segment.limits",
  period: "settings.providers.keybindings.segment.period",
  day: "settings.providers.keybindings.segment.day",
  week: "settings.providers.keybindings.segment.week",
  month: "settings.providers.keybindings.segment.month",
  quarter: "settings.providers.keybindings.segment.quarter",
  stop: "settings.providers.keybindings.segment.stop",
  previous: "settings.providers.keybindings.segment.previous",
  next: "settings.providers.keybindings.segment.next",
  settle: "settings.providers.keybindings.segment.settle",
  pin: "settings.providers.keybindings.segment.pin",
  undo: "settings.providers.keybindings.segment.undo",
  jump: "settings.providers.keybindings.segment.jump",
  previousProvider: "settings.providers.keybindings.segment.previousProvider",
  nextProvider: "settings.providers.keybindings.segment.nextProvider",
  previousWorktree: "settings.providers.keybindings.segment.previousWorktree",
  run: "settings.providers.keybindings.segment.run",
  reopenClosed: "settings.providers.keybindings.segment.reopenClosed",
};

const DEFAULT_T = createTranslator("en");

function compareCommands(
  left: KeybindingCommand,
  right: KeybindingCommand,
  key: (command: KeybindingCommand) => string,
): number {
  const leftRank = usageCommandOrder.get(left);
  const rightRank = usageCommandOrder.get(right);
  if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
  return key(leftRank === undefined ? left : firstUsageCommand).localeCompare(
    key(rightRank === undefined ? right : firstUsageCommand),
  );
}

export type KeybindingSource = "Default" | "Custom" | "Project";

export interface KeybindingRow {
  readonly id: string;
  readonly command: KeybindingCommand;
  readonly key: string;
  readonly when: string;
  readonly source: KeybindingSource;
  readonly defaultKey: string | null;
  readonly defaultWhen: string;
  readonly binding: ResolvedKeybindingRule;
  readonly conflicts: ReadonlyArray<string>;
}

export type WhenVariableOption = string;
export type KeybindingCommandOption = KeybindingCommand;

const CORE_WHEN_VARIABLES = [
  "terminalFocus",
  "terminalOpen",
  "previewOpen",
  "isWeb",
  "isDesktop",
  "true",
  "false",
] as const;

const DEFAULT_WHEN_VARIABLES = new Set<string>(CORE_WHEN_VARIABLES);
for (const binding of DEFAULT_RESOLVED_KEYBINDINGS) {
  collectWhenIdentifiersFromNode(binding.whenAst, DEFAULT_WHEN_VARIABLES);
}

export const DEFAULT_WHEN_VARIABLE =
  [...DEFAULT_WHEN_VARIABLES].find(
    (identifier) => identifier !== "true" && identifier !== "false",
  ) ?? "terminalFocus";
const KNOWN_WHEN_VARIABLES = new Set(DEFAULT_WHEN_VARIABLES);

export function shortcutToKeybindingInput(shortcut: KeybindingShortcut): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("mod");
  if (shortcut.metaKey) parts.push("meta");
  if (shortcut.ctrlKey) parts.push("ctrl");
  if (shortcut.altKey) parts.push("alt");
  if (shortcut.shiftKey) parts.push("shift");
  parts.push(shortcut.key === " " ? "space" : shortcut.key === "escape" ? "esc" : shortcut.key);
  return parts.join("+");
}

export function whenAstToExpression(node: KeybindingWhenNode | undefined): string {
  if (!node) return "";
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${wrapWhenExpression(node.node)}`;
    case "and":
      return `${wrapWhenExpression(node.left)} && ${wrapWhenExpression(node.right)}`;
    case "or":
      return `${wrapWhenExpression(node.left)} || ${wrapWhenExpression(node.right)}`;
  }
}

export function whenNodeRemoveLabel(
  node: KeybindingWhenNode,
  depth: number,
  t: TranslateFn = DEFAULT_T,
): string {
  if (depth === 0) return t("settings.providers.keybindings.clearConditions");
  if (node.type === "identifier" || (node.type === "not" && node.node.type === "identifier")) {
    return t("settings.providers.keybindings.removeCondition");
  }
  return t("settings.providers.keybindings.removeGroup");
}

function wrapWhenExpression(node: KeybindingWhenNode): string {
  if (node.type === "identifier" || node.type === "not") return whenAstToExpression(node);
  return `(${whenAstToExpression(node)})`;
}

export function parseWhenExpressionDraft(
  expression: string,
  t: TranslateFn = DEFAULT_T,
): { ok: true; value: KeybindingWhenNode | undefined } | { ok: false; message: string } {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };

  const ast = parseKeybindingWhenExpression(trimmed);
  if (!ast) {
    return {
      ok: false,
      message: t("settings.providers.keybindings.expressionHelp"),
    };
  }

  return { ok: true, value: ast };
}

function sourceForBinding(binding: ResolvedKeybindingRule): KeybindingSource {
  if (String(binding.command).startsWith("script.")) {
    return "Project";
  }

  const bindingKey = shortcutToKeybindingInput(binding.shortcut);
  const bindingWhen = whenAstToExpression(binding.whenAst);
  const isDefault = DEFAULT_RESOLVED_KEYBINDINGS.some(
    (entry) =>
      entry.command === binding.command &&
      shortcutToKeybindingInput(entry.shortcut) === bindingKey &&
      whenAstToExpression(entry.whenAst) === bindingWhen,
  );

  return isDefault ? "Default" : "Custom";
}

function defaultBindingForBinding(
  binding: ResolvedKeybindingRule,
): ResolvedKeybindingRule | undefined {
  const bindingKey = shortcutToKeybindingInput(binding.shortcut);
  const bindingWhen = whenAstToExpression(binding.whenAst);

  return (
    DEFAULT_RESOLVED_KEYBINDINGS.find(
      (entry) =>
        entry.command === binding.command &&
        shortcutToKeybindingInput(entry.shortcut) === bindingKey &&
        whenAstToExpression(entry.whenAst) === bindingWhen,
    ) ??
    DEFAULT_RESOLVED_KEYBINDINGS.find(
      (entry) =>
        entry.command === binding.command && whenAstToExpression(entry.whenAst) === bindingWhen,
    ) ??
    DEFAULT_RESOLVED_KEYBINDINGS.find((entry) => entry.command === binding.command)
  );
}

function keybindingRowId(command: KeybindingCommand, key: string, when: string): string {
  return `${command}\u0000${key}\u0000${when}`;
}

function conflictsWithWhen(leftWhen: string, rightWhen: string): boolean {
  return leftWhen.length === 0 || rightWhen.length === 0 || leftWhen === rightWhen;
}

export function keybindingConflictLabels(
  rows: ReadonlyArray<KeybindingRow>,
  input: { readonly rowId: string; readonly key: string; readonly when: string },
  platform = navigator.platform,
  t: TranslateFn = DEFAULT_T,
): ReadonlyArray<string> {
  if (input.key.trim().length === 0) return [];
  const shortcut = parseKeybindingShortcut(input.key);
  if (!shortcut) return [];
  // Compare resolved chords so mod+k and ctrl+k collide where mod is Ctrl.
  const conflictKey = shortcutConflictKey(shortcut, platform);
  const conflicts: Array<string> = [];
  for (const candidate of rows) {
    if (
      candidate.id !== input.rowId &&
      shortcutConflictKey(candidate.binding.shortcut, platform) === conflictKey &&
      conflictsWithWhen(candidate.when, input.when)
    ) {
      conflicts.push(commandLabel(candidate.command, t));
    }
  }
  return [...new Set(conflicts)].toSorted();
}

export interface KeybindingGroup {
  readonly id: string;
  readonly title: string;
  readonly rows: ReadonlyArray<KeybindingRow>;
}

const KEYBINDING_GROUPS = [
  {
    id: "navigation",
    title: "settings.providers.keybindings.group.navigation",
    prefixes: ["sidebar", "rightPanel", "commandPalette", "filePicker", "projectSearch", "editor"],
  },
  {
    id: "threads",
    title: "settings.providers.keybindings.group.threads",
    prefixes: ["thread", "chat", "pullRequest"],
  },
  {
    id: "composer",
    title: "settings.providers.keybindings.group.composer",
    prefixes: ["composer", "modelPicker"],
  },
  {
    id: "terminal",
    title: "settings.providers.keybindings.group.terminal",
    prefixes: ["terminal"],
  },
  {
    id: "preview",
    title: "settings.providers.keybindings.group.preview",
    prefixes: ["preview", "diff"],
  },
  {
    id: "appearance",
    title: "settings.providers.keybindings.group.appearance",
    prefixes: ["theme", "appearance", "themeEditor"],
  },
  { id: "scripts", title: "settings.providers.keybindings.group.scripts", prefixes: ["script"] },
] as const;
const OTHER_KEYBINDING_GROUP = {
  id: "other",
  title: "settings.providers.keybindings.group.other",
} as const;

function keybindingGroupFor(command: KeybindingCommand): { id: string; title: MessageKey } {
  const prefix = String(command).split(".")[0] ?? "";
  return (
    KEYBINDING_GROUPS.find((group) => (group.prefixes as ReadonlyArray<string>).includes(prefix)) ??
    OTHER_KEYBINDING_GROUP
  );
}

export function groupKeybindingRows(
  rows: ReadonlyArray<KeybindingRow>,
  t: TranslateFn = DEFAULT_T,
): ReadonlyArray<KeybindingGroup> {
  const rowsByGroup = new Map<string, Array<KeybindingRow>>();
  for (const row of rows) {
    const group = keybindingGroupFor(row.command);
    const bucket = rowsByGroup.get(group.id);
    if (bucket) bucket.push(row);
    else rowsByGroup.set(group.id, [row]);
  }
  return [...KEYBINDING_GROUPS, OTHER_KEYBINDING_GROUP].flatMap((group) => {
    const groupRows = rowsByGroup.get(group.id);
    return groupRows ? [{ id: group.id, title: t(group.title), rows: groupRows }] : [];
  });
}

export function buildKeybindingRows(
  keybindings: ResolvedKeybindingsConfig,
  platform = navigator.platform,
): ReadonlyArray<KeybindingRow> {
  const rowsById = new Map<string, KeybindingRow>();
  for (const binding of keybindings) {
    const defaultBinding = defaultBindingForBinding(binding);
    const key = shortcutToKeybindingInput(binding.shortcut);
    const when = whenAstToExpression(binding.whenAst);
    const id = keybindingRowId(binding.command, key, when);
    rowsById.set(id, {
      id,
      command: binding.command,
      key,
      when,
      source: sourceForBinding(binding),
      defaultKey: defaultBinding ? shortcutToKeybindingInput(defaultBinding.shortcut) : null,
      defaultWhen: whenAstToExpression(defaultBinding?.whenAst),
      binding,
      conflicts: [],
    });
  }
  const rows = [...rowsById.values()];

  const rowsWithConflicts = rows.map((row) => {
    const conflicts = keybindingConflictLabels(
      rows,
      {
        rowId: row.id,
        key: row.key,
        when: row.when,
      },
      platform,
    );
    return conflicts.length > 0
      ? Object.assign({}, row, { conflicts: [...new Set(conflicts)].toSorted() })
      : row;
  });

  rowsWithConflicts.sort((left, right) => {
    const commandCompare = compareCommands(left.command, right.command, (command) => command);
    if (commandCompare !== 0) return commandCompare;
    return left.key.localeCompare(right.key);
  });

  return rowsWithConflicts;
}

export function filterKeybindingRows(
  rows: ReadonlyArray<KeybindingRow>,
  query: string,
  t: TranslateFn = DEFAULT_T,
): ReadonlyArray<KeybindingRow> {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return rows;
  return rows.filter((row) => {
    return (
      row.command.toLowerCase().includes(normalizedQuery) ||
      commandLabel(row.command, t).toLowerCase().includes(normalizedQuery) ||
      row.key.toLowerCase().includes(normalizedQuery) ||
      row.when.toLowerCase().includes(normalizedQuery) ||
      row.source.toLowerCase().includes(normalizedQuery)
    );
  });
}

function collectWhenIdentifiersFromNode(
  node: KeybindingWhenNode | undefined,
  identifiers: Set<string>,
): void {
  if (!node) return;
  switch (node.type) {
    case "identifier":
      identifiers.add(node.name);
      return;
    case "not":
      collectWhenIdentifiersFromNode(node.node, identifiers);
      return;
    case "and":
    case "or":
      collectWhenIdentifiersFromNode(node.left, identifiers);
      collectWhenIdentifiersFromNode(node.right, identifiers);
      return;
  }
}

export function isKnownWhenVariable(identifier: string): boolean {
  return KNOWN_WHEN_VARIABLES.has(identifier);
}

export function unknownWhenVariables(node: KeybindingWhenNode | undefined): ReadonlyArray<string> {
  const identifiers = new Set<string>();
  collectWhenIdentifiersFromNode(node, identifiers);
  return [...identifiers].filter((identifier) => !isKnownWhenVariable(identifier)).toSorted();
}

export function buildWhenVariableOptions(): ReadonlyArray<WhenVariableOption> {
  return [...KNOWN_WHEN_VARIABLES].toSorted((left, right) => {
    const leftCoreIndex = CORE_WHEN_VARIABLES.indexOf(left as (typeof CORE_WHEN_VARIABLES)[number]);
    const rightCoreIndex = CORE_WHEN_VARIABLES.indexOf(
      right as (typeof CORE_WHEN_VARIABLES)[number],
    );
    if (leftCoreIndex !== -1 || rightCoreIndex !== -1) {
      return (
        (leftCoreIndex === -1 ? Number.MAX_SAFE_INTEGER : leftCoreIndex) -
        (rightCoreIndex === -1 ? Number.MAX_SAFE_INTEGER : rightCoreIndex)
      );
    }
    return left.localeCompare(right);
  });
}

export function buildKeybindingCommandOptions(
  keybindings: ResolvedKeybindingsConfig,
  t: TranslateFn = DEFAULT_T,
): ReadonlyArray<KeybindingCommandOption> {
  const commands = new Set<KeybindingCommand>(STATIC_KEYBINDING_COMMANDS);
  for (const binding of keybindings) {
    commands.add(binding.command);
  }
  return [...commands].toSorted((left, right) =>
    compareCommands(left, right, (command) => commandLabel(command, t)),
  );
}

export function commandLabel(command: KeybindingCommand, t: TranslateFn = DEFAULT_T): string {
  if (command === "workspace.focusNext")
    return t("settings.providers.keybindings.command.focusNext");
  if (command === "workspace.focusPrevious")
    return t("settings.providers.keybindings.command.focusPrevious");
  if (command === "composer.sendAlternate")
    return t("settings.providers.keybindings.command.sendAlternate");
  if (command === "composer.sendBackground")
    return t("settings.providers.keybindings.command.sendBackground");
  if (command === "composer.sendAndNewThread")
    return t("settings.providers.keybindings.command.sendAndNew");
  if (command === "composer.dictation")
    return t("settings.providers.keybindings.command.dictation");
  if (command === "thread.steerQueuedMessage")
    return t("settings.providers.keybindings.command.steerQueued");
  if (command === "thread.editQueuedMessage")
    return t("settings.providers.keybindings.command.editQueued");
  if (command === "thread.copyReference")
    return t("settings.providers.keybindings.command.copyReference");
  const usageMetric = METRIC_OPTIONS.find((option) => option.command === command);
  if (usageMetric)
    return t("settings.providers.keybindings.command.usage", { label: usageMetric.label });
  const usagePeriod = WINDOW_OPTIONS.find((option) => option.command === command);
  if (usagePeriod)
    return t("settings.providers.keybindings.command.usagePeriod", { label: usagePeriod.label });
  if (command === "view.reopenClosed") return t("settings.providers.keybindings.command.reopen");
  if (command === "preview.focusUrl") return t("settings.providers.keybindings.command.focusUrl");
  const raw = String(command);
  if (raw.startsWith("script.") && raw.endsWith(".run")) {
    return t("settings.providers.keybindings.command.runScript", {
      name: titleCaseCommandSegment(raw.slice("script.".length, -".run".length)),
    });
  }
  return raw
    .split(".")
    .map((segment) => {
      const key = COMMAND_SEGMENT_KEYS[segment];
      return key ? t(key) : titleCaseCommandSegment(segment);
    })
    .join(t("settings.providers.keybindings.segmentJoin"));
}

function titleCaseCommandSegment(segment: string): string {
  const words: Array<string> = [];
  for (const part of segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[-_\s]+/)) {
    if (part.length > 0) {
      words.push(part.slice(0, 1).toUpperCase() + part.slice(1));
    }
  }
  return words.join(" ");
}

function recordedLayoutShortcutKey(
  event: Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "altKey">,
): string {
  const physicalKey = shortcutKeyFromEvent(event);
  const layoutKey = event.key.toLowerCase();
  if (event.altKey || layoutKey.length !== 1) return physicalKey;
  // Normalize only US shifted glyphs at their US position. Other layouts can
  // produce the same glyph without Shift or at a different position.
  const unshiftedKey = event.shiftKey ? US_SHIFTED_TO_UNSHIFTED_KEYS.get(layoutKey) : undefined;
  return unshiftedKey === physicalKey ? physicalKey : layoutKey;
}

function normalizeShortcutKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (
    normalized === "meta" ||
    normalized === "control" ||
    normalized === "ctrl" ||
    normalized === "shift" ||
    normalized === "alt" ||
    normalized === "option"
  ) {
    return null;
  }
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized === "arrowup") return "arrowup";
  if (normalized === "arrowdown") return "arrowdown";
  if (normalized === "arrowleft") return "arrowleft";
  if (normalized === "arrowright") return "arrowright";
  if (normalized.length === 1) return normalized;
  if (/^f\d{1,2}$/.test(normalized)) return normalized;
  if (normalized === "enter" || normalized === "tab" || normalized === "backspace") {
    return normalized;
  }
  if (normalized === "delete" || normalized === "home" || normalized === "end") {
    return normalized;
  }
  if (normalized === "pageup" || normalized === "pagedown") return normalized;
  return null;
}

export function keybindingFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: string,
  options?: {
    readonly layoutCharacter?: boolean;
  },
): string | null {
  const keyToken = normalizeShortcutKeyToken(
    options?.layoutCharacter ? recordedLayoutShortcutKey(event) : shortcutKeyFromEvent(event),
  );
  if (!keyToken) return null;

  const parts: string[] = [];
  if (isMacPlatform(platform)) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(keyToken);
  return parts.join("+");
}

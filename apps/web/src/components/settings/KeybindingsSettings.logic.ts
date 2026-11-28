import {
  STATIC_KEYBINDING_COMMANDS,
  type ClientSettings,
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
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import {
  formatShortcutLabel,
  shortcutConflictKey,
  shortcutForContext,
  shortcutKeyFromEvent,
} from "../../keybindings";
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
  readonly isUnassigned: boolean;
  readonly defaultKey: string | null;
  readonly defaultWhen: string;
  readonly binding: ResolvedKeybindingRule;
  readonly conflicts: ReadonlyArray<string>;
  readonly previewLabels: ReadonlyArray<string>;
  readonly previewShortcuts: ReadonlyArray<KeybindingShortcut>;
}

export type WhenVariableOption = string;
export type KeybindingCommandOption = KeybindingCommand;

const CORE_WHEN_VARIABLES = [
  "terminalFocus",
  "terminalOpen",
  "previewOpen",
  "composerEmpty",
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

export function shortcutToKeybindingParts(shortcut: KeybindingShortcut): ReadonlyArray<string> {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("mod");
  if (shortcut.metaKey) parts.push("meta");
  if (shortcut.ctrlKey) parts.push("ctrl");
  if (shortcut.altKey) parts.push("alt");
  if (shortcut.shiftKey) parts.push("shift");
  parts.push(shortcut.key === " " ? "space" : shortcut.key === "escape" ? "esc" : shortcut.key);
  return parts;
}

export function shortcutToKeybindingInput(shortcut: KeybindingShortcut): string {
  return shortcutToKeybindingParts(shortcut).join("+");
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
  resolve: MessageResolver = m,
): string {
  if (depth === 0) return resolve(msg("Clear all conditions"));
  if (node.type === "identifier" || (node.type === "not" && node.node.type === "identifier")) {
    return resolve(msg("Remove condition"));
  }
  return resolve(msg("Remove group and its conditions"));
}

function wrapWhenExpression(node: KeybindingWhenNode): string {
  if (node.type === "identifier" || node.type === "not") return whenAstToExpression(node);
  return `(${whenAstToExpression(node)})`;
}

export function parseWhenExpressionDraft(
  expression: string,
  resolve: MessageResolver = m,
): { ok: true; value: KeybindingWhenNode | undefined } | { ok: false; message: string } {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };

  const ast = parseKeybindingWhenExpression(trimmed);
  if (!ast) {
    return {
      ok: false,
      message: resolve(msg("Use variables with !, &&, ||, and parentheses.")),
    };
  }

  return { ok: true, value: ast };
}

function sourceForBinding(binding: ResolvedKeybindingRule): KeybindingSource {
  if (String(binding.command).startsWith("script.")) {
    const source: KeybindingSource = "Project";
    return source;
  }

  const bindingKey = shortcutToKeybindingInput(binding.shortcut);
  const bindingWhen = whenAstToExpression(binding.whenAst);
  const isDefault = DEFAULT_RESOLVED_KEYBINDINGS.some(
    (entry) =>
      entry.command === binding.command &&
      shortcutToKeybindingInput(entry.shortcut) === bindingKey &&
      whenAstToExpression(entry.whenAst) === bindingWhen,
  );

  const source: KeybindingSource = isDefault ? "Default" : "Custom";
  return source;
}

function defaultBindingForBinding(
  binding: ResolvedKeybindingRule,
  keybindings: ResolvedKeybindingsConfig,
): ResolvedKeybindingRule | undefined {
  const bindingKey = shortcutToKeybindingInput(binding.shortcut);
  const bindingWhen = whenAstToExpression(binding.whenAst);
  const isBound = (entry: ResolvedKeybindingRule) =>
    keybindings.some(
      (other) =>
        other.command === entry.command &&
        shortcutToKeybindingInput(other.shortcut) === shortcutToKeybindingInput(entry.shortcut) &&
        [whenAstToExpression(entry.whenAst), "false"].includes(whenAstToExpression(other.whenAst)),
    );
  // An edited row does not record which default it replaced; a default the command still has,
  // or that is unassigned, cannot be it.
  const findDefault = (matches: (entry: ResolvedKeybindingRule) => boolean) =>
    DEFAULT_RESOLVED_KEYBINDINGS.find((entry) => matches(entry) && !isBound(entry)) ??
    DEFAULT_RESOLVED_KEYBINDINGS.find(matches);

  return (
    DEFAULT_RESOLVED_KEYBINDINGS.find(
      (entry) =>
        entry.command === binding.command &&
        shortcutToKeybindingInput(entry.shortcut) === bindingKey &&
        whenAstToExpression(entry.whenAst) === bindingWhen,
    ) ??
    (bindingWhen === "false"
      ? DEFAULT_RESOLVED_KEYBINDINGS.find(
          (entry) =>
            entry.command === binding.command &&
            shortcutToKeybindingInput(entry.shortcut) === bindingKey,
        )
      : undefined) ??
    findDefault(
      (entry) =>
        entry.command === binding.command && whenAstToExpression(entry.whenAst) === bindingWhen,
    ) ??
    // The last rule is the main key; alt+cmd aliases come first (later rules win).
    DEFAULT_RESOLVED_KEYBINDINGS.findLast(
      (entry) => entry.command === binding.command && !isBound(entry),
    ) ??
    DEFAULT_RESOLVED_KEYBINDINGS.findLast((entry) => entry.command === binding.command)
  );
}

function platformAllowsWhen(node: KeybindingWhenNode | undefined, isMac: boolean): boolean | null {
  if (!node) return null;
  switch (node.type) {
    case "identifier":
      return node.name === "isMac" ? isMac : null;
    case "not": {
      const value = platformAllowsWhen(node.node, isMac);
      return value === null ? null : !value;
    }
    case "and": {
      const left = platformAllowsWhen(node.left, isMac);
      const right = platformAllowsWhen(node.right, isMac);
      if (left === false || right === false) return false;
      return left === true && right === true ? true : null;
    }
    case "or": {
      const left = platformAllowsWhen(node.left, isMac);
      const right = platformAllowsWhen(node.right, isMac);
      if (left === true || right === true) return true;
      return left === false && right === false ? false : null;
    }
  }
}

function keybindingRowId(command: KeybindingCommand, key: string, when: string): string {
  return `${command}\u0000${key}\u0000${when}`;
}

function conflictsWithWhen(leftWhen: string, rightWhen: string): boolean {
  if (leftWhen === "false" || rightWhen === "false") return false;
  // An empty condition and "true" are both always active.
  const always = (when: string) => when.length === 0 || when === "true";
  return always(leftWhen) || always(rightWhen) || leftWhen === rightWhen;
}

export function keybindingConflictLabels(
  rows: ReadonlyArray<KeybindingRow>,
  input: { readonly rowId: string; readonly key: string; readonly when: string },
  platform = navigator.platform,
  resolve: MessageResolver = m,
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
      conflicts.push(commandLabel(candidate.command, resolve));
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
    title: msg("Navigation"),
    prefixes: [
      "navigation",
      "sidebar",
      "rightPanel",
      "commandPalette",
      "filePicker",
      "projectSearch",
      "editor",
    ],
  },
  { id: "threads", title: msg("Threads"), prefixes: ["thread", "chat", "pullRequest"] },
  { id: "composer", title: msg("Composer"), prefixes: ["composer", "modelPicker"] },
  { id: "terminal", title: msg("Terminal"), prefixes: ["terminal"] },
  { id: "preview", title: msg("Preview & diff"), prefixes: ["preview", "diff"] },
  {
    id: "appearance",
    title: msg("Appearance"),
    prefixes: ["theme", "appearance", "themeEditor"],
  },
  { id: "scripts", title: msg("Project scripts"), prefixes: ["script"] },
] as const;
const OTHER_KEYBINDING_GROUP = {
  id: "other",
  title: msg("Other", { $context: "keybinding group" }),
} as const;

function keybindingGroupFor(command: KeybindingCommand): { id: string; title: string } {
  const prefix = String(command).split(".")[0] ?? "";
  return (
    KEYBINDING_GROUPS.find((group) => (group.prefixes as ReadonlyArray<string>).includes(prefix)) ??
    OTHER_KEYBINDING_GROUP
  );
}

export function groupKeybindingRows(
  rows: ReadonlyArray<KeybindingRow>,
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
    return groupRows ? [{ id: group.id, title: group.title, rows: groupRows }] : [];
  });
}
export function buildKeybindingRows(
  keybindings: ResolvedKeybindingsConfig,
  platform = navigator.platform,
  sendShortcut: ClientSettings["sendShortcut"] = "enter",
  resolve: MessageResolver = m,
): ReadonlyArray<KeybindingRow> {
  // Multiline sending can use either shortcut; settings have no active composer prompt.
  const modifierModes =
    sendShortcut === "mod-enter-multiline" ? [false, true] : [sendShortcut === "mod-enter"];
  const previewLabels = keybindings.map(() => new Set<string>());
  const previewShortcuts = keybindings.map(() => new Map<string, KeybindingShortcut>());
  for (const composerRequiresModifier of modifierModes) {
    const laterBindings = new Set<string>();
    for (let index = keybindings.length - 1; index >= 0; index--) {
      const binding = keybindings[index]!;
      const when = whenAstToExpression(binding.whenAst);
      if (when === "false") continue;
      const shortcut = shortcutForContext(binding, { composerRequiresModifier });
      const key = shortcutConflictKey(shortcut, platform);
      const conditionKey = `${key}:${when === "true" ? "" : when}`;
      // Distinct conditions may still apply in other focus contexts.
      if (!laterBindings.has(`${key}:`) && !laterBindings.has(conditionKey)) {
        const label = formatShortcutLabel(shortcut, platform);
        previewLabels[index]!.add(label);
        if (!previewShortcuts[index]!.has(label)) {
          previewShortcuts[index]!.set(label, shortcut);
        }
      }
      laterBindings.add(conditionKey);
    }
  }
  const rowsById = new Map<string, KeybindingRow>();
  const isMac = isMacPlatform(platform);
  for (const [index, binding] of keybindings.entries()) {
    if (platformAllowsWhen(binding.whenAst, isMac) === false) continue;
    const defaultBinding = defaultBindingForBinding(binding, keybindings);
    const key = shortcutToKeybindingInput(binding.shortcut);
    const when = whenAstToExpression(binding.whenAst);
    const id = keybindingRowId(binding.command, key, when);
    rowsById.set(id, {
      id,
      command: binding.command,
      key,
      when,
      source: sourceForBinding(binding),
      isUnassigned:
        when === "false" &&
        defaultBinding !== undefined &&
        key === shortcutToKeybindingInput(defaultBinding.shortcut),
      defaultKey: defaultBinding ? shortcutToKeybindingInput(defaultBinding.shortcut) : null,
      defaultWhen: whenAstToExpression(defaultBinding?.whenAst),
      binding,
      conflicts: [],
      previewLabels: [...previewLabels[index]!],
      previewShortcuts: [...previewShortcuts[index]!.values()],
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
      resolve,
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
  resolve: MessageResolver = m,
  platform = navigator.platform,
): ReadonlyArray<KeybindingRow> {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return rows;
  return rows.filter((row) => {
    return (
      row.command.toLowerCase().includes(normalizedQuery) ||
      commandLabel(row.command, resolve).toLowerCase().includes(normalizedQuery) ||
      row.key.toLowerCase().includes(normalizedQuery) ||
      // The row shows the platform label ("Ctrl+K"), not the stored "mod+k".
      formatShortcutLabel(row.binding.shortcut, platform).toLowerCase().includes(normalizedQuery) ||
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
  resolve: MessageResolver = m,
): ReadonlyArray<KeybindingCommandOption> {
  const commands = new Set<KeybindingCommand>(STATIC_KEYBINDING_COMMANDS);
  for (const binding of keybindings) {
    commands.add(binding.command);
  }
  return [...commands].toSorted((left, right) =>
    compareCommands(left, right, (command) => commandLabel(command, resolve)),
  );
}

/** Friendly names for built-in commands, shown in the Shortcuts table and settings search. */
const COMMAND_LABELS: Partial<Record<string, string>> = {
  "workspace.focusNext": msg("Focus next workspace area"),
  "workspace.focusPrevious": msg("Focus previous workspace area"),
  "sidebar.toggle": msg("Toggle sidebar"),
  "navigation.back": msg("Go back"),
  "navigation.forward": msg("Go forward"),
  "terminal.toggle": msg("Toggle terminal"),
  "terminal.split": msg("Split terminal"),
  "terminal.splitVertical": msg("Split terminal vertically"),
  "terminal.new": msg("New terminal"),
  "terminal.close": msg("Close terminal"),
  "terminal.previous": msg("Terminal: Previous"),
  "terminal.next": msg("Terminal: Next"),
  "rightPanel.toggle": msg("Toggle side pane"),
  "threadPanel.toggle": msg("Toggle thread panel"),
  "rightPanel.close": msg("Close right panel"),
  "view.reopenClosed": msg("Reopen closed tab"),
  "pullRequest.copyNumber": msg("Copy pull request number"),
  "diff.toggle": msg("Toggle diff panel"),
  "pullRequests.toggle": msg("Toggle linked pull requests"),
  "preview.toggle": msg("Toggle browser"),
  "preview.refresh": msg("Reload browser"),
  "preview.focusUrl": msg("Focus browser address"),
  "preview.find": msg("Find on page in Preview"),
  "preview.zoomIn": msg("Zoom in browser"),
  "preview.zoomOut": msg("Zoom out browser"),
  "preview.resetZoom": msg("Reset browser zoom"),
  "commandPalette.toggle": msg("Command palette"),
  "filePicker.toggle": msg("Open file"),
  "projectSearch.toggle": msg("Search in project"),
  "theme.select": msg("Select theme"),
  "appearance.cycle": msg("Cycle appearance"),
  "themeEditor.toggle": msg("Toggle theme editor"),
  "composer.stash": msg("Stash prompt"),
  "composer.sendAlternate": msg("Send with the opposite queue or steer action"),
  "composer.sendBackground": msg("Start in background"),
  "composer.sendAndNewThread": msg("Send and start a new thread"),
  "composer.dictation": msg("Start or finish dictation"),
  "composer.host": msg("Choose machine"),
  "composer.effort": msg("Choose effort"),
  "composer.mode": msg("Choose access mode"),
  "composer.workspace": msg("Choose workspace"),
  "composer.previousWorktree": msg("Use previous worktree"),
  "composer.branch": msg("Choose branch"),
  "chat.new": msg("New thread"),
  "chat.newLocal": msg("New local thread"),
  "chat.newWithoutProject": msg("New thread without a project"),
  "chat.citeSelection": msg("Cite selection in composer"),
  "chat.find": msg("Find in thread"),
  "editor.openFavorite": msg("Open in editor"),
  "modelPicker.toggle": msg("Choose model"),
  "modelPicker.previousProvider": msg("Previous model provider"),
  "modelPicker.nextProvider": msg("Next model provider"),
  "thread.stop": msg("Stop run"),
  "thread.steerQueuedMessage": msg("Send first queued message"),
  "thread.editQueuedMessage": msg("Edit last queued message"),
  "thread.previous": msg("Previous thread"),
  "thread.next": msg("Next thread"),
  "thread.copyReference": msg("Copy link to pull request or thread"),
  "thread.settle": msg("Settle thread"),
  "thread.pin": msg("Pin thread"),
  "thread.undo": msg("Undo last thread action"),
  "git.commitPush": msg("Commit and push"),
  "tab.new": msg("New tab"),
  "tab.close": msg("Close tab"),
  "tab.next": msg("Next tab"),
  "tab.previous": msg("Previous tab"),
  "layout.splitRight": msg("New pane to the right"),
  "layout.splitDown": msg("New pane below"),
  "layout.fill": msg("Fill the window"),
  "layout.focusLeft": msg("Focus pane on the left"),
  "layout.focusRight": msg("Focus pane on the right"),
  "layout.focusUp": msg("Focus pane above"),
  "layout.focusDown": msg("Focus pane below"),
  "layout.moveLeft": msg("Move pane left"),
  "layout.moveRight": msg("Move pane right"),
  "layout.moveUp": msg("Move pane up"),
  "layout.moveDown": msg("Move pane down"),
  "layout.focusFirstColumn": msg("Focus first column"),
  "layout.focusLastColumn": msg("Focus last column"),
  "layout.cycleColumnWidth": msg("Column width ⅓ ½ ⅔"),
  "layout.centerColumn": msg("Center column"),
  "layout.pullLeft": msg("Pull pane into the left column"),
  "layout.pullRight": msg("Push pane out to its own column"),
  "layout.shortcutSheet": msg("Show every shortcut"),
  "layout.focusWorkspaceDown": msg("Next workspace"),
  "layout.focusWorkspaceUp": msg("Previous workspace"),
  "layout.moveToWorkspaceDown": msg("Send pane to the next workspace"),
  "layout.moveToWorkspaceUp": msg("Send pane to the previous workspace"),
  "layout.moveWorkspaceDown": msg("Move workspace down"),
  "layout.moveWorkspaceUp": msg("Move workspace up"),
  "layout.overview": msg("Overview", { $context: "shortcut, shows every workspace at once" }),
  "usage.open": msg("Toggle usage"),
  "usage.cost": msg("Show usage by cost"),
  "usage.tokens": msg("Show usage by tokens"),
  "usage.limits": msg("Show usage limits"),
  "usage.period.day": msg("Show usage for the past 24 hours"),
  "usage.period.week": msg("Show usage for the past 7 days"),
  "usage.period.month": msg("Show usage for the past 30 days"),
  "usage.period.quarter": msg("Show usage for the past 90 days"),
  "composer.cycleHost": msg("Composer: Cycle Host"),
  "composer.increaseEffort": msg("Composer: Increase Effort"),
  "composer.decreaseEffort": msg("Composer: Decrease Effort"),
  "thread.regenerateTitle": msg("Thread: Regenerate Title"),
  "rightPanel.new": msg("Right Panel: New"),
  "rightPanel.toggleMaximized": msg("Right Panel: Toggle Maximized"),
};

export function commandLabel(command: KeybindingCommand, resolve: MessageResolver = m): string {
  const label = COMMAND_LABELS[command];
  if (label) return resolve(label);
  const raw = String(command);
  const threadJump = /^thread\.jump\.(\d)$/.exec(raw);
  if (threadJump) return resolve(msg("Jump to thread {n}", { n: threadJump[1] }));
  const modelJump = /^modelPicker\.jump\.(\d)$/.exec(raw);
  if (modelJump) return resolve(msg("Pick model {n}", { n: modelJump[1] }));
  if (raw.startsWith("script.") && raw.endsWith(".run")) {
    return resolve(
      msg("Run script: {name}", {
        name: titleCaseCommandSegment(raw.slice("script.".length, -".run".length)),
      }),
    );
  }
  return raw.split(".").map(titleCaseCommandSegment).join(": ");
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
  platform: string,
): string {
  const physicalKey = shortcutKeyFromEvent(event, platform);
  const layoutKey = event.key.toLowerCase();
  if (layoutKey.length !== 1 || (event.altKey && isMacPlatform(platform))) return physicalKey;
  // A non-Latin letter (Cyrillic, Greek, ...) stops matching once the user switches to a Latin layout.
  if (/^\p{L}$/u.test(layoutKey) && !/\p{Script=Latin}/u.test(layoutKey)) {
    return /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : physicalKey;
  }
  if (event.altKey) return physicalKey;
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
    options?.layoutCharacter
      ? recordedLayoutShortcutKey(event, platform)
      : shortcutKeyFromEvent(event, platform),
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

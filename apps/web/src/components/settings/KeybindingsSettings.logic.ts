import {
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  STATIC_KEYBINDING_COMMANDS,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type KeybindingCommand,
  type KeybindingRule,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { isMacPlatform } from "../../lib/utils";

/**
 * Mirror of `DEFAULT_KEYBINDINGS` in `apps/server/src/keybindings.ts`.
 * The server stays the source of truth at runtime; this copy only backs the
 * settings UI (default labels, reset-to-default). Keep both lists in sync.
 */
const MIRRORED_DEFAULT_RULES: ReadonlyArray<{ key: string; command: string; when?: string }> = [
  { key: "mod+j", command: "terminal.toggle" },
  { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
  { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
  { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
  { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
  { key: "mod+shift+j", command: "preview.toggle" },
  { key: "mod+r", command: "preview.refresh", when: "previewFocus" },
  { key: "mod+l", command: "preview.focusUrl", when: "previewFocus" },
  { key: "mod+=", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod++", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod+-", command: "preview.zoomOut", when: "previewFocus" },
  { key: "mod+0", command: "preview.resetZoom", when: "previewFocus" },
  { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
  { key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
  { key: "mod+f", command: "chat.find", when: "!terminalFocus" },
  { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+n", command: "chat.newLocal", when: "!terminalFocus" },
  { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  { key: "mod+o", command: "editor.openFavorite" },
  { key: "mod+shift+[", command: "thread.previous" },
  { key: "mod+shift+]", command: "thread.next" },
  ...THREAD_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    key: `mod+${index + 1}`,
    command,
  })),
  ...MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    key: `mod+${index + 1}`,
    command,
    when: "modelPickerOpen",
  })),
];

const DEFAULT_RULES_BY_COMMAND = new Map<string, ReadonlyArray<KeybindingRule>>();

function defaultRulesForCommandInternal(command: string): ReadonlyArray<KeybindingRule> {
  const cached = DEFAULT_RULES_BY_COMMAND.get(command);
  if (cached) return cached;
  const rules = MIRRORED_DEFAULT_RULES.filter((rule) => rule.command === command).map((rule) =>
    rule.when === undefined
      ? { key: rule.key, command: rule.command as KeybindingCommand }
      : { key: rule.key, command: rule.command as KeybindingCommand, when: rule.when },
  );
  DEFAULT_RULES_BY_COMMAND.set(command, rules);
  return rules;
}

export function defaultRulesForCommand(command: string): ReadonlyArray<KeybindingRule> {
  return defaultRulesForCommandInternal(command);
}

function titleCaseSegment(segment: string): string {
  const words: Array<string> = [];
  for (const part of segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[-_\s]+/)) {
    if (part.length > 0) {
      words.push(part.slice(0, 1).toUpperCase() + part.slice(1));
    }
  }
  return words.join(" ");
}

/** Human label for a keybinding command, e.g. `terminal.toggle` → `Terminal: Toggle`. */
export function commandLabel(command: string): string {
  const raw = String(command);
  if (raw.startsWith("script.") && raw.endsWith(".run")) {
    return `Run Script: ${titleCaseSegment(raw.slice("script.".length, -".run".length))}`;
  }
  return raw.split(".").map(titleCaseSegment).join(": ");
}

/** Encodes a resolved shortcut back to keybindings.json spelling, e.g. `mod+shift+k`. */
export function encodeShortcutKey(shortcut: KeybindingShortcut): string {
  const modifiers: string[] = [];
  if (shortcut.modKey) modifiers.push("mod");
  if (shortcut.metaKey) modifiers.push("meta");
  if (shortcut.ctrlKey) modifiers.push("ctrl");
  if (shortcut.altKey) modifiers.push("alt");
  if (shortcut.shiftKey) modifiers.push("shift");
  const key = shortcut.key === " " ? "space" : shortcut.key === "escape" ? "esc" : shortcut.key;
  return [...modifiers, key].join("+");
}

function wrapWhenExpression(node: KeybindingWhenNode): string {
  if (node.type === "identifier" || node.type === "not") return whenAstToExpression(node);
  return `(${whenAstToExpression(node)})`;
}

/** Serializes a resolved `when` AST back to an editable expression. Empty when absent. */
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

export interface KeybindingRow {
  readonly id: string;
  readonly command: KeybindingCommand;
  readonly label: string;
  readonly shortcut: KeybindingShortcut;
  /** Editable keybindings.json spelling, e.g. `mod+shift+k`. */
  readonly key: string;
  /** Editable `when` expression; empty when unconditional. */
  readonly when: string;
  readonly source: "Default" | "Custom";
  /** True when this command differs from its server default. */
  readonly isCustomized: boolean;
  readonly conflicts: ReadonlyArray<string>;
}

function isDefaultRule(row: { key: string; when: string; command: string }): boolean {
  return defaultRulesForCommandInternal(row.command).some(
    (rule) => rule.key === row.key && (rule.when ?? "") === row.when,
  );
}

function conflictsWithWhen(leftWhen: string, rightWhen: string): boolean {
  // An unconditional binding overlaps every context; two conditions overlap
  // unless they are textually distinct non-empty expressions. This is a cheap
  // approximation (not a SAT check): `terminalFocus` vs `!terminalFocus` is
  // correctly clean, while semantically exclusive complex expressions may
  // still flag. Exact `when` equality is the common real-overlap case.
  return leftWhen.length === 0 || rightWhen.length === 0 || leftWhen === rightWhen;
}

function commandSortKey(command: string): string {
  return commandLabel(command);
}

function ruleForRow(
  row: Pick<KeybindingRow, "command" | "key" | "when">,
  key: string,
): KeybindingRule {
  return row.when.length > 0
    ? { key, command: row.command, when: row.when }
    : { key, command: row.command };
}

/**
 * Row-level replacement for one command's bindings: the edited row takes
 * `nextKey` (keeping its own activation condition) while every sibling row
 * of the same command is preserved verbatim. Persist the result with
 * `replaceKeybindingRules`, not the command-wide single-rule upsert, so
 * editing one shortcut never deletes the command's other bindings.
 */
export function buildReplacementRules(
  rows: ReadonlyArray<KeybindingRow>,
  editedRow: KeybindingRow,
  nextKey: string,
): KeybindingRule[] {
  return rows
    .filter((row) => row.command === editedRow.command)
    .map((row) => (row.id === editedRow.id ? ruleForRow(row, nextKey) : ruleForRow(row, row.key)));
}

/** One row per resolved rule, sorted by human label. Conflicts are attached. */
export function buildKeybindingRows(keybindings: ResolvedKeybindingsConfig): KeybindingRow[] {
  const rows: KeybindingRow[] = keybindings.map((binding, index) => {
    const key = encodeShortcutKey(binding.shortcut);
    const when = whenAstToExpression(binding.whenAst);
    const source: KeybindingRow["source"] = isDefaultRule({
      key,
      when,
      command: binding.command,
    })
      ? "Default"
      : "Custom";
    return {
      id: `${binding.command}${key}${when}${index}`,
      command: binding.command,
      label: commandLabel(binding.command),
      shortcut: binding.shortcut,
      key,
      when,
      source,
      isCustomized: source === "Custom",
      conflicts: [],
    };
  });

  const byKey = new Map<string, KeybindingRow[]>();
  for (const row of rows) {
    const list = byKey.get(row.key.toLowerCase()) ?? [];
    list.push(row);
    byKey.set(row.key.toLowerCase(), list);
  }
  const resolved: KeybindingRow[] = rows.map((row) => {
    const conflicts = new Set<string>();
    for (const candidate of byKey.get(row.key.toLowerCase()) ?? []) {
      if (candidate.id === row.id) continue;
      if (conflictsWithWhen(candidate.when, row.when)) {
        conflicts.add(candidate.label);
      }
    }
    return { ...row, conflicts: [...conflicts].toSorted() };
  });

  resolved.sort((left, right) => {
    const byCommand = commandSortKey(left.command).localeCompare(commandSortKey(right.command));
    if (byCommand !== 0) return byCommand;
    return left.key.localeCompare(right.key);
  });
  return resolved;
}

/** Case-insensitive match against label, command, key, when, and source. */
export function filterKeybindingRows(
  rows: ReadonlyArray<KeybindingRow>,
  query: string,
): KeybindingRow[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [...rows];
  return rows.filter((row) =>
    [row.label, row.command, row.key, row.when, row.source].some((field) =>
      field.toLowerCase().includes(normalized),
    ),
  );
}

/** Every static command plus any extra (e.g. `script.*`) commands in the config. */
export function allKnownCommands(
  keybindings: ResolvedKeybindingsConfig,
): ReadonlyArray<KeybindingCommand> {
  const commands = new Set<KeybindingCommand>(STATIC_KEYBINDING_COMMANDS);
  for (const binding of keybindings) {
    commands.add(binding.command);
  }
  return [...commands].toSorted((left, right) =>
    commandSortKey(left).localeCompare(commandSortKey(right)),
  );
}

const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta"]);

function normalizeCaptureKey(key: string, code: string | undefined): string | null {
  const normalized = key.toLowerCase();
  if (MODIFIER_KEYS.has(normalized)) return null;
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized === "arrowup" || normalized === "arrowdown") return normalized;
  if (normalized === "arrowleft" || normalized === "arrowright") return normalized;
  if (normalized.length === 1) return normalized;
  if (/^f\d{1,2}$/.test(normalized)) return normalized;
  if (
    normalized === "enter" ||
    normalized === "tab" ||
    normalized === "backspace" ||
    normalized === "delete" ||
    normalized === "home" ||
    normalized === "end" ||
    normalized === "pageup" ||
    normalized === "pagedown"
  ) {
    return normalized;
  }
  // Layout-dependent punctuation (e.g. `[` on some layouts reports varying
  // `key` but a stable `code`); fall back to the US-layout digit/bracket key.
  if (code !== undefined) {
    const digit = /^Digit([0-9])$/.exec(code)?.[1];
    if (digit) return digit;
    if (code === "BracketLeft") return "[";
    if (code === "BracketRight") return "]";
    if (code === "Minus") return "-";
    if (code === "Equal") return "=";
    if (code === "Slash") return "/";
    if (code === "Quote") return "'";
    if (code === "Comma") return ",";
    if (code === "Period") return ".";
    if (code === "Semicolon") return ";";
    if (code === "Backquote") return "`";
    if (code === "Backslash") return "\\";
  }
  return null;
}

export interface KeyboardCaptureEvent {
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * Turns a keydown into keybindings.json spelling such as `mod+shift+k`.
 * Null for modifier-only presses and keys with no binding spelling.
 */
export function keybindingFromKeyboardEvent(
  event: KeyboardCaptureEvent,
  platform: string,
): string | null {
  const keyToken = normalizeCaptureKey(event.key, event.code);
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

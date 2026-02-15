import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  KeybindingRule,
  KeybindingsConfig,
  KeybindingShortcut,
  KeybindingWhenNode,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { keybindingRuleSchema } from "@t3tools/contracts";

interface KeybindingsLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

type WhenToken =
  | { type: "identifier"; value: string }
  | { type: "not" }
  | { type: "and" }
  | { type: "or" }
  | { type: "lparen" }
  | { type: "rparen" };

export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+j", command: "terminal.toggle" },
  { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
  { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
  { key: "mod+shift+o", command: "chat.new" },
  { key: "mod+o", command: "editor.openFavorite" },
];

function normalizeKeyToken(token: string): string {
  if (token === "space") return " ";
  if (token === "esc") return "escape";
  return token;
}

export function parseKeybindingShortcut(value: string): KeybindingShortcut | null {
  const rawTokens = value
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());
  const tokens = [...rawTokens];
  let trailingEmptyCount = 0;
  while (tokens[tokens.length - 1] === "") {
    trailingEmptyCount += 1;
    tokens.pop();
  }
  if (trailingEmptyCount > 0) {
    tokens.push("+");
  }
  if (tokens.some((token) => token.length === 0)) {
    return null;
  }
  if (tokens.length === 0) return null;

  let key: string | null = null;
  let metaKey = false;
  let ctrlKey = false;
  let shiftKey = false;
  let altKey = false;
  let modKey = false;

  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        metaKey = true;
        break;
      case "ctrl":
      case "control":
        ctrlKey = true;
        break;
      case "shift":
        shiftKey = true;
        break;
      case "alt":
      case "option":
        altKey = true;
        break;
      case "mod":
        modKey = true;
        break;
      default: {
        if (key !== null) return null;
        key = normalizeKeyToken(token);
      }
    }
  }

  if (key === null) return null;
  return {
    key,
    metaKey,
    ctrlKey,
    shiftKey,
    altKey,
    modKey,
  };
}

function tokenizeWhenExpression(expression: string): WhenToken[] | null {
  const tokens: WhenToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const current = expression[index];
    if (!current) break;

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (expression.startsWith("&&", index)) {
      tokens.push({ type: "and" });
      index += 2;
      continue;
    }
    if (expression.startsWith("||", index)) {
      tokens.push({ type: "or" });
      index += 2;
      continue;
    }
    if (current === "!") {
      tokens.push({ type: "not" });
      index += 1;
      continue;
    }
    if (current === "(") {
      tokens.push({ type: "lparen" });
      index += 1;
      continue;
    }
    if (current === ")") {
      tokens.push({ type: "rparen" });
      index += 1;
      continue;
    }

    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(expression.slice(index));
    if (!identifier) {
      return null;
    }
    tokens.push({ type: "identifier", value: identifier[0] });
    index += identifier[0].length;
  }

  return tokens;
}

export function parseKeybindingWhenExpression(expression: string): KeybindingWhenNode | null {
  const tokens = tokenizeWhenExpression(expression);
  if (!tokens || tokens.length === 0) return null;
  let index = 0;

  const parsePrimary = (): KeybindingWhenNode | null => {
    const token = tokens[index];
    if (!token) return null;

    if (token.type === "identifier") {
      index += 1;
      return { type: "identifier", name: token.value };
    }

    if (token.type === "lparen") {
      index += 1;
      const expressionNode = parseOr();
      const closeToken = tokens[index];
      if (!expressionNode || !closeToken || closeToken.type !== "rparen") {
        return null;
      }
      index += 1;
      return expressionNode;
    }

    return null;
  };

  const parseUnary = (): KeybindingWhenNode | null => {
    const token = tokens[index];
    if (token?.type === "not") {
      index += 1;
      const node = parseUnary();
      if (!node) return null;
      return { type: "not", node };
    }
    return parsePrimary();
  };

  const parseAnd = (): KeybindingWhenNode | null => {
    let left = parseUnary();
    if (!left) return null;

    while (tokens[index]?.type === "and") {
      index += 1;
      const right = parseUnary();
      if (!right) return null;
      left = { type: "and", left, right };
    }

    return left;
  };

  const parseOr = (): KeybindingWhenNode | null => {
    let left = parseAnd();
    if (!left) return null;

    while (tokens[index]?.type === "or") {
      index += 1;
      const right = parseAnd();
      if (!right) return null;
      left = { type: "or", left, right };
    }

    return left;
  };

  const ast = parseOr();
  if (!ast || index !== tokens.length) return null;
  return ast;
}

export function compileResolvedKeybindingRule(rule: KeybindingRule): ResolvedKeybindingRule | null {
  const key = rule.key.trim();
  if (key.length === 0) return null;
  const shortcut = parseKeybindingShortcut(key);
  if (!shortcut) return null;

  const when = rule.when?.trim();
  if (when && when.length > 0) {
    const whenAst = parseKeybindingWhenExpression(when);
    if (!whenAst) return null;
    return {
      command: rule.command,
      shortcut,
      whenAst,
    };
  }

  return {
    command: rule.command,
    shortcut,
  };
}

export function compileResolvedKeybindingsConfig(
  config: KeybindingsConfig,
): ResolvedKeybindingsConfig {
  const compiled: ResolvedKeybindingsConfig = [];
  for (const rule of config) {
    const resolved = compileResolvedKeybindingRule(rule);
    if (!resolved) continue;
    compiled.push(resolved);
  }
  return compiled;
}

function compileDefaultKeybindings(): ResolvedKeybindingsConfig {
  const resolved: ResolvedKeybindingsConfig = [];
  for (const rule of DEFAULT_KEYBINDINGS) {
    const compiled = compileResolvedKeybindingRule(rule);
    if (!compiled) {
      throw new Error(`Invalid default keybinding: ${rule.command} (${rule.key})`);
    }
    resolved.push(compiled);
  }
  return resolved;
}

const DEFAULT_RESOLVED_KEYBINDINGS = compileDefaultKeybindings();

function mergeWithDefaultKeybindings(custom: ResolvedKeybindingsConfig): ResolvedKeybindingsConfig {
  if (custom.length === 0) {
    return [...DEFAULT_RESOLVED_KEYBINDINGS];
  }

  const overriddenCommands = new Set(custom.map((binding) => binding.command));
  const retainedDefaults = DEFAULT_RESOLVED_KEYBINDINGS.filter(
    (binding) => !overriddenCommands.has(binding.command),
  );
  const merged = [...retainedDefaults, ...custom];

  if (merged.length <= 256) {
    return merged;
  }

  // Keep the latest rules when the config exceeds max size; later rules have higher precedence.
  return merged.slice(-256);
}

export function loadResolvedKeybindingsConfig(
  logger: KeybindingsLogger,
): ResolvedKeybindingsConfig {
  const configPath = path.join(os.homedir(), ".t3", "keybindings.json");
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      logger.warn("ignoring keybindings config with unsupported format; expected array", {
        path: configPath,
      });
      return [...DEFAULT_RESOLVED_KEYBINDINGS];
    }

    const sanitized: ResolvedKeybindingsConfig = [];
    let invalidEntries = 0;
    for (const entry of parsed) {
      const result = keybindingRuleSchema.safeParse(entry);
      if (result.success) {
        const compiled = compileResolvedKeybindingRule(result.data);
        if (!compiled) {
          invalidEntries += 1;
          continue;
        }
        sanitized.push(compiled);
        continue;
      }
      invalidEntries += 1;
    }
    if (invalidEntries > 0) {
      logger.warn("ignoring invalid keybinding entries", {
        path: configPath,
        invalidEntries,
        totalEntries: parsed.length,
      });
    }
    const overriddenCommands = new Set(sanitized.map((entry) => entry.command));
    const mergedBeforeCapLength =
      DEFAULT_RESOLVED_KEYBINDINGS.filter((binding) => !overriddenCommands.has(binding.command))
        .length + sanitized.length;
    const merged = mergeWithDefaultKeybindings(sanitized);
    if (mergedBeforeCapLength > 256) {
      logger.warn("truncating merged keybindings config to max entries", {
        path: configPath,
        maxEntries: 256,
      });
    }
    return merged;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [...DEFAULT_RESOLVED_KEYBINDINGS];
    }
    logger.warn("ignoring malformed keybindings config", {
      path: configPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return [...DEFAULT_RESOLVED_KEYBINDINGS];
}

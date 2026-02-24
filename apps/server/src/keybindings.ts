import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  KeybindingRule,
  KeybindingsConfig,
  KeybindingShortcut,
  KeybindingWhenNode,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { Mutable } from "effect/Types";
import { Schema } from "effect";

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

const MAX_WHEN_EXPRESSION_DEPTH = 256;

export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+j", command: "terminal.toggle" },
  { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
  { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
  { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
  { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+n", command: "chat.newLocal", when: "!terminalFocus" },
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

  const parsePrimary = (depth: number): KeybindingWhenNode | null => {
    if (depth > MAX_WHEN_EXPRESSION_DEPTH) {
      return null;
    }
    const token = tokens[index];
    if (!token) return null;

    if (token.type === "identifier") {
      index += 1;
      return { type: "identifier", name: token.value };
    }

    if (token.type === "lparen") {
      index += 1;
      const expressionNode = parseOr(depth + 1);
      const closeToken = tokens[index];
      if (!expressionNode || !closeToken || closeToken.type !== "rparen") {
        return null;
      }
      index += 1;
      return expressionNode;
    }

    return null;
  };

  const parseUnary = (depth: number): KeybindingWhenNode | null => {
    let notCount = 0;
    while (tokens[index]?.type === "not") {
      index += 1;
      notCount += 1;
      if (notCount > MAX_WHEN_EXPRESSION_DEPTH) {
        return null;
      }
    }

    let node = parsePrimary(depth);
    if (!node) return null;

    while (notCount > 0) {
      node = { type: "not", node };
      notCount -= 1;
    }

    return node;
  };

  const parseAnd = (depth: number): KeybindingWhenNode | null => {
    let left = parseUnary(depth);
    if (!left) return null;

    while (tokens[index]?.type === "and") {
      index += 1;
      const right = parseUnary(depth);
      if (!right) return null;
      left = { type: "and", left, right };
    }

    return left;
  };

  const parseOr = (depth: number): KeybindingWhenNode | null => {
    let left = parseAnd(depth);
    if (!left) return null;

    while (tokens[index]?.type === "or") {
      index += 1;
      const right = parseAnd(depth);
      if (!right) return null;
      left = { type: "or", left, right };
    }

    return left;
  };

  const ast = parseOr(0);
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
  const compiled: Mutable<ResolvedKeybindingsConfig> = [];
  for (const rule of config) {
    const resolved = compileResolvedKeybindingRule(rule);
    if (!resolved) continue;
    compiled.push(resolved);
  }
  return compiled;
}

function compileDefaultKeybindings(): ResolvedKeybindingsConfig {
  const resolved: Mutable<ResolvedKeybindingsConfig> = [];
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
const KEYBINDINGS_CONFIG_PATH = path.join(".t3", "keybindings.json");
const MAX_KEYBINDINGS = 256;

class KeybindingsConfigParseError extends Error {
  constructor(configPath: string, detail: string, options?: { cause?: unknown }) {
    super(`Unable to parse keybindings config at ${configPath}: ${detail}`, options);
  }
}

function resolveKeybindingsConfigPath(): string {
  return path.join(os.homedir(), KEYBINDINGS_CONFIG_PATH);
}

function loadCustomKeybindingsConfig(
  logger: KeybindingsLogger,
  options?: {
    throwOnUnreadableConfig?: boolean;
  },
): KeybindingsConfig {
  const configPath = resolveKeybindingsConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      if (options?.throwOnUnreadableConfig) {
        throw new KeybindingsConfigParseError(configPath, "expected JSON array");
      }
      logger.warn("ignoring keybindings config with unsupported format; expected array", {
        path: configPath,
      });
      return [];
    }

    const sanitized: Mutable<KeybindingsConfig> = [];
    let invalidEntries = 0;
    for (const entry of parsed) {
      const result = Schema.decodeUnknownExit(KeybindingRule)(entry);
      if (result._tag === "Success") {
        if (!compileResolvedKeybindingRule(result.value)) {
          invalidEntries += 1;
          continue;
        }
        sanitized.push(result.value);
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
    return sanitized;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    if (options?.throwOnUnreadableConfig) {
      if (error instanceof KeybindingsConfigParseError) {
        throw error;
      }
      throw new KeybindingsConfigParseError(
        configPath,
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    logger.warn("ignoring malformed keybindings config", {
      path: configPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function writeConfigAtomically(configPath: string, config: KeybindingsConfig): void {
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, configPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function mergeWithDefaultKeybindings(custom: ResolvedKeybindingsConfig): ResolvedKeybindingsConfig {
  if (custom.length === 0) {
    return [...DEFAULT_RESOLVED_KEYBINDINGS];
  }

  const overriddenCommands = new Set(custom.map((binding) => binding.command));
  const retainedDefaults = DEFAULT_RESOLVED_KEYBINDINGS.filter(
    (binding) => !overriddenCommands.has(binding.command),
  );
  const merged = [...retainedDefaults, ...custom];

  if (merged.length <= MAX_KEYBINDINGS) {
    return merged;
  }

  // Keep the latest rules when the config exceeds max size; later rules have higher precedence.
  return merged.slice(-MAX_KEYBINDINGS);
}

export function loadResolvedKeybindingsConfig(
  logger: KeybindingsLogger,
): ResolvedKeybindingsConfig {
  const customConfig = loadCustomKeybindingsConfig(logger);
  const compiledCustomConfig = compileResolvedKeybindingsConfig(customConfig);
  const overriddenCommands = new Set(compiledCustomConfig.map((entry) => entry.command));
  const mergedBeforeCapLength =
    DEFAULT_RESOLVED_KEYBINDINGS.filter((binding) => !overriddenCommands.has(binding.command))
      .length + compiledCustomConfig.length;
  const merged = mergeWithDefaultKeybindings(compiledCustomConfig);
  if (mergedBeforeCapLength > MAX_KEYBINDINGS) {
    logger.warn("truncating merged keybindings config to max entries", {
      path: resolveKeybindingsConfigPath(),
      maxEntries: MAX_KEYBINDINGS,
    });
  }
  return merged;
}

export function upsertKeybindingRule(
  logger: KeybindingsLogger,
  rule: KeybindingRule,
): ResolvedKeybindingsConfig {
  const configPath = resolveKeybindingsConfigPath();
  const customConfig = loadCustomKeybindingsConfig(logger, {
    throwOnUnreadableConfig: true,
  });
  const nextConfig = [...customConfig.filter((entry) => entry.command !== rule.command), rule];
  const cappedConfig =
    nextConfig.length > MAX_KEYBINDINGS ? nextConfig.slice(-MAX_KEYBINDINGS) : nextConfig;

  if (nextConfig.length > MAX_KEYBINDINGS) {
    logger.warn("truncating keybindings config to max entries", {
      path: configPath,
      maxEntries: MAX_KEYBINDINGS,
    });
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeConfigAtomically(configPath, cappedConfig);

  const compiledCustomConfig = compileResolvedKeybindingsConfig(cappedConfig);
  return mergeWithDefaultKeybindings(compiledCustomConfig);
}

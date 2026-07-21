import {
  type KeybindingRule,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  MAX_KEYBINDINGS_COUNT,
  MAX_WHEN_EXPRESSION_DEPTH,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";

type WhenToken =
  | { type: "identifier"; value: string }
  | { type: "not" }
  | { type: "and" }
  | { type: "or" }
  | { type: "lparen" }
  | { type: "rparen" };

export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+b", command: "sidebar.toggle" },
  { key: "mod+j", command: "terminal.toggle" },
  { key: "mod+alt+b", command: "rightPanel.toggle" },
  { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
  { key: "mod+shift+d", command: "terminal.splitVertical", when: "terminalFocus" },
  { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
  {
    key: "mod+w",
    command: "terminal.close",
    when: "terminalFocus && !rightPanelFocus",
  },
  {
    key: "mod+w",
    command: "rightPanel.closeActiveSurface",
    when: "rightPanelFocus",
  },
  { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
  { key: "mod+shift+j", command: "preview.toggle" },
  { key: "mod+r", command: "preview.refresh", when: "previewFocus" },
  { key: "mod+l", command: "preview.focusUrl", when: "previewFocus" },
  { key: "mod+=", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod++", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod+-", command: "preview.zoomOut", when: "previewFocus" },
  { key: "mod+0", command: "preview.resetZoom", when: "previewFocus" },
  { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
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

export interface KeybindingInputLike {
  readonly code?: string;
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export type KeybindingModifierStateLike = Pick<
  KeybindingInputLike,
  "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
>;

const EVENT_CODE_KEY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  BracketLeft: ["["],
  BracketRight: ["]"],
  Digit0: ["0"],
  Digit1: ["1"],
  Digit2: ["2"],
  Digit3: ["3"],
  Digit4: ["4"],
  Digit5: ["5"],
  Digit6: ["6"],
  Digit7: ["7"],
  Digit8: ["8"],
  Digit9: ["9"],
};

function isMacKeybindingPlatform(platform: string): boolean {
  return platform === "darwin" || /mac|iphone|ipad|ipod/i.test(platform);
}

export function normalizeKeybindingEventKey(key: string): string {
  const normalized = key.toLowerCase();
  return normalized === "esc" ? "escape" : normalized;
}

function resolveEventKeys(event: Pick<KeybindingInputLike, "key" | "code">): Set<string> {
  const keys = new Set([normalizeKeybindingEventKey(event.key)]);
  const letterCode = event.code?.match(/^Key([A-Z])$/)?.[1];
  if (letterCode) keys.add(letterCode.toLowerCase());

  const aliases = event.code ? EVENT_CODE_KEY_ALIASES[event.code] : undefined;
  if (aliases) {
    for (const alias of aliases) keys.add(alias);
  }
  return keys;
}

export function matchesKeybindingShortcutKey(
  event: Pick<KeybindingInputLike, "key" | "code">,
  shortcutKey: string,
): boolean {
  return resolveEventKeys(event).has(shortcutKey);
}

export function resolveKeybindingShortcutModifiers(
  shortcut: KeybindingShortcut,
  platform: string,
): KeybindingModifierStateLike {
  const useMetaForMod = isMacKeybindingPlatform(platform);
  return {
    metaKey: shortcut.metaKey || (shortcut.modKey && useMetaForMod),
    ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod),
    shiftKey: shortcut.shiftKey,
    altKey: shortcut.altKey,
  };
}

export function matchesKeybindingShortcutModifiers(
  event: KeybindingModifierStateLike,
  shortcut: KeybindingShortcut,
  platform: string,
): boolean {
  const expected = resolveKeybindingShortcutModifiers(shortcut, platform);
  return (
    event.metaKey === expected.metaKey &&
    event.ctrlKey === expected.ctrlKey &&
    event.shiftKey === expected.shiftKey &&
    event.altKey === expected.altKey
  );
}

export function matchesKeybindingShortcut(
  event: KeybindingInputLike,
  shortcut: KeybindingShortcut,
  platform: string,
): boolean {
  return (
    matchesKeybindingShortcutModifiers(event, shortcut, platform) &&
    matchesKeybindingShortcutKey(event, shortcut.key)
  );
}

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
  const shortcut = parseKeybindingShortcut(rule.key);
  if (!shortcut) return null;

  if (rule.when !== undefined) {
    const whenAst = parseKeybindingWhenExpression(rule.when);
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
  config: ReadonlyArray<KeybindingRule>,
): ResolvedKeybindingsConfig {
  const compiled: ResolvedKeybindingRule[] = [];
  for (const rule of config) {
    const result = compileResolvedKeybindingRule(rule);
    if (result) {
      compiled.push(result);
    }
  }
  return compiled.slice(-MAX_KEYBINDINGS_COUNT);
}

export const DEFAULT_RESOLVED_KEYBINDINGS = compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS);

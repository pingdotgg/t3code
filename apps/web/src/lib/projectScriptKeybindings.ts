import {
  KeybindingRule as KeybindingRuleSchema,
  type KeybindingCommand,
  type KeybindingRule,
  type ResolvedKeybindingsConfig,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE = "Invalid keybinding.";

const decodeKeybindingRule = Schema.decodeUnknownOption(KeybindingRuleSchema);

function normalizeProjectScriptKeybindingInput(
  keybinding: string | null | undefined,
): string | null {
  const trimmed = keybinding?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function decodeProjectScriptKeybindingRule(input: {
  keybinding: string | null | undefined;
  command: KeybindingCommand;
}): KeybindingRule | null {
  const normalizedKey = normalizeProjectScriptKeybindingInput(input.keybinding);
  if (!normalizedKey) return null;

  const decoded = decodeKeybindingRule({
    key: normalizedKey,
    command: input.command,
  });
  if (decoded._tag === "None") {
    throw new Error(PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE);
  }
  return decoded.value;
}

export function keybindingValueForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
): string | null {
  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding || binding.command !== command) continue;

    const parts: string[] = [];
    if (binding.shortcut.modKey) parts.push("mod");
    if (binding.shortcut.ctrlKey) parts.push("ctrl");
    if (binding.shortcut.metaKey) parts.push("meta");
    if (binding.shortcut.altKey) parts.push("alt");
    if (binding.shortcut.shiftKey) parts.push("shift");
    const keyToken =
      binding.shortcut.key === " "
        ? "space"
        : binding.shortcut.key === "escape"
          ? "esc"
          : binding.shortcut.key;
    parts.push(keyToken);
    return parts.join("+");
  }
  return null;
}

type ProjectScriptKeybindingMutation =
  | { type: "upsert"; input: ServerUpsertKeybindingInput }
  | { type: "remove"; input: ServerRemoveKeybindingInput }
  | null;

export function deriveProjectScriptKeybindingMutation(input: {
  keybindings: ResolvedKeybindingsConfig;
  keybinding: string | null | undefined;
  command: KeybindingCommand;
}): ProjectScriptKeybindingMutation {
  const nextRule = decodeProjectScriptKeybindingRule(input);
  const previousKeybinding = keybindingValueForCommand(input.keybindings, input.command);
  const previousRule = previousKeybinding
    ? decodeProjectScriptKeybindingRule({
        keybinding: previousKeybinding,
        command: input.command,
      })
    : null;

  if (nextRule) {
    return {
      type: "upsert",
      input:
        previousRule && previousRule.key !== nextRule.key
          ? { ...nextRule, replace: previousRule }
          : nextRule,
    };
  }
  return previousRule ? { type: "remove", input: previousRule } : null;
}

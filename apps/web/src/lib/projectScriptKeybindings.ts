import {
  KeybindingRule as KeybindingRuleSchema,
  type LocalApi,
  type KeybindingCommand,
  type KeybindingRule,
  type ResolvedKeybindingsConfig,
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

type ProjectScriptKeybindingServer = Pick<
  LocalApi["server"],
  "removeKeybinding" | "upsertKeybinding"
>;

function keybindingValueFromResolvedRule(binding: ResolvedKeybindingsConfig[number]) {
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

export function keybindingValuesForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const binding of keybindings) {
    if (binding.command !== command) continue;
    const value = keybindingValueFromResolvedRule(binding);
    if (seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

export function keybindingValueForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
): string | null {
  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding || binding.command !== command) continue;
    return keybindingValueFromResolvedRule(binding);
  }
  return null;
}

export async function syncProjectScriptKeybinding(input: {
  keybindings: ResolvedKeybindingsConfig;
  keybinding: string | null | undefined;
  command: KeybindingCommand;
  server: ProjectScriptKeybindingServer | null | undefined;
}) {
  if (input.keybinding === undefined) return;
  if (!input.server) return;

  const nextRule = decodeProjectScriptKeybindingRule({
    keybinding: input.keybinding,
    command: input.command,
  });

  const existingTargets = keybindingValuesForCommand(input.keybindings, input.command).map(
    (key) => ({
      key,
      command: input.command,
    }),
  );
  if (!nextRule) {
    if (input.keybinding === null) {
      for (const target of existingTargets) {
        await input.server.removeKeybinding(target);
      }
    }
    return;
  }

  for (const target of existingTargets) {
    if (target.key !== nextRule.key) {
      await input.server.removeKeybinding(target);
    }
  }
  await input.server.upsertKeybinding(nextRule);
}

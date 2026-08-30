import {
  KeybindingRule as KeybindingRuleSchema,
  type KeybindingCommand,
  type KeybindingRule,
  type ResolvedKeybindingsConfig,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  shortcutToKeybindingInput,
  whenAstToExpression,
} from "../components/settings/KeybindingsSettings.logic";
import { projectScriptIdFromCommand } from "../projectScripts";

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

export function mergeProjectScriptKeybindings(
  primary: ResolvedKeybindingsConfig,
  environment: ResolvedKeybindingsConfig,
): ResolvedKeybindingsConfig {
  return [
    ...primary.filter((binding) => projectScriptIdFromCommand(binding.command) === null),
    ...environment.filter((binding) => projectScriptIdFromCommand(binding.command) !== null),
  ];
}

type ProjectScriptKeybindingMutation =
  | { type: "upsert"; input: ServerUpsertKeybindingInput }
  | { type: "remove"; input: ServerRemoveKeybindingInput };

export function deriveProjectScriptKeybindingMutations(input: {
  keybindings: ResolvedKeybindingsConfig;
  keybinding: string | null | undefined;
  command: KeybindingCommand;
}): ReadonlyArray<ProjectScriptKeybindingMutation> {
  const nextRule = decodeProjectScriptKeybindingRule(input);
  const targetsByKey = new Map<string, ServerRemoveKeybindingInput>();
  for (const binding of input.keybindings) {
    if (binding.command !== input.command) continue;
    const when = whenAstToExpression(binding.whenAst).replaceAll(" ", "");
    const target = {
      key: shortcutToKeybindingInput(binding.shortcut),
      command: binding.command,
      ...(when.length > 0 ? { when } : {}),
    };
    targetsByKey.set(`${target.key}\u0000${when}`, target);
  }
  const previousTargets = [...targetsByKey.values()];

  if (nextRule) {
    const replace = previousTargets.at(-1);
    return [
      ...previousTargets.slice(0, -1).map(
        (target): ProjectScriptKeybindingMutation => ({
          type: "remove",
          input: target,
        }),
      ),
      {
        type: "upsert",
        input: replace ? { ...nextRule, replace } : nextRule,
      },
    ];
  }
  return previousTargets.map((target) => ({ type: "remove", input: target }));
}

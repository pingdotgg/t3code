import {
  KeybindingRule as KeybindingRuleSchema,
  type KeybindingCommand,
  type KeybindingRule,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  shortcutToKeybindingInput,
  whenAstToExpression,
} from "../components/settings/KeybindingsSettings.logic";

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
    return shortcutToKeybindingInput(binding.shortcut);
  }
  return null;
}

type ProjectScriptKeybindingMutation =
  | { type: "upsert"; input: ServerUpsertKeybindingInput }
  | { type: "remove"; input: ServerRemoveKeybindingInput };

function keybindingTargetForResolvedRule(
  rule: ResolvedKeybindingRule,
): ServerRemoveKeybindingInput {
  const when = whenAstToExpression(rule.whenAst);
  return {
    key: shortcutToKeybindingInput(rule.shortcut),
    command: rule.command,
    ...(when.length > 0 ? { when } : {}),
  };
}

function isSameKeybindingTarget(
  left: ServerRemoveKeybindingInput,
  right: ServerRemoveKeybindingInput,
): boolean {
  return (
    left.key === right.key &&
    left.command === right.command &&
    (left.when ?? undefined) === (right.when ?? undefined)
  );
}

export function deriveProjectScriptKeybindingMutations(input: {
  keybindings: ResolvedKeybindingsConfig;
  keybinding: string | null | undefined;
  command: KeybindingCommand;
}): ReadonlyArray<ProjectScriptKeybindingMutation> {
  const nextRule = decodeProjectScriptKeybindingRule(input);
  const previousTargets: ServerRemoveKeybindingInput[] = [];
  for (const binding of input.keybindings) {
    if (binding.command !== input.command) continue;
    const target = keybindingTargetForResolvedRule(binding);
    if (!previousTargets.some((candidate) => isSameKeybindingTarget(candidate, target))) {
      previousTargets.push(target);
    }
  }

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

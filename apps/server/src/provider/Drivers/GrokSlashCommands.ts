/**
 * Grok slash-command mapping for the `/` provider command menu.
 *
 * Grok ACP advertises the live command list via `available_commands_update`
 * (shell builtins, user-invocable skills, workflows). We also fall back to
 * mapping enabled skills from `grok inspect` when ACP has not advertised yet.
 *
 * @module provider/Drivers/GrokSlashCommands
 */
import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

function nonEmptyTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function availableCommandHint(
  input: EffectAcpSchema.AvailableCommand["input"],
): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  if (!("hint" in input)) {
    return undefined;
  }
  const hint = (input as { readonly hint?: unknown }).hint;
  return typeof hint === "string" ? nonEmptyTrimmed(hint) : undefined;
}

/**
 * Map ACP `AvailableCommand` entries into the provider snapshot slash-command
 * shape, deduping by case-insensitive name (first wins, fills missing fields).
 */
export function parseGrokAvailableCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand> | null | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  if (!commands || commands.length === 0) {
    return [];
  }

  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyTrimmed(command.name);
    if (!name) {
      continue;
    }

    const description = nonEmptyTrimmed(command.description);
    const hint = availableCommandHint(command.input);
    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description ? {} : description ? { description } : {}),
      ...(existing.input?.hint ? {} : hint ? { input: { hint } } : {}),
    });
  }

  return [...commandsByName.values()];
}

/**
 * Fallback when ACP has not advertised commands: every enabled skill is also a
 * Grok slash command (`/skill-name`).
 */
export function slashCommandsFromGrokSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSlashCommand> {
  return skills
    .filter((skill) => skill.enabled)
    .map((skill) => {
      const description =
        nonEmptyTrimmed(skill.shortDescription) ?? nonEmptyTrimmed(skill.description);
      return {
        name: skill.name,
        ...(description ? { description } : {}),
      } satisfies ServerProviderSlashCommand;
    });
}

/**
 * Prefer the ACP-advertised list (builtins, workflows, namespaced skills) and
 * merge in any invocable inspect skills that ACP omitted (partial first
 * emission). If ACP advertised nothing, fall back to skills alone.
 */
export function resolveGrokSlashCommands(input: {
  readonly availableCommands: ReadonlyArray<EffectAcpSchema.AvailableCommand> | null | undefined;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}): ReadonlyArray<ServerProviderSlashCommand> {
  const fromAcp = parseGrokAvailableCommands(input.availableCommands);
  const fromSkills = slashCommandsFromGrokSkills(input.skills);
  if (fromAcp.length === 0) {
    return fromSkills;
  }
  if (fromSkills.length === 0) {
    return fromAcp;
  }

  const byName = new Map<string, ServerProviderSlashCommand>();
  for (const command of fromAcp) {
    byName.set(command.name.toLowerCase(), command);
  }
  for (const command of fromSkills) {
    const key = command.name.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, command);
    }
  }
  return [...byName.values()];
}

import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import { nonEmptyTrimmed } from "../providerSnapshot.ts";

/**
 * Map ACP `available_commands_update` entries into the provider slash-command
 * shape used by the T3 composer (same contract Claude fills from SDK init).
 */
export function parseAcpAvailableCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand> | null | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  const byName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands ?? []) {
    const name = nonEmptyTrimmed(command.name);
    if (!name) {
      continue;
    }

    const description = nonEmptyTrimmed(command.description);
    const hint =
      command.input && typeof command.input === "object" && "hint" in command.input
        ? nonEmptyTrimmed(command.input.hint)
        : undefined;

    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      });
      continue;
    }

    byName.set(key, {
      ...existing,
      ...(existing.description ? {} : description ? { description } : {}),
      ...(existing.input?.hint ? {} : hint ? { input: { hint } } : {}),
    });
  }

  return [...byName.values()];
}

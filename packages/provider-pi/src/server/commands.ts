import { type ServerProviderSkill, type ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

// Pi RPC get_commands omits TUI builtins. Advertise /compact so T3 can map it to RPC compact.
export const PI_COMPACT_SLASH_COMMAND: ServerProviderSlashCommand = {
  name: "compact",
  description: "Summarize the conversation and reduce context usage",
  input: { hint: "Optional instructions" },
};

export interface PiCompactCommand {
  readonly customInstructions?: string;
}

export function parsePiCompactCommand(text: string): PiCompactCommand | null {
  const trimmed = text.trim();
  if (trimmed === "/compact") return {};
  if (!trimmed.startsWith("/compact")) return null;
  const rest = trimmed.slice("/compact".length);
  if (rest.length === 0) return {};
  if (!/^\s/.test(rest)) return null;
  const customInstructions = rest.trim();
  return customInstructions.length === 0 ? {} : { customInstructions };
}

export function withPiBuiltinSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  return [PI_COMPACT_SLASH_COMMAND, ...commands.filter((command) => command.name !== "compact")];
}

export interface PiDiscoveredCommands {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

function normalizePiSkillScope(scope: string | undefined): string | undefined {
  if (scope === undefined) return undefined;
  const normalized = scope.trim().toLowerCase();
  if (normalized === "global" || normalized === "personal") return "user";
  if (normalized === "workspace" || normalized === "local") return "project";
  return scope;
}

/** Maps Pi's `get_commands` payload to T3's shared command and skill surfaces. */
export function parsePiDiscoveredCommands(data: unknown): PiDiscoveredCommands {
  const commands = recordField(data, "commands");
  if (!Array.isArray(commands)) return { slashCommands: [], skills: [] };
  const slashCommands: Array<ServerProviderSlashCommand> = [];
  const skills: Array<ServerProviderSkill> = [];
  for (const command of commands) {
    const commandName = recordString(command, "name");
    if (commandName === undefined || commandName.length === 0) continue;
    const description = recordString(command, "description");
    if (recordString(command, "source") === "skill") {
      const name = commandName.startsWith("skill:")
        ? commandName.slice("skill:".length)
        : commandName;
      if (name.length === 0) continue;
      const sourceInfo = recordField(command, "sourceInfo");
      const commandInterface = recordField(command, "interface");
      const path =
        recordString(sourceInfo, "path") ?? recordString(command, "path") ?? `pi:skill:${name}`;
      const scope = normalizePiSkillScope(
        recordString(sourceInfo, "scope") ?? recordString(command, "location"),
      );
      const displayName =
        recordString(command, "displayName") ??
        recordString(sourceInfo, "displayName") ??
        recordString(commandInterface, "displayName");
      const shortDescription =
        recordString(command, "shortDescription") ??
        recordString(sourceInfo, "shortDescription") ??
        recordString(commandInterface, "shortDescription");
      skills.push({
        name,
        path,
        enabled: true,
        ...(description === undefined ? {} : { description }),
        ...(scope === undefined ? {} : { scope }),
        ...(displayName === undefined ? {} : { displayName }),
        ...(shortDescription === undefined ? {} : { shortDescription }),
      });
      continue;
    }
    slashCommands.push({
      name: commandName,
      ...(description === undefined ? {} : { description }),
    });
  }
  return { slashCommands, skills };
}

function recordField(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? input[key] : undefined;
}

function recordString(input: unknown, key: string): string | undefined {
  const value = recordField(input, key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

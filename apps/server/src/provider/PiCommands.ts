import { type ServerProviderSkill, type ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

export interface PiDiscoveredCommands {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
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
      const sourceInfo = recordField(command, "sourceInfo");
      const path = recordString(sourceInfo, "path") ?? recordString(command, "path");
      if (name.length === 0 || path === undefined) continue;
      const scope = recordString(sourceInfo, "scope") ?? recordString(command, "location");
      skills.push({
        name,
        ...(description === undefined ? {} : { description }),
        path,
        ...(scope === undefined ? {} : { scope }),
        enabled: true,
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

/**
 * Pi expands skills only through a leading `/skill:name` command. T3 stores
 * skill chips as `$name`, so move the first known skill reference to that
 * native command position while preserving the rest of the user's prompt.
 */
export function expandPiSkillReference(text: string, skillNames: ReadonlySet<string>): string {
  const references = /(^|\s)\$([^\s]+)(?=\s|$)/g;
  for (const match of text.matchAll(references)) {
    const name = match[2];
    if (name === undefined || !skillNames.has(name) || match.index === undefined) continue;
    const tokenStart = match.index + (match[1]?.length ?? 0);
    const tokenEnd = tokenStart + name.length + 1;
    const prompt = [text.slice(0, tokenStart).trimEnd(), text.slice(tokenEnd).trimStart()]
      .filter((part) => part.length > 0)
      .join(" ");
    return prompt.length === 0 ? `/skill:${name}` : `/skill:${name} ${prompt}`;
  }
  return text;
}

function recordField(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? input[key] : undefined;
}

function recordString(input: unknown, key: string): string | undefined {
  const value = recordField(input, key);
  return typeof value === "string" ? value : undefined;
}

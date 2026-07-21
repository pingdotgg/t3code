import type {
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";

import { formatProviderSkillDisplayName } from "~/providerSkillPresentation";

export type ComposerSlashCommandLike = Pick<
  ServerProviderSlashCommand,
  "name" | "description" | "input"
> & {
  readonly displayName?: string;
  readonly provider?: ServerProvider["driver"];
  readonly sourceKind?: "custom" | "agents";
};

export type ComposerSlashCommandSource = {
  readonly providerInstanceId: ServerProvider["instanceId"];
  readonly provider: ServerProvider["driver"];
  readonly command: ComposerSlashCommandLike;
};

export type ComposerSlashCommandToken = {
  readonly type: "slash-command";
  readonly name: string;
  readonly source: string;
  readonly start: number;
  readonly end: number;
};

const SLASH_COMMAND_TOKEN_REGEX = /(^|\s)\/([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:._-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

const BUILT_IN_SLASH_COMMAND_NAMES = new Set(["model", "plan", "default"]);

export function formatComposerSlashCommandDisplayName(command: ComposerSlashCommandLike): string {
  const displayName = command.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(command.name);
}

export function formatComposerSlashCommandLabel(command: ComposerSlashCommandLike): string {
  const displayName = formatComposerSlashCommandDisplayName(command);
  return command.provider || !BUILT_IN_SLASH_COMMAND_NAMES.has(command.name.trim().toLowerCase())
    ? displayName
    : `/${displayName}`;
}

export function resolveComposerSlashCommandDescription(
  command: ComposerSlashCommandLike,
): string | null {
  const description = command.description?.trim();
  if (description) {
    return description;
  }
  const hint = command.input?.hint?.trim();
  return hint || null;
}

function toSkillSlashCommand(skill: ServerProviderSkill): ComposerSlashCommandLike {
  return {
    name: skill.name,
    description: skill.shortDescription?.trim() || skill.description?.trim() || undefined,
    displayName: formatProviderSkillDisplayName(skill),
  };
}

function isAgentsSkillPath(pathValue: string): boolean {
  return pathValue.replaceAll("\\", "/").includes("/.agents/");
}

export type ComposerCustomSlashCommand = {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
};

function slugifySlashCommandName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function formatComposerCustomSlashCommandName(title: string): string {
  return slugifySlashCommandName(title);
}

export function toComposerCustomSlashCommand(
  command: ComposerCustomSlashCommand,
): ComposerSlashCommandLike {
  return {
    name: formatComposerCustomSlashCommandName(command.title),
    description: command.prompt,
    displayName: command.title,
    sourceKind: "custom",
  };
}

function normalizeHiddenSlashCommandsByProvider(
  input?: Readonly<Record<string, ReadonlyArray<string>>> | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const hidden = new Map<string, ReadonlySet<string>>();
  if (!input) return hidden;

  for (const [providerInstanceId, commandNames] of Object.entries(input)) {
    const normalizedNames = commandNames
      .map((commandName) => commandName.trim().toLowerCase())
      .filter((commandName) => commandName.length > 0);
    if (normalizedNames.length > 0) {
      hidden.set(providerInstanceId, new Set(normalizedNames));
    }
  }

  return hidden;
}

function dedupeComposerSlashCommands(
  commands: ReadonlyArray<ComposerSlashCommandLike>,
): ComposerSlashCommandLike[] {
  const unique = new Map<string, ComposerSlashCommandLike>();
  for (const command of commands) {
    const normalizedName = command.name.trim().toLowerCase();
    if (!normalizedName || unique.has(normalizedName)) {
      continue;
    }
    unique.set(normalizedName, command);
  }
  return [...unique.values()];
}

export function collectComposerSlashCommandSources(
  providerSnapshots: ReadonlyArray<
    Pick<
      ServerProvider,
      "instanceId" | "driver" | "enabled" | "installed" | "slashCommands" | "skills"
    >
  >,
  options?: {
    readonly hiddenSlashCommandsByProvider?: Readonly<Record<string, ReadonlyArray<string>>>;
  },
): ComposerSlashCommandSource[] {
  const hiddenSlashCommandsByProvider = normalizeHiddenSlashCommandsByProvider(
    options?.hiddenSlashCommandsByProvider,
  );
  const sources: ComposerSlashCommandSource[] = [];

  for (const provider of providerSnapshots) {
    if (!provider.enabled || !provider.installed) {
      continue;
    }

    const hiddenNames = hiddenSlashCommandsByProvider.get(provider.instanceId);
    const seenCommandNames = new Set<string>();

    for (const skill of provider.skills) {
      const normalizedName = skill.name.trim().toLowerCase();
      if (!normalizedName || seenCommandNames.has(normalizedName)) {
        continue;
      }
      if (!isAgentsSkillPath(skill.path)) {
        continue;
      }
      seenCommandNames.add(normalizedName);
      if (hiddenNames?.has(normalizedName)) {
        continue;
      }

      sources.push({
        providerInstanceId: provider.instanceId,
        provider: provider.driver,
        command: {
          ...toSkillSlashCommand(skill),
          provider: provider.driver,
          sourceKind: "agents",
        },
      });
    }

    for (const command of provider.slashCommands) {
      const normalizedName = command.name.trim().toLowerCase();
      if (!normalizedName || seenCommandNames.has(normalizedName)) {
        continue;
      }
      seenCommandNames.add(normalizedName);
      if (hiddenNames?.has(normalizedName)) {
        continue;
      }

      sources.push({
        providerInstanceId: provider.instanceId,
        provider: provider.driver,
        command: {
          name: command.name,
          description: command.description?.trim() || command.input?.hint?.trim() || undefined,
          provider: provider.driver,
        },
      });
    }

    for (const skill of provider.skills) {
      const normalizedName = skill.name.trim().toLowerCase();
      if (!normalizedName || seenCommandNames.has(normalizedName)) {
        continue;
      }
      if (isAgentsSkillPath(skill.path)) {
        continue;
      }
      seenCommandNames.add(normalizedName);
      if (hiddenNames?.has(normalizedName)) {
        continue;
      }

      sources.push({
        providerInstanceId: provider.instanceId,
        provider: provider.driver,
        command: toSkillSlashCommand(skill),
      });
    }
  }

  return sources;
}

export function collectComposerSlashCommands(
  providerSnapshots: ReadonlyArray<
    Pick<
      ServerProvider,
      "instanceId" | "driver" | "enabled" | "installed" | "slashCommands" | "skills"
    >
  >,
  options?: {
    readonly hiddenSlashCommandsByProvider?: Readonly<Record<string, ReadonlyArray<string>>>;
    readonly customSlashCommands?: ReadonlyArray<ComposerCustomSlashCommand>;
  },
): ComposerSlashCommandLike[] {
  const commands: ComposerSlashCommandLike[] = [
    { name: "model", description: "Switch response model for this thread" },
    { name: "plan", description: "Switch this thread into plan mode" },
    { name: "default", description: "Switch this thread back to normal build mode" },
  ];

  for (const customCommand of options?.customSlashCommands ?? []) {
    const normalizedName = formatComposerCustomSlashCommandName(customCommand.title);
    if (!normalizedName) {
      continue;
    }
    commands.push(toComposerCustomSlashCommand(customCommand));
  }

  for (const source of collectComposerSlashCommandSources(providerSnapshots, options)) {
    commands.push({
      ...source.command,
      provider: source.provider,
    });
  }

  return dedupeComposerSlashCommands(commands);
}

function normalizeSlashCommandName(value: string): string {
  return value.trim().toLowerCase();
}

function buildHiddenSlashCommandSet(commands?: ReadonlyArray<string>): ReadonlySet<string> {
  return new Set(
    (commands ?? []).map(normalizeSlashCommandName).filter((value) => value.length > 0),
  );
}

export function filterComposerSlashCommandsForAutocomplete(
  commands: ReadonlyArray<ComposerSlashCommandLike>,
  options?: {
    readonly hiddenCustomSlashCommands?: ReadonlyArray<string>;
    readonly hiddenGlobalSlashCommands?: ReadonlyArray<string>;
  },
): ComposerSlashCommandLike[] {
  const hiddenCustomSlashCommands = buildHiddenSlashCommandSet(options?.hiddenCustomSlashCommands);
  const hiddenGlobalSlashCommands = buildHiddenSlashCommandSet(options?.hiddenGlobalSlashCommands);

  return commands.filter((command) => {
    const normalizedName = normalizeSlashCommandName(command.name);
    if (!normalizedName) {
      return false;
    }
    if (command.sourceKind === "custom" && hiddenCustomSlashCommands.has(normalizedName)) {
      return false;
    }
    if (command.sourceKind === "agents" && hiddenGlobalSlashCommands.has(normalizedName)) {
      return false;
    }
    return true;
  });
}

export function collectComposerSlashCommandTokens(
  text: string,
  slashCommands: ReadonlyArray<ComposerSlashCommandLike>,
): ReadonlyArray<ComposerSlashCommandToken> {
  if (!text || slashCommands.length === 0) {
    return [];
  }

  const commandNames = new Map<string, ComposerSlashCommandLike>(
    slashCommands.map((command) => [command.name.trim().toLowerCase(), command]),
  );
  const matches: ComposerSlashCommandToken[] = [];

  for (const match of text.matchAll(SLASH_COMMAND_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const name = match[2] ?? "";
    const normalizedName = name.trim().toLowerCase();
    if (!normalizedName || !commandNames.has(normalizedName)) {
      continue;
    }

    const start = (match.index ?? 0) + prefix.length;
    const end = start + name.length + 1;
    matches.push({
      type: "slash-command",
      name,
      source: text.slice(start, end),
      start,
      end,
    });
  }

  return matches;
}

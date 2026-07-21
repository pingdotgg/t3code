import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import {
  collectComposerSlashCommandSources,
  formatComposerCustomSlashCommandName,
  formatComposerSlashCommandLabel,
  toComposerCustomSlashCommand,
  resolveComposerSlashCommandDescription,
} from "~/lib/composerSlashCommands";

const BUILT_IN_SLASH_COMMAND_ITEMS = [
  {
    id: "slash:model",
    type: "slash-command",
    command: "model",
    label: "/model",
    description: "Switch response model for this thread",
  },
  {
    id: "slash:plan",
    type: "slash-command",
    command: "plan",
    label: "/plan",
    description: "Switch this thread into plan mode",
  },
  {
    id: "slash:default",
    type: "slash-command",
    command: "default",
    label: "/default",
    description: "Switch this thread back to normal build mode",
  },
] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;

function normalizeSlashCommandName(value: string): string {
  return value.trim().toLowerCase();
}

export function buildComposerSlashCommandItems(
  providerInstances: ReadonlyArray<ProviderInstanceEntry>,
  hiddenSlashCommandsByProvider?: Readonly<Record<string, ReadonlyArray<string>>>,
  customSlashCommands?: ReadonlyArray<{ id: string; title: string; prompt: string }>,
  hiddenCustomSlashCommands?: ReadonlyArray<string>,
  hiddenGlobalSlashCommands?: ReadonlyArray<string>,
): Array<
  Extract<
    ComposerCommandItem,
    { type: "slash-command" | "provider-slash-command" | "custom-slash-command" }
  >
> {
  const items: Array<
    Extract<
      ComposerCommandItem,
      { type: "slash-command" | "provider-slash-command" | "custom-slash-command" }
    >
  > = [...BUILT_IN_SLASH_COMMAND_ITEMS];
  const seenCommandNames = new Set(
    BUILT_IN_SLASH_COMMAND_ITEMS.map((item) => item.command.toLowerCase()),
  );
  const hiddenCustomCommandNames = new Set(
    (hiddenCustomSlashCommands ?? []).map(normalizeSlashCommandName).filter(Boolean),
  );
  const hiddenGlobalCommandNames = new Set(
    (hiddenGlobalSlashCommands ?? []).map(normalizeSlashCommandName).filter(Boolean),
  );

  for (const customSlashCommand of customSlashCommands ?? []) {
    const normalizedName = formatComposerCustomSlashCommandName(customSlashCommand.title);
    if (!normalizedName || seenCommandNames.has(normalizedName)) {
      continue;
    }
    if (hiddenCustomCommandNames.has(normalizedName)) {
      continue;
    }
    seenCommandNames.add(normalizedName);
    const command = toComposerCustomSlashCommand(customSlashCommand);
    items.push({
      id: `custom-slash-command:${customSlashCommand.id}`,
      type: "custom-slash-command",
      command,
      label: command.displayName ?? command.name,
      description: resolveComposerSlashCommandDescription(command) ?? "Custom T3 Code prompt",
    });
  }

  for (const source of collectComposerSlashCommandSources(
    providerInstances.map((entry) => entry.snapshot),
    hiddenSlashCommandsByProvider === undefined ? undefined : { hiddenSlashCommandsByProvider },
  )) {
    const normalizedName = source.command.name.trim().toLowerCase();
    if (!normalizedName || seenCommandNames.has(normalizedName)) {
      continue;
    }
    if (source.command.sourceKind === "agents" && hiddenGlobalCommandNames.has(normalizedName)) {
      continue;
    }

    seenCommandNames.add(normalizedName);
    items.push({
      id: `provider-slash-command:${source.providerInstanceId}:${source.command.name}`,
      type: "provider-slash-command",
      provider: source.provider,
      command: source.command,
      label: formatComposerSlashCommandLabel(source.command),
      description: resolveComposerSlashCommandDescription(source.command) ?? "Run provider command",
      ...(source.command.sourceKind === "agents" ? { sourceKind: "agents" as const } : {}),
    });
  }

  return items;
}

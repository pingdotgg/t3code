/**
 * Shared mapping from provider-native command/skill catalogs into the
 * ServerProvider fields the web/mobile `/` and `$` pickers read.
 *
 * ACP agents (Grok, Cursor, OpenCode-via-ACP) and the OpenCode SDK both land
 * here so slash/skill presentation stays consistent across providers.
 */
import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

export interface ProviderCommandCatalog {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export const EMPTY_PROVIDER_COMMAND_CATALOG: ProviderCommandCatalog = {
  slashCommands: [],
  skills: [],
};

export function providerCommandCatalogIsEmpty(catalog: ProviderCommandCatalog): boolean {
  return catalog.slashCommands.length === 0 && catalog.skills.length === 0;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function metaString(
  meta: { readonly [x: string]: unknown } | null | undefined,
  key: string,
): string | undefined {
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  return nonEmptyString(meta[key]);
}

function sortByName<T extends { readonly name: string }>(
  items: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return [...items].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Map ACP `availableCommands` (including skill entries with `_meta.path`)
 * into provider status fields.
 *
 * - every named command becomes a slash command (`/`)
 * - commands with a filesystem `_meta.path` also become skills (`$`)
 */
export function mapAcpAvailableCommandsToProviderCatalog(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand> | null | undefined,
): ProviderCommandCatalog {
  const slashByName = new Map<string, ServerProviderSlashCommand>();
  const skillsByName = new Map<string, ServerProviderSkill>();

  for (const command of commands ?? []) {
    const name = nonEmptyString(command.name);
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    const description = nonEmptyString(command.description);
    const hint = nonEmptyString(command.input?.hint);

    if (!slashByName.has(key)) {
      slashByName.set(key, {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      });
    }

    const path = metaString(command._meta, "path");
    if (!path || skillsByName.has(key)) {
      continue;
    }
    const scope = metaString(command._meta, "scope");
    skillsByName.set(key, {
      name,
      path,
      enabled: true,
      ...(description ? { description } : {}),
      ...(scope ? { scope } : {}),
    });
  }

  return {
    slashCommands: sortByName([...slashByName.values()]),
    skills: sortByName([...skillsByName.values()]),
  };
}

export interface OpenCodeSdkCommand {
  readonly name: string;
  readonly description?: string;
  readonly source?: "command" | "mcp" | "skill" | string;
  readonly hints?: ReadonlyArray<string>;
}

export interface OpenCodeSdkSkill {
  readonly name: string;
  readonly description?: string;
  /** Filesystem path, or a built-in sentinel such as `<built-in>`. */
  readonly location: string;
}

/**
 * Map OpenCode SDK `/command` + `/skill` responses into provider status fields.
 *
 * Slash commands come from the command list (includes skill-sourced entries).
 * Skills come from the dedicated skill list so `$` has stable paths.
 */
export function mapOpenCodeSdkCatalogToProviderCatalog(input: {
  readonly commands?: ReadonlyArray<OpenCodeSdkCommand> | null;
  readonly skills?: ReadonlyArray<OpenCodeSdkSkill> | null;
}): ProviderCommandCatalog {
  const slashByName = new Map<string, ServerProviderSlashCommand>();
  const skillsByName = new Map<string, ServerProviderSkill>();

  for (const command of input.commands ?? []) {
    const name = nonEmptyString(command.name);
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (slashByName.has(key)) {
      continue;
    }
    const description = nonEmptyString(command.description);
    const hint = nonEmptyString(command.hints?.[0]);
    slashByName.set(key, {
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }

  for (const skill of input.skills ?? []) {
    const name = nonEmptyString(skill.name);
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (skillsByName.has(key)) {
      continue;
    }
    const location = nonEmptyString(skill.location);
    // Built-ins use a sentinel location; keep them selectable via a stable URI.
    const path =
      location && location !== "<built-in>" && !location.startsWith("<")
        ? location
        : `opencode://skill/${name}`;
    const description = nonEmptyString(skill.description);
    const scope =
      location?.includes("/.config/opencode/") || location?.includes(".config/opencode/")
        ? "user"
        : location?.includes("/.opencode/") || location?.includes(".opencode/")
          ? "project"
          : location === "<built-in>" || location?.startsWith("<")
            ? "built-in"
            : undefined;
    skillsByName.set(key, {
      name,
      path,
      enabled: true,
      ...(description ? { description } : {}),
      ...(scope ? { scope } : {}),
    });
  }

  return {
    slashCommands: sortByName([...slashByName.values()]),
    skills: sortByName([...skillsByName.values()]),
  };
}

import type { ProviderSkillKey, ServerProviderSkill } from "@t3tools/contracts";
import {
  formatProviderSkillDisplayName,
  formatProviderSkillSourceLabel,
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";

/** Group order, broadest source first, so a long list reads the same every time. */
const SOURCE_ORDER: ReadonlyArray<ProviderSkillSourceKind> = [
  "project",
  "repo",
  "personal",
  "app",
  "system",
  "other",
];

export interface SkillsSettingsInputProvider {
  readonly id: string;
  readonly label: string;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export interface SkillsSettingsRow {
  readonly id: string;
  readonly key: ProviderSkillKey;
  readonly title: string;
  readonly description: string | undefined;
  readonly path: string;
  readonly disabled: boolean;
  /** The provider's own configuration switched it off, so the switch is locked. */
  readonly disabledByProvider: boolean;
}

export interface SkillsSettingsSourceGroup {
  readonly source: ProviderSkillSourceKind;
  readonly label: string;
  readonly rows: ReadonlyArray<SkillsSettingsRow>;
}

export interface SkillsSettingsProviderGroup {
  readonly id: string;
  readonly label: string;
  readonly sources: ReadonlyArray<SkillsSettingsSourceGroup>;
}

export interface SkillsSettingsStaleRow {
  readonly id: string;
  readonly key: ProviderSkillKey;
  readonly label: string;
}

export interface SkillsSettingsModel {
  readonly providers: ReadonlyArray<SkillsSettingsProviderGroup>;
  readonly stale: ReadonlyArray<SkillsSettingsStaleRow>;
  /** Rows exist but the query hid every one of them. */
  readonly hasHiddenRows: boolean;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function keyId(key: Pick<ProviderSkillKey, "source" | "name">): string {
  return `${key.source}:${normalizeName(key.name)}`;
}

function isSameProviderSkillKey(
  left: Pick<ProviderSkillKey, "source" | "name">,
  right: Pick<ProviderSkillKey, "source" | "name">,
): boolean {
  return left.source === right.source && normalizeName(left.name) === normalizeName(right.name);
}

/**
 * The list to store after a switch moves. Off adds the key, on removes every
 * entry that matches it, so a list that somehow holds a duplicate settles.
 */
export function toggleDisabledSkill(
  disabledSkills: ReadonlyArray<ProviderSkillKey>,
  key: ProviderSkillKey,
  disabled: boolean,
): ProviderSkillKey[] {
  const without = disabledSkills.filter((entry) => !isSameProviderSkillKey(entry, key));
  return disabled ? [...without, { source: key.source, name: key.name.trim() }] : without;
}

/**
 * The published skills carry the environment fold, so a skill the environment
 * list switched off arrives `enabled: false, disabledBy: "settings"`. A project
 * override replaces that list rather than adding to it, so peel the fold back
 * off before the project's own list decides. A provider's own no stays.
 */
export function unfoldSettingsDisabledSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSkill[] {
  return skills.map((skill) => {
    if (skill.disabledBy !== "settings") return skill;
    const { disabledBy: _folded, ...rest } = skill;
    return { ...rest, enabled: true };
  });
}

function matchesQuery(haystack: ReadonlyArray<string | undefined>, query: string): boolean {
  if (query.length === 0) return true;
  return haystack.some((value) => value !== undefined && value.toLowerCase().includes(query));
}

/**
 * The rows the Skills section renders: every discovered skill grouped by
 * provider then source, plus the stored keys nothing discovered matches.
 *
 * A row's switch reads `disabledSkills` rather than the published
 * `enabled` flag, so the control shows exactly the list it writes even before
 * the registry republishes its fold.
 */
export function buildSkillsSettingsModel(input: {
  readonly providers: ReadonlyArray<SkillsSettingsInputProvider>;
  readonly disabledSkills: ReadonlyArray<ProviderSkillKey>;
  readonly query?: string;
}): SkillsSettingsModel {
  const query = input.query?.trim().toLowerCase() ?? "";
  const disabledIds = new Set(input.disabledSkills.map(keyId));
  const discoveredIds = new Set<string>();
  let hasRows = false;

  const providers: SkillsSettingsProviderGroup[] = [];
  for (const provider of input.providers) {
    const rowsBySource = new Map<ProviderSkillSourceKind, SkillsSettingsRow[]>();
    const seen = new Set<string>();
    for (const skill of provider.skills) {
      const source = resolveProviderSkillSourceKind(skill);
      const id = keyId({ source, name: skill.name });
      discoveredIds.add(id);
      if (seen.has(id)) continue;
      seen.add(id);
      hasRows = true;
      const title = formatProviderSkillDisplayName(skill);
      const description = skill.shortDescription ?? skill.description;
      if (
        !matchesQuery(
          [
            title,
            skill.name,
            description,
            skill.path,
            formatProviderSkillSourceLabel(source),
            provider.label,
          ],
          query,
        )
      ) {
        continue;
      }
      const rows = rowsBySource.get(source) ?? [];
      rows.push({
        id: `${provider.id}:${id}`,
        key: { source, name: skill.name.trim() },
        title,
        description,
        path: skill.path,
        disabled: disabledIds.has(id) || !skill.enabled,
        disabledByProvider: !skill.enabled && skill.disabledBy === "provider",
      });
      rowsBySource.set(source, rows);
    }

    const sources: SkillsSettingsSourceGroup[] = [];
    for (const source of SOURCE_ORDER) {
      const rows = rowsBySource.get(source);
      if (!rows || rows.length === 0) continue;
      rows.sort((left, right) => left.title.localeCompare(right.title));
      sources.push({ source, label: formatProviderSkillSourceLabel(source), rows });
    }
    if (sources.length > 0) providers.push({ id: provider.id, label: provider.label, sources });
  }

  const staleSeen = new Set<string>();
  const stale: SkillsSettingsStaleRow[] = [];
  for (const key of input.disabledSkills) {
    const id = keyId(key);
    if (discoveredIds.has(id) || staleSeen.has(id)) continue;
    staleSeen.add(id);
    hasRows = true;
    const label = `${formatProviderSkillSourceLabel(key.source)} · ${key.name}`;
    if (!matchesQuery([key.name, label], query)) continue;
    stale.push({ id, key, label });
  }

  return {
    providers,
    stale,
    hasHiddenRows: hasRows && providers.length === 0 && stale.length === 0,
  };
}

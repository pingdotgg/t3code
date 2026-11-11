import {
  mergeAgentLibraries,
  type AgentContextRecord,
  type EnvironmentId,
  type McpGatewayProfile,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  agentReferenceState,
  type AgentReferenceState,
} from "@t3tools/shared/composerContextReferences";
import { Atom } from "effect/reactivity";
import {
  AGENT_ICON_CATEGORY_LABELS,
  AGENT_ICONS,
  isAgentIconId,
  legacyAgentIcon,
  type AgentIconEntry,
  type AgentIconId,
  type AgentLegacyIcon,
} from "@t3tools/shared/agentIcons";

export {
  AGENT_ICON_CATEGORY_LABELS,
  AGENT_ICON_IDS,
  AGENT_ICONS,
  isAgentIconId,
  type AgentIconCategory,
  type AgentIconId,
  type AgentLegacyIcon,
} from "@t3tools/shared/agentIcons";

/** The icon a client draws: `iconId` when this build knows it, else the legacy `icon`, else the orb. */
export function resolveAgentIconId(
  profile: Pick<McpGatewayProfile, "icon" | "iconId"> | null | undefined,
): AgentIconId {
  if (isAgentIconId(profile?.iconId)) return profile.iconId;
  if (isAgentIconId(profile?.icon)) return profile.icon;
  return "orb";
}

/** The pair a writer persists, so older builds that only read `icon` still draw something close. */
export function agentIconFields(iconId: AgentIconId): {
  readonly iconId: AgentIconId;
  readonly icon: AgentLegacyIcon;
} {
  return { iconId, icon: legacyAgentIcon(iconId) };
}

/** Icon fields to save: the picked icon, else the original's as stored, so an id from a newer build survives an edit here. */
export function agentIconFieldsToSave(
  original: Pick<McpGatewayProfile, "icon" | "iconId"> | null | undefined,
  picked: AgentIconId | null,
): Pick<McpGatewayProfile, "icon" | "iconId"> {
  if (picked) return agentIconFields(picked);
  if (original?.iconId) {
    return { iconId: original.iconId, icon: original.icon ?? legacyAgentIcon(original.iconId) };
  }
  return agentIconFields(resolveAgentIconId(original));
}

/** Whether an icon matches every word of a search, by id, label, category, or keyword. */
export function agentIconMatches(iconId: AgentIconId, query: string): boolean {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const entry: AgentIconEntry = AGENT_ICONS[iconId];
  const haystack = [
    iconId,
    entry.label,
    AGENT_ICON_CATEGORY_LABELS[entry.category],
    ...entry.keywords,
  ]
    .join(" ")
    .toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}

export const AGENT_ROLE_SUGGESTIONS = ["Dev", "Product", "Research", "Social", "Ops", "Art"];
export const AGENT_MAX_TAGS = 8;
export const AGENT_MAX_TAG_LENGTH = 32;

function tagKey(tag: string) {
  return tag.toLocaleLowerCase();
}

/** Trimmed, length-capped, case-insensitively unique tags; suggested roles keep their canonical casing. */
export function normalizeAgentTags(tags: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const trimmed = raw.replace(/\s+/g, " ").trim().slice(0, AGENT_MAX_TAG_LENGTH).trim();
    if (!trimmed) continue;
    const key = tagKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(AGENT_ROLE_SUGGESTIONS.find((role) => tagKey(role) === key) ?? trimmed);
    if (result.length === AGENT_MAX_TAGS) break;
  }
  return result;
}

/** The role chips a tag field shows: every suggestion, then every saved custom tag. */
export function agentTagOptions(tags: ReadonlyArray<string>): string[] {
  const suggested = new Set(AGENT_ROLE_SUGGESTIONS.map(tagKey));
  return [...AGENT_ROLE_SUGGESTIONS, ...tags.filter((tag) => !suggested.has(tagKey(tag)))];
}

export interface AgentRoleGroup<T> {
  /** Null for agents without a tag. */
  readonly tag: string | null;
  readonly label: string;
  readonly profiles: readonly T[];
}

/**
 * Agents under each of their tags, in the given order. An agent with two tags
 * appears under both; untagged agents land in a trailing "Other" group.
 * Suggested roles come first in their canonical order, then custom tags A–Z.
 */
export function groupAgentsByRole<T extends Pick<McpGatewayProfile, "tags">>(
  profiles: ReadonlyArray<T>,
): AgentRoleGroup<T>[] {
  const groups = new Map<string, { label: string; profiles: T[] }>();
  const other: T[] = [];
  for (const profile of profiles) {
    const tags = normalizeAgentTags(profile.tags ?? []);
    if (tags.length === 0) other.push(profile);
    for (const tag of tags) {
      const key = tagKey(tag);
      const group = groups.get(key);
      if (group) group.profiles.push(profile);
      else groups.set(key, { label: tag, profiles: [profile] });
    }
  }
  const rank = (key: string) => {
    const index = AGENT_ROLE_SUGGESTIONS.findIndex((role) => tagKey(role) === key);
    return index < 0 ? AGENT_ROLE_SUGGESTIONS.length : index;
  };
  const ordered: AgentRoleGroup<T>[] = [...groups]
    .sort(([a, left], [b, right]) => rank(a) - rank(b) || left.label.localeCompare(right.label))
    .map(([, group]) => ({ tag: group.label, label: group.label, profiles: group.profiles }));
  return other.length > 0 ? [...ordered, { tag: null, label: "Other", profiles: other }] : ordered;
}

/** Keeps the previous list when a config push leaves every agent as it was, so readers don't re-render. */
function shareAgentProfiles(
  previous: ReadonlyArray<McpGatewayProfile> | undefined,
  next: ReadonlyArray<McpGatewayProfile>,
): ReadonlyArray<McpGatewayProfile> {
  if (previous === undefined || previous.length !== next.length) return next;
  const same = previous.every(
    (profile, index) =>
      profile === next[index] || JSON.stringify(profile) === JSON.stringify(next[index]),
  );
  return same ? previous : next;
}

/**
 * The agents an `@` mention can name on one environment. Its server resolves mentions against
 * its own library only, and servers without `agentLibraryMutations` predate agent records and
 * drop them. `loading` until the environment's config arrives.
 */
export type EnvironmentAgents =
  | { readonly status: "loading" }
  | { readonly status: "unsupported" }
  | { readonly status: "ready"; readonly profiles: ReadonlyArray<McpGatewayProfile> };

const LOADING: EnvironmentAgents = { status: "loading" };
const UNSUPPORTED: EnvironmentAgents = { status: "unsupported" };

export function environmentAgents(
  config: Pick<ServerConfig, "environment" | "settings"> | null | undefined,
  previous?: EnvironmentAgents,
): EnvironmentAgents {
  if (!config) return LOADING;
  if (config.environment.capabilities.agentLibraryMutations !== true) return UNSUPPORTED;
  const before = previous?.status === "ready" ? previous.profiles : undefined;
  const profiles = shareAgentProfiles(before, config.settings.mcpGatewayProfiles);
  return previous?.status === "ready" && profiles === before
    ? previous
    : { status: "ready", profiles };
}

/** The mentionable profiles: none while loading or on a server that would drop agent records. */
export function mentionableAgentProfiles(
  agents: EnvironmentAgents,
): ReadonlyArray<McpGatewayProfile> {
  return agents.status === "ready" ? agents.profiles : [];
}

/** An agent chip on one environment; `unsupported` where its server would drop the record. */
export function agentChipState(
  record: Pick<AgentContextRecord, "profileId" | "name">,
  agents: EnvironmentAgents,
  environmentId: EnvironmentId | null | undefined,
): AgentReferenceState | { readonly status: "unsupported"; readonly name: string } {
  if (agents.status === "unsupported") return { status: "unsupported", name: record.name };
  return agentReferenceState(
    record,
    agents.status === "ready" ? agents.profiles : undefined,
    environmentId ?? undefined,
  );
}

export function createEnvironmentAgentsAtom(
  configValueAtom: (environmentId: EnvironmentId | null) => Atom.Atom<ServerConfig | null>,
) {
  return Atom.family((environmentId: EnvironmentId | null) => {
    let previous: EnvironmentAgents | undefined;
    return Atom.make(
      (get) => (previous = environmentAgents(get(configValueAtom(environmentId)), previous)),
    ).pipe(Atom.withLabel("environment-agents"));
  });
}

/**
 * Every known environment's agents merged, as the Agents board shows them. Atoms are passed
 * as thunks, read on first evaluation, so app modules can build this at import time.
 */
export function createAgentProfilesAtom(
  serverConfigsAtom: () => Atom.Atom<ReadonlyMap<EnvironmentId, Pick<ServerConfig, "settings">>>,
) {
  let previous: ReadonlyArray<McpGatewayProfile> | undefined;
  return Atom.make(
    (get) =>
      (previous = shareAgentProfiles(
        previous,
        mergeAgentLibraries([...get(serverConfigsAtom()).values()].map((config) => config.settings))
          .mcpGatewayProfiles,
      )),
  ).pipe(Atom.keepAlive, Atom.withLabel("agent-profiles"));
}

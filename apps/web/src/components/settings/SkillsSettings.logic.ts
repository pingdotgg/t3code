import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  SkillAgentAccess,
  SkillListResult,
  SkillScope,
  SkillSummary,
} from "@t3tools/contracts";

import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";

/** An enabled provider instance, named and drawn the way the rest of the app does. */
export type SkillAgent = Pick<
  ProviderInstanceEntry,
  "instanceId" | "driverKind" | "displayName" | "accentColor"
>;

const joinNames = (names: readonly string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

export type Skill = SkillSummary & {
  /** Stable across reads, so an open skill survives a refresh. */
  readonly id: string;
};

export type SkillsContext = {
  /** Provider instances that are installed, enabled and known to the server's folder table. */
  readonly installed: readonly SkillAgent[];
};

/**
 * The environment the page reads skills from. The settings scope names it, connected or not: an
 * offline environment is reported as offline, never swapped for another one, whose skills would
 * be shown as the project's and which would be sent the project's folder. Only a scope that names
 * no environment falls back to the primary one, then the first.
 */
export function skillsEnvironment<T extends { readonly environmentId: EnvironmentId }>(input: {
  /** The scope's connected environment, when it has one. */
  readonly connected: T | null;
  readonly scopeEnvironmentIds: readonly EnvironmentId[];
  readonly environments: readonly T[];
  readonly primaryId: EnvironmentId | null;
}): T | undefined {
  if (input.connected) return input.connected;
  if (input.scopeEnvironmentIds.length > 0) {
    return input.environments.find((item) =>
      input.scopeEnvironmentIds.includes(item.environmentId),
    );
  }
  return (
    input.environments.find((item) => item.environmentId === input.primaryId) ??
    input.environments[0]
  );
}

export function ingestSkills(result: SkillListResult) {
  const skills = result.skills.map((entry): Skill => ({
    ...entry,
    id: `${entry.scope}\0${entry.name}\0${entry.home}`,
  }));
  const known = new Set(skills.flatMap((skill) => skill.access.map((access) => access.instanceId)));
  return { skills, unreadable: result.unreadable, known };
}

export function installedAgents(
  providers: readonly ServerProvider[],
  known: ReadonlySet<ProviderInstanceId>,
): SkillAgent[] {
  return deriveProviderInstanceEntries(providers)
    .filter(
      (entry) =>
        known.has(entry.instanceId) && entry.installed && entry.enabled && entry.isAvailable,
    )
    .map(({ instanceId, driverKind, displayName, accentColor }) => ({
      instanceId,
      driverKind,
      displayName,
      accentColor,
    }));
}

// -- Access -----------------------------------------------------------------------------------

export const accessOf = (
  skill: Skill,
  agent: Pick<SkillAgent, "instanceId">,
): SkillAgentAccess | undefined =>
  skill.access.find((access) => access.instanceId === agent.instanceId);

const hasAccess = (skill: Skill, agent: SkillAgent) => {
  const state = accessOf(skill, agent)?.state;
  return state === "direct" || state === "link";
};

/** Where the agent reads the skill from, or the folder it looks in when it can't see it. */
export const agentSkillPath = (skill: Skill, agent: SkillAgent) => {
  const access = accessOf(skill, agent);
  if (!access) return null;
  return hasAccess(skill, agent) ? `${access.folder}/${skill.name}` : access.folder;
};

/** Installed agents that don't load this copy of the skill. */
const missingAgents = (skill: Skill, ctx: SkillsContext) =>
  ctx.installed.filter((agent) => !hasAccess(skill, agent));

// -- Attention --------------------------------------------------------------------------------

type Attention = {
  /** A conflict gets a badge on its row; the others only show in the list filter and the skill. */
  kind: "conflict" | "header" | "missing";
  detail: string;
};

const scopeName = (scope: SkillScope) => (scope === "global" ? "Global" : "This project");

/** One plain sentence on what is wrong, or null for a healthy skill. */
export function attention(skill: Skill, ctx: SkillsContext): Attention | null {
  const other = skill.copies.find((copy) => !copy.same);
  if (other) {
    const detail =
      other.scope !== skill.scope
        ? `${scopeName(other.scope)} has a different “${skill.name}”.`
        : skill.scope === "global"
          ? `Another global “${skill.name}” is different.`
          : `Another “${skill.name}” in this project is different.`;
    return { kind: "conflict", detail };
  }
  const claude = ctx.installed.filter((agent) => agent.driverKind === "claudeAgent");
  if (skill.invalidHeader && claude.length > 0) {
    return {
      kind: "header",
      detail: `${joinNames(claude.map((agent) => agent.displayName))} can't read this skill's header.`,
    };
  }
  const missing = missingAgents(skill, ctx);
  return missing.length === 0
    ? null
    : {
        kind: "missing",
        detail: `Not available to ${joinNames(missing.map((agent) => agent.displayName))}`,
      };
}

/** Who can use a skill, among the installed agents. */
type Availability = {
  /** Every installed agent can use it. */
  everyone: boolean;
  agents: SkillAgent[];
  /** Installed agents that can't. */
  missing: SkillAgent[];
};

export function availability(skill: Skill, ctx: SkillsContext): Availability {
  const missing = missingAgents(skill, ctx);
  return {
    everyone: ctx.installed.length > 0 && missing.length === 0,
    agents: ctx.installed.filter((agent) => hasAccess(skill, agent)),
    missing,
  };
}

/** The tooltip on a row's agent icons. */
export const availabilityNote = (value: Availability) =>
  value.everyone
    ? "Available to all your agents"
    : `Not available to ${joinNames(value.missing.map((agent) => agent.displayName))}`;

/** One short line on the folders the server couldn't read, which would otherwise look empty. */
export function unreadableNote(folders: SkillListResult["unreadable"]) {
  const [first, second, ...rest] = folders.map((item) => item.folder);
  if (first === undefined) return "";
  if (second === undefined) return `Couldn't read ${first}`;
  return rest.length === 0
    ? `Couldn't read ${first} and ${second}`
    : `Couldn't read ${first}, ${second} and ${rest.length} more`;
}

// -- Search -----------------------------------------------------------------------------------

export const matchesQuery = (skill: Skill, needle: string) =>
  `${skill.name} ${skill.description}`.toLowerCase().includes(needle);

/** Files an agent could run, shown as a warning in the skill view. */
const SCRIPT_FILE = /\.(?:sh|mjs|ts|py)$/;
export function scriptFiles(files: ReadonlyArray<{ path: string; executable: boolean }>) {
  return files
    .filter(
      (file) =>
        file.path !== "SKILL.md" &&
        (file.path.startsWith("bin/") || SCRIPT_FILE.test(file.path) || file.executable),
    )
    .map((file) => file.path);
}

// -- Files and SKILL.md -----------------------------------------------------------------------

/** Sort entry as the file tree hands it over. */
type FileSortEntry = { path: string; isDirectory: boolean; segments: readonly string[] };

/** The tree's usual order (folders first, then names), with the root SKILL.md pinned on top. */
export function compareSkillFiles(left: FileSortEntry, right: FileSortEntry) {
  const pinned = Number(right.path === "SKILL.md") - Number(left.path === "SKILL.md");
  if (pinned !== 0) return pinned;
  const shared = Math.min(left.segments.length, right.segments.length);
  for (let depth = 0; depth < shared; depth += 1) {
    const a = left.segments[depth]!;
    const b = right.segments[depth]!;
    if (a === b) continue;
    const aFolder = depth < left.segments.length - 1 || left.isDirectory;
    const bFolder = depth < right.segments.length - 1 || right.isDirectory;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return (
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }) || (a < b ? -1 : 1)
    );
  }
  return left.segments.length - right.segments.length;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const BLANK_LINES = /^(?:[ \t]*\r?\n)*/;

/** The instructions after the frontmatter, without the blank line that separates them. */
export function skillBody(contents: string) {
  const match = FRONTMATTER.exec(contents);
  const rest = match ? contents.slice(match[0].length) : contents;
  return rest.slice(BLANK_LINES.exec(rest)![0].length);
}

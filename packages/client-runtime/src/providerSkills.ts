import type {
  ProviderSkillSourceKind,
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";

// The classifier and the disabled-skill fold live in `@t3tools/shared` so the
// server shares one implementation; re-exported for the clients already here.
export { resolveProviderSkillSourceKind } from "@t3tools/shared/providerSkills";
export type { ProviderSkillSourceKind };

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

export function dedupeProviderSkillsByName(
  skills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSkill[] {
  const seenNames = new Set<string>();
  return skills.filter((skill) => {
    const normalizedName = skill.name.trim().toLowerCase();
    if (seenNames.has(normalizedName)) {
      return false;
    }
    seenNames.add(normalizedName);
    return true;
  });
}

/**
 * Whether a composer pick can start this skill. A skill switched off in the
 * provider's settings will not run, and one the provider reserves for the
 * agent (Claude Code's `user-invocable: false`) rejects a user invocation.
 * Everything else, including skills the agent may not start on its own, is
 * fair game: the server dispatches the pick in the provider's native form.
 */
export function isProviderSkillUserInvocable(
  skill: Pick<ServerProviderSkill, "enabled" | "userInvocable">,
): boolean {
  return skill.enabled && skill.userInvocable !== false;
}

const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
const visibleSkillsByList = new WeakMap<
  ReadonlyArray<ServerProviderSkill>,
  ReadonlyArray<ServerProviderSkill>
>();

/**
 * The rows every picker starts from: the skills a user can pick, deduped by
 * name. A skill switched off in T3 Code's settings arrives here already
 * `enabled: false` from the shared fold, so it drops out with the ones the
 * provider itself switched off.
 *
 * Memoised on the list the server published, so a settings change that leaves
 * the skills alone hands the composer the same array back and repaints no row.
 */
export function getVisibleProviderSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSkill> {
  const cached = visibleSkillsByList.get(skills);
  if (cached) return cached;
  const visible = dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable));
  visibleSkillsByList.set(skills, visible);
  return visible;
}

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ReadonlyArray<ServerProviderSkill> {
  return showSkillsInSlashMenu ? getVisibleProviderSkills(skills) : NO_SKILLS;
}

const SKILL_SOURCE_LABEL_BY_KIND: Record<ProviderSkillSourceKind, string> = {
  app: "App",
  repo: "Repo",
  project: "Project",
  personal: "Personal",
  system: "System",
  other: "Other",
};

/**
 * The short source label a picker row carries, so a Personal `review` and a
 * Project `review` are tellable apart. One map for every client.
 */
export function formatProviderSkillSourceLabel(kind: ProviderSkillSourceKind): string {
  return SKILL_SOURCE_LABEL_BY_KIND[kind];
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

function resolveProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string | null | undefined,
) {
  if (!cwd) return undefined;
  return provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
}

export function resolveProviderSkillsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["skills"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.skills ?? provider.skills;
}

export function resolveProviderSlashCommandsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["slashCommands"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.slashCommands ?? provider.slashCommands;
}

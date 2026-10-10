import {
  isProviderWorkspaceSnapshotCurrent,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { formatLinkedSkillMention } from "@t3tools/shared/composerInlineTokens";

export type ProviderSkillSourceKind = "app" | "repo" | "project" | "personal" | "system" | "other";

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

/**
 * One menu row per SKILL.md. Same-name skills from different files stay
 * separate rows: they are different skills, and a pick binds its own file.
 */
export function dedupeProviderSkillsByPath(
  skills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSkill[] {
  const seenPaths = new Set<string>();
  return skills.filter((skill) => {
    const normalizedPath = normalizePathSeparators(skill.path);
    if (seenPaths.has(normalizedPath)) {
      return false;
    }
    seenPaths.add(normalizedPath);
    return true;
  });
}

/** Whether another pickable skill has this exact name, so `$name` alone is ambiguous. */
function isProviderSkillNameShared(
  skill: Pick<ServerProviderSkill, "name" | "path">,
  skills: ReadonlyArray<ServerProviderSkill>,
): boolean {
  return skills.some(
    (other) =>
      other.name === skill.name &&
      normalizePathSeparators(other.path) !== normalizePathSeparators(skill.path) &&
      isProviderSkillUserInvocable(other),
  );
}

/**
 * The composer text for a skill pick: `$name`, or a mention linked to the
 * picked SKILL.md when another skill shares the name. The server checks the
 * link and has every provider run that file (orchestration-v2/linkedSkillMentions.ts).
 * `null` when the name is shared but the skill has no SKILL.md to link:
 * `$name` could run a different skill, so the pick inserts nothing.
 */
export function formatProviderSkillMention(
  skill: Pick<ServerProviderSkill, "name" | "path">,
  skills: ReadonlyArray<ServerProviderSkill>,
): string | null {
  if (!isProviderSkillNameShared(skill, skills)) return `$${skill.name}`;
  return formatLinkedSkillMention(skill) ?? null;
}

/**
 * Menu description, led by the file path when the name alone cannot tell rows
 * apart, and saying so when such a row cannot be picked.
 */
export function formatProviderSkillMenuDescription(
  skill: ServerProviderSkill,
  skills: ReadonlyArray<ServerProviderSkill>,
  fallback = "",
): string {
  const description = skill.shortDescription ?? skill.description ?? fallback;
  if (!isProviderSkillNameShared(skill, skills)) {
    return description;
  }
  if (formatLinkedSkillMention(skill) === undefined) {
    return `${skill.path} · Can't be picked: another skill shares its name and this one has no SKILL.md to link`;
  }
  return description ? `${skill.path} · ${description}` : skill.path;
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

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ServerProviderSkill[] {
  return showSkillsInSlashMenu
    ? dedupeProviderSkillsByPath(skills.filter(isProviderSkillUserInvocable))
    : [];
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

export function resolveProviderSkillSourceKind(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): ProviderSkillSourceKind {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "app";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  switch (normalizedScope) {
    case "repo":
    case "repository":
      return "repo";
    case "project":
    case "workspace":
    case "local":
      return "project";
    case "user":
    case "personal":
      return "personal";
    case "system":
      return "system";
    case undefined:
    case "":
      return "other";
    default:
      return "other";
  }
}

function resolveProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string | null | undefined,
) {
  if (!cwd) return undefined;
  return provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
}

export function hasCompleteProviderWorkspaceSnapshot(
  provider: ServerProvider | null | undefined,
  cwd: string | null | undefined,
): boolean {
  const snapshot = provider && resolveProviderWorkspaceSnapshot(provider, cwd);
  return Boolean(snapshot && !snapshot.slashCommandsPending);
}

/** A complete snapshot young enough that opening a composer need not rescan. */
export function hasCurrentProviderWorkspaceSnapshot(
  provider: ServerProvider | null | undefined,
  cwd: string | null | undefined,
  nowMs: number,
): boolean {
  const snapshot = provider && resolveProviderWorkspaceSnapshot(provider, cwd);
  return Boolean(
    snapshot &&
    !snapshot.slashCommandsPending &&
    isProviderWorkspaceSnapshotCurrent(snapshot, nowMs),
  );
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

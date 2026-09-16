import type {
  ProviderSkillKey,
  ProviderSkillSourceKind,
  ServerProviderSkill,
} from "@t3tools/contracts";

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

/**
 * The one classifier. Both the badge a picker renders and the key a disable is
 * stored under come from here, so they cannot disagree.
 */
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

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Fold the user's disabled skills into a provider's discovered list. The one
 * place that decides whether a skill is off: the pickers and the send path both
 * call this rather than re-deriving the rule.
 *
 * `disabledSkills` is the effective list for wherever the caller stands, which
 * for a thread means the one `resolveProjectSettings` already resolved for its
 * project. Keys that match nothing discovered are ignored rather than pruned —
 * a skill missing from this worktree stays off when it comes back.
 */
export function resolveEffectiveSkills(input: {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly disabledSkills: ReadonlyArray<ProviderSkillKey>;
}): ServerProviderSkill[] {
  const disabledNamesBySource = new Map<ProviderSkillSourceKind, Set<string>>();
  for (const key of input.disabledSkills) {
    let names = disabledNamesBySource.get(key.source);
    if (!names) {
      names = new Set();
      disabledNamesBySource.set(key.source, names);
    }
    names.add(normalizeSkillName(key.name));
  }

  return input.skills.map((skill) => {
    // The provider's own no wins: T3 Code never writes provider configuration,
    // so it cannot switch such a skill back on and must not claim the disable.
    if (!skill.enabled) {
      return skill.disabledBy ? skill : { ...skill, disabledBy: "provider" as const };
    }
    const names = disabledNamesBySource.get(resolveProviderSkillSourceKind(skill));
    if (!names?.has(normalizeSkillName(skill.name))) {
      return skill;
    }
    return { ...skill, enabled: false, disabledBy: "settings" as const };
  });
}

import type { ServerProviderSkill } from "@t3tools/contracts";

export interface CachedComposerProviderSkills {
  readonly targetKey: string;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

const EMPTY_PROVIDER_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

export function getComposerProviderSkillsCacheEntry(input: {
  readonly targetKey: string;
  readonly discoveredSkills: ReadonlyArray<ServerProviderSkill> | null;
  readonly snapshotSkills: ReadonlyArray<ServerProviderSkill> | undefined;
  readonly discoveryUnsupported: boolean;
}): CachedComposerProviderSkills | null {
  if (input.discoveredSkills !== null) {
    return { targetKey: input.targetKey, skills: input.discoveredSkills };
  }
  if (input.discoveryUnsupported) {
    return {
      targetKey: input.targetKey,
      skills: input.snapshotSkills ?? EMPTY_PROVIDER_SKILLS,
    };
  }
  return null;
}

export function resolveComposerProviderSkills(input: {
  readonly targetKey: string;
  readonly discoveredSkills: ReadonlyArray<ServerProviderSkill> | null;
  readonly cachedSkills: CachedComposerProviderSkills | null;
  readonly snapshotSkills: ReadonlyArray<ServerProviderSkill> | undefined;
  readonly discoveryUnsupported: boolean;
}): ReadonlyArray<ServerProviderSkill> {
  if (input.discoveredSkills !== null) {
    return input.discoveredSkills;
  }

  if (input.cachedSkills?.targetKey === input.targetKey) {
    return input.cachedSkills.skills;
  }

  // Provider snapshots are not cwd-aware. They are therefore only a safe
  // fallback when the selected provider cannot perform project discovery at
  // all; while a cwd-aware request is pending they may belong to another
  // project or worktree.
  if (input.discoveryUnsupported) {
    return input.snapshotSkills ?? EMPTY_PROVIDER_SKILLS;
  }

  return EMPTY_PROVIDER_SKILLS;
}

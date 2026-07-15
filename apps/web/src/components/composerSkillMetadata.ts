export type ComposerSkillMetadata = {
  label: string;
  description: string | null;
};

export function resolveComposerSkillMetadata(
  skillName: string,
  skillMetadata: ReadonlyMap<string, ComposerSkillMetadata>,
): ComposerSkillMetadata {
  return skillMetadata.get(skillName) ?? { label: skillName, description: null };
}

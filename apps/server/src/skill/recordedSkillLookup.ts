export type RecordedSkillReference = {
  readonly name: string;
  readonly path: string;
};

export type RecordedSkillLookup =
  | { readonly kind: "legacy" }
  | { readonly kind: "recorded"; readonly skill: RecordedSkillReference | undefined };

// New messages persist `resolvedSkills`, including `[]`, so later provider
// changes cannot make an unresolved `$skill` readable. Legacy messages omit
// the field and still live-resolve against the current provider.
export function lookupRecordedSkill(
  resolvedSkills: ReadonlyArray<RecordedSkillReference> | undefined,
  skillName: string,
): RecordedSkillLookup {
  if (resolvedSkills === undefined) {
    return { kind: "legacy" };
  }
  return {
    kind: "recorded",
    skill: resolvedSkills.find((candidate) => candidate.name === skillName),
  };
}

export function projectGroupTitleNeedsUpdate(
  _memberTitles: ReadonlyArray<string>,
  _nextTitle: string,
  wasEdited: boolean,
): boolean {
  // The settings field shows the derived group label, so an explicit edit is
  // always a rename the user expects to stick — even when every member title
  // already equals the next title (e.g. stripping "group/subgroup/" down to
  // "repo"). Untouched blurs still skip the fan-out via wasEdited.
  return wasEdited;
}

export function projectGroupTitleNeedsUpdate(
  memberTitles: ReadonlyArray<string>,
  nextTitle: string,
): boolean {
  return memberTitles.some((title) => title !== nextTitle);
}

export function projectGroupTitleNeedsUpdate(
  memberTitles: ReadonlyArray<string>,
  nextTitle: string,
  wasEdited: boolean,
): boolean {
  return wasEdited && memberTitles.some((title) => title !== nextTitle);
}

export function checkoutKey(member: { environmentId: string; id: string }): string {
  return JSON.stringify([member.environmentId, member.id]);
}

/** Follow a checkout even when relinking moves it out of a still-existing group. */
export function resolveSettingsProjectGroup<
  T extends {
    projectKey: string;
    memberProjects: ReadonlyArray<{ environmentId: string; id: string }>;
  },
>(groups: ReadonlyArray<T>, projectKey: string, checkout?: string): T | null {
  return (
    (checkout
      ? groups.find((group) =>
          group.memberProjects.some((member) => checkoutKey(member) === checkout),
        )
      : undefined) ??
    groups.find((group) => group.projectKey === projectKey) ??
    null
  );
}

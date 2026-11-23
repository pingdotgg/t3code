const CODING_SETTINGS: ReadonlySet<string> = new Set([
  "/settings/diffs",
  "/settings/snap-shot",
  "/settings/browser",
  "/settings/devices",
  "/settings/projects",
  "/settings/source-control",
  "/settings/worktrees",
  "/settings/labs",
]);

export const chatModeSettingsGroups = <Group extends { readonly paths: ReadonlyArray<string> }>(
  groups: ReadonlyArray<Group>,
): ReadonlyArray<Group> =>
  groups
    .map((group) => ({
      ...group,
      paths: group.paths.filter((path) => !CODING_SETTINGS.has(path)),
    }))
    .filter((group) => group.paths.length > 0);

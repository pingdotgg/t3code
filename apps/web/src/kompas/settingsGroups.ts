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

const CODING_PAGES: ReadonlySet<string> = new Set(["/pull-requests", "/issues", "/workflows"]);

export const isCodingSettingsPage = (path: string) => CODING_SETTINGS.has(path);

/** Where chat mode sends a link to a page it hides; null for every other page. */
export const chatModeRedirect = (pathname: string): "/" | "/settings/general" | null =>
  isCodingSettingsPage(pathname) ? "/settings/general" : CODING_PAGES.has(pathname) ? "/" : null;

export const chatModeSettingsGroups = <Group extends { readonly paths: ReadonlyArray<string> }>(
  groups: ReadonlyArray<Group>,
): ReadonlyArray<Group> =>
  groups
    .map((group) => ({
      ...group,
      paths: group.paths.filter((path) => !isCodingSettingsPage(path)),
    }))
    .filter((group) => group.paths.length > 0);

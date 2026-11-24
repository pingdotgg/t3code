// Mirrors the server's set in apps/server/src/vcs/VcsProcess.ts, which shared cannot import.
const REPOSITORY_SELECTORS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
]);

/**
 * `git bisect run`, `git rebase --exec` and hooks export GIT_DIR (hooks also GIT_INDEX_FILE) to what
 * they run, so a fixture's git commands would work on that repository instead of the one in their
 * cwd. Spread the result into a child's env to unset them under the spelling they were inherited as.
 */
export const unsetInheritedGitRepositoryEnv = (
  inherited: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Record<string, undefined> =>
  Object.fromEntries(
    Object.keys(inherited)
      .filter((name) => REPOSITORY_SELECTORS.has(platform === "win32" ? name.toUpperCase() : name))
      .map((name) => [name, undefined]),
  );

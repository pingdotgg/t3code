const REPOSITORY_SELECTORS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
]);

/**
 * Unsets repository selectors the caller inherited, such as a Git hook's `GIT_DIR`, so Git finds
 * the repository from cwd. Spread it before a command's own env, which may still set them.
 */
export const unsetInheritedRepositoryEnv = (
  inherited: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.keys(inherited)
      .filter((name) => REPOSITORY_SELECTORS.has(platform === "win32" ? name.toUpperCase() : name))
      .map((name) => [name, undefined]),
  );

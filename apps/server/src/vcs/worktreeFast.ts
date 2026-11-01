/** Searches the desktop app's bundled git-worktree-fast after PATH, so one the user installed wins. */
export const worktreeFastEnv = (input: {
  readonly bundledPath: string | undefined;
  readonly pathEnv: string | undefined;
  readonly dirname: (path: string) => string;
}): NodeJS.ProcessEnv => {
  if (input.bundledPath === undefined) return {};
  const bundledDirectory = input.dirname(input.bundledPath);
  // Only macOS uses git-worktree-fast, so the separator is always ":".
  return { PATH: input.pathEnv ? `${input.pathEnv}:${bundledDirectory}` : bundledDirectory };
};

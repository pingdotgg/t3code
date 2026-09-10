/** Checkpoints belong to the project even when a nested repository is the default. */
export function resolveNestedDiffRepositoryPath(input: {
  isTurnSelected: boolean;
  repositoryPath: string | undefined;
}): string | null {
  return input.isTurnSelected || input.repositoryPath === "."
    ? null
    : (input.repositoryPath ?? null);
}

/**
 * Explains that a repository configured for this project could not be located,
 * or `null` when there is nothing to explain.
 *
 * Refusing to guess a location leaves the panel without a diff to show, and an
 * unexplained empty panel looks like a bug rather than a configuration problem.
 * Turn diffs come from checkpoints and cover the whole project, so they render
 * either way and say nothing about the repository.
 */
export function resolveUnresolvableRepositoryMessage(input: {
  isTurnSelected: boolean;
  hasUnresolvableRepository: boolean;
  repositoryPath: string | null;
}): string | null {
  if (input.isTurnSelected || !input.hasUnresolvableRepository || input.repositoryPath === null) {
    return null;
  }
  return `The repository "${input.repositoryPath}" could not be found inside the project folder. Check the repositories entry in t3.json.`;
}

/** Marker of the server-side rejection the environment-cwd retry exists for. */
const WORKSPACE_ROOT_ERROR_MARKER = "configured workspace root";

/**
 * Whether a failed branch diff preview may be retried at the environment's own
 * working directory.
 *
 * The retry covers a project whose root the server refuses because it sits
 * outside the configured workspace root. It must not run for an explicitly
 * selected nested repository: the retry reads a different repository, so the
 * panel would show that repository's diff under the selected repository's label
 * while file clicks are still re-based onto the selected repository's root.
 * Suppressing it surfaces the server's rejection instead.
 */
export function shouldRetryDiffPreviewAtEnvironmentCwd(input: {
  isTurnSelected: boolean;
  nestedRepositoryPath: string | null;
  previewError: string | null;
  environmentCwd: string | undefined;
  activeGitCwd: string | undefined;
}): boolean {
  return (
    !input.isTurnSelected &&
    input.nestedRepositoryPath === null &&
    input.previewError?.includes(WORKSPACE_ROOT_ERROR_MARKER) === true &&
    input.environmentCwd !== undefined &&
    input.environmentCwd !== input.activeGitCwd
  );
}

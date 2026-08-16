/**
 * Pure choice of Claude Code's on-disk transcript directory.
 *
 * Used by `UsageService` so a missing default `~/.claude/projects` is reported
 * as missing instead of walking the user's `~/projects` tree.
 *
 * @module usageClaudeTranscriptDir
 */

export function isClaudeHomeExplicitOverride(configuredHomePath: string): boolean {
  return configuredHomePath.trim().length > 0;
}

/**
 * Default installs nest transcripts under `<home>/.claude/projects`. A custom
 * CLAUDE_CONFIG_DIR uses `<home>/projects` only when that nested path is
 * absent. The OS home never falls back to `<home>/projects`.
 */
export function resolveClaudeTranscriptDirPath(input: {
  readonly homePath: string;
  readonly join: (a: string, b: string, ...rest: string[]) => string;
  readonly nestedProjectsExists: boolean;
  readonly homeIsExplicitOverride: boolean;
}): string {
  const nested = input.join(input.homePath, ".claude", "projects");
  if (input.nestedProjectsExists) return nested;
  if (input.homeIsExplicitOverride) return input.join(input.homePath, "projects");
  return nested;
}

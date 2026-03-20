import { Effect } from "effect";

import { GitCommandError } from "./Errors.ts";

export interface CommitPatternAnalysis {
  readonly hasEmojis: boolean;
  readonly hasScopes: boolean;
  readonly hasTypes: boolean;
  readonly examples: readonly string[];
  readonly analysis: string;
}

/**
 * Conventional commit types used across most projects.
 * This includes the official specification and common extensions.
 */
const COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
  "security",
  "deps",
  "config",
  "infra",
  "adhoc",
] as const;

/**
 * Regex to detect conventional commit messages.
 *
 * Examples supported:
 * feat: add feature
 * fix(auth): resolve login issue
 * ✨ feat: add feature (with optional emoji prefix)
 * ✨🚀 feat: add feature (with multiple emoji prefix)
 * Feat: add feature (case-insensitive)
 */
export const TYPE_PATTERN = new RegExp(
  `^(?:[\\p{Extended_Pictographic}\\p{Emoji_Presentation}]\\s*)*(${COMMIT_TYPES.join("|")})(\\([^)]+\\))?:`,
  "iu",
);

const SCOPE_PATTERN = /\([^)]+\)/;

const EMOJI_PATTERN = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u;

export interface AnalyzeCommitPatternsDependencies {
  readonly getRecentCommitMessages: (
    cwd: string,
    count?: number,
  ) => Effect.Effect<readonly string[], GitCommandError>;
}

/**
 * Analyzes recent git commit messages to detect patterns and provide examples.
 * Returns analysis of emoji usage, scopes, conventional types, and real examples.
 *
 * Note: Commit messages include full body (subject + body) for better pattern detection
 * and more useful examples for AI prompt generation.
 */
export const analyzeCommitPatterns =
  (dependencies: AnalyzeCommitPatternsDependencies) =>
  (cwd: string): Effect.Effect<CommitPatternAnalysis, never> =>
    Effect.gen(function* () {
      const recentMessages = yield* dependencies
        .getRecentCommitMessages(cwd, 5)
        .pipe(Effect.catch(() => Effect.succeed<readonly string[]>([])));

      const validMessages = recentMessages.filter((msg) => msg.trim().length > 0);

      if (validMessages.length === 0) {
        return {
          hasEmojis: false,
          hasScopes: false,
          hasTypes: false,
          examples: [],
          analysis: "No previous commits found. Use conventional commits.",
        };
      }

      const subjects = validMessages.map((msg) => {
        const firstLine = msg.split(/\r?\n/)[0] ?? "";
        return firstLine.trim();
      });

      const emojiCount = subjects.filter((subject) => EMOJI_PATTERN.test(subject)).length;
      const hasEmojis = emojiCount >= subjects.length * 0.4;

      const scopeCount = subjects.filter((subject) => SCOPE_PATTERN.test(subject)).length;
      const hasScopes = scopeCount >= subjects.length * 0.4;

      const typeCount = subjects.filter((subject) => TYPE_PATTERN.test(subject)).length;
      const hasTypes = typeCount >= subjects.length * 0.4;

      const bestExample =
        validMessages.find((msg) => {
          const subject = msg.split(/\r?\n/)[0] ?? "";
          return (
            EMOJI_PATTERN.test(subject) && TYPE_PATTERN.test(subject) && SCOPE_PATTERN.test(subject)
          );
        }) ??
        validMessages.find((msg) => {
          const subject = msg.split(/\r?\n/)[0] ?? "";
          return (
            (EMOJI_PATTERN.test(subject) && TYPE_PATTERN.test(subject)) ||
            (TYPE_PATTERN.test(subject) && SCOPE_PATTERN.test(subject))
          );
        }) ??
        validMessages.find((msg) => {
          const subject = msg.split(/\r?\n/)[0] ?? "";
          return (
            EMOJI_PATTERN.test(subject) || TYPE_PATTERN.test(subject) || SCOPE_PATTERN.test(subject)
          );
        }) ??
        validMessages[0]!;

      const examples: readonly string[] = [bestExample];

      let analysis = "Detected commit patterns:\n";
      if (hasEmojis) {
        analysis += "- Uses emoji prefixes (gitmoji-style)\n";
      }
      if (hasScopes) {
        analysis += "- Uses scopes like feat(scope): or fix(scope):\n";
      }
      if (hasTypes) {
        analysis += "- Uses conventional commit types (feat, fix, docs, etc.)\n";
      }
      if (!hasEmojis && !hasScopes && !hasTypes) {
        analysis += "- No specific pattern detected\n";
      }

      return {
        hasEmojis,
        hasScopes,
        hasTypes,
        examples,
        analysis,
      };
    });

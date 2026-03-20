import { describe, it, expect } from "vitest";
import { Effect } from "effect";

import { analyzeCommitPatterns } from "./analyzeCommitPatterns";
import { GitCommandError } from "./Errors.ts";

describe("analyzeCommitPatterns", () => {
  const mockDependencies = (commits: readonly string[] | Error) => ({
    getRecentCommitMessages: (_cwd: string, _count?: number) =>
      commits instanceof Error
        ? Effect.fail(
            new GitCommandError({
              operation: "getRecentCommitMessages",
              command: "git log",
              cwd: "/fake/cwd",
              detail: commits.message,
              cause: commits,
            }),
          )
        : Effect.succeed(commits),
  });

  const runAnalysis = (commits: readonly string[] | Error) => {
    const result = Effect.runSync(analyzeCommitPatterns(mockDependencies(commits))("/fake/cwd"));
    return result;
  };

  it("detects emoji + scope + type pattern", () => {
    const commits = [
      `✨ feat(git): improve commit pattern detection logic
      Enhance commit message analysis to detect emojis, scopes and types more accurately.
      Improves pattern matching logic for better AI prompt generation.
      - Improve regex for emoji detection
      - Add validation for commit scope pattern
      - Improve detection accuracy for conventional types
      - Update tests to cover mixed commit styles
      This update ensures the system can correctly detect structured commit formats used in modern repositories.`,

      `🐛 fix: handle empty commit history safely
      Fix issue where commit analysis failed when repository had no commit history.
      Adds graceful fallback behaviour.
      - Handle empty git log response
      - Prevent runtime errors when parsing commits
      - Add fallback analysis message
      This ensures the commit analysis feature works correctly even in newly initialised repositories.`,

      `feat(commit): support emoji detection in commit messages
      Add functionality to detect emoji prefixes in commit subjects.
      Uses Unicode emoji pattern matching for better accuracy.
      - Add emoji regex detection
      - Update commit pattern interface
      - Add unit tests for emoji commits
      This change allows commit analysis to detect gitmoji-style workflows.`,
    ];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(true);
    expect(result.hasScopes).toBe(true);
    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
    expect(result.examples[0]).toContain("✨ feat(git): improve commit pattern detection logic");
    expect(result.analysis).toContain("Uses emoji prefixes");
    expect(result.analysis).toContain("Uses scopes");
    expect(result.analysis).toContain("Uses conventional commit types");
  });

  it("detects emoji + type pattern (no scope)", () => {
    const commits = [
      `🐛 fix: handle empty commit history safely
      Fix issue where commit analysis failed when repository had no commit history.
      Adds graceful fallback behaviour.
      - Handle empty git log response
      - Prevent runtime errors when parsing commits
      - Add fallback analysis message
      This ensures the commit analysis feature works correctly even in newly initialised repositories.`,

      `⚡ perf: optimise commit pattern detection performance
      Improve efficiency of commit message analysis for large repositories.
      Reduces unnecessary regex evaluations.
      - Cache compiled regex patterns
      - Reduce redundant message parsing
      - Add performance benchmarks
      This optimisation significantly reduces analysis time for large commit histories.`,

      `📚 update documentation for commit pattern analysis
      Improve documentation explaining how commit analysis works internally.
      Adds examples and better explanations.
      - Add usage examples
      - Document regex pattern logic
      - Clarify commit analysis workflow
      This documentation update helps contributors understand commit analysis behaviour.`,
    ];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(true);
    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
    expect(result.examples[0]).toMatch(/🐛|⚡|📚/);
    expect(result.analysis).toContain("Uses emoji prefixes");
    expect(result.analysis).toContain("Uses conventional commit types");
  });

  it("detects scope + type pattern (no emoji)", () => {
    const commits = [
      `feat(commit): support emoji detection in commit messages
      Add functionality to detect emoji prefixes in commit subjects.
      Uses Unicode emoji pattern matching for better accuracy.
      - Add emoji regex detection
      - Update commit pattern interface
      - Add unit tests for emoji commits
      This change allows commit analysis to detect gitmoji-style workflows.`,

      `fix(parser): correctly extract commit subject lines
      Fix issue where commit subject parsing failed for multiline messages.
      Ensures only the first line is used for pattern detection.
      - Improve message splitting logic
      - Handle edge cases for newline characters
      - Add regression tests
      This change improves accuracy of commit pattern detection.`,

      `refactor: simplify commit analysis pipeline
      Refactor commit analysis implementation to improve readability and maintainability.
      Removes duplicated logic and clarifies intent.
      - Extract pattern detection helpers
      - Simplify analysis builder logic
      - Improve naming for internal variables
      This refactor makes the analysis module easier to maintain and extend.`,
    ];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(false);
    expect(result.hasScopes).toBe(true);
    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
    expect(result.analysis).toContain("Uses scopes");
    expect(result.analysis).toContain("Uses conventional commit types");
  });

  it("detects type only pattern", () => {
    const commits = [
      `refactor: simplify commit analysis pipeline
      Refactor commit analysis implementation to improve readability and maintainability.
      Removes duplicated logic and clarifies intent.
      - Extract pattern detection helpers
      - Simplify analysis builder logic
      - Improve naming for internal variables
      This refactor makes the analysis module easier to maintain and extend.`,

      `test: add coverage for commit pattern detection
      Introduce additional tests to verify detection of emojis, scopes and types.
      Improves reliability of commit analysis logic.
      - Add emoji detection tests
      - Add scope detection tests
      - Add conventional commit detection tests
      These tests ensure the commit analysis behaves correctly across multiple commit styles.`,

      `chore: update dependencies to latest versions
      Update project dependencies to their latest stable versions.
      Ensures security patches and bug fixes are included.
      - Update package.json
      - Run npm audit fix
      - Update lockfile
      This update keeps the project secure and up-to-date.`,
    ];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(false);
    expect(result.hasScopes).toBe(false);
    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
    expect(result.analysis).toContain("Uses conventional commit types");
  });

  it("detects emoji only pattern", () => {
    const commits = [
      `📚 update documentation for commit pattern analysis
      Improve documentation explaining how commit analysis works internally.
      Adds examples and better explanations.
      - Add usage examples
      - Document regex pattern logic
      - Clarify commit analysis workflow
      This documentation update helps contributors understand commit analysis behaviour.`,

      `🎨 improve UI styling for commit viewer
      Enhance visual appearance of commit message viewer component.
      Uses modern design patterns for better UX.
      - Update color scheme
      - Improve spacing and typography
      - Add hover effects
      This visual update makes the commit viewer more pleasant to use.`,

      `✅ add CI pipeline for automated testing
      Set up continuous integration pipeline for automated testing.
      Ensures code quality and prevents regressions.
      - Configure GitHub Actions
      - Add automated test runs
      - Set up deployment checks
      This CI setup improves development workflow and code quality.`,
    ];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(true);
    expect(result.hasScopes).toBe(false);
    expect(result.hasTypes).toBe(false);
    expect(result.examples).toHaveLength(1);
    expect(result.analysis).toContain("Uses emoji prefixes");
  });

  it("selects best example when mixed patterns exist", () => {
    const commits = [
      `📚 update documentation
      Simple doc update with no type or scope.`,

      `✨ feat(git): improve commit pattern detection logic
      Enhance commit message analysis to detect emojis, scopes and types more accurately.
      Improves pattern matching logic for better AI prompt generation.
      - Improve regex for emoji detection
      - Add validation for commit scope pattern
      - Improve detection accuracy for conventional types
      - Update tests to cover mixed commit styles
      This update ensures the system can correctly detect structured commit formats used in modern repositories.`,

      `refactor(api): simplify code
      Refactor with no emoji but has type and scope.`,
    ];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(true);
    expect(result.hasScopes).toBe(true);
    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
    expect(result.examples[0]).toContain("✨ feat(git): improve commit pattern detection logic");
  });

  it("handles empty repository (no commits)", () => {
    const result = runAnalysis([]);

    expect(result.hasEmojis).toBe(false);
    expect(result.hasScopes).toBe(false);
    expect(result.hasTypes).toBe(false);
    expect(result.examples).toEqual([]);
    expect(result.analysis).toContain("No previous commits found");
  });

  it("handles git log failure gracefully", () => {
    const result = runAnalysis(new Error("Git command failed"));

    expect(result.hasEmojis).toBe(false);
    expect(result.hasScopes).toBe(false);
    expect(result.hasTypes).toBe(false);
    expect(result.examples).toEqual([]);
    expect(result.analysis).toContain("No previous commits found");
  });

  it("handles commits with only subject lines (no body)", () => {
    const commits = [
      "✨ feat: initial commit",
      "🐛 fix: bug",
      "♻️ refactor: code",
      "📝 docs: readme",
      "🚀 chore: release",
    ];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(true);
    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
    expect(result.examples[0]).toBe("✨ feat: initial commit");
  });

  it("detects no pattern when commits are unstructured", () => {
    const commits = [
      `Initial commit
      Set up the project structure.`,
      `Update dependencies
      Ran npm update.`,
      `Fix bug
      Fixed the login issue.`,
      `Add feature
      Added user profile.`,
      `Refactor code
      Cleaned up the codebase.`,
    ];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(false);
    expect(result.hasScopes).toBe(false);
    expect(result.hasTypes).toBe(false);
    expect(result.analysis).toContain("No specific pattern detected");
  });

  it("correctly parses the test commit message from requirements", () => {
    const commits = [
      `feat(git): add getRecentCommitMessages function
      Add method to retrieve recent commit messages from git repository.
      Supports optional count parameter with default of 5 messages.
      Excludes merge commits and returns clean message list.
      - Add interface definition in GitCoreShape
      - Implement git log command execution with proper error handling
      - Add comprehensive unit tests for functionality
      - Follows existing Effect patterns in codebase
      This commit adds new git functionality that can be used for features like gitmoji suggestions or commit history analysis.`,
    ];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(false);
    expect(result.hasScopes).toBe(true);
    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
    expect(result.examples[0]).toContain("feat(git): add getRecentCommitMessages function");
    expect(result.analysis).toContain("Uses scopes");
    expect(result.analysis).toContain("Uses conventional commit types");
  });

  it("handles one-liner commits with emoji + type + scope", () => {
    const commits = [
      "✨ feat(git): add feature",
      "🐛 fix(api): resolve bug",
      "🚀 chore(deps): update packages",
    ];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(true);
    expect(result.hasScopes).toBe(true);
    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
    expect(result.examples[0]).toBe("✨ feat(git): add feature");
  });

  it("handles one-liner commits with emoji + type (no scope)", () => {
    const commits = ["✨ feat: add feature", "🐛 fix: resolve bug", "🚀 chore: update packages"];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(true);
    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
  });

  it("handles one-liner commits with emoji only (no type)", () => {
    const commits = ["✨ add feature", "🐛 resolve bug", "🚀 update packages"];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(true);
    expect(result.hasScopes).toBe(false);
    expect(result.hasTypes).toBe(false);
    expect(result.examples).toHaveLength(1);
  });

  it("handles one-liner commits with type only (no emoji)", () => {
    const commits = ["feat: add feature", "fix: resolve bug", "chore: update packages"];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(false);
    expect(result.hasScopes).toBe(false);
    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
  });

  it("handles one-liner commits with type + scope (no emoji)", () => {
    const commits = [
      "feat(git): add feature",
      "fix(api): resolve bug",
      "chore(deps): update packages",
    ];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(false);
    expect(result.hasScopes).toBe(true);
    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
  });

  it("handles one-liner commits with no pattern", () => {
    const commits = ["add feature", "resolve bug", "update packages"];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(false);
    expect(result.hasScopes).toBe(false);
    expect(result.hasTypes).toBe(false);
    expect(result.analysis).toContain("No specific pattern detected");
  });

  it("handles commits with multiple emojis", () => {
    const commits = ["✨🚀 feat: add feature", "🐛🔧 fix: resolve bug", "📝🎨 docs: update readme"];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(true);
    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
  });

  it("handles commits with special characters and URLs", () => {
    const commits = [
      `feat(api): add OAuth2 authentication
Integrate with GitHub OAuth2 API.
https://github.com/oauth/docs
- Add OAuth2 flow
- Handle tokens
- Fix edge case: API rate-limit (403 errors)
Supports scopes: read:user, repo, admin:repo_hook`,

      `fix(config): resolve CORS issues
Fixed Access-Control-Allow-Origin errors.
See: https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS
- Configure allowed origins
- Set proper headers
- Handle preflight requests`,

      `docs(readme): update installation guide
Updated URLs for new package registry.
https://npmjs.com/package/v2
- Update install command
- Fix broken links
- Add troubleshooting section`,
    ];

    const result = runAnalysis(commits);

    expect(result.hasScopes).toBe(true);
    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
  });

  it("handles commits with mixed case types", () => {
    const commits = ["Feat: add feature", "FIX: resolve bug", "Chore: update packages"];

    const result = runAnalysis(commits);

    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
  });

  it("handles commits with colons in subject", () => {
    const commits = [
      `feat: add feature: with colon in description
Implement new feature that handles colons.`,
      `fix(api): resolve: rate limiting issue
Fixed the API rate:limit problem.`,
    ];

    const result = runAnalysis(commits);

    expect(result.hasTypes).toBe(true);
  });

  it("handles commits with trailing whitespace", () => {
    const commits = ["feat: add feature   ", "fix: resolve bug\t", "chore: update packages  \n"];

    const result = runAnalysis(commits);

    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
    expect(result.examples[0]?.trim()).toBe("feat: add feature");
  });

  it("handles commits with only body (no proper subject line)", () => {
    const commits = [
      `This is a commit with no subject line
Just the body of the commit message.
Describing what was done.`,
    ];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(false);
    expect(result.hasScopes).toBe(false);
    expect(result.hasTypes).toBe(false);
  });

  it("handles very long commit messages", () => {
    const commits = [
      `feat(git): add comprehensive commit message analysis
      This is a very long commit message with lots of details.
      - Add support for emoji detection
      - Add support for scope detection
      - Add support for conventional commit types
      - Add comprehensive test coverage
      - Handle edge cases like one-liners, empty bodies, special characters
      - Support mixed commit styles
      - Add intelligent example selection
      - Ensure proper error handling
      - Follow existing code patterns
      - Add detailed documentation
      - Performance optimizations for large repositories
      - Cache compiled regex patterns
      - Reduce redundant parsing operations
      - Add benchmarks for performance validation
      This commit represents a substantial feature addition with comprehensive testing and documentation.`,
    ];

    const result = runAnalysis(commits);

    expect(result.hasScopes).toBe(true);
    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
  });

  it("handles commits with code blocks and technical content", () => {
    const commits = [
      `feat(parser): add commit message parser
      Add function to parse commit messages efficiently.

      \`\`\`typescript
      function parseCommit(message: string): Commit {
        return {
          type: extractType(message),
          scope: extractScope(message),
          subject: extractSubject(message),
        };
      }
      \`\`\`

      Usage:
      \`\`\`
      const commit = parseCommit("feat(api): add endpoint");
      // { type: "feat", scope: "api", subject: "add endpoint" }
      \`\`\`

      - Support emoji prefixes
      - Handle edge cases
      - Add unit tests`,

      `fix(types): resolve type inference issue
      Fixed issue with generic type constraints.

      Before:
      \`\`\`typescript
      function parse<T>(input: T): T
      \`\`\`

      After:
      \`\`\`typescript
      function parse<T extends string>(input: T): Commit
      \`\`\`

      - Add proper type constraints
      - Update all call sites
      - Add regression tests`,
    ];

    const result = runAnalysis(commits);

    expect(result.hasScopes).toBe(true);
    expect(result.hasTypes).toBe(true);
  });

  it("handles mixed one-liner and multi-line commits", () => {
    const commits = [
      "✨ feat: add feature",
      `🐛 fix(api): resolve bug
      Fixed null pointer exception in API handler.
      - Add null checks
      - Add error handling
      This prevents crashes on invalid input.`,
      "🚀 chore: update packages",
      `feat(ui): improve button styling
      Better visual feedback for user interactions.
      - Add hover states
      - Add active states
      - Improve accessibility`,
      "📝 docs: update readme",
    ];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(true);
    expect(result.hasScopes).toBe(true);
    expect(result.hasTypes).toBe(true);
  });

  it("handles commits with only bullet points in body", () => {
    const commits = [
      `feat(git): add commit analysis
      - Support emoji detection
      - Support scope detection
      - Support type detection
      - Add comprehensive tests
      - Add documentation`,

      `fix(api): resolve rate limiting
      - Add rate limiter
      - Configure limits
      - Add monitoring
      - Add alerts`,
    ];

    const result = runAnalysis(commits);

    expect(result.hasScopes).toBe(true);
    expect(result.hasTypes).toBe(true);
  });

  it("handles commits with various line endings", () => {
    const commits = [
      "feat: add feature\r\n\r\nWith CRLF line endings",
      "fix: resolve bug\n\nWith LF line endings",
      "chore: update\rWith mixed line endings",
    ];

    const result = runAnalysis(commits);

    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
  });

  it("handles commits with numbers in types", () => {
    const commits = ["feat: add feature", "fix2: resolve bug", "v1: initial release"];

    const result = runAnalysis(commits);

    expect(result.hasTypes).toBe(false);
    expect(result.examples).toHaveLength(1);
    expect(result.examples[0]).toBe("feat: add feature");
  });

  it("handles empty strings and whitespace-only commits", () => {
    const commits = ["", "   ", "\n\n", "feat: actual commit", "  \t  "];

    const result = runAnalysis(commits);

    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
    expect(result.examples[0]).toBe("feat: actual commit");
  });

  it("handles real-world mixed commit styles", () => {
    const commits = [
      "✨ feat: add user authentication",
      "fix(api): resolve rate limiting",
      `feat(ui): improve dashboard
      Redesign dashboard with new charts.
      - Add pie charts
      - Add bar charts
      - Add line charts
      This improves data visualization.`,
      "🐛 fix: memory leak in event handlers",
      "refactor(core): optimize data structures",
      "📚 docs: update API documentation",
      "chore: update dependencies",
      `feat(auth): add OAuth2 support
      Integrate with GitHub OAuth2.
      - Add OAuth2 flow
      - Handle tokens
      - Store sessions`,
      "test: add unit tests for auth module",
      "⚡ perf: cache compiled regex patterns",
    ];

    const result = runAnalysis(commits);

    expect(result.hasEmojis).toBe(true);
    expect(result.hasScopes).toBe(true);
    expect(result.hasTypes).toBe(true);
    expect(result.examples).toHaveLength(1);
    expect(result.examples[0]).toMatch(/✨ feat:|feat\(auth\):|feat\(ui\):|feat\(git\):/);
  });
});

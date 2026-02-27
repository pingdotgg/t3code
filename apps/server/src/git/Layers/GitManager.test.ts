import fs from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError, Scope } from "effect";
import { expect } from "vitest";

import { GitHubCliError, TextGenerationError } from "../Errors.ts";
import { type GitManagerShape } from "../Services/GitManager.ts";
import {
  type GitHubCliShape,
  type GitHubPullRequestSummary,
  GitHubCli,
} from "../Services/GitHubCli.ts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import { GitServiceLive } from "./GitService.ts";
import { GitService } from "../Services/GitService.ts";
import { GitCoreLive } from "./GitCore.ts";
import { makeGitManager } from "./GitManager.ts";

interface FakeGhScenario {
  prListSequence?: string[];
  createdPrUrl?: string;
  defaultBranch?: string;
  failWith?: Error;
}

interface FakeGitTextGeneration {
  generateCommitMessage: (input: {
    cwd: string;
    branch: string | null;
    stagedSummary: string;
    stagedPatch: string;
  }) => Effect.Effect<{ subject: string; body: string }, unknown>;
  generatePrContent: (input: {
    cwd: string;
    baseBranch: string;
    headBranch: string;
    commitSummary: string;
    diffSummary: string;
    diffPatch: string;
  }) => Effect.Effect<{ title: string; body: string }, unknown>;
}

function makeTempDir(
  prefix: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function runGit(
  cwd: string,
  args: readonly string[],
  allowNonZeroExit = false,
): Effect.Effect<
  { readonly code: number; readonly stdout: string; readonly stderr: string },
  unknown,
  GitService
> {
  return Effect.gen(function* () {
    const gitService = yield* GitService;
    return yield* gitService.execute({
      operation: "GitManager.test.runGit",
      cwd,
      args,
      allowNonZeroExit,
    });
  });
}

function initRepo(
  cwd: string,
): Effect.Effect<void, unknown, FileSystem.FileSystem | Scope.Scope | GitService> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* runGit(cwd, ["init", "--initial-branch=main"]);
    yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test User"]);
    yield* fs.writeFileString(path.join(cwd, "README.md"), "hello\n");
    yield* runGit(cwd, ["add", "README.md"]);
    yield* runGit(cwd, ["commit", "-m", "Initial commit"]);
  });
}

function createBareRemote(): Effect.Effect<
  string,
  unknown,
  FileSystem.FileSystem | Scope.Scope | GitService
> {
  return Effect.gen(function* () {
    const remoteDir = yield* makeTempDir("t3code-git-remote-");
    yield* runGit(remoteDir, ["init", "--bare"]);
    return remoteDir;
  });
}

function createTextGeneration(overrides: Partial<FakeGitTextGeneration> = {}): TextGenerationShape {
  const implementation: FakeGitTextGeneration = {
    generateCommitMessage: () =>
      Effect.succeed({
        subject: "Implement stacked git actions",
        body: "",
      }),
    generatePrContent: () =>
      Effect.succeed({
        title: "Add stacked git actions",
        body: "## Summary\n- Add stacked git workflow\n\n## Testing\n- Not run",
      }),
    ...overrides,
  };

  return {
    generateCommitMessage: (input) =>
      implementation.generateCommitMessage(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateCommitMessage",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generatePrContent: (input) =>
      implementation.generatePrContent(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generatePrContent",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
  };
}

const normalizeGhError = (error: Error): GitHubCliError => {
  if (error.message.includes("Command not found: gh")) {
    return new GitHubCliError({
      operation: "execute",
      detail: "GitHub CLI (`gh`) is required but not available on PATH.",
      cause: error,
    });
  }
  const lower = error.message.toLowerCase();
  if (
    lower.includes("authentication failed") ||
    lower.includes("not logged in") ||
    lower.includes("gh auth login") ||
    lower.includes("no oauth token")
  ) {
    return new GitHubCliError({
      operation: "execute",
      detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
      cause: error,
    });
  }
  return new GitHubCliError({
    operation: "execute",
    detail: error.message,
    cause: error,
  });
};

function createGitHubCliWithFakeGh(scenario: FakeGhScenario = {}): {
  service: GitHubCliShape;
  ghCalls: string[];
} {
  const prListQueue = [...(scenario.prListSequence ?? [])];
  const ghCalls: string[] = [];

  const execute: GitHubCliShape["execute"] = (input) => {
    const args = [...input.args];
    ghCalls.push(args.join(" "));

    if (scenario.failWith) {
      return Effect.fail(normalizeGhError(scenario.failWith));
    }

    if (args[0] === "pr" && args[1] === "list") {
      const stdout = (prListQueue.shift() ?? "[]") + "\n";
      return Effect.succeed({
        stdout,
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
    }

    if (args[0] === "pr" && args[1] === "create") {
      return Effect.succeed({
        stdout:
          (scenario.createdPrUrl ?? "https://github.com/pingdotgg/codething-mvp/pull/101") + "\n",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
    }

    if (args[0] === "pr" && args[1] === "view") {
      return Effect.succeed({
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
    }

    if (args[0] === "repo" && args[1] === "view") {
      return Effect.succeed({
        stdout: `${scenario.defaultBranch ?? "main"}\n`,
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
    }

    return Effect.fail(
      new GitHubCliError({
        operation: "execute",
        detail: `Unexpected gh command: ${args.join(" ")}`,
      }),
    );
  };

  return {
    service: {
      execute,
      listOpenPullRequests: (input) =>
        execute({
          cwd: input.cwd,
          args: [
            "pr",
            "list",
            "--head",
            input.headBranch,
            "--state",
            "open",
            "--limit",
            String(input.limit ?? 1),
            "--json",
            "number,title,url,baseRefName,headRefName",
          ],
        }).pipe(
          Effect.map(
            (result) => JSON.parse(result.stdout) as ReadonlyArray<GitHubPullRequestSummary>,
          ),
        ),
      createPullRequest: (input) =>
        execute({
          cwd: input.cwd,
          args: [
            "pr",
            "create",
            "--base",
            input.baseBranch,
            "--head",
            input.headBranch,
            "--title",
            input.title,
            "--body-file",
            input.bodyFile,
          ],
        }).pipe(Effect.asVoid),
      getDefaultBranch: (input) =>
        execute({
          cwd: input.cwd,
          args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
        }).pipe(
          Effect.map((result) => {
            const value = result.stdout.trim();
            return value.length > 0 ? value : null;
          }),
        ),
    },
    ghCalls,
  };
}

function runStackedAction(
  manager: GitManagerShape,
  input: {
    cwd: string;
    action: "commit" | "commit_push" | "commit_push_pr";
    commitMessage?: string;
  },
) {
  return manager.runStackedAction(input);
}

function makeManager(input?: {
  ghScenario?: FakeGhScenario;
  textGeneration?: Partial<FakeGitTextGeneration>;
}) {
  const { service: gitHubCli, ghCalls } = createGitHubCliWithFakeGh(input?.ghScenario);
  const textGeneration = createTextGeneration(input?.textGeneration);

  const gitCoreLayer = GitCoreLive.pipe(
    Layer.provideMerge(GitServiceLive),
    Layer.provideMerge(NodeServices.layer),
  );

  const managerLayer = Layer.mergeAll(
    Layer.succeed(GitHubCli, gitHubCli),
    Layer.succeed(TextGeneration, textGeneration),
    gitCoreLayer,
    NodeServices.layer,
  );

  return makeGitManager.pipe(
    Effect.provide(managerLayer),
    Effect.map((manager) => ({ manager, ghCalls })),
  );
}

const GitManagerTestLayer = Layer.provideMerge(GitServiceLive, NodeServices.layer);

it.layer(GitManagerTestLayer)("GitManager", (it) => {
  it.effect("status includes open PR metadata when branch already has an open PR", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-open-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-open-pr"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 13,
                title: "Existing PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/13",
                baseRefName: "main",
                headRefName: "feature/status-open-pr",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/status-open-pr");
      expect(status.openPr).toEqual({
        number: 13,
        title: "Existing PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/13",
        baseBranch: "main",
        headBranch: "feature/status-open-pr",
      });
    }),
  );

  it.effect("status is resilient to gh lookup failures and returns openPr null", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-no-gh"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-no-gh"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          failWith: new Error("Command not found: gh"),
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/status-no-gh");
      expect(status.openPr).toBeNull();
    }),
  );

  it.effect("creates a commit when working tree is dirty", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\nworld\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("skipped_not_requested");
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%s"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("Implement stacked git actions");
    }),
  );

  it.effect("uses custom commit message when provided", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\ncustom\n");
      let generatedCount = 0;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: () =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "this should not be used",
                body: "",
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        commitMessage: "feat: custom summary line\n\n- details from user",
      });

      expect(result.commit.status).toBe("created");
      expect(result.commit.subject).toBe("feat: custom summary line");
      expect(generatedCount).toBe(0);
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%s"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("feat: custom summary line");
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%b"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toContain("- details from user");
    }),
  );

  it.effect("skips commit when there are no uncommitted changes", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(result.commit.status).toBe("skipped_no_changes");
      expect(result.push.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("skipped_not_requested");
    }),
  );

  it.effect("commits and pushes with upstream auto-setup when needed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/stacked-flow"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
      });

      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("pushed");
      expect(result.push.setUpstream).toBe(true);
      expect(
        yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("origin/feature/stacked-flow");
    }),
  );

  it.effect("skips push when branch is already up to date", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/up-to-date"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/up-to-date"]);

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
      });

      expect(result.commit.status).toBe("skipped_no_changes");
      expect(result.push.status).toBe("skipped_up_to_date");
    }),
  );

  it.effect("returns existing PR metadata for commit/push/pr action", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/existing-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/existing-pr"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 42,
                title: "Existing PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/42",
                baseRefName: "main",
                headRefName: "feature/existing-pr",
              },
            ]),
          ],
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      });

      expect(result.pr.status).toBe("opened_existing");
      expect(result.pr.number).toBe(42);
      expect(ghCalls.some((call) => call.startsWith("pr view "))).toBe(false);
    }),
  );

  it.effect("creates PR when one does not already exist", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature-create-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(repoDir, "changes.txt"), "change\n");
      yield* runGit(repoDir, ["add", "changes.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Feature commit"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature-create-pr"]);
      yield* runGit(repoDir, ["config", "branch.feature-create-pr.gh-merge-base", "main"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            "[]",
            JSON.stringify([
              {
                number: 88,
                title: "Add stacked git actions",
                url: "https://github.com/pingdotgg/codething-mvp/pull/88",
                baseRefName: "main",
                headRefName: "feature-create-pr",
              },
            ]),
          ],
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      });

      expect(result.pr.status).toBe("created");
      expect(result.pr.number).toBe(88);
      expect(
        ghCalls.some((call) => call.includes("pr create --base main --head feature-create-pr")),
      ).toBe(true);
      expect(ghCalls.some((call) => call.startsWith("pr view "))).toBe(false);
    }),
  );

  it.effect("rejects push/pr actions from detached HEAD", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "--detach", "HEAD"]);

      const { manager } = yield* makeManager();
      const errorMessage = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
      }).pipe(
        Effect.flip,
        Effect.map((error) => (error instanceof Error ? error.message : String(error))),
      );
      expect(errorMessage).toContain("detached HEAD");
    }),
  );

  it.effect("surfaces missing gh binary errors", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/gh-missing"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/gh-missing"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          failWith: new Error("Command not found: gh"),
        },
      });

      const errorMessage = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      }).pipe(
        Effect.flip,
        Effect.map((error) => (error instanceof Error ? error.message : String(error))),
      );
      expect(errorMessage).toContain("GitHub CLI (`gh`) is required");
    }),
  );

  it.effect("surfaces gh auth errors with guidance", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/gh-auth"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/gh-auth"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          failWith: new Error("authentication failed"),
        },
      });

      const errorMessage = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      }).pipe(
        Effect.flip,
        Effect.map((error) => (error instanceof Error ? error.message : String(error))),
      );
      expect(errorMessage).toContain("gh auth login");
    }),
  );
});

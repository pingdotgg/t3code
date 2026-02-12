import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitManager } from "./gitManager";
import {
  type ProcessRunOptions,
  type ProcessRunResult,
  runProcess,
} from "./processRunner";

interface FakeGhScenario {
  prListSequence?: string[];
  createdPrUrl?: string;
  defaultBranch?: string;
  failWith?: Error;
}

interface FakeGitTextGenerator {
  generateCommitMessage: (input: {
    cwd: string;
    branch: string | null;
    stagedSummary: string;
    stagedPatch: string;
  }) => Promise<{ subject: string; body: string }>;
  generatePrContent: (input: {
    cwd: string;
    baseBranch: string;
    headBranch: string;
    commitSummary: string;
    diffSummary: string;
    diffPatch: string;
  }) => Promise<{ title: string; body: string }>;
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function runGit(
  cwd: string,
  args: readonly string[],
  allowNonZeroExit = false,
): Promise<ProcessRunResult> {
  return runProcess("git", args, { cwd, allowNonZeroExit });
}

async function runGitStdout(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runGit(cwd, args);
  return result.stdout.trim();
}

async function initRepo(cwd: string): Promise<void> {
  await runGit(cwd, ["init", "--initial-branch=main"]);
  await runGit(cwd, ["config", "user.email", "test@example.com"]);
  await runGit(cwd, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "hello\n");
  await runGit(cwd, ["add", "README.md"]);
  await runGit(cwd, ["commit", "-m", "Initial commit"]);
}

async function createBareRemote(): Promise<string> {
  const remoteDir = makeTempDir("t3code-git-remote-");
  await runProcess("git", ["init", "--bare"], { cwd: remoteDir });
  return remoteDir;
}

function createTextGenerator(
  overrides: Partial<FakeGitTextGenerator> = {},
): FakeGitTextGenerator {
  return {
    generateCommitMessage: async () => ({
      subject: "Implement stacked git actions",
      body: "",
    }),
    generatePrContent: async () => ({
      title: "Add stacked git actions",
      body: "## Summary\n- Add stacked git workflow\n\n## Testing\n- Not run",
    }),
    ...overrides,
  };
}

function createRunnerWithFakeGh(scenario: FakeGhScenario = {}): {
  runner: (
    command: string,
    args: readonly string[],
    options?: ProcessRunOptions,
  ) => Promise<ProcessRunResult>;
  ghCalls: string[];
} {
  const prListQueue = [...(scenario.prListSequence ?? [])];
  const ghCalls: string[] = [];

  const runner = async (
    command: string,
    args: readonly string[],
    options?: ProcessRunOptions,
  ): Promise<ProcessRunResult> => {
    if (command !== "gh") {
      return runProcess(command, args, options);
    }

    ghCalls.push(args.join(" "));
    if (scenario.failWith) {
      throw scenario.failWith;
    }

    if (args[0] === "pr" && args[1] === "list") {
      const stdout = (prListQueue.shift() ?? "[]") + "\n";
      return {
        stdout,
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      };
    }

    if (args[0] === "pr" && args[1] === "create") {
      return {
        stdout:
          (scenario.createdPrUrl ??
            "https://github.com/pingdotgg/codething-mvp/pull/101") + "\n",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      };
    }

    if (args[0] === "pr" && args[1] === "view") {
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      };
    }

    if (args[0] === "repo" && args[1] === "view") {
      return {
        stdout: `${scenario.defaultBranch ?? "main"}\n`,
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      };
    }

    throw new Error(`Unexpected gh command: ${args.join(" ")}`);
  };

  return { runner, ghCalls };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("GitManager", () => {
  it("creates a commit when working tree is dirty", async () => {
    const repoDir = makeTempDir("t3code-git-manager-");
    await initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, "README.md"), "hello\nworld\n");

    const manager = new GitManager({
      textGenerator: createTextGenerator(),
    });
    const result = await manager.runStackedAction({
      cwd: repoDir,
      action: "commit",
    });

    expect(result.commit.status).toBe("created");
    expect(result.push.status).toBe("skipped_not_requested");
    expect(result.pr.status).toBe("skipped_not_requested");
    expect(await runGitStdout(repoDir, ["log", "-1", "--pretty=%s"])).toBe(
      "Implement stacked git actions",
    );
  });

  it("skips commit when there are no uncommitted changes", async () => {
    const repoDir = makeTempDir("t3code-git-manager-");
    await initRepo(repoDir);

    const manager = new GitManager({
      textGenerator: createTextGenerator(),
    });
    const result = await manager.runStackedAction({
      cwd: repoDir,
      action: "commit",
    });

    expect(result.commit.status).toBe("skipped_no_changes");
    expect(result.push.status).toBe("skipped_not_requested");
    expect(result.pr.status).toBe("skipped_not_requested");
  });

  it("commits and pushes with upstream auto-setup when needed", async () => {
    const repoDir = makeTempDir("t3code-git-manager-");
    await initRepo(repoDir);
    await runGit(repoDir, ["checkout", "-b", "feature/stacked-flow"]);
    const remoteDir = await createBareRemote();
    await runGit(repoDir, ["remote", "add", "origin", remoteDir]);
    fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature\n");

    const manager = new GitManager({
      textGenerator: createTextGenerator(),
    });
    const result = await manager.runStackedAction({
      cwd: repoDir,
      action: "commit_push",
    });

    expect(result.commit.status).toBe("created");
    expect(result.push.status).toBe("pushed");
    expect(result.push.setUpstream).toBe(true);
    expect(await runGitStdout(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
      "origin/feature/stacked-flow",
    );
  });

  it("skips push when branch is already up to date", async () => {
    const repoDir = makeTempDir("t3code-git-manager-");
    await initRepo(repoDir);
    await runGit(repoDir, ["checkout", "-b", "feature/up-to-date"]);
    const remoteDir = await createBareRemote();
    await runGit(repoDir, ["remote", "add", "origin", remoteDir]);
    await runGit(repoDir, ["push", "-u", "origin", "feature/up-to-date"]);

    const manager = new GitManager({
      textGenerator: createTextGenerator(),
    });
    const result = await manager.runStackedAction({
      cwd: repoDir,
      action: "commit_push",
    });

    expect(result.commit.status).toBe("skipped_no_changes");
    expect(result.push.status).toBe("skipped_up_to_date");
  });

  it("opens existing PR for commit/push/pr action", async () => {
    const repoDir = makeTempDir("t3code-git-manager-");
    await initRepo(repoDir);
    await runGit(repoDir, ["checkout", "-b", "feature/existing-pr"]);
    const remoteDir = await createBareRemote();
    await runGit(repoDir, ["remote", "add", "origin", remoteDir]);
    await runGit(repoDir, ["push", "-u", "origin", "feature/existing-pr"]);

    const { runner, ghCalls } = createRunnerWithFakeGh({
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
    });

    const manager = new GitManager({
      runProcess: runner,
      textGenerator: createTextGenerator(),
    });
    const result = await manager.runStackedAction({
      cwd: repoDir,
      action: "commit_push_pr",
    });

    expect(result.pr.status).toBe("opened_existing");
    expect(result.pr.number).toBe(42);
    expect(
      ghCalls.some((call) => call.startsWith("pr view feature/existing-pr --web")),
    ).toBe(true);
  });

  it("creates PR when one does not already exist", async () => {
    const repoDir = makeTempDir("t3code-git-manager-");
    await initRepo(repoDir);
    await runGit(repoDir, ["checkout", "-b", "feature-create-pr"]);
    const remoteDir = await createBareRemote();
    await runGit(repoDir, ["remote", "add", "origin", remoteDir]);
    fs.writeFileSync(path.join(repoDir, "changes.txt"), "change\n");
    await runGit(repoDir, ["add", "changes.txt"]);
    await runGit(repoDir, ["commit", "-m", "Feature commit"]);
    await runGit(repoDir, ["push", "-u", "origin", "feature-create-pr"]);
    await runGit(repoDir, ["config", "branch.feature-create-pr.gh-merge-base", "main"]);

    const { runner, ghCalls } = createRunnerWithFakeGh({
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
    });

    const manager = new GitManager({
      runProcess: runner,
      textGenerator: createTextGenerator(),
    });
    const result = await manager.runStackedAction({
      cwd: repoDir,
      action: "commit_push_pr",
    });

    expect(result.pr.status).toBe("created");
    expect(result.pr.number).toBe(88);
    expect(
      ghCalls.some((call) => call.includes("pr create --base main --head feature-create-pr")),
    ).toBe(true);
  });

  it("rejects push/pr actions from detached HEAD", async () => {
    const repoDir = makeTempDir("t3code-git-manager-");
    await initRepo(repoDir);
    await runGit(repoDir, ["checkout", "--detach", "HEAD"]);

    const manager = new GitManager({
      textGenerator: createTextGenerator(),
    });
    await expect(
      manager.runStackedAction({
        cwd: repoDir,
        action: "commit_push",
      }),
    ).rejects.toThrow("detached HEAD");
  });

  it("surfaces missing gh binary errors", async () => {
    const repoDir = makeTempDir("t3code-git-manager-");
    await initRepo(repoDir);
    await runGit(repoDir, ["checkout", "-b", "feature/gh-missing"]);
    const remoteDir = await createBareRemote();
    await runGit(repoDir, ["remote", "add", "origin", remoteDir]);
    await runGit(repoDir, ["push", "-u", "origin", "feature/gh-missing"]);

    const { runner } = createRunnerWithFakeGh({
      failWith: new Error("Command not found: gh"),
    });
    const manager = new GitManager({
      runProcess: runner,
      textGenerator: createTextGenerator(),
    });

    await expect(
      manager.runStackedAction({
        cwd: repoDir,
        action: "commit_push_pr",
      }),
    ).rejects.toThrow("GitHub CLI (`gh`) is required");
  });

  it("surfaces gh auth errors with guidance", async () => {
    const repoDir = makeTempDir("t3code-git-manager-");
    await initRepo(repoDir);
    await runGit(repoDir, ["checkout", "-b", "feature/gh-auth"]);
    const remoteDir = await createBareRemote();
    await runGit(repoDir, ["remote", "add", "origin", remoteDir]);
    await runGit(repoDir, ["push", "-u", "origin", "feature/gh-auth"]);

    const { runner } = createRunnerWithFakeGh({
      failWith: new Error("authentication failed"),
    });
    const manager = new GitManager({
      runProcess: runner,
      textGenerator: createTextGenerator(),
    });

    await expect(
      manager.runStackedAction({
        cwd: repoDir,
        action: "commit_push_pr",
      }),
    ).rejects.toThrow("gh auth login");
  });
});

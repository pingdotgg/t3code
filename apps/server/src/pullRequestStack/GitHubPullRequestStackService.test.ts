import { assert, afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubPullRequestStackService from "./GitHubPullRequestStackService.ts";

const cwd = "/workspace/app";
const localStackJson = JSON.stringify({
  trunk: "main",
  currentBranch: "api",
  branches: [
    {
      name: "auth",
      head: "a1",
      base: "main",
      isCurrent: false,
      isMerged: false,
      isQueued: false,
      needsRebase: false,
      pr: { number: 10, url: "https://github.com/acme/app/pull/10", state: "OPEN" },
    },
    {
      name: "api",
      head: "b2",
      base: "auth",
      isCurrent: true,
      isMerged: false,
      isQueued: false,
      needsRebase: false,
      pr: { number: 11, url: "https://github.com/acme/app/pull/11", state: "OPEN" },
    },
  ],
});

function processOutput(exitCode: number, stdout = "", stderr = ""): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(exitCode),
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

const run = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();
const layer = GitHubPullRequestStackService.layer.pipe(
  Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run })),
);

afterEach(() => {
  run.mockReset();
});

describe("GitHubPullRequestStackService", () => {
  it.effect("returns a normal empty state when the branch is not in a stack", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(Effect.succeed(processOutput(2)));

      const stacks = yield* GitHubPullRequestStackService.GitHubPullRequestStackService;
      const current = yield* stacks.current({ cwd });

      assert.deepStrictEqual(current, { availability: "available", stack: null });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reports a missing extension without breaking normal pull requests", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(
        Effect.succeed(processOutput(1, "", 'unknown command "stack" for "gh"')),
      );

      const stacks = yield* GitHubPullRequestStackService.GitHubPullRequestStackService;
      const current = yield* stacks.current({ cwd });

      assert.deepStrictEqual(current, { availability: "extension_missing", stack: null });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads all remote stacks with one GitHub API call", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            0,
            '[{"id":41,"number":7,"url":"https://api.github.com/repos/acme/app/stacks/7","base":{"ref":"main"},"open":true,"pull_requests":[{"number":10,"state":"open","draft":false,"merged_at":null,"head":{"ref":"auth","sha":"a1"}}]}]',
          ),
        ),
      );

      const stacks = yield* GitHubPullRequestStackService.GitHubPullRequestStackService;
      const response = yield* stacks.list({ cwd, host: "github.example.com" });

      assert.strictEqual(response.availability, "available");
      assert.strictEqual(response.stacks[0]?.steps[0]?.pullRequestNumber, 10);
      expect(run).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith({
        operation: "GitHubPullRequestStackService.list",
        command: "gh",
        args: ["api", "repos/{owner}/{repo}/stacks", "--hostname", "github.example.com"],
        cwd,
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps raw command output out of the user-facing error", () =>
    Effect.gen(function* () {
      const rawOutput = "remote https://github.com/acme/private token expired";
      run.mockReturnValueOnce(Effect.succeed(processOutput(1, "", rawOutput)));

      const stacks = yield* GitHubPullRequestStackService.GitHubPullRequestStackService;
      const error = yield* stacks.current({ cwd }).pipe(Effect.flip);

      assert.strictEqual(error.detail, "The GitHub stack command failed.");
      assert.strictEqual(error.cause, rawOutput);
      assert.strictEqual(/private|token/i.test(error.message), false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reports repositories without stacked pull requests as unsupported", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(Effect.succeed(processOutput(9)));

      const stacks = yield* GitHubPullRequestStackService.GitHubPullRequestStackService;
      const current = yield* stacks.current({ cwd });

      assert.deepStrictEqual(current, { availability: "unsupported", stack: null });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("verifies repository access before treating an HTTP 404 as unsupported", () =>
    Effect.gen(function* () {
      run
        .mockReturnValueOnce(Effect.succeed(processOutput(1, "", "HTTP 404")))
        .mockReturnValueOnce(Effect.succeed(processOutput(0, "{}")));

      const stacks = yield* GitHubPullRequestStackService.GitHubPullRequestStackService;
      const response = yield* stacks.list({ cwd, host: "github.example.com" });

      assert.deepStrictEqual(response, { availability: "unsupported", stacks: [] });
      expect(run).toHaveBeenNthCalledWith(2, {
        operation: "GitHubPullRequestStackService.list",
        command: "gh",
        args: ["api", "repos/{owner}/{repo}", "--hostname", "github.example.com"],
        cwd,
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces repository access failures instead of hiding them as unsupported", () =>
    Effect.gen(function* () {
      run
        .mockReturnValueOnce(Effect.succeed(processOutput(1, "", "HTTP 404")))
        .mockReturnValueOnce(Effect.succeed(processOutput(1, "", "HTTP 401")));

      const stacks = yield* GitHubPullRequestStackService.GitHubPullRequestStackService;
      const error = yield* stacks.list({ cwd }).pipe(Effect.flip);

      assert.match(error.detail, /credentials|permissions/i);
      assert.strictEqual(error.cause, "HTTP 401");
      expect(run).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("runs a non-interactive submit and returns fresh local state", () =>
    Effect.gen(function* () {
      run
        .mockReturnValueOnce(Effect.succeed(processOutput(0, "Submitted stack")))
        .mockReturnValueOnce(Effect.succeed(processOutput(0, localStackJson)));

      const stacks = yield* GitHubPullRequestStackService.GitHubPullRequestStackService;
      const response = yield* stacks.runAction({
        cwd,
        action: "submit",
      });

      assert.strictEqual(response.action, "submit");
      assert.strictEqual(response.stack?.currentBranch, "api");
      expect(run).toHaveBeenNthCalledWith(1, {
        operation: "GitHubPullRequestStackService.submit",
        command: "gh",
        args: ["stack", "submit", "--auto"],
        cwd,
        allowNonZeroExit: true,
        timeoutMs: 600_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not treat a diverged sync as successful", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            0,
            "Your local stack has diverged from the stack on GitHub\nSync aborted — no changes were made",
          ),
        ),
      );

      const stacks = yield* GitHubPullRequestStackService.GitHubPullRequestStackService;
      const error = yield* stacks.runAction({ cwd, action: "sync" }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "PullRequestStackError");
      assert.match(error.detail, /diverged/i);
      expect(run).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("returns the merge state reported by the official CLI", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(
        Effect.succeed(processOutput(0, "Added #10, #11 to the merge queue for main")),
      );

      const stacks = yield* GitHubPullRequestStackService.GitHubPullRequestStackService;
      const response = yield* stacks.merge({
        cwd,
        pullRequestNumber: 11,
        mergeMethod: "squash",
      });

      assert.deepStrictEqual(response, { status: "queued" });
      expect(run).toHaveBeenCalledWith({
        operation: "GitHubPullRequestStackService.merge",
        command: "gh",
        args: ["stack", "merge", "11", "--yes", "--squash"],
        cwd,
        allowNonZeroExit: true,
        timeoutMs: 600_000,
      });
    }).pipe(Effect.provide(layer)),
  );
});

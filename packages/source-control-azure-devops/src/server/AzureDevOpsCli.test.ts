import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, afterEach, describe, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";

const processOutput = (stdout: string): SourceControlHost.SourceControlProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();

const layerSupport = Layer.mergeAll(
  TestSourceControlHost.layer({ process: { run: mockRun } }),
  NodeServices.layer,
);
const layer = Layer.mergeAll(AzureDevOpsCli.layer.pipe(Layer.provide(layerSupport)), layerSupport);

afterEach(() => {
  mockRun.mockReset();
});

describe("AzureDevOpsCli.layer", () => {
  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              pullRequestId: 42,
              title: "Add Azure provider",
              sourceRefName: "refs/heads/feature/source-control",
              targetRefName: "refs/heads/main",
              lastMergeSourceCommit: { commitId: "a".repeat(40) },
              status: "active",
              creationDate: "2026-01-02T00:00:00.000Z",
              closedDate: null,
              _links: {
                web: {
                  href: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
                },
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.strictEqual(result.number, 42);
      assert.strictEqual(result.title, "Add Azure provider");
      assert.strictEqual(result.url, "https://dev.azure.com/acme/project/_git/repo/pullrequest/42");
      assert.strictEqual(result.baseRefName, "main");
      assert.strictEqual(result.headRefName, "feature/source-control");
      assert.strictEqual(result.headSha, "a".repeat(40));
      assert.strictEqual(result.state, "open");
      assert.deepStrictEqual(result.updatedAt._tag, Option.some(1)._tag);
      const { classifyFailure, ...call } = mockRun.mock.calls.at(-1)?.[0] ?? {};
      assert.strictEqual(
        classifyFailure?.("Please run az login to setup account."),
        "authentication",
      );
      assert.strictEqual(
        classifyFailure?.("Please run 'az login' to setup account."),
        "authentication",
      );
      assert.strictEqual(
        classifyFailure?.("TF401180: The requested pull request was not found."),
        "not-found",
      );
      assert.deepStrictEqual(call, {
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "pr",
          "show",
          "--detect",
          "true",
          "--id",
          "42",
          "--only-show-errors",
          "--output",
          "json",
        ],
        cwd: "/repo",
        notFoundDetail: "Pull request not found.",
        timeoutMs: 30_000,
      });
      assert.strictEqual(result.isCrossRepository, false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("marks a pull request from a fork as cross-repository", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              pullRequestId: 43,
              title: "From a fork",
              sourceRefName: "refs/heads/main",
              targetRefName: "refs/heads/main",
              status: "active",
              forkSource: { name: "refs/heads/main", repository: { name: "repo-fork" } },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getPullRequest({ cwd: "/repo", reference: "43" });

      assert.strictEqual(result.isCrossRepository, true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("builds a web URL when Azure returns only the pull request REST URL", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              pullRequestId: 863,
              title: "Fix Azure link",
              url: "https://dev.azure.com/saplyai/a8fe4088-ad76-4eda-aaaa-e3329713a097/_apis/git/repositories/16108a25-93a3-4eff-b77d-85e894ee0fe4/pullRequests/863",
              repository: {
                name: "CV-engine",
                project: {
                  name: "CV-engine",
                },
              },
              sourceRefName: "refs/heads/feature/azure-pr-link",
              targetRefName: "refs/heads/main",
              status: "active",
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getPullRequest({
        cwd: "/repo",
        reference: "863",
      });

      assert.strictEqual(
        result.url,
        "https://dev.azure.com/saplyai/CV-engine/_git/CV-engine/pullrequest/863",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              name: "repo",
              webUrl: "https://dev.azure.com/acme/project/_git/repo",
              remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
              sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
              project: {
                name: "project",
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "repo",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "project/repo",
        url: "https://dev.azure.com/acme/project/_git/repo",
        sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("looks up a project/repository path as that project's repository", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              name: "repo",
              webUrl: "https://dev.azure.com/acme/project/_git/repo",
              remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
              sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
              project: { name: "project" },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.getRepositoryCloneUrls({ cwd: "/somewhere", repository: "project/repo" });

      assert.deepStrictEqual(mockRun.mock.calls.at(-1)?.[0].args, [
        "repos",
        "show",
        "--detect",
        "true",
        "--repository",
        "repo",
        "--project",
        "project",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves VCS causes without copying upstream details into messages", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "AzureDevOpsCli.execute",
        command: "az repos list --organization sensitive-upstream-detail",
        cwd: "/repo",
        exitCode: 1,
        detail: "sensitive-upstream-detail",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.execute({ cwd: "/repo", args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsCommandFailedError);
      assert.strictEqual(error.operation, "execute");
      assert.strictEqual(error.command, "az");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.argumentCount, 2);
      assert.strictEqual(error.detail, "Azure DevOps CLI command failed.");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes("sensitive-upstream-detail"), false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not report a missing working directory as a missing Azure CLI", () =>
    Effect.gen(function* () {
      const cwd = "/missing/repo";
      const platformCause = PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        syscall: "chdir",
        pathOrDescriptor: cwd,
      });
      const cause = new VcsProcessSpawnError({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        cwd,
        argumentCount: 2,
        cause: platformCause,
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.execute({ cwd, args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsCommandFailedError);
      assert.strictEqual(error.cwd, cwd);
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves rate-limit failures as a distinct error", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        cwd: "/repo",
        argumentCount: 2,
        exitCode: 1,
        detail: "API rate limit exceeded.",
        failureKind: "rate-limited",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.execute({ cwd: "/repo", args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsCliRateLimitError);
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(layer)),
  );
});

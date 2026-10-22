import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it, afterEach, describe, vi } from "@effect/vitest";
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
      assert.deepStrictEqual(mockRun.mock.calls.at(-1)?.[0], {
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

describe("repository-scoped PR updates", () => {
  it.effect("uses Azure CLI's Python runtime and preserves the body and repository route", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(processOutput("Python location '/opt/az/bin/python'")),
      );
      mockRun.mockReturnValue(Effect.succeed(processOutput("{}")));
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const input = {
        cwd: "/repo",
        bodyFile: "/tmp/pr-body.json",
        routeValues: { project: "project", repositoryId: "repo", pullRequestId: "42" },
      };
      yield* az.patchPullRequest(input);
      yield* az.patchPullRequest(input);
      expect(mockRun.mock.calls).toHaveLength(3);
      const request = mockRun.mock.calls[1]?.[0];
      expect(request?.command).toBe("/opt/az/bin/python");
      expect(request?.cwd).toBe("/repo");
      expect(JSON.parse(request?.stdin ?? "{}")).toEqual({
        bodyFile: input.bodyFile,
        routeValues: input.routeValues,
      });
      expect(request?.args?.[2]).toContain("9946fd70-0d40-406e-b686-b4744cbbcc37");
      expect(request?.args?.[2]).toContain("get_git_client");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not execute an unknown runtime when Azure CLI omits its Python location", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValue(Effect.succeed(processOutput("azure-cli version")));
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az
        .patchPullRequest({
          cwd: "/repo",
          bodyFile: "/tmp/body.json",
          routeValues: { project: "project", repositoryId: "repo", pullRequestId: "42" },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(mockRun.mock.calls).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );
});

it.effect("preserves the host's native operation refusal instead of reporting success", () =>
  Effect.gen(function* () {
    mockRun.mockReturnValueOnce(
      Effect.succeed(processOutput("Python location '/opt/az/bin/python'")),
    );
    mockRun.mockReturnValueOnce(
      Effect.succeed(
        processOutput(
          JSON.stringify({
            _t3SdkError: { message: "This credential lacks notification write permission." },
          }),
        ),
      ),
    );
    const az = yield* AzureDevOpsCli.AzureDevOpsCli;
    const error = yield* az
      .notificationSubscriptions({ cwd: "/repo", method: "POST", bodyFile: "/tmp/body.json" })
      .pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "permission-denied", argumentCount: 3 });
    expect(error.detail).toBe(
      "Your Azure credential lacks the required scope or permission for this action.",
    );
    expect(error.cause).toBe("This credential lacks notification write permission.");
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps unexpected SDK error text in the cause without displaying it", () =>
  Effect.gen(function* () {
    const secret = "remote detail with a private project URL and token";
    mockRun.mockReturnValueOnce(
      Effect.succeed(processOutput("Python location '/opt/az/bin/python'")),
    );
    mockRun.mockReturnValueOnce(
      Effect.succeed(processOutput(JSON.stringify({ _t3SdkError: { message: secret } }))),
    );
    const az = yield* AzureDevOpsCli.AzureDevOpsCli;
    const error = yield* az
      .notificationSubscriptions({ cwd: "/repo", method: "POST" })
      .pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "failed", cause: secret });
    expect(error.detail).toBe("Azure refused this operation.");
    expect(error.message).not.toContain(secret);
    expect(mockRun.mock.calls[1]?.[0].args?.slice(0, 2)).toEqual(["-I", "-c"]);
  }).pipe(Effect.provide(layer)),
);

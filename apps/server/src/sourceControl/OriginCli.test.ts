import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as OriginCli from "./OriginCli.ts";
import { ORIGIN_PULL_REQUEST_JSON_FIELDS } from "./originPullRequests.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();

const layer = OriginCli.layer.pipe(
  Layer.provide(
    Layer.mock(VcsProcess.VcsProcess)({
      run: mockRun,
    }),
  ),
);

afterEach(() => {
  mockRun.mockReset();
});

describe("OriginCli.layer", () => {
  it("does not classify a missing cwd as an unavailable origin executable", () => {
    const context = { command: "origin", cwd: "/repo" } as const;
    const missingCwd = new VcsProcessSpawnError({
      operation: "OriginCli.execute",
      command: "origin",
      cwd: context.cwd,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method: "access",
        pathOrDescriptor: context.cwd,
      }),
    });

    const commandFailure = OriginCli.fromVcsError(context, missingCwd);

    assert.equal(commandFailure._tag, "OriginCliCommandError");
    assert.strictEqual(commandFailure.cause, missingCwd);
  });

  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 13,
              title: "Add Origin provider",
              url: "https://cursor.com/codebase/acme/checkout/pull/13",
              status: "open",
              head: { ref: "feature/origin" },
              base: { ref: "main" },
            }),
          ),
        ),
      );

      const origin = yield* OriginCli.OriginCli;
      const result = yield* origin.getPullRequest({
        cwd: "/repo",
        reference: "13",
      });

      assert.deepStrictEqual(result, {
        number: 13,
        title: "Add Origin provider",
        url: "https://cursor.com/codebase/acme/checkout/pull/13",
        baseRefName: "main",
        headRefName: "feature/origin",
        state: "open",
        updatedAt: Option.none(),
      });
      expect(mockRun).toHaveBeenCalledWith({
        operation: "OriginCli.execute",
        command: "origin",
        args: ["pr", "view", "13", "--json", ORIGIN_PULL_REQUEST_JSON_FIELDS],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rebuilds Origin pull request URLs from the repository identity", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 13,
              title: "Add Origin provider",
              status: "open",
              head: { ref: "feature/origin" },
              base: { ref: "main" },
            }),
          ),
        ),
      );

      const origin = yield* OriginCli.OriginCli;
      const result = yield* origin.getPullRequest({
        cwd: "/repo",
        reference: "13",
        nameWithOwner: "acme/checkout",
      });

      assert.strictEqual(result.url, "https://cursor.com/codebase/acme/checkout/pull/13");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates repositories without a visibility flag", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            "Created repository acme/checkout\nhttps://origin.cursor.com/acme/checkout.git\n",
          ),
        ),
      );

      const origin = yield* OriginCli.OriginCli;
      const result = yield* origin.createRepository({
        cwd: "/repo",
        repository: "acme/checkout",
        visibility: "public",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "acme/checkout",
        url: "https://cursor.com/codebase/acme/checkout",
        sshUrl: "git@origin.cursor.com:acme/checkout.git",
      });
      expect(mockRun).toHaveBeenNthCalledWith(1, {
        operation: "OriginCli.execute",
        command: "origin",
        args: ["repo", "create", "acme/checkout"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("opens pull requests as open rather than Origin's draft default", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const origin = yield* OriginCli.OriginCli;
      yield* origin.createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/origin",
        title: "Add Origin provider",
        bodyFile: "/tmp/body.md",
      });

      expect(mockRun).toHaveBeenCalledWith({
        operation: "OriginCli.execute",
        command: "origin",
        args: [
          "pr",
          "create",
          "--base",
          "main",
          "--head",
          "feature/origin",
          "--title",
          "Add Origin provider",
          "--body-file",
          "/tmp/body.md",
          "--status",
          "open",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces a friendly error when the pull request is not found", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "OriginCli.execute",
        command: "origin pr view",
        cwd: "/repo",
        exitCode: 1,
        failureKind: "not-found",
        detail: "pull request 13 was not found",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const origin = yield* OriginCli.OriginCli;
      const error = yield* origin
        .getPullRequest({ cwd: "/repo", reference: "13" })
        .pipe(Effect.flip);

      assert.equal(error._tag, "OriginPullRequestNotFoundError");
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(layer)),
  );
});

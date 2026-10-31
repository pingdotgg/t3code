import { assert, it, afterEach, expect, vi } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import { VcsProcessExitError, VcsProcessTimeoutError } from "@t3tools/contracts";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitLabCli from "./GitLabCli.ts";

const mockedRun = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();
const mockedRemotes = vi.fn<SourceControlHost.SourceControlHost["Service"]["git"]["remotes"]>();
const layer = it.layer(
  Layer.merge(
    GitLabCli.layer.pipe(
      Layer.provide(
        TestSourceControlHost.layer({
          process: { run: mockedRun },
          git: { remotes: mockedRemotes },
        }),
      ),
    ),
    // Keeps a developer's own GITLAB_HOST out of these tests.
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
  ),
);

function processOutput(stdout: string): SourceControlHost.SourceControlProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function mockGlab(
  signedInHosts: ReadonlyArray<string>,
  remoteUrls: ReadonlyArray<string | { readonly url: string; readonly pushUrl: string }> = [],
) {
  mockedRemotes.mockReturnValue(
    Effect.succeed(
      Effect.succeed({
        remotes: remoteUrls.map((remote) => ({
          name: "origin",
          url: typeof remote === "string" ? remote : remote.url,
          pushUrl: typeof remote === "string" ? Option.none() : Option.some(remote.pushUrl),
          isPrimary: true,
        })),
        freshness: {
          source: "live-local" as const,
          observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
          expiresAt: Option.none(),
        },
      }),
    ),
  );
  mockedRun.mockImplementation((input) => {
    if (input.args[0] === "auth") {
      return Effect.succeed({
        ...processOutput(""),
        stderr: signedInHosts.map((host) => `${host}\n  ✓ Logged in to ${host} as user\n`).join(""),
      });
    }
    if (input.args[1]?.startsWith("namespaces/")) {
      return Effect.succeed(processOutput(JSON.stringify({ id: 9 })));
    }
    return Effect.succeed(
      processOutput(
        JSON.stringify({
          path_with_namespace: "team/app",
          web_url: "https://gitlab.example.test/team/app",
          http_url_to_repo: "https://gitlab.example.test/team/app.git",
          ssh_url_to_repo: "git@gitlab.example.test:team/app.git",
        }),
      ),
    );
  });
}

afterEach(() => {
  mockedRun.mockReset();
  mockedRemotes.mockReset();
});

layer("GitLabCli.layer", (it) => {
  it.effect("parses merge request view output", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              iid: 42,
              title: "Add MR thread creation",
              web_url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
              target_branch: "main",
              source_branch: "feature/mr-threads",
              sha: "a".repeat(40),
              state: "closed",
              closed_at: "2026-08-23T10:00:00Z",
              source_project_id: 101,
              target_project_id: 100,
              source_project: {
                path_with_namespace: "octocat/t3code",
              },
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "42",
        });
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add MR thread creation",
        url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
        baseRefName: "main",
        headRefName: "feature/mr-threads",
        headSha: "a".repeat(40),
        state: "closed",
        closedAt: "2026-08-23T10:00:00Z",
        mergedAt: null,
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/t3code",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "view", "--output", "json", "--", "42"],
        }),
      );
    }),
  );

  it.effect("skips invalid entries when parsing MR lists", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify([
              {
                iid: 0,
                title: "invalid",
                web_url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/0",
                target_branch: "main",
                source_branch: "feature/invalid",
              },
              {
                iid: 43,
                title: "  Valid MR  ",
                web_url: " https://gitlab.com/pingdotgg/t3code/-/merge_requests/43 ",
                target_branch: " main ",
                source_branch: " feature/mr-list ",
                state: "merged",
                merged_at: "2026-08-23T11:00:00Z",
              },
            ]),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.listMergeRequests({
          cwd: "/repo",
          headSelector: "feature/mr-list",
          state: "all",
        });
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid MR",
          url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/43",
          baseRefName: "main",
          headRefName: "feature/mr-list",
          state: "merged",
          closedAt: null,
          mergedAt: "2026-08-23T11:00:00Z",
        },
      ]);
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "mr",
            "list",
            "--source-branch",
            "feature/mr-list",
            "--all",
            "--per-page",
            "20",
            "--output",
            "json",
          ],
        }),
      );
    }),
  );

  it.effect("surfaces a friendly error when the merge request is not found", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "GET 404 merge request not found",
        failureKind: "not-found",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("Merge request 4888 was not found"), true);
      assert.strictEqual(error._tag, "GitLabMergeRequestNotFoundError");
      assert.strictEqual(error.command, "glab");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes(cause.detail), false);
    }),
  );

  it.effect("keeps non-merge-request not-found failures generic", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "GET 404 project not found",
        failureKind: "not-found",
      });
      mockedRun.mockImplementation((input) =>
        input.args[0] === "auth"
          ? Effect.fail(
              new VcsProcessTimeoutError({
                operation: "GitLabCli.authStatus",
                command: "glab",
                cwd: "/repo",
                timeoutMs: 5_000,
              }),
            )
          : Effect.fail(cause),
      );

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "missing/project",
        });
      }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabCliCommandError");
      assert.strictEqual(error.cause, cause);
      expect(mockedRun).toHaveBeenLastCalledWith(
        expect.objectContaining({ args: ["api", "projects/missing%2Fproject"] }),
      );
    }),
  );

  it.effect("looks up repositories on the only signed-in host, spelled as glab prints it", () =>
    Effect.gen(function* () {
      mockGlab(["Git.Example.test:8443"]);

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.getRepositoryCloneUrls({ cwd: "/server", repository: "team/app" });

      expect(mockedRun).toHaveBeenLastCalledWith(
        expect.objectContaining({
          args: ["api", "projects/team%2Fapp"],
          env: { GITLAB_HOST: "Git.Example.test:8443" },
        }),
      );
    }),
  );

  it.effect("leaves an explicit GITLAB_HOST to glab without probing sign-ins", () =>
    Effect.gen(function* () {
      mockGlab(["gitlab.selfhosted.test"]);

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab
        .getRepositoryCloneUrls({ cwd: "/server", repository: "team/app" })
        .pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { GITLAB_HOST: "gitlab.com" } })),
          ),
        );

      expect(mockedRun.mock.calls.map(([input]) => [input.args[0], input.env])).toEqual([
        ["api", undefined],
      ]);
    }),
  );

  it.effect.each([
    { case: "several hosts are signed in", hosts: ["gitlab.com", "gitlab.selfhosted.test"] },
    {
      case: "the checkout has a gitlab.com remote",
      hosts: ["gitlab.selfhosted.test"],
      remotes: ["git@gitlab.com:team/app.git"],
    },
    {
      case: "the checkout has a userless SCP gitlab.com remote",
      hosts: ["gitlab.selfhosted.test"],
      remotes: ["gitlab.com:team/app.git"],
    },
    {
      case: "the checkout has a userless SCP gitlab.com remote with a trailing slash",
      hosts: ["gitlab.selfhosted.test"],
      remotes: ["gitlab.com:team/app.git/"],
    },
    {
      case: "the checkout fetches from a mirror and pushes to gitlab.com",
      hosts: ["gitlab.selfhosted.test"],
      remotes: [{ url: "/srv/mirror/app.git", pushUrl: "git@gitlab.com:team/app.git" }],
    },
  ])("leaves the host to glab when $case", ({ hosts, remotes }) =>
    Effect.gen(function* () {
      mockGlab(hosts, remotes);

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.getRepositoryCloneUrls({ cwd: "/server", repository: "team/app" });

      expect(mockedRun.mock.lastCall?.[0].env).toBeUndefined();
    }),
  );

  it.effect("publishes to the only signed-in host", () =>
    Effect.gen(function* () {
      mockGlab(["gitlab.selfhosted.test"]);

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createRepository({
        cwd: "/server",
        repository: "team/app",
        visibility: "private",
      });

      expect(
        mockedRun.mock.calls
          .filter(([input]) => input.args[0] === "api")
          .map(([input]) => [input.args[1], input.env]),
      ).toEqual([
        ["namespaces/team", { GITLAB_HOST: "gitlab.selfhosted.test" }],
        ["--method", { GITLAB_HOST: "gitlab.selfhosted.test" }],
      ]);
    }),
  );

  it.effect("preserves rate-limit failures as a distinct error", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "API rate limit exceeded.",
        failureKind: "rate-limited",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .execute({ cwd: "/repo", args: ["api", "projects"] })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabCliRateLimitError");
      assert.strictEqual(error.cause, cause);
    }),
  );
});

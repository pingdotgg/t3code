import { assert, it, afterEach, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import { VcsProcessExitError } from "@t3tools/contracts";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitLabCli from "./GitLabCli.ts";
import { userFacingSourceControlDetail } from "@t3tools/source-control-core/server/SourceControlProvider";

const mockedRun = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();
const layer = it.layer(
  GitLabCli.layer.pipe(Layer.provide(TestSourceControlHost.layer({ process: { run: mockedRun } }))),
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

afterEach(() => {
  mockedRun.mockReset();
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

  const project = {
    path_with_namespace: "gitlab/team/app",
    web_url: "https://example.com:8443/gitlab/gitlab/team/app",
    http_url_to_repo: "https://example.com:8443/gitlab/gitlab/team/app.git",
    ssh_url_to_repo: "git@example.com:gitlab/team/app.git",
  };

  it.effect.each([
    {
      repository: "https://example.com:8443/gitlab/gitlab/team/app.git",
      projectPath: "gitlab/team/app",
      configuredHost: "example.com:8443/gitlab",
      webRoot: "https://example.com:8443/gitlab",
    },
    {
      repository: "http://example.com/gitlab/gitlab/team/app.git",
      projectPath: "gitlab/team/app",
      configuredHost: "example.com/gitlab",
      webRoot: "http://example.com/gitlab",
    },
    {
      repository: "https://example.com:443/gitlab/GitLab/Team/App.git",
      projectPath: "GitLab/Team/App",
      configuredHost: "example.com/gitlab",
      webRoot: "https://example.com/gitlab",
    },
    {
      repository: "git@example.com:gitlab/team/app.git",
      projectPath: "gitlab/team/app",
      configuredHost: "example.com:8443/gitlab",
      webRoot: "https://example.com:8443/gitlab",
    },
    {
      repository: "ssh://git@example.com:2222/gitlab/team/app.git",
      projectPath: "gitlab/team/app",
      configuredHost: "example.com:8443/gitlab",
      webRoot: "https://example.com:8443/gitlab",
    },
  ])("resolves $repository through its nested project path on the selected server", (row) =>
    Effect.gen(function* () {
      const url = `${row.webRoot}/gitlab/team/app`;
      mockedRun.mockImplementation((input) =>
        Effect.succeed(
          processOutput(
            input.args[0] === "config"
              ? `${row.configuredHost}\n`
              : JSON.stringify({ ...project, web_url: url, http_url_to_repo: `${url}.git` }),
          ),
        ),
      );

      const glab = yield* GitLabCli.GitLabCli;
      const result = yield* glab.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: row.repository,
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "gitlab/team/app",
        url,
        sshUrl: project.ssh_url_to_repo,
      });
      expect(mockedRun.mock.calls.filter(([input]) => input.args[0] === "api")).toEqual([
        [
          expect.objectContaining({
            command: "glab",
            args: ["api", `projects/${encodeURIComponent(row.projectPath)}`],
          }),
        ],
      ]);
    }),
  );

  it.effect("resolves an SSH remote served from a different host than the web UI", () =>
    Effect.gen(function* () {
      const sshProject = { ...project, ssh_url_to_repo: "git@ssh.example.com:gitlab/team/app.git" };
      mockedRun.mockImplementation((input) =>
        Effect.succeed(
          processOutput(
            input.args[0] === "config" ? "example.com:8443/gitlab\n" : JSON.stringify(sshProject),
          ),
        ),
      );

      const glab = yield* GitLabCli.GitLabCli;
      const result = yield* glab.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: sshProject.ssh_url_to_repo,
      });

      assert.strictEqual(result.sshUrl, sshProject.ssh_url_to_repo);
    }),
  );

  it.effect.each([
    "https://other.example.com:8443/gitlab/team/app",
    "https://example.com:9443/gitlab/team/app",
  ])("rejects %s when the selected server resolves a different repository", (repository) =>
    Effect.gen(function* () {
      mockedRun.mockImplementation((input) =>
        Effect.succeed(
          processOutput(
            input.args[0] === "config" ? "example.com:8443/gitlab\n" : JSON.stringify(project),
          ),
        ),
      );

      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .getRepositoryCloneUrls({ cwd: "/repo", repository })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabRepositoryHostMismatchError");
      expect(userFacingSourceControlDetail(error)).toContain(new URL(repository).host);
      expect(userFacingSourceControlDetail(error)).not.toContain("glab config set host");
      expect(mockedRun.mock.calls.filter(([input]) => input.args[0] === "api")).toEqual([
        [
          expect.objectContaining({
            command: "glab",
            args: ["api", "projects/gitlab%2Fteam%2Fapp"],
          }),
        ],
      ]);
    }),
  );

  it.effect(
    "rejects a pasted URL outside the configured install root when another project exists",
    () =>
      Effect.gen(function* () {
        mockedRun.mockImplementation((input) =>
          Effect.succeed(
            processOutput(
              input.args[0] === "config"
                ? "example.com:8443/gitlab\n"
                : JSON.stringify({
                    path_with_namespace: "other/team/app",
                    web_url: "https://example.com:8443/gitlab/other/team/app",
                    http_url_to_repo: "https://example.com:8443/gitlab/other/team/app.git",
                    ssh_url_to_repo: "git@example.com:other/team/app.git",
                  }),
            ),
          ),
        );

        const glab = yield* GitLabCli.GitLabCli;
        const error = yield* glab
          .getRepositoryCloneUrls({
            cwd: "/repo",
            repository: "https://example.com:8443/other/team/app.git",
          })
          .pipe(Effect.flip);

        assert.strictEqual(error._tag, "GitLabRepositoryPathMismatchError");
        expect(userFacingSourceControlDetail(error)).toContain("/other/team/app");
        expect(mockedRun.mock.calls.filter(([input]) => input.args[0] === "api")).toEqual([
          [
            expect.objectContaining({
              command: "glab",
              args: ["api", "projects/other%2Fteam%2Fapp"],
            }),
          ],
        ]);
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
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "missing/project",
        });
      }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabCliCommandError");
      assert.strictEqual(error.cause, cause);
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

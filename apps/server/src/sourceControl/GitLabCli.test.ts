import { assert, it, afterEach, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import { VcsProcessExitError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitLabCli from "./GitLabCli.ts";

const mockedRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();
const layer = it.layer(
  GitLabCli.layer.pipe(
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: mockedRun,
      }),
    ),
  ),
);

function processOutput(stdout: string): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function mockRepository(
  repositoryJson: string,
  config: { readonly subfolder?: string; readonly host?: string } = {},
) {
  mockedRun.mockImplementation((run) => {
    if (run.args[0] !== "config") return Effect.succeed(processOutput(repositoryJson));
    return Effect.succeed(
      processOutput(run.args[2] === "subfolder" ? (config.subfolder ?? "") : (config.host ?? "")),
    );
  });
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
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              iid: 42,
              title: "Add MR thread creation",
              web_url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
              target_branch: "main",
              source_branch: "feature/mr-threads",
              state: "opened",
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
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/t3code",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "view", "42", "--output", "json"],
        }),
      );
    }),
  );

  it.effect("skips invalid entries when parsing MR lists", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
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

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              path_with_namespace: "octocat/t3code",
              web_url: "https://gitlab.com/octocat/t3code",
              http_url_to_repo: "https://gitlab.com/octocat/t3code.git",
              ssh_url_to_repo: "git@gitlab.com:octocat/t3code.git",
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "octocat/t3code",
        });
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/t3code",
        url: "https://gitlab.com/octocat/t3code",
        sshUrl: "git@gitlab.com:octocat/t3code.git",
      });
    }),
  );

  it.effect("reduces a repository given as a URL to the project path it names", () =>
    Effect.gen(function* () {
      const repositoryJson =
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          path_with_namespace: "group/subgroup/project",
          web_url: "https://sourcecontrol.example.com/group/subgroup/project",
          http_url_to_repo: "https://sourcecontrol.example.com/group/subgroup/project.git",
          ssh_url_to_repo: "git@sourcecontrol.example.com:group/subgroup/project.git",
        });
      const project = "projects/group%2Fsubgroup%2Fproject";

      const cases: ReadonlyArray<readonly [string, string]> = [
        ["https://sourcecontrol.example.com/group/subgroup/project", project],
        ["https://sourcecontrol.example.com/group/subgroup/project.git", project],
        ["https://sourcecontrol.example.com/group/subgroup/project/-/tree/main", project],
        ["https://sourcecontrol.example.com/group/subgroup/project?ref_type=heads", project],
        ["git@sourcecontrol.example.com:group/subgroup/project.git", project],
        ["sourcecontrol.example.com:group/subgroup/project.git", project],
        ["ssh://git@sourcecontrol.example.com:22/group/subgroup/project.git", project],
        [
          "https://sourcecontrol.example.com/group/subgroup/pro%2Dject",
          "projects/group%2Fsubgroup%2Fpro-ject",
        ],
        ["https://sourcecontrol.example.com/group/pro%ZZject", "projects/group%2Fpro%25ZZject"],
        ["group/subgroup/project", project],
      ];

      mockRepository(repositoryJson);

      const sent: Array<readonly [string, ReadonlyArray<string> | undefined]> = [];
      for (const [repository] of cases) {
        const glab = yield* GitLabCli.GitLabCli;
        yield* glab.getRepositoryCloneUrls({ cwd: "/repo", repository });
        sent.push([repository, mockedRun.mock.lastCall?.[0].args]);
      }

      assert.deepStrictEqual(
        sent,
        cases.map(([repository, path]) => [repository, ["api", path]]),
      );
    }),
  );

  it.effect("drops the relative URL root of an instance hosted under a subfolder", () =>
    Effect.gen(function* () {
      mockRepository(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          path_with_namespace: "group/project",
          web_url: "https://example.com/gitlab/group/project",
          http_url_to_repo: "https://example.com/gitlab/group/project.git",
          ssh_url_to_repo: "git@example.com:group/project.git",
        }),
        { subfolder: "gitlab" },
      );

      const glab = yield* GitLabCli.GitLabCli;
      const urls = yield* glab.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "https://example.com/gitlab/group/project",
      });

      assert.deepStrictEqual(mockedRun.mock.calls[0]?.[0].args, [
        "config",
        "get",
        "subfolder",
        "--host",
        "example.com",
      ]);
      assert.deepStrictEqual(mockedRun.mock.lastCall?.[0].args, [
        "api",
        "projects/group%2Fproject",
      ]);
      assert.strictEqual(urls.nameWithOwner, "group/project");
    }),
  );

  it.effect("reads the relative URL root from a host configured with or without a scheme", () =>
    Effect.gen(function* () {
      for (const host of ["example.com/gitlab", "https://example.com/gitlab"]) {
        mockRepository(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            path_with_namespace: "group/subgroup/project",
            web_url: "https://example.com/gitlab/group/subgroup/project",
            http_url_to_repo: "https://example.com/gitlab/group/subgroup/project.git",
            ssh_url_to_repo: "git@example.com:group/subgroup/project.git",
          }),
          { host },
        );

        const glab = yield* GitLabCli.GitLabCli;
        const urls = yield* glab.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "https://example.com/gitlab/group/subgroup/project.git",
        });

        assert.deepStrictEqual(
          mockedRun.mock.lastCall?.[0].args,
          ["api", "projects/group%2Fsubgroup%2Fproject"],
          host,
        );
        assert.strictEqual(urls.nameWithOwner, "group/subgroup/project");
      }
    }),
  );

  it.effect("strips an installation root whose lowercase spelling changes length", () =>
    Effect.gen(function* () {
      mockRepository(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          path_with_namespace: "group/project",
          web_url: "https://example.com/İ/group/project",
          http_url_to_repo: "https://example.com/İ/group/project.git",
          ssh_url_to_repo: "git@example.com:group/project.git",
        }),
        { subfolder: "İ" },
      );

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "https://example.com/İ/group/project",
      });

      assert.deepStrictEqual(mockedRun.mock.lastCall?.[0].args, [
        "api",
        "projects/group%2Fproject",
      ]);
    }),
  );

  it.effect("reads the relative URL root under the port the instance is served on", () =>
    Effect.gen(function* () {
      mockRepository(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          path_with_namespace: "group/project",
          web_url: "https://example.com:8443/gitlab/group/project",
          http_url_to_repo: "https://example.com:8443/gitlab/group/project.git",
          ssh_url_to_repo: "git@example.com:group/project.git",
        }),
        { subfolder: "gitlab" },
      );

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "https://example.com:8443/gitlab/group/project",
      });

      assert.deepStrictEqual(mockedRun.mock.calls[0]?.[0].args, [
        "config",
        "get",
        "subfolder",
        "--host",
        "example.com:8443",
      ]);
      assert.deepStrictEqual(mockedRun.mock.lastCall?.[0].args, [
        "api",
        "projects/group%2Fproject",
      ]);
    }),
  );

  it.effect("keeps a leading segment when the configured root belongs to another host", () =>
    Effect.gen(function* () {
      mockRepository(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          path_with_namespace: "gitlab/group/project",
          web_url: "https://gitlab.com/gitlab/group/project",
          http_url_to_repo: "https://gitlab.com/gitlab/group/project.git",
          ssh_url_to_repo: "git@gitlab.com:gitlab/group/project.git",
        }),
        { host: "https://example.com/gitlab" },
      );

      const glab = yield* GitLabCli.GitLabCli;
      const urls = yield* glab.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "https://gitlab.com/gitlab/group/project",
      });

      assert.deepStrictEqual(mockedRun.mock.lastCall?.[0].args, [
        "api",
        "projects/gitlab%2Fgroup%2Fproject",
      ]);
      assert.strictEqual(urls.nameWithOwner, "gitlab/group/project");
    }),
  );

  it.effect("keeps a root that would leave a project without its namespace", () =>
    Effect.gen(function* () {
      mockRepository(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          path_with_namespace: "group/project",
          web_url: "https://example.com/group/project",
          http_url_to_repo: "https://example.com/group/project.git",
          ssh_url_to_repo: "git@example.com:group/project.git",
        }),
        { subfolder: "group" },
      );

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "https://example.com/group/project",
      });

      assert.deepStrictEqual(mockedRun.mock.lastCall?.[0].args, [
        "api",
        "projects/group%2Fproject",
      ]);
    }),
  );

  it.effect("asks for a bare project path without reading any config", () =>
    Effect.gen(function* () {
      mockRepository(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          path_with_namespace: "group/subgroup/project",
          web_url: "https://gitlab.com/group/subgroup/project",
          http_url_to_repo: "https://gitlab.com/group/subgroup/project.git",
          ssh_url_to_repo: "git@gitlab.com:group/subgroup/project.git",
        }),
      );

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.getRepositoryCloneUrls({ cwd: "/repo", repository: "group/subgroup/project" });

      assert.deepStrictEqual(
        mockedRun.mock.calls.map((call) => call[0].args),
        [["api", "projects/group%2Fsubgroup%2Fproject"]],
      );
    }),
  );

  it.effect("accepts a project served on a non-default port", () =>
    Effect.gen(function* () {
      mockRepository(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          path_with_namespace: "group/project",
          web_url: "https://sourcecontrol.example.com:8443/group/project",
          http_url_to_repo: "https://sourcecontrol.example.com:8443/group/project.git",
          ssh_url_to_repo: "git@sourcecontrol.example.com:group/project.git",
        }),
      );

      const glab = yield* GitLabCli.GitLabCli;
      const urls = yield* glab.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "git@sourcecontrol.example.com:group/project.git",
      });

      assert.strictEqual(urls.nameWithOwner, "group/project");
    }),
  );

  it.effect("refuses a project served on a different port than the URL named", () =>
    Effect.gen(function* () {
      mockRepository(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          path_with_namespace: "group/project",
          web_url: "https://sourcecontrol.example.com/group/project",
          http_url_to_repo: "https://sourcecontrol.example.com/group/project.git",
          ssh_url_to_repo: "git@sourcecontrol.example.com:group/project.git",
        }),
      );

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "https://sourcecontrol.example.com:8443/group/project",
        });
      }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabRepositoryHostMismatchError");
      assert.equal(error.detail.includes("sourcecontrol.example.com:8443"), true);
    }),
  );

  it.effect.each([
    "https://sourcecontrol.example.com/group/project",
    "https://sourcecontrol.example.com:443/group/project",
  ])("does not treat the default web port as a wildcard: %s", (repository) =>
    Effect.gen(function* () {
      mockRepository(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          path_with_namespace: "group/project",
          web_url: "https://sourcecontrol.example.com:8443/group/project",
          http_url_to_repo: "https://sourcecontrol.example.com:8443/group/project.git",
          ssh_url_to_repo: "git@sourcecontrol.example.com:group/project.git",
        }),
      );

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getRepositoryCloneUrls({ cwd: "/repo", repository });
      }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabRepositoryHostMismatchError");
      assert.equal(error.detail.includes("sourcecontrol.example.com:8443"), true);
    }),
  );

  it.effect("refuses a project resolved on a host the URL did not name", () =>
    Effect.gen(function* () {
      mockRepository(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          path_with_namespace: "group/project",
          web_url: "https://gitlab.com/group/project",
          http_url_to_repo: "https://gitlab.com/group/project.git",
          ssh_url_to_repo: "git@gitlab.com:group/project.git",
        }),
      );

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "https://sourcecontrol.example.com/group/project",
        });
      }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabRepositoryHostMismatchError");
      assert.equal(error.detail.includes("sourcecontrol.example.com"), true);
      assert.equal(error.detail.includes("gitlab.com"), true);
    }),
  );

  it.effect("creates merge requests through the GitLab API without placing the body in argv", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "owner:feature/provider",
        title: "Provider MR",
        bodyFile: "/tmp/t3-mr-body.md",
      });

      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "api",
            "--method",
            "POST",
            "projects/:fullpath/merge_requests",
            "--raw-field",
            "source_branch=feature/provider",
            "--raw-field",
            "target_branch=main",
            "--raw-field",
            "title=Provider MR",
            "--field",
            "description=@/tmp/t3-mr-body.md",
          ],
        }),
      );
    }),
  );

  it.effect("creates repositories under an explicit namespace", () =>
    Effect.gen(function* () {
      mockedRun

        .mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({ id: 1234 }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({
                path_with_namespace: "octocat/t3code",
                web_url: "https://gitlab.com/octocat/t3code",
                http_url_to_repo: "https://gitlab.com/octocat/t3code.git",
                ssh_url_to_repo: "git@gitlab.com:octocat/t3code.git",
              }),
            ),
          ),
        );

      const glab = yield* GitLabCli.GitLabCli;
      const result = yield* glab.createRepository({
        cwd: "/repo",
        repository: "octocat/t3code",
        visibility: "public",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/t3code",
        url: "https://gitlab.com/octocat/t3code",
        sshUrl: "git@gitlab.com:octocat/t3code.git",
      });
      expect(mockedRun).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["api", "namespaces/octocat"],
        }),
      );
      expect(mockedRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "api",
            "--method",
            "POST",
            "projects",
            "--raw-field",
            "path=t3code",
            "--raw-field",
            "name=t3code",
            "--raw-field",
            "visibility=public",
            "--raw-field",
            "namespace_id=1234",
          ],
        }),
      );
    }),
  );

  it.effect("does not pass unsupported force flags when checking out merge requests", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.checkoutMergeRequest({
        cwd: "/repo",
        reference: "42",
        force: true,
      });

      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "checkout", "42"],
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

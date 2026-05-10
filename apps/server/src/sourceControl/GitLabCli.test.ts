import { assert, it, afterEach, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import { VcsProcessExitError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitLabCli from "./GitLabCli.ts";

const mockedRun = vi.fn<VcsProcess.VcsProcessShape["run"]>();
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
      mockedRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessExitError({
            operation: "GitLabCli.execute",
            command: "glab mr view 4888",
            cwd: "/repo",
            exitCode: 1,
            detail: "GET 404 merge request not found",
          }),
        ),
      );

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("Merge request not found"), true);
    }),
  );
});

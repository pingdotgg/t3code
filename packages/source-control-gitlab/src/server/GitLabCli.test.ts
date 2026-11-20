import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, afterEach, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import { VcsProcessExitError } from "@t3tools/contracts";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitLabCli from "./GitLabCli.ts";

const mockedRun = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();
const layer = it.layer(
  GitLabCli.layer.pipe(
    Layer.provide(TestSourceControlHost.layer({ process: { run: mockedRun } })),
    Layer.provideMerge(NodeServices.layer),
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
      const classifyFailure = mockedRun.mock.calls.at(-1)?.[0].classifyFailure;
      assert.strictEqual(
        classifyFailure?.(
          "x gitlab.example.test has not been authenticated with glab. Run `glab auth login`",
        ),
        "authentication",
      );
      assert.strictEqual(
        classifyFailure?.(
          'Failed to get merge request 42: oauth2: "invalid_grant" "The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client."',
        ),
        "authentication",
      );
    }),
  );

  // A strictly confined glab (Snap) has a private /tmp, so it cannot open the server's body file.
  it.effect("sends the merge request description to glab on stdin, not as a file path", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bodyDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gitlab-mr-body-" });
      const bodyFile = path.join(bodyDir, "t3code-pr-body.md");
      yield* fileSystem.writeFileString(bodyFile, "## Summary\n\nFixes the thing.\n");
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/mr",
        title: "Add MR",
        bodyFile,
      });

      const call = mockedRun.mock.calls.at(-1)?.[0];
      expect(call?.args.join(" ")).not.toContain(bodyFile);
      expect(call?.args).toContain("description=@-");
      assert.strictEqual(call?.stdin, "## Summary\n\nFixes the thing.\n");
    }).pipe(Effect.scoped),
  );

  it.effect("fails with a typed error and skips glab when the description cannot be read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bodyDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gitlab-mr-body-" });
      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .createMergeRequest({
          cwd: "/repo",
          baseBranch: "main",
          headSelector: "feature/mr",
          title: "Add MR",
          bodyFile: path.join(bodyDir, "missing.md"),
        })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabMergeRequestBodyReadError");
      assert.strictEqual(error.detail, "The merge request description could not be read.");
      expect(mockedRun).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
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

  it.effect(
    "retries oversized MR lists with smaller pages without losing same-named branches",
    () =>
      Effect.gen(function* () {
        const entries = Array.from({ length: 4 }, (_, index) => ({
          iid: index + 1,
          title: "MR " + index,
          // The first alone escapes past the default 1 MB cap; together they pass the list cap.
          description: index === 0 ? '"'.repeat(600_000) : "x".repeat(3_000_000),
          web_url: "https://gitlab.com/acme/web/-/merge_requests/" + (index + 1),
          target_branch: "main",
          source_branch: "feature",
          source_project_id: index === 3 ? 100 : 101,
          target_project_id: 100,
        }));
        mockedRun.mockImplementation((input) => {
          const size = Number(input.args[input.args.indexOf("--per-page") + 1]);
          const pageIndex = input.args.indexOf("--page");
          const page = pageIndex < 0 ? 1 : Number(input.args[pageIndex + 1]);
          const raw = JSON.stringify(entries.slice((page - 1) * size, page * size));
          const cap = input.maxOutputBytes ?? 1_000_000;
          return Effect.succeed({
            ...processOutput(raw.slice(0, cap)),
            stdoutTruncated: raw.length > cap,
          });
        });
        const glab = yield* GitLabCli.GitLabCli;
        const result = yield* glab.listMergeRequests({
          cwd: "/repo",
          headSelector: "feature",
          state: "open",
          limit: 4,
        });
        assert.deepStrictEqual(
          result.map((mr) => mr.number),
          [1, 2, 3, 4],
        );
        assert.strictEqual(result[3]?.isCrossRepository, false);
      }),
  );

  it.effect("creates same-project MRs without a repository lookup, drafts by title prefix", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const bodyFile = yield* fileSystem.makeTempFileScoped({ prefix: "t3-gitlab-mr-body-" });
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));
      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/fix",
        title: "Fix remote flow",
        bodyFile,
      });
      expect(mockedRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          args: [
            "api",
            "--method",
            "POST",
            "projects/:fullpath/merge_requests",
            "--raw-field",
            "source_branch=feature/fix",
            "--raw-field",
            "target_branch=main",
            "--raw-field",
            "title=Fix remote flow",
            "--field",
            "description=@-",
          ],
        }),
      );

      const draftTitle = (title: string) =>
        Effect.gen(function* () {
          mockedRun.mockClear();
          mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));
          yield* glab.createMergeRequest({
            cwd: "/repo",
            baseBranch: "main",
            headSelector: "feature/fix",
            title,
            bodyFile,
            draft: true,
          });
          return mockedRun.mock.calls[0]?.[0].args.find((arg) => arg.startsWith("title="));
        });
      expect(yield* draftTitle("Fix remote flow")).toBe("title=Draft: Fix remote flow");
      expect(yield* draftTitle("draft: Fix remote flow")).toBe("title=draft: Fix remote flow");
      expect(yield* draftTitle("[Draft] Fix remote flow")).toBe("title=[Draft] Fix remote flow");
    }).pipe(Effect.scoped),
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

  it.effect.each([
    { repository: "group/project", args: ["api", "projects/group%2Fproject"], env: {} },
    {
      repository: "https://gitlab.example.com:8443/group/sub/project.git",
      args: ["api", "--hostname", "gitlab.example.com:8443", "projects/group%2Fsub%2Fproject"],
      // The environment token is the default host's login, not this host's.
      env: { GITLAB_TOKEN: "", GITLAB_ACCESS_TOKEN: "", OAUTH_TOKEN: "" },
    },
    {
      repository: "https://gitlab.com/group/project/-/tree/main",
      args: ["api", "--hostname", "gitlab.com", "projects/group%2Fproject"],
      env: {},
    },
  ])("looks up $repository by its project path", ({ repository, args, env }) =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              path_with_namespace: "group/project",
              web_url: "https://sourcecontrol.example.com/group/project",
              http_url_to_repo: "https://sourcecontrol.example.com/group/project.git",
              ssh_url_to_repo: "git@sourcecontrol.example.com:group/project.git",
            }),
          ),
        ),
      );

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.getRepositoryCloneUrls({ cwd: "/repo", repository });

      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({ command: "glab", args, env }),
      );
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

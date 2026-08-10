import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerSettingsError, VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();

const layerWithSettings = (overrides: Parameters<typeof ServerSettings.layerTest>[0] = {}) =>
  GitHubCli.layer.pipe(
    Layer.provide(ServerSettings.layerTest(overrides)),
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: mockRun,
      }),
    ),
  );

const layer = layerWithSettings();

const originalGitHubToken = process.env.GITHUB_TOKEN;

afterEach(() => {
  if (originalGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalGitHubToken;
  mockRun.mockReset();
});

describe("GitHubCli.layer", () => {
  it.effect("uses the GitHub CLI active account when no selection is configured", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("ok")));
      const gh = yield* GitHubCli.GitHubCli;

      yield* gh.execute({
        cwd: "/repo",
        host: "github.com",
        repositories: ["acme/widget"],
        args: ["api", "user"],
      });

      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(mockRun.mock.calls[0]?.[0]).not.toHaveProperty("env");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("selects an environment-backed GitHub credential by token source", () => {
    process.env.GITHUB_TOKEN = "environment-token";
    mockRun.mockReturnValueOnce(Effect.succeed(processOutput("ok")));
    const selectedLayer = layerWithSettings({
      githubDefaultAccounts: {
        "github.com": {
          host: "github.com",
          login: "DominicVonk",
          tokenSource: "GITHUB_TOKEN",
        },
      },
    });

    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.execute({
        cwd: "/repo",
        host: "github.com",
        repositories: ["acme/widget"],
        args: ["api", "user"],
      });

      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["api", "user"],
        cwd: "/repo",
        env: { GH_TOKEN: "environment-token" },
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(selectedLayer));
  });

  it.effect("selects a keyring credential for a GitHub owner override", () => {
    mockRun
      .mockReturnValueOnce(Effect.succeed(processOutput("keyring-token\n")))
      .mockReturnValueOnce(Effect.succeed(processOutput("ok")));
    const selectedLayer = layerWithSettings({
      githubAccountOverrides: {
        "github.com/acme": {
          host: "github.com",
          login: "work-user",
          tokenSource: "keyring",
        },
      },
    });

    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.execute({
        cwd: "/repo",
        host: "github.com",
        repositories: ["acme/widget"],
        args: ["api", "user"],
      });

      expect(mockRun).toHaveBeenNthCalledWith(1, {
        operation: "GitHubCli.authToken",
        command: "gh",
        args: ["auth", "token", "--hostname", "github.com", "--user", "work-user"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
      expect(mockRun).toHaveBeenNthCalledWith(2, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["api", "user"],
        cwd: "/repo",
        env: { GH_TOKEN: "keyring-token" },
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(selectedLayer));
  });

  it.effect("reads keyring credentials again after token rotation", () => {
    mockRun
      .mockReturnValueOnce(Effect.succeed(processOutput("first-token\n")))
      .mockReturnValueOnce(Effect.succeed(processOutput("ok")))
      .mockReturnValueOnce(Effect.succeed(processOutput("rotated-token\n")))
      .mockReturnValueOnce(Effect.succeed(processOutput("ok")));
    const selectedLayer = layerWithSettings({
      githubDefaultAccounts: {
        "github.com": {
          host: "github.com",
          login: "work-user",
          tokenSource: "keyring",
        },
      },
    });

    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      const input = {
        cwd: "/repo",
        host: "github.com",
        repositories: ["acme/widget"],
        args: ["api", "user"],
      } as const;

      yield* gh.execute(input);
      yield* gh.execute(input);

      expect(mockRun).toHaveBeenNthCalledWith(2, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["api", "user"],
        cwd: "/repo",
        env: { GH_TOKEN: "first-token" },
        timeoutMs: 30_000,
      });
      expect(mockRun).toHaveBeenNthCalledWith(4, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["api", "user"],
        cwd: "/repo",
        env: { GH_TOKEN: "rotated-token" },
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(selectedLayer));
  });

  it.effect("preserves missing-tool classification while reading a keyring token", () => {
    const cause = new VcsProcessSpawnError({
      operation: "GitHubCli.authToken",
      command: "gh",
      cwd: "/repo",
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "gh missing",
      }),
    });
    mockRun.mockReturnValueOnce(Effect.fail(cause));
    const selectedLayer = layerWithSettings({
      githubDefaultAccounts: {
        "github.com": { host: "github.com", login: "work-user", tokenSource: "keyring" },
      },
    });

    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .execute({
          cwd: "/repo",
          host: "github.com",
          repositories: ["acme/widget"],
          args: ["api", "user"],
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "GitHubCliUnavailableError");
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(selectedLayer));
  });

  it.effect("normalizes host casing before selecting the token environment variable", () => {
    process.env.GITHUB_TOKEN = "environment-token";
    mockRun.mockReturnValueOnce(Effect.succeed(processOutput("ok")));
    const selectedLayer = layerWithSettings({
      githubDefaultAccounts: {
        "github.com": {
          host: "GitHub.com",
          login: "work-user",
          tokenSource: "GITHUB_TOKEN",
        },
      },
    });

    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.execute({
        cwd: "/repo",
        host: "GitHub.com",
        repositories: ["acme/widget"],
        args: ["api", "user"],
      });

      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["api", "user"],
        cwd: "/repo",
        env: { GH_TOKEN: "environment-token" },
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(selectedLayer));
  });

  it.effect("reports unavailable token sources structurally", () => {
    delete process.env.GITHUB_TOKEN;
    const selectedLayer = layerWithSettings({
      githubDefaultAccounts: {
        "github.com": {
          host: "github.com",
          login: "environment-user",
          tokenSource: "GITHUB_TOKEN",
        },
      },
    });

    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .execute({
          cwd: "/repo",
          host: "github.com",
          repositories: ["acme/widget"],
          args: ["api", "user"],
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "GitHubTokenEnvironmentUnavailableError");
      if (error._tag !== "GitHubTokenEnvironmentUnavailableError") return;
      assert.equal(error.tokenSource, "GITHUB_TOKEN");
    }).pipe(Effect.provide(selectedLayer));
  });

  it.effect("reports empty keyring token output structurally", () => {
    mockRun.mockReturnValueOnce(Effect.succeed(processOutput("\n")));
    const selectedLayer = layerWithSettings({
      githubDefaultAccounts: {
        "github.com": { host: "github.com", login: "work-user", tokenSource: "keyring" },
      },
    });

    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .execute({
          cwd: "/repo",
          host: "github.com",
          repositories: ["acme/widget"],
          args: ["api", "user"],
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "GitHubTokenOutputEmptyError");
      if (error._tag !== "GitHubTokenOutputEmptyError") return;
      assert.equal(error.login, "work-user");
    }).pipe(Effect.provide(selectedLayer));
  });

  it.effect("reports settings read failures at the account-selection stage", () => {
    const cause = new ServerSettingsError({
      settingsPath: "/settings.json",
      operation: "read-file",
      cause: new Error("unavailable"),
    });
    const selectedLayer = GitHubCli.layer.pipe(
      Layer.provide(
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.fail(cause),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: mockRun,
        }),
      ),
    );

    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getBatchKey({
          cwd: "/repo",
          host: "github.com",
          repositories: ["acme/widget"],
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "GitHubAccountSettingsUnavailableError");
      if (error._tag !== "GitHubAccountSettingsUnavailableError") return;
      assert.equal(error.host, "github.com");
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(selectedLayer));
  });

  it("does not classify a missing cwd as an unavailable gh executable", () => {
    const context = { command: "gh", cwd: "/repo" } as const;
    const missingCwd = new VcsProcessSpawnError({
      operation: "GitHubCli.execute",
      command: "gh",
      cwd: context.cwd,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method: "access",
        pathOrDescriptor: context.cwd,
      }),
    });

    const commandFailure = GitHubCli.fromVcsError(context, missingCwd);

    assert.equal(commandFailure._tag, "GitHubCliCommandError");
    assert.strictEqual(commandFailure.cause, missingCwd);
    assert.notProperty(commandFailure, "operation");
  });

  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 42,
              title: "Add PR thread creation",
              url: "https://github.com/pingdotgg/codething-mvp/pull/42",
              baseRefName: "main",
              headRefName: "feature/pr-threads",
              state: "OPEN",
              mergedAt: null,
              isCrossRepository: true,
              headRepository: {
                nameWithOwner: "octocat/codething-mvp",
              },
              headRepositoryOwner: {
                login: "octocat",
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: [
          "pr",
          "view",
          "#42",
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("trims pull request fields decoded from gh json", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 42,
              title: "  Add PR thread creation  \n",
              url: " https://github.com/pingdotgg/codething-mvp/pull/42 ",
              baseRefName: " main ",
              headRefName: "\tfeature/pr-threads\t",
              state: "OPEN",
              mergedAt: null,
              isCrossRepository: true,
              headRepository: {
                nameWithOwner: " octocat/codething-mvp ",
              },
              headRepositoryOwner: {
                login: " octocat ",
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("skips invalid entries when parsing pr lists", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 0,
                title: "invalid",
                url: "https://github.com/pingdotgg/codething-mvp/pull/0",
                baseRefName: "main",
                headRefName: "feature/invalid",
              },
              {
                number: 43,
                title: "  Valid PR  ",
                url: " https://github.com/pingdotgg/codething-mvp/pull/43 ",
                baseRefName: " main ",
                headRefName: " feature/pr-list ",
                headRepository: {
                  nameWithOwner: "   ",
                },
                headRepositoryOwner: {
                  login: "   ",
                },
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenPullRequests({
        cwd: "/repo",
        headSelector: "feature/pr-list",
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/43",
          baseRefName: "main",
          headRefName: "feature/pr-list",
          state: "open",
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps pull requests from gh versions without headRepository.nameWithOwner", () =>
    // gh < 2.47 (e.g. Ubuntu-packaged 2.46) exports headRepository as
    // {id, name} only. These entries must decode instead of being dropped,
    // with nameWithOwner rebuilt from the owner login.
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 2829,
                title: "Codex turn mapping",
                url: "https://github.com/pingdotgg/codething-mvp/pull/2829",
                baseRefName: "main",
                headRefName: "t3code/codex-turn-mapping",
                state: "OPEN",
                mergedAt: null,
                isCrossRepository: false,
                headRepository: {
                  id: "R_kgDORLtfbQ",
                  name: "codething-mvp",
                },
                headRepositoryOwner: {
                  id: "MDEyOk9yZ2FuaXphdGlvbjg5MTkxNzI3",
                  login: "pingdotgg",
                },
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenPullRequests({
        cwd: "/repo",
        headSelector: "t3code/codex-turn-mapping",
      });

      assert.deepStrictEqual(result, [
        {
          number: 2829,
          title: "Codex turn mapping",
          url: "https://github.com/pingdotgg/codething-mvp/pull/2829",
          baseRefName: "main",
          headRefName: "t3code/codex-turn-mapping",
          state: "open",
          isCrossRepository: false,
          headRepositoryNameWithOwner: "pingdotgg/codething-mvp",
          headRepositoryOwnerLogin: "pingdotgg",
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              nameWithOwner: "octocat/codething-mvp",
              url: "https://github.com/octocat/codething-mvp",
              sshUrl: "git@github.com:octocat/codething-mvp.git",
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates repositories and parses clone URLs from create output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            "✓ Created repository octocat/codething-mvp on github.com\nhttps://github.com/octocat/codething-mvp\n",
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.createRepository({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(mockRun).toHaveBeenNthCalledWith(1, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["repo", "create", "octocat/codething-mvp", "--private"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("falls back to constructed URLs when create output omits a URL", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.createRepository({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces a friendly error when the pull request is not found", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitHubCli.execute",
        command: "gh pr view",
        cwd: "/repo",
        exitCode: 1,
        failureKind: "not-found",
        detail:
          "GraphQL: Could not resolve to a PullRequest with the number of 4888. (repository.pullRequest)",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequest({
          cwd: "/repo",
          reference: "4888",
        })
        .pipe(Effect.flip);

      assert.equal(error.message.includes("Pull request not found"), true);
      assert.strictEqual(error._tag, "GitHubPullRequestNotFoundError");
      assert.strictEqual(error.command, "gh");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes(cause.detail), false);
    }).pipe(Effect.provide(layer)),
  );
});

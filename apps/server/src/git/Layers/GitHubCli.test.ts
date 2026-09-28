import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, expect, vi } from "vitest";

vi.mock("../../processRunner", () => ({
  runProcess: vi.fn(),
}));

import { runProcess } from "../../processRunner.ts";
import { GitHubApiUsage, GitHubApiUsageLive } from "../../gitHubUsage/GitHubApiUsage.ts";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { GitHubCliLive, splitRunnerMessage } from "./GitHubCli.ts";

const mockedRunProcess = vi.mocked(runProcess);
const layer = it.layer(GitHubCliLive);

afterEach(() => {
  mockedRunProcess.mockReset();
});

layer("GitHubCliLive", (it) => {
  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
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
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "#42",
        });
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
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "pr",
          "view",
          "#42",
          "--json",
          "number,title,url,baseRefName,headRefName,headRefOid,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("reads explicit pull request URLs with included GitHub response headers", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: [
          "HTTP/2.0 200 OK",
          "content-type: application/json; charset=utf-8",
          "",
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  number: 42,
                  title: "Add PR thread creation",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/42",
                  baseRefName: "main",
                  headRefName: "feature/pr-threads",
                  headRefOid: "0123456789abcdef",
                  state: "OPEN",
                  mergedAt: null,
                  isCrossRepository: true,
                  headRepository: { nameWithOwner: "octocat/codething-mvp" },
                  headRepositoryOwner: { login: "octocat" },
                },
              },
            },
          }),
        ].join("\r\n"),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "https://github.com/pingdotgg/codething-mvp/pull/42?tab=files",
        });
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        headRefOid: "0123456789abcdef",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
      const [command, args, options] = mockedRunProcess.mock.calls[0]!;
      assert.equal(command, "gh");
      expect(args).toEqual(
        expect.arrayContaining([
          "api",
          "--hostname",
          "github.com",
          "--include",
          "graphql",
          "-f",
          "owner=pingdotgg",
          "-f",
          "name=codething-mvp",
          "-F",
          "number=42",
        ]),
      );
      expect(options).toEqual(expect.objectContaining({ cwd: "/repo", allowNonZeroExit: true }));
    }),
  );

  it.effect("preserves Retry-After headers from an explicit URL rate-limit response", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: [
          "HTTP/2.0 403 Forbidden",
          "content-type: application/json; charset=utf-8",
          "retry-after: 120",
          "",
          JSON.stringify({ message: "API rate limit exceeded for authenticated user." }),
        ].join("\r\n"),
        stderr: "",
        code: 1,
        signal: null,
        timedOut: false,
      });

      const error = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "https://github.com/pingdotgg/codething-mvp/pull/42",
        });
      }).pipe(Effect.flip);

      assert.equal(error.retryAfterAt !== undefined, true);
      assert.equal(Date.parse(error.retryAfterAt!) >= Date.now() + 119_000, true);
      const [, , options] = mockedRunProcess.mock.calls[0]!;
      expect(options).toEqual(expect.objectContaining({ allowNonZeroExit: true }));
    }),
  );

  it.effect("reads the aggregate pull request diff instead of per-commit patches", () =>
    Effect.gen(function* () {
      const diff = "diff --git a/src/example.ts b/src/example.ts\n";
      mockedRunProcess.mockResolvedValueOnce({
        stdout: diff,
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequestPatch({
          cwd: "/repo",
          reference: "42",
        });
      });

      assert.equal(result, diff);
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        ["pr", "diff", "42"],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("trims pull request fields decoded from gh json", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
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
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "#42",
        });
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
    }),
  );

  it.effect("skips invalid entries when parsing pr lists", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify([
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
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listOpenPullRequests({
          cwd: "/repo",
          headSelector: "feature/pr-list",
        });
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
    }),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          nameWithOwner: "octocat/codething-mvp",
          url: "https://github.com/octocat/codething-mvp",
          sshUrl: "git@github.com:octocat/codething-mvp.git",
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "octocat/codething-mvp",
        });
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }),
  );

  it.effect("surfaces a friendly error when the pull request is not found", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockRejectedValueOnce(
        new Error(
          "GraphQL: Could not resolve to a PullRequest with the number of 4888. (repository.pullRequest)",
        ),
      );

      const error = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("Pull request not found"), true);
    }),
  );

  it.effect("preserves Retry-After from a rate-limited GitHub CLI response", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockRejectedValueOnce(
        new Error("HTTP 403: API rate limit exceeded\nRetry-After: 120"),
      );

      const error = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "42",
        });
      }).pipe(Effect.flip);

      assert.equal(error.retryAfterAt !== undefined, true);
      assert.equal(Date.parse(error.retryAfterAt!) >= Date.now() + 119_000, true);
    }),
  );
});

it("recovers raw stderr from the runner message prefix", () => {
  const args = ["api", "--hostname", "github.com", "user", "--jq", ".login"];
  const label = `gh ${args.join(" ")}`;
  const stderr = "* Request to https://api.github.com/user\n< HTTP/2.0 403 Forbidden";
  expect(
    splitRunnerMessage(`${label} failed (code=1, signal=null). ${stderr}`, args),
  ).toStrictEqual({ stderr, timedOut: false });
  expect(splitRunnerMessage(`${label} timed out. ${stderr}`, args)).toStrictEqual({
    stderr,
    timedOut: true,
  });
  expect(splitRunnerMessage(`${label} failed (code=1, signal=null).`, args)).toStrictEqual({
    stderr: "",
    timedOut: false,
  });
  // Spawn errors, raw stderr, and other commands' messages pass through untouched.
  expect(splitRunnerMessage("Command not found: gh", args)).toStrictEqual({
    stderr: "Command not found: gh",
    timedOut: false,
  });
  expect(splitRunnerMessage(stderr, args)).toStrictEqual({ stderr, timedOut: false });
  expect(splitRunnerMessage(`${label} exceeded stdout buffer limit (8 bytes).`, args).stderr).toBe(
    `${label} exceeded stdout buffer limit (8 bytes).`,
  );
});

it.effect("records measured requests and quota from a failed invocation", () =>
  Effect.gen(function* () {
    const args = ["api", "--hostname", "github.com", "user", "--jq", ".login"];
    const stderr = [
      "* Request to https://api.github.com/user",
      "> GET /user HTTP/1.1",
      "> Authorization: token ████████████████████",
      "< HTTP/2.0 403 Forbidden",
      "< X-Ratelimit-Limit: 5000",
      "< X-Ratelimit-Remaining: 0",
      "< X-Ratelimit-Reset: 1790633756",
      "< X-Ratelimit-Resource: core",
      "< X-Ratelimit-Used: 5000",
      "API rate limit exceeded for authenticated user.",
    ].join("\n");
    mockedRunProcess.mockRejectedValueOnce(
      new Error(`gh ${args.join(" ")} failed (code=1, signal=null). ${stderr}`),
    );

    const program = Effect.gen(function* () {
      const gh = yield* GitHubCli;
      const usage = yield* GitHubApiUsage;
      const error = yield* gh
        .execute({ cwd: "/repo", args, usage: { feature: "viewer", host: "github.com" } })
        .pipe(Effect.flip);
      const report = yield* usage.report({ window: "5m" });
      return { error, report };
    }).pipe(Effect.provide(Layer.mergeAll(GitHubCliLive, GitHubApiUsageLive)));
    const { error, report } = yield* program;

    // The single failed request counts exactly, and its quota headers are
    // observed precisely when quota pressure occurs.
    assert.strictEqual(report.totals.httpRequests, 1);
    assert.strictEqual(report.totals.httpRequestsUnknown, false);
    assert.strictEqual(report.totals.rateLimited, 1);
    assert.strictEqual(report.quota[0]?.resource, "core");
    assert.strictEqual(report.quota[0]?.remaining, 0);
    // The detail carries neither the argv nor the debug trace.
    assert.equal(error.detail.includes("gh api"), false);
    assert.equal(error.detail.includes("--jq"), false);
    assert.equal(error.detail.includes("* Request to"), false);
    assert.equal(error.detail.includes("GitHub API rate limit exceeded"), true);
  }),
);

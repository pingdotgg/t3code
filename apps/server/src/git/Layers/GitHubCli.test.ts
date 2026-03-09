import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

vi.mock("../../processRunner", () => ({
  runProcess: vi.fn(),
}));

import { runProcess } from "../../processRunner";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { GitHubCliLive } from "./GitHubCli.ts";

const mockedRunProcess = vi.mocked(runProcess);

describe("GitHubCliLive", () => {
  it("parses pull request view output", async () => {
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

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "#42",
        });
      }).pipe(Effect.provide(GitHubCliLive)),
    );

    expect(result).toEqual({
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
        "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
      ],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("reads repository clone URLs", async () => {
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

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "octocat/codething-mvp",
        });
      }).pipe(Effect.provide(GitHubCliLive)),
    );

    expect(result).toEqual({
      nameWithOwner: "octocat/codething-mvp",
      url: "https://github.com/octocat/codething-mvp",
      sshUrl: "git@github.com:octocat/codething-mvp.git",
    });
  });

  it("surfaces a friendly error when the pull request is not found", async () => {
    mockedRunProcess.mockRejectedValueOnce(
      new Error(
        "GraphQL: Could not resolve to a PullRequest with the number of 4888. (repository.pullRequest)",
      ),
    );

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.provide(GitHubCliLive), Effect.flip),
    );

    expect(error.message).toContain("Pull request not found");
  });
});

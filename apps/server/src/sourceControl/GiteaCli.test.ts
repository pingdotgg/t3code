import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GiteaCli from "./GiteaCli.ts";

const mockedRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();
const layer = it.layer(
  GiteaCli.layer.pipe(
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: mockedRun,
      }),
    ),
  ),
);

/**
 * `tea api -i` prints the HTTP status line to stderr and the body to stdout, and exits 0 whatever
 * the status is. These doubles reproduce that exactly; it is the behavior the error mapping rests
 * on, verified against tea 0.15.1.
 */
function apiOutput(stdout: string, status = 200): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: `HTTP/1.1 ${status} ${status === 200 ? "OK" : "Error"}\r\nContent-Type: application/json\r\n`,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

/** Serializes a fixture into the stdout tea would produce. */
function apiJson(value: unknown, status = 200): VcsProcess.VcsProcessOutput {
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return apiOutput(JSON.stringify(value), status);
}

function pullRequestJson(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: "Add widget",
    html_url: "https://git.example.com/owner/repo/pulls/42",
    state: "open",
    merged: false,
    updated_at: "2026-01-02T03:04:05Z",
    base: { ref: "main", label: "main", repo: { full_name: "owner/repo" } },
    head: {
      ref: "t3code/abcd1234",
      label: "t3code/abcd1234",
      repo: { full_name: "owner/repo", owner: { login: "owner" } },
    },
    ...overrides,
  };
}

function lastArgs(): ReadonlyArray<string> {
  const call = mockedRun.mock.calls.at(-1);
  return call?.[0].args ?? [];
}

afterEach(() => {
  mockedRun.mockReset();
});

describe("parseHttpStatusCode", () => {
  it("reads the status line tea writes under -i", () => {
    expect(GiteaCli.parseHttpStatusCode("HTTP/1.1 404 Not Found\r\nDate: x\r\n")).toBe(404);
    expect(GiteaCli.parseHttpStatusCode("HTTP/2 200 OK\n")).toBe(200);
  });

  it("uses the final status when a redirect chain is reported", () => {
    expect(GiteaCli.parseHttpStatusCode("HTTP/1.1 301 Moved\nHTTP/1.1 200 OK\n")).toBe(200);
  });

  it("returns null when no status line is present", () => {
    expect(GiteaCli.parseHttpStatusCode("")).toBeNull();
    expect(GiteaCli.parseHttpStatusCode("some other output")).toBeNull();
  });
});

describe("parseGiteaPullRequestReference", () => {
  it("accepts bare and hash-prefixed indexes", () => {
    expect(GiteaCli.parseGiteaPullRequestReference("42")).toEqual({ index: "42" });
    expect(GiteaCli.parseGiteaPullRequestReference("#42")).toEqual({ index: "42" });
    expect(GiteaCli.parseGiteaPullRequestReference(" 42 ")).toEqual({ index: "42" });
  });

  it("accepts Gitea PR URLs on arbitrary self-hosted hosts", () => {
    expect(GiteaCli.parseGiteaPullRequestReference("https://gitea.com/foo/bar/pulls/1")).toEqual({
      index: "1",
      repository: "foo/bar",
    });
    expect(
      GiteaCli.parseGiteaPullRequestReference("https://git.example.com/foo/bar/pulls/42"),
    ).toEqual({ index: "42", repository: "foo/bar" });
    expect(
      GiteaCli.parseGiteaPullRequestReference("https://code.home.internal/team/project/pulls/999"),
    ).toEqual({ index: "999", repository: "team/project" });
  });

  it("accepts the singular /pull/ spelling and a trailing slash", () => {
    expect(GiteaCli.parseGiteaPullRequestReference("https://git.example.com/o/r/pull/7")).toEqual({
      index: "7",
      repository: "o/r",
    });
    expect(GiteaCli.parseGiteaPullRequestReference("https://git.example.com/o/r/pulls/7/")).toEqual(
      {
        index: "7",
        repository: "o/r",
      },
    );
  });

  it("rejects references that are neither an index nor a PR URL", () => {
    expect(GiteaCli.parseGiteaPullRequestReference("")).toBeNull();
    expect(GiteaCli.parseGiteaPullRequestReference("not-a-ref")).toBeNull();
    expect(
      GiteaCli.parseGiteaPullRequestReference("https://git.example.com/o/r/issues/1"),
    ).toBeNull();
    expect(
      GiteaCli.parseGiteaPullRequestReference("https://git.example.com/o/r/pulls/abc"),
    ).toBeNull();
  });
});

layer("GiteaCli.layer", (it) => {
  it.effect("gets a pull request by index", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(apiJson(pullRequestJson())));

      const tea = yield* GiteaCli.GiteaCli;
      const { updatedAt, ...result } = yield* tea.getPullRequest({
        cwd: "/repo",
        reference: "42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add widget",
        url: "https://git.example.com/owner/repo/pulls/42",
        baseRefName: "main",
        headRefName: "t3code/abcd1234",
        state: "open",
        isCrossRepository: false,
        headRepositoryNameWithOwner: "owner/repo",
        headRepositoryOwnerLogin: "owner",
      });
      expect(Option.isSome(updatedAt ?? Option.none())).toBe(true);
      expect(lastArgs()).toEqual(["api", "-i", "repos/{owner}/{repo}/pulls/42"]);
    }),
  );

  it.effect("targets the repository named in a PR URL rather than the repo in cwd", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(apiJson(pullRequestJson())));

      const tea = yield* GiteaCli.GiteaCli;
      yield* tea.getPullRequest({
        cwd: "/repo",
        reference: "https://git.example.com/other/project/pulls/7",
      });

      expect(lastArgs()).toEqual(["api", "-i", "repos/other/project/pulls/7"]);
    }),
  );

  it.effect("reports a merged pull request as merged, not closed", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(apiJson(pullRequestJson({ state: "closed", merged: true }))),
      );

      const tea = yield* GiteaCli.GiteaCli;
      const result = yield* tea.getPullRequest({ cwd: "/repo", reference: "42" });
      expect(result.state).toBe("merged");
    }),
  );

  it.effect("reports a closed, unmerged pull request as closed", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(apiJson(pullRequestJson({ state: "closed", merged: false }))),
      );

      const tea = yield* GiteaCli.GiteaCli;
      const result = yield* tea.getPullRequest({ cwd: "/repo", reference: "42" });
      expect(result.state).toBe("closed");
    }),
  );

  it.effect("marks a fork pull request as cross-repository", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          apiJson(
            pullRequestJson({
              head: {
                ref: "feature",
                label: "contributor:feature",
                repo: { full_name: "contributor/repo", owner: { login: "contributor" } },
              },
            }),
          ),
        ),
      );

      const tea = yield* GiteaCli.GiteaCli;
      const result = yield* tea.getPullRequest({ cwd: "/repo", reference: "42" });
      expect(result.isCrossRepository).toBe(true);
      expect(result.headRepositoryNameWithOwner).toBe("contributor/repo");
      expect(result.headRepositoryOwnerLogin).toBe("contributor");
      expect(result.headRefName).toBe("feature");
    }),
  );

  it.effect("derives the head branch from label when ref is absent", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          apiJson(pullRequestJson({ head: { label: "contributor:feature", repo: null } })),
        ),
      );

      const tea = yield* GiteaCli.GiteaCli;
      const result = yield* tea.getPullRequest({ cwd: "/repo", reference: "42" });
      expect(result.headRefName).toBe("feature");
    }),
  );

  it.effect("filters the list by head branch, which Gitea cannot do server side", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          apiJson([
            pullRequestJson({ number: 1, head: { ref: "other-branch", repo: null } }),
            pullRequestJson({ number: 2 }),
          ]),
        ),
      );

      const tea = yield* GiteaCli.GiteaCli;
      const result = yield* tea.listPullRequests({
        cwd: "/repo",
        headSelector: "t3code/abcd1234",
        state: "open",
      });

      expect(result.map((entry) => entry.number)).toEqual([2]);
      expect(lastArgs()[2]).toBe("repos/{owner}/{repo}/pulls?state=open&limit=50&page=1");
    }),
  );

  it.effect("returns an empty list when the repository has no pull requests", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(apiOutput("[]")));

      const tea = yield* GiteaCli.GiteaCli;
      const result = yield* tea.listPullRequests({
        cwd: "/repo",
        headSelector: "feature",
        state: "open",
      });

      expect(result).toEqual([]);
      expect(mockedRun).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("stops after one request when the first page is short", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(apiJson([pullRequestJson({ number: 9 })])));

      const tea = yield* GiteaCli.GiteaCli;
      yield* tea.listPullRequests({
        cwd: "/repo",
        headSelector: "nothing-matches",
        state: "open",
      });

      expect(mockedRun).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("walks to the next page when a full page holds no match", () =>
    Effect.gen(function* () {
      const fullPage = Array.from({ length: 50 }, (_unused, index) =>
        pullRequestJson({ number: index + 1, head: { ref: "unrelated", repo: null } }),
      );
      mockedRun.mockReturnValueOnce(Effect.succeed(apiJson(fullPage)));
      mockedRun.mockReturnValueOnce(Effect.succeed(apiJson([pullRequestJson({ number: 77 })])));

      const tea = yield* GiteaCli.GiteaCli;
      const result = yield* tea.listPullRequests({
        cwd: "/repo",
        headSelector: "t3code/abcd1234",
        state: "open",
      });

      expect(result.map((entry) => entry.number)).toEqual([77]);
      expect(mockedRun).toHaveBeenCalledTimes(2);
      expect(lastArgs()[2]).toBe("repos/{owner}/{repo}/pulls?state=open&limit=50&page=2");
    }),
  );

  it.effect("asks Gitea for closed PRs when merged ones are wanted, then keeps only merged", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          apiJson([
            pullRequestJson({ number: 3, state: "closed", merged: false }),
            pullRequestJson({ number: 4, state: "closed", merged: true }),
          ]),
        ),
      );

      const tea = yield* GiteaCli.GiteaCli;
      const result = yield* tea.listPullRequests({
        cwd: "/repo",
        headSelector: "t3code/abcd1234",
        state: "merged",
      });

      expect(result.map((entry) => entry.number)).toEqual([4]);
      expect(lastArgs()[2]).toContain("state=closed");
    }),
  );

  it.effect("excludes merged PRs from a closed-state query", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          apiJson([
            pullRequestJson({ number: 3, state: "closed", merged: false }),
            pullRequestJson({ number: 4, state: "closed", merged: true }),
          ]),
        ),
      );

      const tea = yield* GiteaCli.GiteaCli;
      const result = yield* tea.listPullRequests({
        cwd: "/repo",
        headSelector: "t3code/abcd1234",
        state: "closed",
      });

      expect(result.map((entry) => entry.number)).toEqual([3]);
    }),
  );

  it.effect("creates a pull request with the body passed as a file, never as argv", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(apiOutput("{}")));

      const tea = yield* GiteaCli.GiteaCli;
      yield* tea.createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "t3code/abcd1234",
        title: "Add widget",
        bodyFile: "/tmp/body.md",
      });

      expect(lastArgs()).toEqual([
        "api",
        "-i",
        "-X",
        "POST",
        "repos/{owner}/{repo}/pulls",
        "-f",
        "head=t3code/abcd1234",
        "-f",
        "base=main",
        "-f",
        "title=Add widget",
        "-F",
        "body=@/tmp/body.md",
      ]);
    }),
  );

  it.effect("creates a cross-repository pull request using Gitea's owner:branch head", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(apiOutput("{}")));

      const tea = yield* GiteaCli.GiteaCli;
      yield* tea.createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "contributor:feature",
        source: { owner: "contributor", refName: "feature" },
        title: "Add widget",
        bodyFile: "/tmp/body.md",
      });

      expect(lastArgs()).toContain("head=contributor:feature");
    }),
  );

  it.effect("reads the repository default branch", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(apiJson({ default_branch: "trunk" })));

      const tea = yield* GiteaCli.GiteaCli;
      expect(yield* tea.getDefaultBranch({ cwd: "/repo" })).toBe("trunk");
      expect(lastArgs()).toEqual(["api", "-i", "repos/{owner}/{repo}"]);
    }),
  );

  it.effect("returns null when the repository reports no default branch", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(apiOutput("{}")));

      const tea = yield* GiteaCli.GiteaCli;
      expect(yield* tea.getDefaultBranch({ cwd: "/repo" })).toBeNull();
    }),
  );

  it.effect("maps clone URLs from clone_url and ssh_url", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          apiJson({
            full_name: "owner/repo",
            clone_url: "https://git.example.com/owner/repo.git",
            ssh_url: "git@git.example.com:owner/repo.git",
            html_url: "https://git.example.com/owner/repo",
          }),
        ),
      );

      const tea = yield* GiteaCli.GiteaCli;
      const result = yield* tea.getRepositoryCloneUrls({ cwd: "/repo", repository: "owner/repo" });

      assert.deepStrictEqual(result, {
        nameWithOwner: "owner/repo",
        // The browser URL would not work as a git remote, so clone_url is the one that matters.
        url: "https://git.example.com/owner/repo.git",
        sshUrl: "git@git.example.com:owner/repo.git",
      });
      expect(lastArgs()).toEqual(["api", "-i", "repos/owner/repo"]);
    }),
  );

  it.effect("creates a repository for the authenticated user when no owner is given", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          apiJson({
            full_name: "mario/widget",
            clone_url: "https://git.example.com/mario/widget.git",
            ssh_url: "git@git.example.com:mario/widget.git",
          }),
        ),
      );

      const tea = yield* GiteaCli.GiteaCli;
      yield* tea.createRepository({ cwd: "/repo", repository: "widget", visibility: "private" });

      expect(lastArgs()).toEqual([
        "api",
        "-i",
        "-X",
        "POST",
        "user/repos",
        "-f",
        "name=widget",
        "-F",
        "private=true",
      ]);
    }),
  );

  it.effect("creates a repository under an organization when an owner is given", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          apiJson({
            full_name: "acme/widget",
            clone_url: "https://git.example.com/acme/widget.git",
            ssh_url: "git@git.example.com:acme/widget.git",
          }),
        ),
      );

      const tea = yield* GiteaCli.GiteaCli;
      yield* tea.createRepository({
        cwd: "/repo",
        repository: "acme/widget",
        visibility: "public",
      });

      expect(lastArgs()).toEqual([
        "api",
        "-i",
        "-X",
        "POST",
        "orgs/acme/repos",
        "-f",
        "name=widget",
        "-F",
        "private=false",
      ]);
    }),
  );

  it.effect("checks out a pull request through tea, creating the local branch", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(apiOutput("")));

      const tea = yield* GiteaCli.GiteaCli;
      yield* tea.checkoutPullRequest({ cwd: "/repo", reference: "42" });

      expect(lastArgs()).toEqual(["pulls", "checkout", "42", "--branch"]);
    }),
  );

  it.effect("checks out by index when handed a full PR URL", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(apiOutput("")));

      const tea = yield* GiteaCli.GiteaCli;
      yield* tea.checkoutPullRequest({
        cwd: "/repo",
        reference: "https://git.example.com/owner/repo/pulls/42",
      });

      expect(lastArgs()).toEqual(["pulls", "checkout", "42", "--branch"]);
    }),
  );
});

layer("GiteaCli failures", (it) => {
  // These are the cases that matter most: tea exits 0 on HTTP errors, so without status parsing a
  // 404 would decode as "no pull request" and T3 would open a duplicate PR.
  it.effect("turns HTTP 404 into a not-found error rather than an empty result", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(apiOutput('{"message":"The target couldn\'t be found."}', 404)),
      );

      const tea = yield* GiteaCli.GiteaCli;
      const error = yield* Effect.flip(tea.getPullRequest({ cwd: "/repo", reference: "42" }));

      expect(error._tag).toBe("GiteaPullRequestNotFoundError");
    }),
  );

  it.effect("turns HTTP 401 and 403 into authentication errors", () =>
    Effect.gen(function* () {
      const tea = yield* GiteaCli.GiteaCli;

      for (const status of [401, 403]) {
        mockedRun.mockReturnValueOnce(Effect.succeed(apiOutput('{"message":"no"}', status)));
        const error = yield* Effect.flip(tea.getDefaultBranch({ cwd: "/repo" }));
        expect(error._tag).toBe("GiteaCliAuthenticationError");
      }
    }),
  );

  it.effect("turns HTTP 429 into a rate limit error", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(apiOutput('{"message":"slow down"}', 429)));

      const tea = yield* GiteaCli.GiteaCli;
      const error = yield* Effect.flip(tea.getDefaultBranch({ cwd: "/repo" }));

      expect(error._tag).toBe("GiteaCliRateLimitError");
    }),
  );

  it.effect("turns other HTTP failures into command errors", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(apiOutput('{"message":"boom"}', 500)));

      const tea = yield* GiteaCli.GiteaCli;
      const error = yield* Effect.flip(tea.getDefaultBranch({ cwd: "/repo" }));

      expect(error._tag).toBe("GiteaCliCommandError");
    }),
  );

  it.effect("fails a create when the API rejects it, so no duplicate PR is silently assumed", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(apiOutput('{"message":"conflict"}', 409)));

      const tea = yield* GiteaCli.GiteaCli;
      const error = yield* Effect.flip(
        tea.createPullRequest({
          cwd: "/repo",
          baseBranch: "main",
          headSelector: "feature",
          title: "t",
          bodyFile: "/tmp/b.md",
        }),
      );

      expect(error._tag).toBe("GiteaCliCommandError");
    }),
  );

  it.effect("reports a missing tea executable as unavailable", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessSpawnError({
            operation: "GiteaCli.execute",
            command: "tea",
            cwd: "/repo",
            argumentCount: 3,
            cause: new Error("spawn tea ENOENT"),
          }),
        ),
      );

      const tea = yield* GiteaCli.GiteaCli;
      const error = yield* Effect.flip(tea.getDefaultBranch({ cwd: "/repo" }));

      expect(error._tag).toBe("GiteaCliUnavailableError");
    }),
  );

  it.effect("maps a non-zero tea exit during checkout to a not-found error", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessExitError({
            operation: "GiteaCli.execute",
            command: "tea",
            cwd: "/repo",
            argumentCount: 4,
            exitCode: ChildProcessSpawner.ExitCode(1),
            detail: "pull request not found",
            failureKind: "not-found",
          }),
        ),
      );

      const tea = yield* GiteaCli.GiteaCli;
      const error = yield* Effect.flip(
        tea.checkoutPullRequest({ cwd: "/repo", reference: "9999" }),
      );

      expect(error._tag).toBe("GiteaPullRequestNotFoundError");
    }),
  );

  it.effect("rejects a reference that is neither an index nor a PR URL", () =>
    Effect.gen(function* () {
      const tea = yield* GiteaCli.GiteaCli;
      const error = yield* Effect.flip(
        tea.getPullRequest({ cwd: "/repo", reference: "definitely-not-a-pr" }),
      );

      expect(error._tag).toBe("GiteaPullRequestNotFoundError");
      expect(mockedRun).not.toHaveBeenCalled();
    }),
  );

  it.effect("fails on invalid JSON instead of returning a half-decoded pull request", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(apiOutput("not json")));

      const tea = yield* GiteaCli.GiteaCli;
      const error = yield* Effect.flip(tea.getPullRequest({ cwd: "/repo", reference: "42" }));

      expect(error._tag).toBe("GiteaPullRequestDecodeError");
    }),
  );

  it.effect("fails when required pull request fields are missing", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(apiJson({ number: 42 })));

      const tea = yield* GiteaCli.GiteaCli;
      const error = yield* Effect.flip(tea.getPullRequest({ cwd: "/repo", reference: "42" }));

      expect(error._tag).toBe("GiteaPullRequestDecodeError");
    }),
  );

  it.effect("skips malformed entries in a list rather than failing the whole refresh", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(apiJson([{ number: "not a number" }, pullRequestJson({ number: 5 })])),
      );

      const tea = yield* GiteaCli.GiteaCli;
      const result = yield* tea.listPullRequests({
        cwd: "/repo",
        headSelector: "t3code/abcd1234",
        state: "open",
      });

      expect(result.map((entry) => entry.number)).toEqual([5]);
    }),
  );

  it.effect("fails when the list is not JSON at all", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(apiOutput("<html>error</html>")));

      const tea = yield* GiteaCli.GiteaCli;
      const error = yield* Effect.flip(
        tea.listPullRequests({ cwd: "/repo", headSelector: "x", state: "open" }),
      );

      expect(error._tag).toBe("GiteaPullRequestListDecodeError");
    }),
  );
});

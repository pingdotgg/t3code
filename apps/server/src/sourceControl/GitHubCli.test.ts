import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const processOutput = (stdout: string, exitCode = 0): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const remotesOutput = (...entries: ReadonlyArray<readonly [string, string]>) =>
  entries
    .flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
    .join("\n");

const restResponse = (body: unknown, status = 200): GitHubApi.GitHubRestResponse => ({
  status,
  headers: {},
  body: body === undefined ? "" : encodeJson(body),
  truncated: false,
  invalidUtf8: false,
});

const node = (number: number, headRefName: string, owner = "acme") => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  baseRefName: "main",
  headRefName,
  state: "OPEN",
  isCrossRepository: owner !== "acme",
  updatedAt: "2026-01-02T00:00:00Z",
  headRepository: { name: "web", nameWithOwner: `${owner}/web` },
  headRepositoryOwner: { login: owner },
});

/**
 * A GitHubCli over a mocked GitHubApi, git driver and process. `remotes` is what
 * `git remote -v` prints; `git` records every driver call.
 */
function harness(input: {
  readonly remotes: string;
  readonly api: Partial<GitHubApi.GitHubApi["Service"]>;
  readonly localBranches?: ReadonlyArray<string>;
}) {
  const git: Array<readonly [string, unknown]> = [];
  const record =
    <A>(name: string, value: A) =>
    (args: unknown) =>
      Effect.sync(() => {
        git.push([name, args]);
        return value;
      });
  const driver = Layer.mock(GitVcsDriver.GitVcsDriver)({
    execute: (args) =>
      Effect.sync(() => {
        git.push(["execute", args.args]);
        return processOutput("");
      }),
    resolvePrimaryRemoteName: () => Effect.succeed("origin"),
    readConfigValue: () => Effect.succeed("git@github.com:acme/web.git"),
    ensureRemote: (args) =>
      Effect.sync(() => {
        git.push(["ensureRemote", args]);
        return args.preferredName;
      }),
    fetchRemoteTrackingBranch: (args) => record("fetchRemoteTrackingBranch", undefined)(args),
    setBranchUpstream: (args) => record("setBranchUpstream", undefined)(args),
    switchRef: (args) => record("switchRef", { refName: args.refName })(args) as never,
    listLocalBranchNames: () => Effect.succeed([...(input.localBranches ?? [])]),
    resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
  });
  const process = Layer.mock(VcsProcess.VcsProcess)({
    run: (args) =>
      Effect.succeed(
        args.args[0] === "remote" ? processOutput(input.remotes) : processOutput("", 1),
      ),
  });
  const layer = Layer.effect(GitHubCli.GitHubCli, GitHubCli.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        driver,
        process,
        Layer.mock(GitHubApi.GitHubApi)(input.api),
        NodeServices.layer,
      ),
    ),
  );
  return { layer, git };
}

describe("selectGitHubBaseRepository", () => {
  const remotes = (...entries: ReadonlyArray<readonly [string, string]>) =>
    entries
      .flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
      .join("\n");
  const select = (input: { remotes: string; resolved?: string }) =>
    GitHubCli.selectGitHubBaseRepository({ resolved: "", host: "github.com", ...input });

  it("picks the repository gh reads without a prompt", () => {
    assert.deepStrictEqual(select({ remotes: remotes(["fork", "git@github.com:me/web.git"]) }), {
      owner: "me",
      name: "web",
    });
    const fork = remotes(
      ["origin", "git@github.com:me/web.git"],
      ["upstream", "https://github.com/Acme/Web.git"],
    );
    assert.deepStrictEqual(select({ remotes: fork }), { owner: "acme", name: "web" });
    assert.deepStrictEqual(select({ remotes: fork, resolved: "remote.origin.gh-resolved base" }), {
      owner: "me",
      name: "web",
    });
    assert.deepStrictEqual(
      select({ remotes: fork, resolved: "remote.origin.gh-resolved acme/other" }),
      { owner: "acme", name: "other" },
    );
    // gh ranks remote names in any case.
    assert.deepStrictEqual(
      select({
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["Upstream", "git@github.com:acme/web.git"],
        ),
      }),
      { owner: "acme", name: "web" },
    );
  });

  it("leaves gh to choose when it might weigh the remotes differently", () => {
    for (const input of [
      { remotes: "" },
      {
        remotes: remotes(["a", "git@github.com:me/web.git"], ["b", "git@github.com:acme/web.git"]),
      },
      {
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["mirror", "git@gitlab.com:me/web.git"],
        ),
      },
      { remotes: remotes(["origin", "git@github-work:me/web.git"]) },
      {
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["Origin", "git@github.com:acme/web.git"],
        ),
      },
      {
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["upstream", "git@github.com:acme/web.git"],
        ),
        resolved: "remote.origin.gh-resolved base\nremote.upstream.gh-resolved base",
      },
    ]) {
      assert.strictEqual(select(input), null);
    }
  });
});

describe("GitHubCli repository resolution", () => {
  it.effect("reads the repository gh would pick from the remotes", () => {
    const paths: string[] = [];
    const { layer } = harness({
      remotes: remotesOutput(
        ["origin", "git@github.com:me/web.git"],
        ["upstream", "https://github.com/acme/web.git"],
      ),
      api: {
        rest: (input) =>
          Effect.sync(() => {
            paths.push(`${input.host} ${input.path}`);
            return restResponse({
              full_name: "acme/web",
              html_url: "https://github.com/acme/web",
              ssh_url: "git@github.com:acme/web.git",
              default_branch: "trunk",
            });
          }),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      assert.strictEqual(yield* gh.getDefaultBranch({ cwd: "/repo" }), "trunk");
      assert.deepStrictEqual(paths, ["github.com repos/acme/web"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads an SSH alias remote through github.com", () => {
    const hosts: string[] = [];
    const { layer } = harness({
      remotes: remotesOutput(["origin", "git@github:acme/web.git"]),
      api: {
        rest: (input) =>
          Effect.sync(() => {
            hosts.push(`${input.host} ${input.path}`);
            return restResponse({
              full_name: "acme/web",
              html_url: "https://github.com/acme/web",
              ssh_url: "git@github.com:acme/web.git",
              default_branch: "main",
            });
          }),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.getDefaultBranch({ cwd: "/repo" });
      // A provider's host hint for the same alias (`github` here) resolves the same way.
      yield* gh.getDefaultBranch({ cwd: "/repo", rateLimitHost: "github" });
      assert.deepStrictEqual(hosts, ["github.com repos/acme/web", "github.com repos/acme/web"]);
      assert.strictEqual(
        GitHubCli.gitHubApiHostForRemote("git@github.example.com:a/b.git"),
        "github.example.com",
      );
      assert.strictEqual(GitHubCli.gitHubApiHostForRemote("git@gitlab.com:a/b.git"), null);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails clearly when no remote is on GitHub", () => {
    const { layer } = harness({
      remotes: remotesOutput(["origin", "git@gitlab.com:a/b.git"]),
      api: {},
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh.getDefaultBranch({ cwd: "/repo" }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubCliCommandError");
      assert.include(String((error.cause as Error).message), "No GitHub repository");
    }).pipe(Effect.provide(layer));
  });
});

describe("GitHubCli.listPullRequestsByHead", () => {
  const remotes = remotesOutput(["origin", "git@github.com:acme/web.git"]);

  it.effect("reads a background sweep's staggered heads in one GraphQL document", () => {
    const documents: Array<GitHubApi.GitHubGraphQlInput> = [];
    const { layer } = harness({
      remotes,
      api: {
        graphql: (input) =>
          Effect.sync(() => {
            documents.push(input);
            return encodeJson({
              data: { repository: { h0: { nodes: [node(7, "feature/a")] }, h1: { nodes: [] } } },
            });
          }),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      const lookup = (headSelector: string) =>
        gh
          .listPullRequestsByHead({
            cwd: "/repo",
            headSelector,
            state: "all",
            limit: 100,
            rateLimitHost: "github.com",
          })
          .pipe(Effect.forkChild);
      // Each branch's own git reads come first, so a sweep's lookups arrive spread out.
      const firstLookup = yield* lookup("feature/a");
      yield* TestClock.adjust("200 millis");
      const secondLookup = yield* lookup("feature/b");
      yield* TestClock.adjust("300 millis");
      const first = yield* Fiber.join(firstLookup);
      const second = yield* Fiber.join(secondLookup);
      assert.deepStrictEqual(
        first?.map((pr) => pr.number),
        [7],
      );
      assert.deepStrictEqual(second, []);
      assert.strictEqual(documents.length, 1);
      assert.deepStrictEqual(documents[0]!.variables, {
        owner: "acme",
        name: "web",
        h0: "feature/a",
        s0: ["OPEN", "CLOSED", "MERGED"],
        h1: "feature/b",
        s1: ["OPEN", "CLOSED", "MERGED"],
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("caps a background document at twenty-five heads", () => {
    const headCounts: Array<number> = [];
    const { layer } = harness({
      remotes,
      api: {
        graphql: (input) =>
          Effect.sync(() => {
            const heads = Object.keys(input.variables ?? {}).filter((key) => /^h\d+$/.test(key));
            headCounts.push(heads.length);
            return encodeJson({
              data: { repository: Object.fromEntries(heads.map((key) => [key, { nodes: [] }])) },
            });
          }),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      const lookups = yield* Effect.all(
        Array.from({ length: 26 }, (_, index) =>
          gh.listPullRequestsByHead({
            cwd: "/repo",
            headSelector: `feature/${index}`,
            state: "all",
            limit: 100,
            rateLimitHost: "github.com",
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(lookups);
      assert.deepStrictEqual(
        headCounts.toSorted((a, b) => a - b),
        [1, 25],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("matches an owner:branch selector on the head owner", () => {
    const { layer } = harness({
      remotes,
      api: {
        graphql: (input) =>
          Effect.succeed(
            encodeJson({
              data: {
                repository: {
                  h0: {
                    nodes:
                      input.variables?.h0 === "main"
                        ? [node(9, "main", "someone"), node(8, "main", "me"), node(7, "main", "me")]
                        : [],
                  },
                },
              },
            }),
          ),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      const open = yield* gh
        .listOpenPullRequests({ cwd: "/repo", headSelector: "me:main", limit: 1 })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("50 millis");
      assert.deepStrictEqual(
        (yield* Fiber.join(open)).map((pr) => pr.number),
        [8],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps API failures onto the errors callers handle", () => {
    const { layer } = harness({
      remotes,
      api: {
        graphql: (input) =>
          Effect.fail(
            input.variables?.h0 === "missing"
              ? new GitHubCredentials.GitHubCliMissingError({ host: "github.com" })
              : new GitHubApi.GitHubApiRateLimitError({
                  host: "github.com",
                  operation: "x",
                  retryAt: 123,
                }),
          ),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      const read = (headSelector: string) =>
        gh
          .listPullRequestsByHead({ cwd: "/repo", headSelector, state: "open", limit: 1 })
          .pipe(Effect.flip, Effect.forkChild);
      const missing = yield* read("missing");
      yield* TestClock.adjust("500 millis");
      assert.strictEqual((yield* Fiber.join(missing))._tag, "GitHubCliUnavailableError");
      const limited = yield* read("limited");
      yield* TestClock.adjust("500 millis");
      const error = yield* Fiber.join(limited);
      assert.strictEqual(error._tag, "GitHubCliRateLimitError");
      assert.propertyVal(error, "retryAt", 123);
    }).pipe(Effect.provide(layer));
  });
});

describe("GitHubCli.getPullRequest", () => {
  it.effect("reads a pull request by number, and by URL on its own repository", () => {
    const variables: Array<unknown> = [];
    const { layer } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      api: {
        graphql: (input) =>
          Effect.sync(() => {
            variables.push(input.variables);
            return encodeJson({ data: { repository: { pullRequest: node(42, "feature") } } });
          }),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      assert.strictEqual((yield* gh.getPullRequest({ cwd: "/repo", reference: "#42" })).number, 42);
      yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "https://github.com/other/thing/pull/42",
      });
      assert.deepStrictEqual(variables, [
        { owner: "acme", name: "web", number: 42 },
        { owner: "other", name: "thing", number: 42 },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a missing pull request as not found", () => {
    const { layer } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      api: {
        graphql: () => Effect.succeed(encodeJson({ data: { repository: { pullRequest: null } } })),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh.getPullRequest({ cwd: "/repo", reference: "7" }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubPullRequestNotFoundError");
    }).pipe(Effect.provide(layer));
  });
});

describe("GitHubCli writes", () => {
  it.effect("creates a cross-repository pull request with an owner:branch head", () => {
    const requests: Array<GitHubApi.GitHubRestInput> = [];
    const { layer } = harness({
      remotes: remotesOutput(
        ["origin", "git@github.com:me/web.git"],
        ["upstream", "git@github.com:acme/web.git"],
      ),
      api: {
        rest: (input) =>
          Effect.sync(() => {
            requests.push(input);
            return restResponse({ number: 1 }, 201);
          }),
      },
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bodyFile = yield* fs.makeTempFileScoped({ suffix: ".md" });
      yield* fs.writeFileString(bodyFile, "Body");
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "me:feature",
        title: "Title",
        bodyFile,
      });
      assert.strictEqual(requests[0]!.method, "POST");
      assert.strictEqual(requests[0]!.path, "repos/acme/web/pulls");
      assert.deepStrictEqual(requests[0]!.body, {
        base: "main",
        head: "me:feature",
        title: "Title",
        body: "Body",
        maintainer_can_modify: true,
      });
    }).pipe(Effect.provide(Layer.merge(layer, NodeServices.layer)), Effect.scoped);
  });

  it.effect("creates a repository under an organization the viewer is not", () => {
    const requests: Array<string> = [];
    const { layer } = harness({
      remotes: "",
      api: {
        rest: (input) =>
          Effect.sync(() => {
            requests.push(`${input.method ?? "GET"} ${input.path}`);
            return input.path === "user"
              ? restResponse({ login: "me" })
              : restResponse({
                  full_name: "acme/new",
                  html_url: "https://github.com/acme/new",
                  ssh_url: "git@github.com:acme/new.git",
                });
          }),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      const urls = yield* gh.createRepository({
        cwd: "/repo",
        repository: "acme/new",
        visibility: "private",
      });
      assert.deepStrictEqual(urls, {
        nameWithOwner: "acme/new",
        url: "https://github.com/acme/new",
        sshUrl: "git@github.com:acme/new.git",
      });
      assert.deepStrictEqual(requests, ["GET user", "POST orgs/acme/repos"]);
    }).pipe(Effect.provide(layer));
  });
});

describe("GitHubCli.checkoutPullRequest", () => {
  const repository = (fullName: string, defaultBranch = "main") =>
    restResponse({
      full_name: fullName,
      html_url: `https://github.com/${fullName}`,
      ssh_url: `git@github.com:${fullName}.git`,
      default_branch: defaultBranch,
    });

  it.effect("checks a same-repository pull request out from its head branch", () => {
    const { layer, git } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      api: {
        graphql: () =>
          Effect.succeed(
            encodeJson({ data: { repository: { pullRequest: node(5, "feature/x") } } }),
          ),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.checkoutPullRequest({ cwd: "/repo", reference: "5" });
      assert.deepStrictEqual(git, [
        [
          "fetchRemoteTrackingBranch",
          { cwd: "/repo", remoteName: "origin", remoteBranch: "feature/x" },
        ],
        ["execute", ["branch", "feature/x", "refs/remotes/origin/feature/x"]],
        ["switchRef", { cwd: "/repo", refName: "feature/x" }],
        [
          "setBranchUpstream",
          { cwd: "/repo", branch: "feature/x", remoteName: "origin", remoteBranch: "feature/x" },
        ],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a fork checkout when the base's default branch cannot be read", () => {
    const { layer, git } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      localBranches: ["main"],
      api: {
        graphql: () =>
          Effect.succeed(
            encodeJson({ data: { repository: { pullRequest: node(6, "main", "someone") } } }),
          ),
        rest: () =>
          Effect.fail(
            new GitHubApi.GitHubApiRequestError({
              host: "github.com",
              operation: "x",
              cause: "offline",
            }),
          ),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      yield* Effect.flip(gh.checkoutPullRequest({ cwd: "/repo", reference: "6", force: true }));
      // Nothing touched the local branches: `main` must not be reset to the fork's commit.
      assert.deepStrictEqual(git, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("adds a remote for a fork and names a default-branch head after its owner", () => {
    const { layer, git } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      localBranches: ["someone/main"],
      api: {
        graphql: () =>
          Effect.succeed(
            encodeJson({ data: { repository: { pullRequest: node(6, "main", "someone") } } }),
          ),
        rest: (input) =>
          Effect.succeed(repository(input.path === "repos/acme/web" ? "acme/web" : "someone/web")),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.checkoutPullRequest({ cwd: "/repo", reference: "6", force: true });
      assert.deepStrictEqual(git, [
        [
          "ensureRemote",
          { cwd: "/repo", preferredName: "someone", url: "git@github.com:someone/web.git" },
        ],
        [
          "fetchRemoteTrackingBranch",
          { cwd: "/repo", remoteName: "someone", remoteBranch: "main" },
        ],
        ["switchRef", { cwd: "/repo", refName: "someone/main" }],
        ["execute", ["reset", "--hard", "--quiet", "refs/remotes/someone/main"]],
        [
          "setBranchUpstream",
          { cwd: "/repo", branch: "someone/main", remoteName: "someone", remoteBranch: "main" },
        ],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it("names the local branch the way gh pr checkout does", () => {
    const name = (headRefName: string, isCrossRepository: boolean) =>
      GitHubCli.pullRequestCheckoutBranchName({
        headRefName,
        headOwner: "someone",
        isCrossRepository,
        defaultBranch: "main",
      });
    assert.strictEqual(name("main", true), "someone/main");
    assert.strictEqual(name("feature", true), "feature");
    assert.strictEqual(name("main", false), "main");
  });
});

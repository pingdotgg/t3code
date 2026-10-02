import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Cache from "effect/Cache";
import * as TestClock from "effect/testing/TestClock";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitHubGraphQlBudget from "./githubGraphQlBudget.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";

const encodeGitHubCliError = Schema.encodeEffect(Schema.fromJsonString(GitHubCli.GitHubCliError));

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const quotaOutput = (remaining = 5000, resetAt = "2099-01-01T00:00:00Z") =>
  processOutput(
    JSON.stringify({ data: { rateLimit: { cost: 1, limit: 5000, remaining, resetAt } } }),
  );

const isBudgetReading = (input: VcsProcess.VcsProcessInput) =>
  input.args[0] === "api" &&
  input.args[1] === "graphql" &&
  input.args.at(-1)?.includes("rateLimit");

const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();

// Budget readings are answered here, so `mockRun` sees only the commands under test.
const layer = GitHubCli.layer.pipe(
  Layer.provide(
    Layer.mock(VcsProcess.VcsProcess)({
      run: (input) => (isBudgetReading(input) ? Effect.succeed(quotaOutput()) : mockRun(input)),
    }),
  ),
);

afterEach(() => {
  mockRun.mockReset();
});

it.effect("reads the GraphQL budget once per window, preserves the reserve, and resumes", () =>
  Effect.gen(function* () {
    let readings = 0;
    const commands: string[] = [];
    let remaining = 501;
    let resetAt = DateTime.formatIso(
      DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 60_000),
    );
    const gh = yield* GitHubCli.make.pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) =>
          Effect.sync(() => {
            if (isBudgetReading(input)) {
              readings++;
              assert.strictEqual(input.args[3], "enterprise.test");
              return quotaOutput(remaining, resetAt);
            }
            commands.push(input.args.slice(0, 2).join(" "));
            return processOutput("[]");
          }),
      }),
    );
    const read = (command: string) =>
      gh.execute({
        cwd: "/repo",
        args:
          command === "repo"
            ? ["repo", "view", "enterprise.test/acme/web", "--json", "name"]
            : ["pr", command, "--repo=enterprise.test/acme/web", "--json", "number"],
      });
    yield* read("list");
    const failure = yield* read("view").pipe(Effect.flip);
    assert.strictEqual(failure._tag, "GitHubCliRateLimitError");
    assert.deepStrictEqual(commands, ["pr list"]);
    yield* read("view").pipe(Effect.provideService(GitHubCli.AllowGitHubReserve, true));
    yield* gh.execute({ cwd: "/repo", args: ["pr", "merge", "1"] });
    assert.deepStrictEqual(commands, ["pr list", "pr view", "pr merge"]);
    // One reading covers the whole window.
    assert.strictEqual(readings, 1);
    yield* TestClock.adjust("1 minute");
    remaining = 5000;
    resetAt = DateTime.formatIso(DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 60_000));
    yield* Effect.all([read("list"), read("repo")], { concurrency: 2 });
    assert.strictEqual(readings, 2);
    assert.deepStrictEqual(commands.slice(3).toSorted(), ["pr list", "repo view"]);
  }).pipe(Effect.provide(Layer.merge(GitHubGraphQlBudget.layer, SourceControlRateLimit.layer))),
);

it.effect("reads the budget again at a near reset, and every ten minutes in a long window", () =>
  Effect.gen(function* () {
    let readings = 0;
    const startedAt = yield* Clock.currentTimeMillis;
    let resetAt = DateTime.formatIso(DateTime.makeUnsafe(startedAt + 10_000));
    const gh = yield* GitHubCli.make.pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) =>
          Effect.sync(() => {
            if (!isBudgetReading(input)) return processOutput("[]");
            readings++;
            return quotaOutput(5000, resetAt);
          }),
      }),
    );
    const read = gh.execute({ cwd: "/repo", args: ["pr", "list"] });
    yield* read;
    // The window resets ten seconds in, so the reading expires with it.
    resetAt = DateTime.formatIso(DateTime.makeUnsafe(startedAt + 10_000 + 3_600_000));
    yield* TestClock.adjust("10 seconds");
    yield* read;
    assert.strictEqual(readings, 2);
    yield* TestClock.adjust("9 minutes");
    yield* read;
    assert.strictEqual(readings, 2);
    yield* TestClock.adjust("1 minute");
    yield* read;
    assert.strictEqual(readings, 3);
  }).pipe(Effect.provide(Layer.merge(GitHubGraphQlBudget.layer, SourceControlRateLimit.layer))),
);

it.effect("reads anyway when the budget reading fails", () =>
  Effect.gen(function* () {
    const gh = yield* GitHubCli.make.pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) =>
          isBudgetReading(input)
            ? Effect.fail(
                new VcsProcessSpawnError({
                  operation: "GitHubCli.execute",
                  command: "gh",
                  cwd: "/gone",
                  cause: new Error("ENOENT"),
                }),
              )
            : Effect.succeed(processOutput("[]")),
      }),
    );
    const result = yield* gh.execute({ cwd: "/repo", args: ["pr", "list"] });
    assert.strictEqual(result.stdout, "[]");
  }).pipe(Effect.provide(Layer.merge(GitHubGraphQlBudget.layer, SourceControlRateLimit.layer))),
);

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

describe("GitHubCli.listPullRequestsByHead", () => {
  const remoteOutput =
    "origin\tgit@github.com:acme/web.git (fetch)\norigin\tgit@github.com:acme/web.git (push)\n";
  const node = (number: number, headRefName: string) => ({
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/web/pull/${number}`,
    baseRefName: "main",
    headRefName,
    state: "MERGED",
    mergedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    headRepository: { name: "web", nameWithOwner: "acme/web" },
    headRepositoryOwner: { login: "acme" },
  });
  const decodeRequest = Schema.decodeSync(
    Schema.fromJsonString(
      Schema.Struct({
        query: Schema.String,
        variables: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  );
  const jsonOutput = (value: unknown) => processOutput(JSON.stringify(value));
  const git = (input: VcsProcess.VcsProcessInput) =>
    input.args[0] === "remote"
      ? processOutput(remoteOutput)
      : { ...processOutput(""), exitCode: ChildProcessSpawner.ExitCode(1) };

  it.effect("reads heads on one repository in one GraphQL document", () =>
    Effect.gen(function* () {
      const documents: Array<{ query: string; variables: Record<string, unknown> }> = [];
      mockRun.mockImplementation((input) =>
        Effect.sync(() => {
          if (input.command === "git") return git(input);
          documents.push(decodeRequest(input.stdin ?? ""));
          return jsonOutput({
            data: {
              repository: { h0: { nodes: [node(7, "feature/a")] }, h1: { nodes: [] } },
              rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: "2099-01-01T00:00:00Z" },
            },
          });
        }),
      );
      const gh = yield* GitHubCli.GitHubCli;
      const lookups = yield* Effect.all(
        ["feature/a", "feature/b"].map((headSelector) =>
          gh.listPullRequestsByHead({
            cwd: "/repo",
            headSelector,
            state: "all",
            limit: 100,
            rateLimitHost: "github.com",
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("50 millis");
      const [first, second] = yield* Fiber.join(lookups);
      assert.deepStrictEqual(
        first?.map((pr) => [pr.number, pr.state, pr.headRepositoryNameWithOwner]),
        [[7, "merged", "acme/web"]],
      );
      assert.deepStrictEqual(second, []);
      assert.strictEqual(documents.length, 1);
      assert.include(documents[0]!.query, "rateLimit");
      assert.deepStrictEqual(documents[0]!.variables, {
        owner: "acme",
        name: "web",
        h0: "feature/a",
        s0: ["OPEN", "CLOSED", "MERGED"],
        h1: "feature/b",
        s1: ["OPEN", "CLOSED", "MERGED"],
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("asks gh pr list when gh could read another repository", () =>
    Effect.gen(function* () {
      const commands: Array<ReadonlyArray<string>> = [];
      mockRun.mockImplementation((input) =>
        Effect.sync(() => {
          commands.push([input.command, ...input.args]);
          if (input.command === "git") {
            return processOutput(
              input.args[0] === "remote"
                ? "a\tgit@github.com:me/web.git (fetch)\nb\tgit@github.com:acme/web.git (fetch)\n"
                : "",
            );
          }
          return input.args[3] === "feature/empty"
            ? processOutput("")
            : jsonOutput([node(8, "feature/a")]);
        }),
      );
      const gh = yield* GitHubCli.GitHubCli;
      const pullRequests = yield* gh.listPullRequestsByHead({
        cwd: "/repo",
        headSelector: "feature/a",
        state: "all",
        limit: 100,
        rateLimitHost: "github.com",
      });
      assert.deepStrictEqual(
        pullRequests.map((pr) => pr.number),
        [8],
      );
      assert.deepStrictEqual(commands.at(-1), [
        "gh",
        "pr",
        "list",
        "--head",
        "feature/a",
        "--state",
        "all",
        "--limit",
        "100",
        "--json",
        "number,title,url,baseRefName,headRefName,headRefOid,state,isDraft,mergedAt,closedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
      ]);
      const empty = yield* gh.listPullRequestsByHead({
        cwd: "/repo",
        headSelector: "feature/empty",
        state: "all",
        limit: 100,
        rateLimitHost: "github.com",
      });
      assert.deepStrictEqual(empty, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails a rate-limited document whole instead of asking head by head", () =>
    Effect.gen(function* () {
      let ghCalls = 0;
      mockRun.mockImplementation((input) => {
        if (input.command === "git") return Effect.succeed(git(input));
        ghCalls++;
        return Effect.fail(
          new VcsProcessExitError({
            operation: "GitHubCli.execute",
            command: "gh",
            cwd: "/repo",
            exitCode: 1,
            failureKind: "rate-limited",
            detail: "API rate limit exceeded.",
            stderrLength: 24,
            stderrTruncated: false,
          }),
        );
      });
      const gh = yield* GitHubCli.GitHubCli;
      const lookups = yield* Effect.all(
        ["feature/a", "feature/b"].map((headSelector) =>
          gh
            .listPullRequestsByHead({
              cwd: "/repo",
              headSelector,
              state: "all",
              limit: 100,
              rateLimitHost: "github.com",
            })
            .pipe(Effect.flip),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("50 millis");
      const errors = yield* Fiber.join(lookups);
      assert.deepStrictEqual(
        errors.map((error) => error._tag),
        ["GitHubCliRateLimitError", "GitHubCliRateLimitError"],
      );
      assert.strictEqual(ghCalls, 1);
    }).pipe(Effect.provide(layer)),
  );
});

describe("GitHubCli.layer", () => {
  it.effect("shares the registry budget with CLI reads through nested layer providers", () =>
    Effect.gen(function* () {
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      const gh = yield* GitHubCli.GitHubCli;
      yield* budget.observe("github.com", quotaOutput(0).stdout);
      const error = yield* gh.execute({ cwd: "/repo", args: ["pr", "list"] }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubCliRateLimitError");
      expect(mockRun).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer.pipe(Layer.provide(GitHubGraphQlBudget.layer)))),
  );

  it.effect("keeps quota snapshots separate for verified credentials on the same host", () =>
    Effect.gen(function* () {
      let reads = 0;
      const gh = yield* GitHubCli.make.pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) =>
            Effect.sync(() => {
              if (isBudgetReading(input)) {
                return quotaOutput(input.env?.GH_TOKEN === "empty" ? 0 : 5000);
              }
              reads++;
              return processOutput("[]");
            }),
        }),
      );
      const read = (token: string) =>
        gh.execute({ cwd: "/repo", args: ["pr", "list", "--repo", "github.com/acme/web"] }).pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, {
            host: "github.com",
            token: Redacted.make(token),
            credentialFingerprint: token,
          }),
        );
      yield* read("empty").pipe(Effect.flip);
      yield* read("healthy");
      yield* read("empty").pipe(Effect.flip);
      assert.strictEqual(reads, 1);
    }).pipe(Effect.provide(Layer.merge(GitHubGraphQlBudget.layer, SourceControlRateLimit.layer))),
  );

  it.effect("pins concurrent cached commands to their own verified credentials", () =>
    Effect.gen(function* () {
      mockRun.mockImplementation((input) =>
        Effect.succeed(processOutput(input.env?.GH_TOKEN ?? "ambient")),
      );
      const gh = yield* GitHubCli.GitHubCli;
      // Constructed outside either request, like the PR service's read caches.
      const cache = yield* Cache.make({
        lookup: (host: string) =>
          gh.execute({
            cwd: "/repo",
            args: ["api", "user", "--hostname", host],
            env: { GH_DEBUG: "api", GH_TOKEN: "changed-after-verification" },
          }),
        capacity: 2,
        timeToLive: "1 minute",
      });
      const results = yield* Effect.forEach(
        ["github.com", "github.example.test"],
        (host, index) =>
          Cache.get(cache, host).pipe(
            Effect.provideService(GitHubCli.PinnedGitHubCredential, {
              host,
              token: Redacted.make(`credential-${index}`),
              credentialFingerprint: `fingerprint-${index}`,
            }),
          ),
        { concurrency: 2 },
      );
      expect(results.map((result) => result.stdout)).toEqual(["credential-0", "credential-1"]);
      for (const [input] of mockRun.mock.calls) {
        expect(input.env).toMatchObject({
          GH_HOST: input.args[3],
          GH_DEBUG: "",
          GH_TOKEN: input.env?.GITHUB_TOKEN,
          GH_ENTERPRISE_TOKEN: input.env?.GH_TOKEN,
          GITHUB_ENTERPRISE_TOKEN: input.env?.GH_TOKEN,
        });
      }
      expect((yield* gh.execute({ cwd: "/repo", args: ["api", "user"] })).stdout).toBe("ambient");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses other or implicit hosts before exposing a scoped credential to gh", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      for (const args of [
        ["api", "user", "--hostname", "other.example.test"],
        ["api", "user", "--hostname=other.example.test"],
        ["pr", "view", "1", "--repo", "other.example.test/owner/repo"],
        ["repo", "view", "other.example.test/owner/repo", "--json", "name"],
        ["api", "https://other.example.test/user", "--hostname", "github.com"],
        ["api", "user"],
      ]) {
        const failure = yield* gh.execute({ cwd: "/repo", args }).pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, {
            host: "github.com",
            token: Redacted.make("secret-credential"),
            credentialFingerprint: "fingerprint",
          }),
          Effect.flip,
        );
        expect(failure._tag).toBe("GitHubCliCommandError");
        expect(yield* encodeGitHubCliError(failure)).not.toContain("secret-credential");
      }
      expect(mockRun).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("pins repository-targeted writes on enterprise hosts", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValue(Effect.succeed(processOutput("")));
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh
        .execute({
          cwd: "/repo",
          args: ["pr", "merge", "1", "--repo", "github.example.test/owner/repo"],
        })
        .pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, {
            host: "github.example.test",
            token: Redacted.make("enterprise-credential"),
            credentialFingerprint: "fingerprint",
          }),
        );
      yield* gh
        .execute({
          cwd: "/repo",
          args: ["repo", "view", "github.example.test/owner/repo", "--json", "name"],
        })
        .pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, {
            host: "github.example.test",
            token: Redacted.make("enterprise-credential"),
            credentialFingerprint: "fingerprint",
          }),
        );
      expect(mockRun.mock.calls[0]?.[0].env).toMatchObject({
        GH_HOST: "github.example.test",
        GH_ENTERPRISE_TOKEN: "enterprise-credential",
        GH_DEBUG: "",
      });
    }).pipe(Effect.provide(layer)),
  );

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
              isDraft: true,
              mergedAt: null,
              updatedAt: "2026-08-24T12:34:56Z",
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
        closedAt: null,
        mergedAt: null,
        isDraft: true,
        updatedAt: "2026-08-24T12:34:56.000Z",
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
          "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
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
        closedAt: null,
        mergedAt: null,
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
          closedAt: null,
          mergedAt: null,
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
          closedAt: null,
          mergedAt: null,
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

  it.effect("surfaces an actionable rate-limit error without exposing provider stderr", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitHubCli.execute",
        command: "gh",
        cwd: "/repo",
        exitCode: 1,
        failureKind: "rate-limited",
        detail: "API rate limit exceeded.",
        stderrLength: 82,
        stderrTruncated: false,
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .listOpenPullRequests({
          cwd: "/repo",
          headSelector: "feature/rate-limited",
        })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitHubCliRateLimitError");
      assert.include(error.detail, "GitHub API rate limit exceeded");
      assert.include(error.detail, "gh api rate_limit");
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, "user ID");
      const paused = yield* gh
        .execute({ cwd: "/other-repo", args: ["pr", "list"] })
        .pipe(Effect.flip);
      assert.strictEqual(paused._tag, "GitHubCliRateLimitError");
      expect(mockRun).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust("30 seconds");
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("[]")));
      yield* gh.execute({ cwd: "/other-repo", args: ["pr", "list"] });
      expect(mockRun).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer)),
  );
});

it.effect("accepts conditional 304 responses and preserves HTTP errors and retry delays", () =>
  Effect.gen(function* () {
    const gh = yield* GitHubCli.GitHubCli;
    const request = {
      cwd: "/repo",
      args: [
        "api",
        "repos/acme/web/pulls/1",
        "--hostname",
        "github.com",
        "--include",
        "-H",
        'If-None-Match: "one"',
      ],
      acceptNotModified: true,
    };
    const respond = (status: number, headers = "") =>
      mockRun.mockImplementation(() =>
        Effect.succeed({
          ...processOutput(`HTTP/2.0 ${status}\r\n${headers}\r\n`),
          exitCode: ChildProcessSpawner.ExitCode(1),
        }),
      );
    respond(304);
    expect((yield* gh.execute(request)).stdout).toContain("304");
    expect(mockRun.mock.calls[0]?.[0].allowNonZeroExit).toBe(true);
    respond(401);
    expect((yield* gh.execute(request).pipe(Effect.flip))._tag).toBe(
      "GitHubCliAuthenticationError",
    );
    respond(403);
    expect((yield* gh.execute(request).pipe(Effect.flip))._tag).toBe("GitHubCliCommandError");
    for (const status of [403, 429]) {
      respond(status, "Retry-After: 120\r\n");
      expect(yield* gh.execute(request).pipe(Effect.flip)).toMatchObject({
        _tag: "GitHubCliRateLimitError",
        retryAt: (yield* Clock.currentTimeMillis) + 120_000,
      });
    }
    respond(
      403,
      `X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: ${Math.floor((yield* Clock.currentTimeMillis) / 1_000) + 60}\r\n`,
    );
    expect(yield* gh.execute(request).pipe(Effect.flip)).toMatchObject({
      _tag: "GitHubCliRateLimitError",
      retryAt: (yield* Clock.currentTimeMillis) + 60_000,
    });
    respond(500);
    expect(yield* gh.execute(request).pipe(Effect.flip)).toMatchObject({
      _tag: "GitHubCliCommandError",
      httpStatus: 500,
    });
  }).pipe(Effect.provide(layer)),
);

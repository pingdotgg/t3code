import {
  assert,
  describe,
  it,
} from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import { encodeJson, githubContext, harness, makeProvider, node, processResult, remotesOutput, restResponse } from "./GitHubSourceControlProvider.part2.testkit.ts";

describe("GitHubSourceControlProvider repository resolution", () => {
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
      const gh = yield* GitHubSourceControlProvider.make;
      assert.strictEqual(yield* gh.getDefaultBranch({ cwd: "/repo" }), "trunk");
      assert.deepStrictEqual(paths, ["github.com repos/acme/web"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads clone URLs on the given host before the checkout's", () => {
    const paths: string[] = [];
    const { layer } = harness({
      remotes: remotesOutput(["origin", "https://github.com/acme/web.git"]),
      api: {
        rest: (input) =>
          Effect.sync(() => {
            paths.push(`${input.host} ${input.path}`);
            return restResponse({
              full_name: "acme/web",
              html_url: `https://${input.host}/acme/web`,
              ssh_url: `git@${input.host}:acme/web.git`,
            });
          }),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      const cloneUrls = yield* gh.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "acme/web",
        host: "GitHub.Enterprise.test",
      });
      yield* gh.getRepositoryCloneUrls({ cwd: "/repo", repository: "acme/web" });
      assert.strictEqual(cloneUrls.url, "https://github.enterprise.test/acme/web");
      assert.deepStrictEqual(paths, [
        "github.enterprise.test repos/acme/web",
        "github.com repos/acme/web",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    ["github", "git@github:acme/web.git"],
    ["github.com-scale", "git@github.com-scale:acme/web.git"],
    ["github.com-scale", "ssh://git@github.com-scale:22/acme/web.git"],
  ] as const)("reads an SSH alias on %s through github.com (%s)", ([host, remoteUrl]) => {
    const hosts: string[] = [];
    const { layer } = harness({
      remotes: remotesOutput(["origin", remoteUrl]),
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
      const gh = yield* GitHubSourceControlProvider.make;
      const resolveWebHost = gh.resolveRemoteWebHost;
      assert.ok(resolveWebHost);
      assert.strictEqual(
        yield* resolveWebHost({
          cwd: "/repo",
          context: { ...githubContext(host), remoteUrl },
          resolveContext: () => Effect.succeed(null),
        }),
        "github.com",
      );
      yield* gh.getDefaultBranch({ cwd: "/repo" });
      yield* gh.getDefaultBranch({
        cwd: "/repo",
        context: { ...githubContext(host), remoteUrl },
      });
      assert.deepStrictEqual(hosts, ["github.com repos/acme/web", "github.com repos/acme/web"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["sole", "upstream", "missing"])(
    "preserves an HTTPS context host with %s remotes",
    (mode) => {
      const paths: string[] = [];
      const remoteUrl = "https://github.com-scale/me/web.git";
      const { layer } = harness({
        remotes:
          mode === "missing"
            ? ""
            : remotesOutput(
                ["origin", remoteUrl],
                ...(mode === "upstream"
                  ? ([["upstream", "https://github.com/acme/web.git"]] as const)
                  : []),
              ),
        api: {
          rest: (input) =>
            Effect.sync(() => {
              paths.push(`${input.host} ${input.path}`);
              return restResponse({
                full_name: "me/web",
                html_url: "https://github.com-scale/me/web",
                ssh_url: "git@github.com-scale:me/web.git",
                default_branch: "trunk",
              });
            }),
        },
      });
      return Effect.gen(function* () {
        const gh = yield* GitHubSourceControlProvider.make;
        const resolveWebHost = gh.resolveRemoteWebHost;
        assert.ok(resolveWebHost);
        for (const url of [remoteUrl, "git@github.com-evil.example:me/web.git"]) {
          assert.strictEqual(
            yield* resolveWebHost({
              cwd: "/repo",
              context: { ...githubContext("github.com-scale"), remoteUrl: url },
              resolveContext: () => Effect.succeed(null),
            }),
            url === remoteUrl ? "github.com-scale" : "github.com-evil.example",
          );
        }
        assert.strictEqual(
          yield* gh.getDefaultBranch({
            cwd: "/repo",
            context: { ...githubContext("github.com-scale"), remoteUrl },
          }),
          "trunk",
        );
        assert.deepStrictEqual(paths, ["github.com-scale repos/me/web"]);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("GitHubSourceControlProvider change request lookups by head", () => {
  const remotes = remotesOutput(["origin", "git@github.com:acme/web.git"]);

  it.effect("matches an owner:branch selector on the head owner", () => {
    const { layer } = harness({
      remotes,
      graphql: (lookup) => ({
        pullRequests: {
          nodes:
            lookup.head === "main"
              ? [node(9, "main", "someone"), node(8, "main", "me"), node(7, "main", "me")]
              : [],
        },
      }),
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      const open = yield* gh
        .listChangeRequests({ cwd: "/repo", headSelector: "me:main", state: "open", limit: 1 })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("50 millis");
      assert.deepStrictEqual(
        (yield* Fiber.join(open)).map((pr) => pr.number),
        [8],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps API failures onto the errors callers handle", () => {
    let signedIn = false;
    const { layer } = harness({
      remotes,
      credential: (host) =>
        signedIn
          ? Effect.succeed({
              host,
              token: Redacted.make("token"),
              source: "gh" as const,
              fingerprint: "fp",
            })
          : Effect.fail(new GitHubCredentials.GitHubCliMissingError({ host })),
      graphql: () =>
        new Response(encodeJson({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "123" },
        }),
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      const read = (headSelector: string) =>
        gh
          .listChangeRequests({ cwd: "/repo", headSelector, state: "open", limit: 1 })
          .pipe(Effect.flip, Effect.forkChild);
      const missing = yield* read("missing");
      yield* TestClock.adjust("500 millis");
      assert.include((yield* Fiber.join(missing)).detail, "No GitHub credential on the server");
      signedIn = true;
      const limited = yield* read("limited");
      yield* TestClock.adjust("500 millis");
      const error = yield* Fiber.join(limited);
      assert.include(error.detail, "rate limit exceeded");
      assert.propertyVal(error.cause, "retryAt", 123_000);
    }).pipe(Effect.provide(layer));
  });
});

describe("GitHubSourceControlProvider.getChangeRequest", () => {
  it.effect("reads a pull request by number, and by URL on its own repository", () => {
    const { layer, graphqlCalls } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      graphql: () => ({ pullRequest: node(42, "feature") }),
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      assert.strictEqual(
        (yield* gh.getChangeRequest({ cwd: "/repo", reference: "#42" })).number,
        42,
      );
      yield* gh.getChangeRequest({
        cwd: "/repo",
        reference: "https://github.com/other/thing/pull/42",
      });
      assert.deepStrictEqual(
        graphqlCalls.flatMap((call) => call.lookups),
        [
          { owner: "acme", name: "web", number: 42 },
          { owner: "other", name: "thing", number: 42 },
        ],
      );
    }).pipe(Effect.provide(layer));
  });
});

describe("GitHubSourceControlProvider writes", () => {
  it.effect("creates a cross-repository pull request with an owner:branch head", () => {
    const requests: Array<GitHubRest.GitHubRestInput> = [];
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
      const gh = yield* GitHubSourceControlProvider.make;
      yield* gh.createChangeRequest({
        cwd: "/repo",
        baseRefName: "main",
        headSelector: "me:feature",
        title: "Title",
        bodyFile,
      });
      assert.strictEqual(requests[0]!.method, "POST");
      assert.strictEqual(requests[0]!.path, "repos/acme/web/pulls");
      assert.strictEqual(requests[0]!.allowReserve, true);
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
      const gh = yield* GitHubSourceControlProvider.make;
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

  it.effect("looks up a bare repository name under the signed-in account on that host", () => {
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const gh = yield* makeProvider({
        rest: (input) =>
          Effect.sync(() => {
            requests.push(`${input.host} ${input.method ?? "GET"} ${input.path}`);
            return input.path === "user"
              ? restResponse({ login: "me" })
              : restResponse({
                  full_name: "me/notes",
                  html_url: `https://${input.host}/me/notes`,
                  ssh_url: `git@${input.host}:me/notes.git`,
                });
          }),
      });

      const urls = yield* gh.getRepositoryCloneUrls({
        cwd: "/repo",
        context: githubContext("code.example.test"),
        repository: " notes.git ",
      });

      assert.deepStrictEqual(urls, {
        nameWithOwner: "me/notes",
        url: "https://code.example.test/me/notes",
        sshUrl: "git@code.example.test:me/notes.git",
      });
      assert.deepStrictEqual(requests, [
        "code.example.test GET user",
        "code.example.test GET repos/me/notes",
      ]);
      for (const repository of ["me/", "/notes", "a/b/c/d", "", "two words"]) {
        const error = yield* Effect.flip(gh.getRepositoryCloneUrls({ cwd: "/repo", repository }));
        assert.include(error.message, "Repositories are named owner/name.");
      }
      assert.strictEqual(requests.length, 2);
    });
  });
});

describe("GitHubSourceControlProvider.checkoutChangeRequest", () => {
  it.effect("refuses a fork checkout when the base's default branch cannot be read", () => {
    const { layer, git } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      localBranches: ["main"],
      graphql: () => ({ pullRequest: node(6, "main", "someone") }),
      api: {
        rest: () =>
          Effect.fail(
            new GitHubRequestPolicy.GitHubApiRequestError({
              host: "github.com",
              operation: "x",
              cause: "offline",
            }),
          ),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      yield* Effect.flip(gh.checkoutChangeRequest({ cwd: "/repo", reference: "6", force: true }));
      assert.deepStrictEqual(git, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps git's own output out of what a failed checkout reports", () => {
    const { layer } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      gitFailure: new Error("fatal: /home/me/secret-path: permission denied"),
      graphql: () => ({ pullRequest: node(5, "feature/x") }),
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      const error = yield* gh
        .checkoutChangeRequest({ cwd: "/repo", reference: "5" })
        .pipe(Effect.flip);
      assert.strictEqual(error.detail, "The pull request could not be checked out with git.");
      assert.notInclude(error.message, "secret-path");
    }).pipe(Effect.provide(layer));
  });

  it.effect("records the branch base for gh through the host's config write", () => {
    const { layer, git } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      yield* gh.recordBranchBase!({ cwd: "/repo", branch: "feature", baseBranch: "main" });
      assert.deepStrictEqual(git, [
        ["writeConfigValue", { cwd: "/repo", key: "branch.feature.gh-merge-base", value: "main" }],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it("names the local branch the way gh pr checkout does", () => {
    const name = (headRefName: string, isCrossRepository: boolean) =>
      GitHubSourceControlProvider.pullRequestCheckoutBranchName({
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

it("accepts active authenticated GitHub accounts when another account fails", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "active-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
            {
              state: "error",
              active: false,
              host: "github.com",
              login: "stale-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
              error: "The token in keyring is invalid.",
            },
          ],
        },
      }),
    ),
  );

  assert.deepStrictEqual(
    {
      status: auth.status,
      account: auth.account,
      host: auth.host,
    },
    {
      status: "authenticated",
      account: Option.some("active-user"),
      host: Option.some("github.com"),
    },
  );
});

it("parses GitHub auth JSON from stdout when stderr has warnings", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "active-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
          ],
        },
      }),
      { stderr: "warning: ignored diagnostic from gh\n" },
    ),
  );

  assert.deepStrictEqual(
    {
      status: auth.status,
      account: auth.account,
      host: auth.host,
    },
    {
      status: "authenticated",
      account: Option.some("active-user"),
      host: Option.some("github.com"),
    },
  );
});

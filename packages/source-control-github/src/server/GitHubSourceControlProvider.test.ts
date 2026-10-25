import { SourceControlProviderKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import { parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const processResult = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): SourceControlHost.SourceControlProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const processOutput = (
  stdout: string,
  exitCode = 0,
): SourceControlHost.SourceControlProcessOutput => ({
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

const restResponse = (body: unknown, status = 200): GitHubRest.GitHubRestResponse => ({
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
  headRefOid: "f".repeat(40),
  state: "OPEN",
  isDraft: false,
  mergedAt: null,
  closedAt: null,
  isCrossRepository: owner !== "acme",
  updatedAt: "2026-01-02T00:00:00Z",
  headRepository: { name: "web", nameWithOwner: `${owner}/web` },
  headRepositoryOwner: { __typename: "User", login: owner },
});

interface GraphQlCall {
  readonly host: string;
  readonly operationName: string;
  readonly query: string;
  readonly lookups: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

type GraphQlAnswer = unknown;
type GraphQlRespond = (
  lookup: Readonly<Record<string, unknown>>,
  call: GraphQlCall,
) => GraphQlAnswer | Response;

function graphQlHttp(respond: GraphQlRespond, calls: Array<GraphQlCall>) {
  return HttpClient.make((request) =>
    Effect.sync(() => {
      const sent =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
              readonly query: string;
              readonly operationName: string;
              readonly variables: Readonly<Record<string, unknown>>;
            })
          : { query: "", operationName: "", variables: {} };
      const prefixes = [
        ...new Set(Object.keys(sent.variables).flatMap((key) => /^_\d+_/.exec(key) ?? [])),
      ];
      const lookups =
        prefixes.length === 0
          ? [sent.variables]
          : prefixes.map((prefix) =>
              Object.fromEntries(
                Object.entries(sent.variables)
                  .filter(([key]) => key.startsWith(prefix))
                  .map(([key, value]) => [key.slice(prefix.length), value]),
              ),
            );
      const call: GraphQlCall = {
        host: new URL(request.url).hostname.replace(/^api\./, ""),
        operationName: sent.operationName,
        query: sent.query,
        lookups,
      };
      calls.push(call);
      const answers = lookups.map((lookup) => respond(lookup, call));
      const refusal = answers.find((answer) => answer instanceof Response);
      const response =
        refusal ??
        new Response(
          encodeJson({
            data: Object.fromEntries(
              answers.map((answer, index) => [
                prefixes.length === 0 ? "repository" : `${prefixes[index]}repository`,
                answer,
              ]),
            ),
          }),
          { headers: { "content-type": "application/json" } },
        );
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
}

function harness(input: {
  readonly remotes: string;
  readonly api?: Partial<GitHubRest.GitHubRest["Service"]>;
  readonly graphql?: GraphQlRespond;
  readonly credential?: (
    host: string,
  ) => Effect.Effect<
    GitHubCredentials.GitHubCredential,
    GitHubCredentials.GitHubCredentialUnavailableError
  >;
  readonly localBranches?: ReadonlyArray<string>;
  readonly resolved?: string;
  readonly gitFailure?: unknown;
}) {
  const git: Array<readonly [string, unknown]> = [];
  const graphqlCalls: Array<GraphQlCall> = [];
  const record =
    <A>(name: string, value: A) =>
    (args: unknown) =>
      Effect.sync(() => {
        git.push([name, args]);
        return value;
      });
  const hostGit: Partial<SourceControlHost.SourceControlHost["Service"]["git"]> = {
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
    listLocalBranchNames: () =>
      input.gitFailure === undefined
        ? Effect.succeed([...(input.localBranches ?? [])])
        : Effect.fail(input.gitFailure as never),
    resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
  };
  const host = TestSourceControlHost.layer({
    git: hostGit,
    process: {
      run: (args) =>
        Effect.succeed(
          args.args[0] === "remote"
            ? processOutput(input.remotes)
            : processOutput(input.resolved ?? "", input.resolved ? 0 : 1),
        ),
    },
  });
  const graphql =
    input.graphql ??
    (() => {
      throw new Error("Unexpected GraphQL read");
    });
  const policy = GitHubRequestPolicy.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(GitHubCredentials.GitHubCredentials, {
          get:
            input.credential ??
            ((host) =>
              Effect.succeed({
                host,
                token: Redacted.make("token"),
                source: "gh" as const,
                fingerprint: `${host}:token`,
              })),
          invalidate: () => Effect.void,
        }),
        GitHubQuota.layer,
        SourceControlRateLimit.layer,
      ),
    ),
  );
  const layer = Layer.mergeAll(
    host,
    Layer.mock(GitHubRest.GitHubRest)(input.api ?? {}),
    policy,
    Layer.succeed(HttpClient.HttpClient, graphQlHttp(graphql, graphqlCalls)),
    NodeServices.layer,
  );
  return { layer, git, graphqlCalls };
}

const makeProvider = (api: Partial<GitHubRest.GitHubRest["Service"]>) =>
  GitHubSourceControlProvider.make.pipe(Effect.provide(harness({ remotes: "", api }).layer));

const githubContext = (host: string) => ({
  provider: {
    kind: SourceControlProviderKind.make("github"),
    name: "GitHub",
    baseUrl: `https://${host}`,
  },
  remoteName: "origin",
  remoteUrl: `git@${host}:acme/web.git`,
});

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

it("parses GitHub auth status accounts by host and active state", () => {
  assert.deepStrictEqual(
    parseGitHubAuthStatus(
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
            },
          ],
          "github.example.test": [
            {
              state: "success",
              active: false,
              host: "github.example.test",
              login: "enterprise-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
          ],
        },
      }),
    ).accounts,
    [
      {
        host: "github.com",
        account: "active-user",
        authenticated: true,
        active: true,
        error: null,
        environmentVariable: null,
      },
      {
        host: "github.com",
        account: "stale-user",
        authenticated: false,
        active: false,
        error: null,
        environmentVariable: null,
      },
      {
        host: "github.example.test",
        account: "enterprise-user",
        authenticated: true,
        active: false,
        error: null,
        environmentVariable: null,
      },
    ],
  );
});

it("reports unauthenticated when GitHub JSON has accounts but none are valid", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "error",
              active: true,
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
      host: auth.host,
      detail: auth.detail,
    },
    {
      status: "unauthenticated",
      host: Option.some("github.com"),
      detail: Option.some("The token in keyring is invalid."),
    },
  );
});

it("reports an update hint instead of unauthenticated when gh predates --json", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult("", {
      stderr: "unknown flag: --json\n\nUsage:  gh auth status [flags]\n",
      exitCode: ChildProcessSpawner.ExitCode(1),
    }),
  );

  assert.strictEqual(auth.status, "unknown");
  assert.match(
    Option.getOrElse(auth.detail, () => ""),
    /2\.81\.0/,
  );
});

it.effect.each(["pull", "issues"])(
  "resolves %s subjects on the linked host without using the checkout",
  (kind) =>
    Effect.gen(function* () {
      const provider = yield* makeProvider({
        rest: (input) => {
          assert.strictEqual(input.host, "github.com");
          assert.strictEqual(input.path, "repos/owner/repo/issues/42");
          return Effect.succeed(
            restResponse({ title: "Pairing expiry", body: "Preserve remote access", id: 1 }),
          );
        },
      });
      const lookup = provider.resolveLink?.({
        cwd: "/unrelated",
        url: new URL(`https://github.com/owner/repo/${kind}/42`),
      });
      assert.ok(lookup);
      assert.deepStrictEqual(yield* lookup, {
        title: "Pairing expiry",
        body: "Preserve remote access",
      });
      for (const url of [
        "https://github.com/owner/repo",
        "https://github.attacker.test/owner/repo/issues/42",
      ]) {
        assert.strictEqual(
          provider.resolveLink?.({ cwd: "/unrelated", url: new URL(url) }),
          undefined,
        );
      }
    }),
);

it.effect.each(["read", "decode"] as const)(
  "retains the %s failure without exposing its raw contents",
  (stage) =>
    Effect.gen(function* () {
      const cause = new GitHubRequestPolicy.GitHubApiResponseError({
        host: "github.com",
        operation: "resolveLink",
        status: 500,
      });
      const provider = yield* makeProvider({
        rest: () =>
          stage === "read"
            ? Effect.fail(cause)
            : Effect.succeed({ ...restResponse(undefined), body: "private response text" }),
      });
      const lookup = provider.resolveLink?.({
        cwd: "/repo",
        url: new URL("https://github.com/owner/repo/issues/42"),
      });
      assert.ok(lookup);
      const error = yield* Effect.flip(lookup);
      assert.strictEqual(error.operation, stage === "read" ? "resolveLink" : "resolveLink.decode");
      assert.strictEqual(error.detail, "The linked subject could not be read.");
      assert.notInclude(error.message, "private response text");
      if (stage === "read") assert.strictEqual(error.cause, cause);
      else assert.propertyVal(error.cause, "_tag", "SchemaError");
    }),
);

const multiAccountStatus = (extra: ReadonlyArray<Record<string, unknown>> = []) =>
  processResult(
    JSON.stringify({
      hosts: {
        "github.com": [
          { state: "success", active: true, host: "github.com", login: "personal" },
          { state: "success", active: false, host: "github.com", login: "work" },
          ...extra,
        ],
        "ghe.acme.test": [
          { state: "error", active: true, host: "ghe.acme.test", login: "jm", error: "expired" },
        ],
      },
    }),
  );

it("reports every gh login and leads with the account Settings pin", () => {
  const auth = GitHubSourceControlProvider.parseGitHubAuth(multiAccountStatus(), {
    hosts: { "github.com": { account: "work", enabled: true } },
    tokens: {},
  });
  assert.deepStrictEqual(auth.account, Option.some("work"));
  assert.deepStrictEqual(auth.accounts, [
    { host: "github.com", account: "personal", active: true, authenticated: true },
    { host: "github.com", account: "work", active: false, authenticated: true },
    { host: "ghe.acme.test", account: "jm", active: true, authenticated: false, error: "expired" },
  ]);
});

it("reports unauthenticated when Settings turn off every signed-in host", () => {
  const auth = GitHubSourceControlProvider.parseGitHubAuth(multiAccountStatus(), {
    hosts: { "github.com": { enabled: false } },
    tokens: {},
  });
  assert.strictEqual(auth.status, "unauthenticated");
  assert.deepStrictEqual(
    auth.detail,
    Option.some("Every GitHub host gh is signed in to is turned off in Settings → Source Control."),
  );
});

it("names the environment token that overrides the Settings choice", () => {
  const auth = GitHubSourceControlProvider.parseGitHubAuth(
    multiAccountStatus([
      {
        state: "success",
        active: false,
        host: "github.com",
        login: "bot",
        tokenSource: "GH_TOKEN",
      },
    ]),
    { hosts: { "github.com": { account: "work", enabled: true } }, tokens: {} },
  );
  assert.deepStrictEqual(auth.account, Option.some("bot"));
  assert.deepStrictEqual(
    auth.detail,
    Option.some(
      "Using GH_TOKEN from the server environment; it overrides the account chosen in Settings.",
    ),
  );
  assert.strictEqual(auth.accounts?.[2]?.environmentVariable, "GH_TOKEN");
});

it.live.each([
  "git@code.example.test:team/project.git",
  "ssh://git@code.example.test/team/project.git",
  "https://code.example.test/team/project.git",
])("keeps Enterprise operations on the selected remote: %s", (remoteUrl) => {
  const rest: GitHubRest.GitHubRestInput[] = [];
  const pr = {
    ...node(42, "feature", "team"),
    url: "https://code.example.test/team/project/pull/42",
    isCrossRepository: false,
    headRepository: { name: "project", nameWithOwner: "team/project" },
  };
  const api = {
    rest: (input: GitHubRest.GitHubRestInput) =>
      Effect.sync(() => {
        rest.push(input);
        return restResponse({
          full_name: "team/project",
          html_url: `https://${input.host}/team/project`,
          ssh_url: `git@${input.host}:team/project.git`,
          default_branch: "main",
        });
      }),
  };
  const { layer, git, graphqlCalls } = harness({
    remotes: remotesOutput(
      ["origin", "git@github.com:team/project.git"],
      ["enterprise", remoteUrl],
    ),
    api,
    graphql: (_, call) =>
      call.operationName === "PullRequestByNumber"
        ? { pullRequest: pr }
        : { pullRequests: { nodes: [pr] } },
  });
  return Effect.gen(function* () {
    const provider = yield* GitHubSourceControlProvider.make;
    const fs = yield* FileSystem.FileSystem;
    const bodyFile = yield* fs.makeTempFileScoped({ suffix: ".md" });
    yield* fs.writeFileString(bodyFile, "Enterprise PR");
    const input = {
      cwd: "/repo",
      context: {
        provider: {
          kind: SourceControlProviderKind.make("github"),
          name: "GitHub Self-Hosted",
          baseUrl: "https://code.example.test",
        },
        remoteName: "enterprise",
        remoteUrl,
      },
    };
    for (const state of ["open", "closed"] as const) {
      const prs = yield* provider.listChangeRequests({
        ...input,
        state,
        headSelector: "feature",
      });
      assert.strictEqual(prs[0]?.url, "https://code.example.test/team/project/pull/42");
    }
    yield* provider.getChangeRequest({ ...input, reference: "42" });
    yield* provider.getChangeRequest({ ...input, reference: "feature" });
    yield* provider.createChangeRequest({
      ...input,
      baseRefName: "main",
      headSelector: "feature",
      title: "PR",
      bodyFile,
    });
    assert.strictEqual(yield* provider.getDefaultBranch(input), "main");
    yield* provider.checkoutChangeRequest({ ...input, reference: "42" });
    yield* provider.getRepositoryCloneUrls({ ...input, repository: "team/other" });
    yield* provider.getRepositoryCloneUrls({ ...input, repository: "github.com/team/explicit" });
    const lookups = graphqlCalls.flatMap((call) =>
      call.lookups.map(({ owner, name }) => [call.host, owner, name]),
    );
    assert.deepStrictEqual(
      lookups,
      Array.from({ length: 5 }, () => ["code.example.test", "team", "project"]),
    );
    assert.deepStrictEqual(
      rest.map(({ host, path }) => [host, path]),
      [
        ["code.example.test", "repos/team/project/pulls"],
        ["code.example.test", "repos/team/project"],
        ["code.example.test", "repos/team/other"],
        ["github.com", "repos/team/explicit"],
      ],
    );
    assert.deepStrictEqual(git.find(([name]) => name === "fetchRemoteTrackingBranch")?.[1], {
      cwd: "/repo",
      remoteName: "enterprise",
      remoteBranch: "feature",
    });
  }).pipe(Effect.provide(layer), Effect.provideService(HostProcess.Environment, {}), Effect.scoped);
});

it.effect.each([
  { host: "github.com", resolved: "", envRepository: "", expected: "acme/web" },
  {
    host: "code.example.test",
    resolved: "remote.origin.gh-resolved base",
    envRepository: "",
    expected: "me/web",
  },
  {
    host: "github.com",
    resolved: "remote.upstream.gh-resolved acme/other",
    envRepository: "",
    expected: "acme/other",
  },
  {
    host: "code.example.test",
    resolved: "",
    envRepository: "chosen/repo",
    expected: "chosen/repo",
  },
])(
  "preserves repository precedence on $host: $resolved $envRepository",
  ({ host, resolved, envRepository, expected }) => {
    const targets: string[] = [];
    const { layer } = harness({
      remotes: remotesOutput(
        ["origin", `git@${host}:me/web.git`],
        ["upstream", `git@${host}:acme/web.git`],
      ),
      resolved,
      api: {
        rest: (input) =>
          Effect.sync(() => {
            targets.push(`${input.host}/${input.path}`);
            return restResponse({
              full_name: expected,
              html_url: `https://${host}/${expected}`,
              ssh_url: `git@${host}:${expected}.git`,
              default_branch: "main",
            });
          }),
      },
    });
    return Effect.gen(function* () {
      const provider = yield* GitHubSourceControlProvider.make;
      const fs = yield* FileSystem.FileSystem;
      const bodyFile = yield* fs.makeTempFileScoped();
      yield* fs.writeFileString(bodyFile, "Body");
      const input = {
        cwd: "/repo",
        context: {
          provider: {
            kind: SourceControlProviderKind.make("github"),
            name: "GitHub",
            baseUrl: `https://${host}`,
          },
          remoteName: "origin",
          remoteUrl: `git@${host}:me/web.git`,
        },
      };
      yield* provider.getDefaultBranch(input);
      yield* provider.createChangeRequest({
        ...input,
        baseRefName: "main",
        headSelector: "me:feature",
        title: "PR",
        bodyFile,
      });
      assert.deepStrictEqual(targets, [
        `${host}/repos/${expected}`,
        `${host}/repos/${expected}/pulls`,
      ]);
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcess.Environment, { GH_REPO: envRepository }),
      Effect.scoped,
    );
  },
);

it.effect("says a GH_REPO naming an unparseable host targets no remote rather than failing", () => {
  const { layer } = harness({
    remotes: remotesOutput(["upstream", "git@github.com:acme/web.git"]),
    resolved: "",
    api: {},
  });
  return Effect.gen(function* () {
    const provider = yield* GitHubSourceControlProvider.make;
    const targets = yield* provider.createsChangeRequestsIn!({
      cwd: "/repo",
      context: {
        provider: {
          kind: SourceControlProviderKind.make("github"),
          name: "GitHub",
          baseUrl: "https://github.com",
        },
        remoteName: "upstream",
        remoteUrl: "git@github.com:acme/web.git",
      },
      repository: "acme/web",
    });
    assert.isFalse(targets);
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(HostProcess.Environment, { GH_REPO: "bad host/acme/web" }),
  );
});

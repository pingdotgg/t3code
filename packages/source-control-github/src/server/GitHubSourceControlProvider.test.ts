import { SourceControlProviderKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import { parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import { harness, makeProvider, node, processResult, remotesOutput, restResponse } from "./GitHubSourceControlProvider.part2.testkit.ts";

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
    signIns: {},
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
    signIns: {},
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
    { hosts: { "github.com": { account: "work", enabled: true } }, tokens: {}, signIns: {} },
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
    assert.deepStrictEqual(git.find(([name]) => name === "createBranch")?.[1], {
      cwd: "/repo",
      branch: "feature",
      startPoint: "refs/remotes/enterprise/feature",
    });
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

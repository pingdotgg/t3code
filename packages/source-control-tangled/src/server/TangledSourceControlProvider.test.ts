import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, GitCommandError, VcsProcessSpawnError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientResponse } from "effect/http";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as TangledClient from "../client/definition.ts";
import * as TangledCli from "./TangledCli.ts";
import * as TangledSourceControlProvider from "./TangledSourceControlProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isPullRequestProviderError = Schema.is(PullRequestProviderError);

const context = (remoteUrl: string) =>
  ({
    provider: { kind: TangledSourceControlProvider.KIND, name: "Tangled", baseUrl: "tangled.org" },
    remoteName: "origin",
    remoteUrl,
  }) as const;

const REMOTE = context("git@tangled.org:alice.example/repo");
const unusedHttpClient = HttpClient.make(() => Effect.die("Unexpected HTTP request"));

interface Route {
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

/**
 * A `tg` stand-in that answers from `routes`, keyed by the subcommand and its arguments. The
 * global flags lead the invocation, so they are dropped before the key is read. Anything
 * unscripted dies, so an unexpected command is visible in the failure.
 */
function fakeTg(routes: Readonly<Record<string, Route>>) {
  const calls: Array<ReadonlyArray<string>> = [];
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) => {
    const seen = withoutJson(input.args);
    calls.push(seen);
    const route = routes[seen.join(" ")];
    if (route === undefined) return Effect.die(`Unexpected tg ${seen.join(" ")}`);
    return Effect.succeed(
      TestSourceControlHost.processOutput(route.stdout, {
        stderr: route.stderr ?? "",
        exitCode: ChildProcessSpawner.ExitCode(route.exitCode ?? 0),
      }),
    );
  };
  return { calls, layer: TestSourceControlHost.layer({ process: { run } }) };
}

function withoutJson(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.filter((arg) => arg !== "--json");
}

/** The layers every test needs: the provider's own `tg`, over the fake's process host. */
const serve =
  (tg: ReturnType<typeof fakeTg>, client = unusedHttpClient) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(TangledCli.layer.pipe(Layer.provideMerge(tg.layer))),
      Effect.provideService(HttpClient.HttpClient, client),
    );

describe("TangledSourceControlProvider.parseAuth", () => {
  it("reports an expired saved session as unauthenticated", () => {
    const expired = TangledSourceControlProvider.parseAuth({
      stdout: encodeJson({ authenticated: true, status: "expired", handle: "noz.am" }),
      stderr: "",
      exitCode: ChildProcessSpawner.ExitCode(0),
    });
    assert.strictEqual(expired.status, "unauthenticated");
  });

  it("reads the signed-in account from tg auth status", () => {
    const signedIn = TangledSourceControlProvider.parseAuth({
      stdout: encodeJson({ authenticated: true, handle: "alice.example", did: "did:plc:abc" }),
      stderr: "",
      exitCode: ChildProcessSpawner.ExitCode(0),
    });
    assert.strictEqual(signedIn.status, "authenticated");
    assert.deepStrictEqual(signedIn.account, Option.some("alice.example"));
    assert.deepStrictEqual(signedIn.host, Option.some("tangled.org"));
  });

  it("falls back to the DID when no handle is reported", () => {
    const byDid = TangledSourceControlProvider.parseAuth({
      stdout: encodeJson({ authenticated: true, did: "did:plc:abc" }),
      stderr: "",
      exitCode: ChildProcessSpawner.ExitCode(0),
    });
    assert.deepStrictEqual(byDid.account, Option.some("did:plc:abc"));
  });

  it("reads a signed-out CLI as unauthenticated, and unreadable output as unknown", () => {
    const signedOut = TangledSourceControlProvider.parseAuth({
      stdout: encodeJson({ authenticated: false }),
      stderr: "",
      exitCode: ChildProcessSpawner.ExitCode(0),
    });
    assert.strictEqual(signedOut.status, "unauthenticated");

    const unreadable = TangledSourceControlProvider.parseAuth({
      stdout: "",
      stderr: 'Error: not logged in; provide a handle or run "tg auth login"',
      exitCode: ChildProcessSpawner.ExitCode(1),
    });
    assert.strictEqual(unreadable.status, "unknown");
    assert.deepStrictEqual(
      unreadable.detail,
      Option.some('Error: not logged in; provide a handle or run "tg auth login"'),
    );
  });
});

describe("TangledSourceControlProvider.discovery", () => {
  it("probes the tg binary on PATH the way other CLI hosts do", () => {
    const { discovery } = TangledSourceControlProvider;
    assert.strictEqual(discovery.type, "cli");
    assert.strictEqual(discovery.executable, "tg");
    assert.deepStrictEqual(discovery.versionArgs, ["--version"]);
    assert.deepStrictEqual(discovery.authArgs, ["auth", "status", "--json"]);
    assert.strictEqual(discovery.label, "Tangled");
  });
});

describe("TangledSourceControlProvider.defaultBranchFromSymref", () => {
  it("reads the branch git ls-remote --symref points HEAD at", () => {
    assert.strictEqual(
      TangledSourceControlProvider.defaultBranchFromSymref(
        "ref: refs/heads/main\tHEAD\nf2460055a6527526508b0fa1bed674b917f447f7\tHEAD\n",
      ),
      "main",
    );
  });

  it("is null when the remote names no HEAD symref", () => {
    assert.strictEqual(
      TangledSourceControlProvider.defaultBranchFromSymref("f2460055\trefs/heads/main\n"),
      null,
    );
  });
});

describe("TangledSourceControlProvider.createsUnderOwner", () => {
  it.each(["alice.example", "did:plc:alice"])("accepts the same owner %s", (owner) => {
    assert.strictEqual(
      TangledSourceControlProvider.createsUnderOwner({
        requested: owner,
        created: owner,
      }),
      true,
    );
  });

  it("refuses another handle, which tg would have created under the signed-in account", () => {
    assert.strictEqual(
      TangledSourceControlProvider.createsUnderOwner({
        requested: "someone-else",
        created: "alice.example",
      }),
      false,
    );
  });

  it("does not read a DID and a handle for one account as a mismatch", () => {
    assert.strictEqual(
      TangledSourceControlProvider.createsUnderOwner({
        requested: "did:plc:abc",
        created: "alice.example",
      }),
      true,
    );
    assert.strictEqual(
      TangledSourceControlProvider.createsUnderOwner({
        requested: "alice.example",
        created: "did:plc:abc",
      }),
      true,
    );
  });

  it("accepts an answer that names no owner at all", () => {
    assert.strictEqual(
      TangledSourceControlProvider.createsUnderOwner({
        requested: "alice.example",
        created: undefined,
      }),
      true,
    );
  });
});

describe("createChangeRequest", () => {
  const pullList = (items: ReadonlyArray<Record<string, unknown>>) => ({
    stdout: encodeJson({ items }),
  });

  const create = () =>
    Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      return yield* provider.createChangeRequest({
        cwd: "/repo",
        context: REMOTE,
        baseRefName: "main",
        headSelector: "feature",
        title: "Add a thing",
        bodyFile: "/tmp/body.md",
      });
    });

  it.effect("creates a pull request once no open one holds the branch", () => {
    const tg = fakeTg({
      "pr list alice.example/repo --state open": pullList([]),
      "pr create --title Add a thing --body-file /tmp/body.md --base main --head feature --repo alice.example/repo":
        { stdout: "" },
    });
    return create().pipe(
      Effect.map(() => {
        assert.deepStrictEqual(tg.calls, [
          ["pr", "list", "alice.example/repo", "--state", "open"],
          [
            "pr",
            "create",
            "--title",
            "Add a thing",
            "--body-file",
            "/tmp/body.md",
            "--base",
            "main",
            "--head",
            "feature",
            "--repo",
            "alice.example/repo",
          ],
        ]);
      }),
      serve(tg),
    );
  });

  it.effect("refuses a duplicate beyond the first 100 open pull requests", () => {
    const tg = fakeTg({
      "pr list alice.example/repo --state open": pullList([
        ...Array.from({ length: 100 }, (_, index) => ({
          rkey: `other-${index}`,
          title: "Another branch",
          state: "open",
          sourceBranch: `other-${index}`,
          targetBranch: "main",
        })),
        {
          rkey: "3mkaewigwhi22",
          title: "Already open",
          state: "open",
          sourceBranch: "feature",
          targetBranch: "main",
        },
      ]),
      "pr create --title Add a thing --body-file /tmp/body.md --base main --head feature --repo alice.example/repo":
        { stdout: "" },
    });
    return create().pipe(
      Effect.flip,
      Effect.map((error) => {
        assert.match(error.detail, /already has an open pull request/u);
        assert.match(error.detail, /3mkaewigwhi22/u);
        assert.deepStrictEqual(tg.calls, [["pr", "list", "alice.example/repo", "--state", "open"]]);
      }),
      serve(tg),
    );
  });

  it.effect("creates when the open pull request targets a different branch", () => {
    const tg = fakeTg({
      "pr list alice.example/repo --state open": pullList([
        {
          rkey: "3mkaewigwhi22",
          title: "Into staging",
          state: "open",
          sourceBranch: "feature",
          targetBranch: "staging",
        },
      ]),
      "pr create --title Add a thing --body-file /tmp/body.md --base main --head feature --repo alice.example/repo":
        { stdout: "" },
    });
    return create().pipe(
      Effect.map(() => {
        assert.equal(tg.calls.length, 2);
        assert.strictEqual(tg.calls[1]?.[0], "pr");
        assert.strictEqual(tg.calls[1]?.[1], "create");
      }),
      serve(tg),
    );
  });

  it.effect("creates from a DID remote without passing --repo, which takes no DID", () => {
    const tg = fakeTg({
      "pr list did:plc:4ygmvhvc6kw3w7j4fmd4eiqp --state open": pullList([]),
      "pr create --title Add a thing --body-file /tmp/body.md --base main --head feature": {
        stdout: "",
      },
    });
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      yield* provider.createChangeRequest({
        cwd: "/repo",
        context: context("git@tangled.org:did:plc:4ygmvhvc6kw3w7j4fmd4eiqp"),
        baseRefName: "main",
        headSelector: "feature",
        title: "Add a thing",
        bodyFile: "/tmp/body.md",
      });
      assert.ok(!tg.calls[1]?.includes("--repo"));
    }).pipe(serve(tg));
  });

  it.effect("reports what tg said when the pull request itself fails", () => {
    const tg = fakeTg({
      "pr list alice.example/repo --state open": pullList([]),
      "pr create --title Add a thing --body-file /tmp/body.md --base main --head feature --repo alice.example/repo":
        {
          stdout: "",
          stderr: "Error: branch feature has no commits ahead of main",
          exitCode: 1,
        },
    });
    return create().pipe(
      Effect.flip,
      Effect.map((error) => {
        assert.match(error.detail, /no commits ahead/u);
        assert.strictEqual(error.command, "tg");
      }),
      serve(tg),
    );
  });
});

describe("TangledSourceControlProvider.make", () => {
  it.effect("returns clone URLs for the repository the remote names", () => {
    const tg = fakeTg({
      "repo view alice.example/repo": {
        stdout: encodeJson({ name: "repo", author: "alice.example", knot: "knot1.tangled.sh" }),
      },
    });
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      const urls = yield* provider.getRepositoryCloneUrls({
        cwd: "/repo",
        context: REMOTE,
        repository: "alice.example/repo",
      });
      assert.deepStrictEqual(urls, {
        nameWithOwner: "alice.example/repo",
        url: "https://tangled.org/alice.example/repo",
        sshUrl: "git@tangled.org:alice.example/repo",
      });
      assert.deepStrictEqual(tg.calls, [["repo", "view", "alice.example/repo"]]);
    }).pipe(serve(tg));
  });

  it.effect("resolves the repository from the name alone, with no checkout at all", () => {
    // The clone picker types `handle/repo` and passes no context, so no remote is present here.
    const tg = fakeTg({
      "repo view alice.example/repo": {
        stdout: encodeJson({ name: "repo", author: "alice.example", knot: "knot1.tangled.sh" }),
      },
    });
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      const urls = yield* provider.getRepositoryCloneUrls({
        cwd: "/workspace",
        repository: "alice.example/repo",
      });
      assert.deepStrictEqual(urls, {
        nameWithOwner: "alice.example/repo",
        url: "https://tangled.org/alice.example/repo",
        sshUrl: "git@tangled.org:alice.example/repo",
      });
      assert.deepStrictEqual(tg.calls, [["repo", "view", "alice.example/repo"]]);
    }).pipe(serve(tg));
  });

  it.effect("reads a pasted repository URL as the address it names", () => {
    const tg = fakeTg({
      "repo view alice.example/repo": {
        stdout: encodeJson({ name: "repo", author: "alice.example", knot: "knot1.tangled.sh" }),
      },
    });
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      for (const repository of [
        "https://tangled.org/alice.example/repo",
        "git@tangled.org:alice.example/repo.git",
        "  alice.example/repo/  ",
      ]) {
        const urls = yield* provider.getRepositoryCloneUrls({
          cwd: "/workspace",
          repository,
        });
        assert.strictEqual(urls.nameWithOwner, "alice.example/repo");
      }
    }).pipe(serve(tg));
  });

  it.effect("reports what tg said when the repository does not resolve", () => {
    const tg = fakeTg({
      "repo view alice.example/missing": {
        stdout: "",
        stderr: 'Error: repo "missing" not found for handle "alice.example"',
        exitCode: 1,
      },
    });
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      const error = yield* provider
        .getRepositoryCloneUrls({
          cwd: "/repo",
          context: context("git@tangled.org:alice.example/missing"),
          repository: "alice.example/missing",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.operation, "getRepositoryCloneUrls");
      assert.strictEqual(error.command, "tg");
      assert.match(error.detail, /not found for handle/u);
    }).pipe(serve(tg));
  });

  it.effect("accepts a repository DID remote without asking tg to resolve it", () => {
    // `tg repo view` refuses a DID, and `tg` writes a DID into the remote whenever the repository
    // record carries one — which is what most real Tangled remotes look like.
    const tg = fakeTg({});
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      const urls = yield* provider.getRepositoryCloneUrls({
        cwd: "/repo",
        context: context("git@tangled.org:did:plc:4ygmvhvc6kw3w7j4fmd4eiqp"),
        repository: "did:plc:4ygmvhvc6kw3w7j4fmd4eiqp",
      });
      assert.deepStrictEqual(urls, {
        nameWithOwner: "did:plc:4ygmvhvc6kw3w7j4fmd4eiqp",
        url: "https://tangled.org/did:plc:4ygmvhvc6kw3w7j4fmd4eiqp",
        sshUrl: "git@tangled.org:did:plc:4ygmvhvc6kw3w7j4fmd4eiqp",
      });
      assert.deepStrictEqual(tg.calls, []);
    }).pipe(serve(tg));
  });

  it.effect("refuses a remote that names neither handle/repo nor a repository DID", () => {
    const tg = fakeTg({});
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      const error = yield* provider
        .getRepositoryCloneUrls({
          cwd: "/repo",
          context: context("git@tangled.org:group/nested/repo"),
          repository: "group/nested/repo",
        })
        .pipe(Effect.flip);
      assert.match(error.detail, /handle\/repo/u);
    }).pipe(serve(tg));
  });

  it.effect.each(["alice.example", "did:plc:alice"])(
    "creates a repository for the confirmed owner %s",
    (owner) => {
      const tg = fakeTg({
        "auth status": {
          stdout: encodeJson({
            authenticated: true,
            handle: "alice.example",
            did: "did:plc:alice",
          }),
        },
        "repo create repo": {
          stdout: encodeJson({ name: "repo", author: "alice.example", knot: "knot1.tangled.sh" }),
        },
      });
      return Effect.gen(function* () {
        const provider = yield* TangledSourceControlProvider.make;
        const urls = yield* provider.createRepository({
          cwd: "/repo",
          repository: `${owner}/repo`,
          visibility: "public",
        });
        assert.deepStrictEqual(urls, {
          nameWithOwner: `${owner}/repo`,
          url: `https://tangled.org/${owner}/repo`,
          sshUrl: `git@tangled.org:${owner}/repo`,
        });
        assert.deepStrictEqual(tg.calls, [
          ["auth", "status"],
          ["repo", "create", "repo"],
        ]);
      }).pipe(serve(tg));
    },
  );

  it.effect("rejects malformed repository paths before invoking tg", () => {
    const tg = fakeTg({});
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      for (const repository of [
        "alice.example/repo/extra",
        "/repo",
        "alice.example/",
        "alice.example/repo/",
      ]) {
        const error = yield* provider
          .createRepository({
            cwd: "/repo",
            repository,
            visibility: "public",
          })
          .pipe(Effect.flip);
        assert.match(error.detail, /handle\/repo/u);
      }
      assert.deepStrictEqual(tg.calls, []);
    }).pipe(serve(tg));
  });

  it.effect("rejects a different signed-in handle before creating a repository", () => {
    const tg = fakeTg({
      "auth status": { stdout: encodeJson({ authenticated: true, handle: "alice.example" }) },
      "repo create repo": {
        stdout: encodeJson({ name: "repo", author: "alice.example", knot: "knot1.tangled.sh" }),
      },
    });
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      const error = yield* provider
        .createRepository({ cwd: "/repo", repository: "someone-else/repo", visibility: "public" })
        .pipe(Effect.flip);
      assert.match(error.detail, /someone-else/u);
      assert.deepStrictEqual(tg.calls, [["auth", "status"]]);
    }).pipe(serve(tg));
  });

  it.effect("rejects a different signed-in DID before creating a repository", () => {
    const tg = fakeTg({
      "auth status": { stdout: encodeJson({ authenticated: true, did: "did:plc:bob" }) },
      "repo create repo": {
        stdout: encodeJson({ name: "repo", author: "did:plc:bob", knot: "knot1.tangled.sh" }),
      },
    });
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      const error = yield* provider
        .createRepository({
          cwd: "/repo",
          repository: "did:plc:alice/repo",
          visibility: "public",
        })
        .pipe(Effect.flip);
      assert.match(error.detail, /did:plc:bob/u);
      assert.match(error.detail, /did:plc:alice/u);
      assert.deepStrictEqual(tg.calls, [["auth", "status"]]);
    }).pipe(serve(tg));
  });

  it.effect.each([
    { authenticated: false, handle: "alice.example" },
    { authenticated: true },
    { authenticated: true, status: "expired", handle: "alice.example" },
    { authenticated: true, status: "unknown", handle: "alice.example" },
  ])("does not create when the signed-in owner cannot be confirmed: %j", (account) => {
    const tg = fakeTg({ "auth status": { stdout: encodeJson(account) } });
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      const error = yield* provider
        .createRepository({
          cwd: "/repo",
          repository: "alice.example/repo",
          visibility: "public",
        })
        .pipe(Effect.flip);
      assert.match(error.detail, /Cannot confirm/u);
      assert.deepStrictEqual(tg.calls, [["auth", "status"]]);
    }).pipe(serve(tg));
  });

  it.effect("reads the default branch from git's own symref", () => {
    const gitCalls: Array<ReadonlyArray<string>> = [];
    const layer = TestSourceControlHost.layer({
      process: { run: () => Effect.die("tg must not run to read a default branch.") },
      git: {
        execute: (input) => {
          gitCalls.push(input.args);
          return Effect.succeed(
            TestSourceControlHost.processOutput("ref: refs/heads/trunk\tHEAD\nabc123\tHEAD\n"),
          );
        },
      },
    });
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      const branch = yield* provider.getDefaultBranch({ cwd: "/repo", context: REMOTE });
      assert.strictEqual(branch, "trunk");
      assert.deepStrictEqual(gitCalls, [["ls-remote", "--symref", "origin", "HEAD"]]);
    }).pipe(
      Effect.provide(TangledCli.layer.pipe(Layer.provideMerge(layer))),
      Effect.provideService(HttpClient.HttpClient, unusedHttpClient),
    );
  });

  it.effect("reports a git failure to list the remote's branches", () => {
    const layer = TestSourceControlHost.layer({
      git: {
        execute: () =>
          Effect.fail(
            new GitCommandError({
              operation: "execute",
              command: "git",
              cwd: "/repo",
              detail: "remote not found.",
            }),
          ),
      },
    });
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      const error = yield* provider
        .getDefaultBranch({ cwd: "/repo", context: REMOTE })
        .pipe(Effect.flip);
      assert.strictEqual(error.operation, "getDefaultBranch");
      assert.strictEqual(error.detail, "Tangled operation failed.");
    }).pipe(
      Effect.provide(TangledCli.layer.pipe(Layer.provideMerge(layer))),
      Effect.provideService(HttpClient.HttpClient, unusedHttpClient),
    );
  });

  it.effect("preserves the immediate PR provider error when branch lookup fails", () => {
    const tg = fakeTg({
      "pr list alice.example/repo": {
        stdout: "",
        stderr: "Error: not logged in",
        exitCode: 1,
      },
    });
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      const error = yield* provider
        .listChangeRequests({
          cwd: "/repo",
          context: REMOTE,
          headSelector: "feature",
          state: "all",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.provider, TangledSourceControlProvider.KIND);
      assert.strictEqual(error.operation, "listChangeRequests");
      assert.strictEqual(error.cwd, "/repo");
      const cause = error.cause;
      if (!isPullRequestProviderError(cause))
        return assert.fail("Missing immediate PR provider error");
      assert.strictEqual(error.detail, cause.detail);
      assert.strictEqual(cause.reason, "unauthenticated");
    }).pipe(serve(tg));
  });

  it.effect("finds only the current branch's pull requests before applying the limit", () => {
    const tg = fakeTg({
      "pr list alice.example/repo": {
        stdout: encodeJson({
          items: [
            {
              rkey: "a",
              title: "Old PR",
              state: "closed",
              sourceBranch: "test/pull-request",
              targetBranch: "main",
              createdAt: "2026-10-12T12:00:00Z",
            },
            {
              rkey: "b",
              title: "Current PR",
              state: "open",
              sourceBranch: "test/another-branch",
              targetBranch: "main",
              createdAt: "2026-10-12T13:00:00Z",
            },
          ],
        }),
      },
    });
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response('<a href="/alice.example/repo/pulls/2">Current PR</a>'),
        ),
      ),
    );
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      const matches = yield* provider.listChangeRequests({
        cwd: "/repo",
        context: REMOTE,
        headSelector: "alice.example:test/another-branch",
        state: "all",
        limit: 1,
      });
      assert.deepStrictEqual(
        matches.map((pull) => [pull.number, pull.headRefName]),
        [[2, "test/another-branch"]],
      );
      assert.deepStrictEqual(
        yield* provider.listChangeRequests({
          cwd: "/repo",
          context: REMOTE,
          headSelector: "no-pr",
          state: "all",
        }),
        [],
      );
      assert.deepStrictEqual(
        yield* provider.listChangeRequests({
          cwd: "/repo",
          context: REMOTE,
          headSelector: "test/pull-request",
          state: "open",
        }),
        [],
      );
    }).pipe(serve(tg, client));
  });

  it.effect("still refuses to read or check out a pull request it cannot number", () => {
    const tg = fakeTg({});
    return Effect.gen(function* () {
      const provider = yield* TangledSourceControlProvider.make;
      for (const call of [
        provider.getChangeRequest({ cwd: "/repo", context: REMOTE, reference: "19" }),
        provider.checkoutChangeRequest({ cwd: "/repo", context: REMOTE, reference: "19" }),
      ]) {
        const error = yield* call.pipe(Effect.flip);
        assert.match(error.detail, /record key/u);
      }
      assert.deepStrictEqual(tg.calls, []);
    }).pipe(serve(tg));
  });
});

describe("TangledCli environment flags", () => {
  const signedIn = encodeJson({ authenticated: true, handle: "alice.example" });

  it.effect("defaults to the appview and knot the settings schema carries", () => {
    const runs: Array<{ readonly args: ReadonlyArray<string>; readonly env: unknown }> = [];
    const layer = TestSourceControlHost.layer({
      process: {
        run: (input) => {
          runs.push({ args: input.args, env: input.env });
          return Effect.succeed(TestSourceControlHost.processOutput(signedIn));
        },
      },
    });
    return Effect.gen(function* () {
      const cli = yield* TangledCli.TangledCli;
      const status = yield* cli.runJson({
        cwd: "/repo",
        args: ["auth", "status"],
        schema: TangledCli.TangledAuthStatusSchema,
      });
      assert.deepStrictEqual(status, { authenticated: true, handle: "alice.example" });
      assert.deepStrictEqual(runs[0]?.args, ["auth", "status", "--json"]);
      // `tg` has no global `--knot`, so both reach it through the environment it documents.
      assert.deepStrictEqual(runs[0]?.env, {
        TG_APPVIEW: TangledClient.DEFAULT_APPVIEW,
        TG_KNOT: TangledClient.DEFAULT_KNOT,
      });
    }).pipe(Effect.provide(TangledCli.layer.pipe(Layer.provideMerge(layer))));
  });

  it.effect("lets a saved knot and appview override the defaults", () => {
    const runs: Array<{ readonly args: ReadonlyArray<string>; readonly env: unknown }> = [];
    const layer = TestSourceControlHost.layer({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        sourceControlHosts: {
          ...DEFAULT_SERVER_SETTINGS.sourceControlHosts,
          tangled: { knot: "knot.example.com", appview: "https://appview.example.com" },
        },
      },
      process: {
        run: (input) => {
          runs.push({ args: input.args, env: input.env });
          return Effect.succeed(TestSourceControlHost.processOutput(signedIn));
        },
      },
    });
    return Effect.gen(function* () {
      const cli = yield* TangledCli.TangledCli;
      yield* cli.runJson({
        cwd: "/repo",
        args: ["auth", "status"],
        schema: TangledCli.TangledAuthStatusSchema,
      });
      assert.deepStrictEqual(runs[0]?.env, {
        TG_APPVIEW: "https://appview.example.com",
        TG_KNOT: "knot.example.com",
      });
    }).pipe(Effect.provide(TangledCli.layer.pipe(Layer.provideMerge(layer))));
  });

  it.effect("leaves a cleared field unset so tg falls back to its own config", () => {
    const runs: Array<{ readonly env: unknown }> = [];
    const layer = TestSourceControlHost.layer({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        sourceControlHosts: {
          ...DEFAULT_SERVER_SETTINGS.sourceControlHosts,
          tangled: { knot: "  ", appview: "" },
        },
      },
      process: {
        run: (input) => {
          runs.push({ env: input.env });
          return Effect.succeed(TestSourceControlHost.processOutput(signedIn));
        },
      },
    });
    return Effect.gen(function* () {
      const cli = yield* TangledCli.TangledCli;
      yield* cli.runJson({
        cwd: "/repo",
        args: ["auth", "status"],
        schema: TangledCli.TangledAuthStatusSchema,
      });
      assert.deepStrictEqual(runs[0]?.env, {});
    }).pipe(Effect.provide(TangledCli.layer.pipe(Layer.provideMerge(layer))));
  });

  it.effect("decodes a signed-out CLI as authenticated:false", () => {
    const layer = TestSourceControlHost.layer({
      process: {
        run: () =>
          Effect.succeed(TestSourceControlHost.processOutput(encodeJson({ authenticated: false }))),
      },
    });
    return Effect.gen(function* () {
      const cli = yield* TangledCli.TangledCli;
      assert.deepStrictEqual(
        yield* cli.runJson({
          cwd: "/repo",
          args: ["auth", "status"],
          schema: TangledCli.TangledAuthStatusSchema,
        }),
        { authenticated: false },
      );
    }).pipe(Effect.provide(TangledCli.layer.pipe(Layer.provideMerge(layer))));
  });

  it.effect("fails with a missing-tool error when tg is not on PATH", () => {
    const layer = TestSourceControlHost.layer({
      process: {
        run: () =>
          Effect.fail(
            new VcsProcessSpawnError({
              operation: "TangledCli.execute",
              command: "tg",
              cwd: "/repo",
              cause: new Error("spawn tg ENOENT"),
            }),
          ),
      },
    });
    return Effect.gen(function* () {
      const cli = yield* TangledCli.TangledCli;
      const error = yield* cli
        .runJson({
          cwd: "/repo",
          args: ["repo", "view", "alice.example/repo"],
          schema: TangledCli.TangledRepositorySchema,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "missing-cli");
      assert.match(error.detail, /not found on the server PATH/u);
    }).pipe(Effect.provide(TangledCli.layer.pipe(Layer.provideMerge(layer))));
  });
});

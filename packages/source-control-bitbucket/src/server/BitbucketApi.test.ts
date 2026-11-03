import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as BitbucketApi from "./BitbucketApi.ts";

type HostGit = SourceControlHost.SourceControlHost["Service"]["git"];

const isBitbucketRepositoryLocatorError = Schema.is(BitbucketApi.BitbucketRepositoryLocatorError);

const bitbucketPullRequest = {
  id: 42,
  title: "Add Bitbucket provider",
  state: "OPEN",
  updated_on: "2026-01-02T00:00:00.000Z",
  links: {
    html: {
      href: "https://bitbucket.org/pingdotgg/t3code/pull-requests/42",
    },
  },
  source: {
    branch: { name: "feature/source-control" },
    repository: {
      full_name: "octocat/t3code",
      workspace: { slug: "octocat" },
    },
  },
  destination: {
    branch: { name: "main" },
    repository: {
      full_name: "pingdotgg/t3code",
      workspace: { slug: "pingdotgg" },
    },
  },
};

const repositoryJson = {
  full_name: "pingdotgg/t3code",
  links: {
    html: { href: "https://bitbucket.org/pingdotgg/t3code" },
    clone: [
      { name: "https", href: "https://bitbucket.org/pingdotgg/t3code.git" },
      { name: "ssh", href: "git@bitbucket.org:pingdotgg/t3code.git" },
    ],
  },
  mainbranch: { name: "main" },
};

function makeLayer(input: {
  readonly response: (request: HttpClientRequest.HttpClientRequest) => Response;
  /** Holds the answer until it resolves, in place of answering at once. */
  readonly answer?: (response: Response) => Effect.Effect<Response>;
  readonly requestFailure?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientError.HttpClientError;
  readonly stall?: boolean;
  readonly git?: Partial<HostGit>;
  readonly env?: Record<string, string>;
  readonly remoteUrl?: string;
}) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    input.stall
      ? Effect.never
      : input.requestFailure
        ? Effect.fail(input.requestFailure(request))
        : (input.answer ?? Effect.succeed)(input.response(request)).pipe(
            Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
          ),
  );
  const gitMock = {
    readConfigValue: vi.fn<HostGit["readConfigValue"]>(() =>
      Effect.succeed<string | null>("git@bitbucket.org:pingdotgg/t3code.git"),
    ),
    resolvePrimaryRemoteName: vi.fn<HostGit["resolvePrimaryRemoteName"]>(() =>
      Effect.succeed("origin"),
    ),
    ensureRemote: vi.fn<HostGit["ensureRemote"]>(() => Effect.succeed("octocat")),
    fetchRemoteBranch: vi.fn<HostGit["fetchRemoteBranch"]>(() => Effect.void),
    fetchRemoteTrackingBranch: vi.fn<HostGit["fetchRemoteTrackingBranch"]>(() => Effect.void),
    setBranchUpstream: vi.fn<HostGit["setBranchUpstream"]>(() => Effect.void),
    switchRef: vi.fn<HostGit["switchRef"]>((request) =>
      Effect.succeed({ refName: request.refName }),
    ),
    listLocalBranchNames: vi.fn<HostGit["listLocalBranchNames"]>(() => Effect.succeed([])),
  };
  const git = {
    ...gitMock,
    ...input.git,
  } satisfies Partial<HostGit>;

  const listRemotes = vi.fn(() =>
    Effect.succeed({
      remotes: [
        {
          name: "origin",
          url: input.remoteUrl ?? "git@bitbucket.org:pingdotgg/t3code.git",
          pushUrl: Option.none(),
          isPrimary: true,
        },
      ],
      freshness: {
        source: "live-local" as const,
        observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
        expiresAt: Option.none(),
      },
    }),
  );
  // The outer effect resolves the repository; the inner one lists its remotes.
  const resolve = vi.fn((_cwd: string) => Effect.succeed(Effect.suspend(listRemotes)));

  const layer = BitbucketApi.layer.pipe(
    Layer.provide(SourceControlRateLimit.layer),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: input.env ?? {
            T3CODE_BITBUCKET_API_BASE_URL: "https://api.test.local/2.0",
            T3CODE_BITBUCKET_EMAIL: "user@example.com",
            T3CODE_BITBUCKET_API_TOKEN: "token",
          },
        }),
      ),
    ),
    Layer.provideMerge(TestSourceControlHost.layer({ git: { ...git, remotes: resolve } })),
    Layer.provideMerge(NodeServices.layer),
  );

  return { execute, git: gitMock, resolve, listRemotes, layer };
}

it.effect("parses pull request responses from the Bitbucket REST API", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        ...bitbucketPullRequest,
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const result = yield* bitbucket.getPullRequest({
      cwd: "/repo",
      reference: "#42",
    });

    assert.deepStrictEqual(result, {
      number: 42,
      title: "Add Bitbucket provider",
      url: "https://bitbucket.org/pingdotgg/t3code/pull-requests/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.some(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "octocat/t3code",
      headRepositoryOwnerLogin: "octocat",
    });
    assert.strictEqual(
      execute.mock.calls[0]?.[0].url,
      "https://api.test.local/2.0/repositories/pingdotgg/t3code/pullrequests/42",
    );
  }).pipe(Effect.provide(layer));
});

it.effect.each([false, true])("honors PR URL repositories, context=%s", (withContext) => {
  const { execute, git, layer } = makeLayer({
    response: (request) =>
      Response.json(
        request.url.endsWith("/pullrequests/42")
          ? {
              ...bitbucketPullRequest,
              source: {
                branch: { name: "feature/source-control" },
                repository: { full_name: "another/app" },
              },
              destination: { branch: { name: "main" }, repository: { full_name: "another/app" } },
            }
          : {
              ...repositoryJson,
              full_name: "another/app",
              links: { clone: [{ name: "ssh", href: "git@bitbucket.org:another/app.git" }] },
            },
      ),
  });
  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const input = {
      cwd: "/repo",
      reference: "https://bitbucket.org/another/app/pull-requests/42",
      ...(withContext
        ? {
            context: {
              provider: {
                kind: SourceControlProviderKind.make("bitbucket"),
                name: "Bitbucket",
                baseUrl: "https://bitbucket.org",
              },
              remoteName: "origin",
              remoteUrl: "git@bitbucket.org:pingdotgg/t3code.git",
            },
          }
        : {}),
    };
    yield* bitbucket.getPullRequest(input);
    yield* bitbucket.checkoutPullRequest(input);
    assert.deepStrictEqual(
      execute.mock.calls.slice(0, 2).map(([request]) => request.url),
      [
        "https://api.test.local/2.0/repositories/another/app/pullrequests/42",
        "https://api.test.local/2.0/repositories/another/app/pullrequests/42",
      ],
    );
    assert.deepStrictEqual(git.ensureRemote.mock.calls[0]?.[0], {
      cwd: "/repo",
      preferredName: "another",
      url: "git@bitbucket.org:another/app.git",
    });
    assert.deepStrictEqual(git.fetchRemoteBranch.mock.calls[0]?.[0], {
      cwd: "/repo",
      remoteName: "octocat",
      remoteBranch: "feature/source-control",
      localBranch: "feature/source-control",
    });
    assert.deepStrictEqual(git.setBranchUpstream.mock.calls[0]?.[0], {
      cwd: "/repo",
      branch: "feature/source-control",
      remoteName: "octocat",
      remoteBranch: "feature/source-control",
    });
  }).pipe(Effect.provide(layer));
});

it.effect.each([false, true])(
  "reuses matching checkout remotes for numeric references, context=%s",
  (withContext) => {
    const { git, layer } = makeLayer({
      response: () =>
        Response.json({
          ...bitbucketPullRequest,
          source: { ...bitbucketPullRequest.source, repository: { full_name: "pingdotgg/t3code" } },
        }),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      yield* bitbucket.checkoutPullRequest({
        cwd: "/repo",
        reference: "#42",
        ...(withContext
          ? {
              context: {
                provider: {
                  kind: SourceControlProviderKind.make("bitbucket"),
                  name: "Bitbucket",
                  baseUrl: "https://bitbucket.org",
                },
                remoteName: "upstream",
                remoteUrl: "git@bitbucket.org:PingDotGG/T3Code.git",
              },
            }
          : {}),
      });
      assert.strictEqual(git.ensureRemote.mock.calls.length, 0);
      assert.deepStrictEqual(git.fetchRemoteBranch.mock.calls[0]?.[0], {
        cwd: "/repo",
        remoteName: withContext ? "upstream" : "origin",
        remoteBranch: "feature/source-control",
        localBranch: "feature/source-control",
      });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("lists pull requests with Bitbucket state and source branch query params", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        values: [
          {
            ...bitbucketPullRequest,
            id: 7,
            state: "MERGED",
            source: {
              branch: { name: "feature/merged" },
              repository: { full_name: "pingdotgg/t3code" },
            },
          },
        ],
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const result = yield* bitbucket.listPullRequests({
      cwd: "/repo",
      headSelector: "origin:feature/merged",
      state: "merged",
      limit: 10,
    });

    assert.strictEqual(result[0]?.state, "merged");
    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(
      request?.url,
      "https://api.test.local/2.0/repositories/pingdotgg/t3code/pullrequests",
    );
    assert.deepStrictEqual(request?.urlParams.params, [
      ["pagelen", "10"],
      ["sort", "-updated_on"],
      ["q", 'source.branch.name = "feature/merged" AND state = "MERGED"'],
      ["state", "MERGED"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("reads repository clone URLs and default branch", () => {
  const { layer } = makeLayer({
    response: (request) =>
      Response.json(
        request.url.endsWith("/branching-model")
          ? {
              development: {
                branch: { name: "main" },
                name: "main",
                use_mainbranch: true,
              },
            }
          : repositoryJson,
      ),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const cloneUrls = yield* bitbucket.getRepositoryCloneUrls({
      cwd: "/repo",
      repository: "pingdotgg/t3code",
    });
    const defaultBranch = yield* bitbucket.getDefaultBranch({ cwd: "/repo" });

    assert.deepStrictEqual(cloneUrls, {
      nameWithOwner: "pingdotgg/t3code",
      url: "https://bitbucket.org/pingdotgg/t3code.git",
      sshUrl: "git@bitbucket.org:pingdotgg/t3code.git",
    });
    assert.strictEqual(defaultBranch, "main");
  }).pipe(Effect.provide(layer));
});

it.effect.each([false, true])(
  "rejects invalid explicit repositories before fallback, context=%s",
  (withContext) => {
    const { execute, resolve, listRemotes, layer } = makeLayer({
      response: () => Response.json(repositoryJson),
    });

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      for (const repository of ["t3code", "", " \t "]) {
        const error = yield* bitbucket
          .getRepositoryCloneUrls({
            cwd: "/repo",
            repository,
            ...(withContext
              ? {
                  context: {
                    provider: {
                      kind: SourceControlProviderKind.make("bitbucket"),
                      name: "Bitbucket",
                      baseUrl: "https://bitbucket.org",
                    },
                    remoteName: "origin",
                    remoteUrl: "git@bitbucket.org:pingdotgg/t3code.git",
                  },
                }
              : {}),
          })
          .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }));

        assert.instanceOf(error, BitbucketApi.BitbucketRepositoryLocatorError);
        assert.strictEqual(
          isBitbucketRepositoryLocatorError(error) ? error.repository : null,
          repository,
        );
        assert.strictEqual(resolve.mock.calls.length, 0);
        assert.strictEqual(listRemotes.mock.calls.length, 0);
        assert.strictEqual(execute.mock.calls.length, 0);
      }
    }).pipe(Effect.provide(layer));
  },
);

it.effect("prefers an explicit repository and uses context when the repository is omitted", () => {
  const { execute, resolve, listRemotes, layer } = makeLayer({
    response: (request) =>
      Response.json(request.url.endsWith("/branching-model") ? {} : repositoryJson),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const context = {
      provider: {
        kind: SourceControlProviderKind.make("bitbucket"),
        name: "Bitbucket",
        baseUrl: "https://bitbucket.org",
      },
      remoteName: "origin",
      remoteUrl: "git@bitbucket.org:another/context.git",
    };
    for (const repository of ["pingdotgg/t3code", "https://bitbucket.org/pingdotgg/t3code.git"]) {
      yield* bitbucket.getRepositoryCloneUrls({ cwd: "/repo", context, repository });
    }
    yield* bitbucket.getDefaultBranch({ cwd: "/repo", context });

    assert.deepStrictEqual(
      execute.mock.calls.map(([request]) => request.url).toSorted(),
      [
        "https://api.test.local/2.0/repositories/pingdotgg/t3code",
        "https://api.test.local/2.0/repositories/pingdotgg/t3code",
        "https://api.test.local/2.0/repositories/another/context",
        "https://api.test.local/2.0/repositories/another/context/branching-model",
      ].toSorted(),
    );
    assert.strictEqual(resolve.mock.calls.length, 0);
    assert.strictEqual(listRemotes.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("sends a self-hosted Bitbucket remote nowhere unless an API base url is configured", () =>
  Effect.gen(function* () {
    const remoteUrl = "https://bitbucket.example.com/scm/proj/repo.git";
    const context = {
      provider: {
        kind: SourceControlProviderKind.make("bitbucket"),
        name: "Bitbucket Self-Hosted",
        baseUrl: "https://bitbucket.example.com",
      },
      remoteName: "origin",
      remoteUrl,
    };
    const cloudEnv = {
      T3CODE_BITBUCKET_EMAIL: "user@example.com",
      T3CODE_BITBUCKET_API_TOKEN: "t",
    };
    const response = (request: HttpClientRequest.HttpClientRequest) =>
      Response.json(request.url.endsWith("/branching-model") ? {} : repositoryJson);
    const defaultBranch = (setup: ReturnType<typeof makeLayer>, withContext: boolean) =>
      BitbucketApi.BitbucketApi.pipe(
        Effect.flatMap((bitbucket) =>
          bitbucket.getDefaultBranch({ cwd: "/repo", ...(withContext ? { context } : {}) }),
        ),
        Effect.provide(setup.layer),
      );
    const requestedUrls = (setup: ReturnType<typeof makeLayer>) =>
      setup.execute.mock.calls.map(([request]) => request.url).toSorted();

    // A self-hosted remote in the checkout, then a self-hosted context beside a Cloud remote.
    for (const [setup, withContext] of [
      [makeLayer({ response, env: cloudEnv, remoteUrl }), false],
      [makeLayer({ response, env: cloudEnv }), true],
    ] as const) {
      const result = yield* defaultBranch(setup, withContext).pipe(Effect.result);
      assert.deepStrictEqual(requestedUrls(setup), []);
      assert.strictEqual(
        Result.isFailure(result) && result.failure._tag,
        "BitbucketRepositoryRemoteNotFoundError",
      );
    }

    // An explicit repository does not let a self-hosted context reach the Cloud API.
    const explicit = makeLayer({ response, env: cloudEnv });
    const cloneUrls = yield* BitbucketApi.BitbucketApi.pipe(
      Effect.flatMap((bitbucket) =>
        bitbucket.getRepositoryCloneUrls({ cwd: "/repo", context, repository: "proj/repo" }),
      ),
      Effect.provide(explicit.layer),
      Effect.result,
    );
    assert.deepStrictEqual(requestedUrls(explicit), []);
    assert.strictEqual(
      Result.isFailure(cloneUrls) && cloneUrls.failure._tag,
      "BitbucketRepositoryRemoteNotFoundError",
    );

    const cloud = makeLayer({ response, env: cloudEnv });
    yield* defaultBranch(cloud, false);
    assert.deepStrictEqual(requestedUrls(cloud), [
      "https://api.bitbucket.org/2.0/repositories/pingdotgg/t3code",
      "https://api.bitbucket.org/2.0/repositories/pingdotgg/t3code/branching-model",
    ]);

    const configured = makeLayer({ response, remoteUrl });
    yield* defaultBranch(configured, true);
    assert.deepStrictEqual(requestedUrls(configured), [
      "https://api.test.local/2.0/repositories/proj/repo",
      "https://api.test.local/2.0/repositories/proj/repo/branching-model",
    ]);
  }),
);

it.effect(
  "prefers the Bitbucket branching model development branch as the default PR target",
  () => {
    const { execute, layer } = makeLayer({
      response: (request) =>
        Response.json(
          request.url.endsWith("/branching-model")
            ? {
                development: {
                  branch: { name: "develop" },
                  name: "develop",
                  use_mainbranch: false,
                },
              }
            : repositoryJson,
        ),
    });

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const defaultBranch = yield* bitbucket.getDefaultBranch({ cwd: "/repo" });

      assert.strictEqual(defaultBranch, "develop");
      assert.deepStrictEqual(
        execute.mock.calls.map((call) => call[0].url).toSorted(),
        [
          "https://api.test.local/2.0/repositories/pingdotgg/t3code",
          "https://api.test.local/2.0/repositories/pingdotgg/t3code/branching-model",
        ].toSorted(),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "falls back to the repository main branch when the Bitbucket development branch is invalid",
  () => {
    const { layer } = makeLayer({
      response: (request) =>
        Response.json(
          request.url.endsWith("/branching-model")
            ? {
                development: {
                  name: "develop",
                  use_mainbranch: false,
                  is_valid: false,
                },
              }
            : repositoryJson,
        ),
    });

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const defaultBranch = yield* bitbucket.getDefaultBranch({ cwd: "/repo" });

      assert.strictEqual(defaultBranch, "main");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("creates pull requests using the official REST payload shape", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json(bitbucketPullRequest),
  });

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const bodyFile = yield* fileSystem.makeTempFileScoped({ prefix: "bitbucket-pr-body-" });
    yield* fileSystem.writeFileString(bodyFile, "PR body");

    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.createPullRequest({
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile,
    });

    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(
      request?.url,
      "https://api.test.local/2.0/repositories/pingdotgg/t3code/pullrequests",
    );
    assert.strictEqual(request?.method, "POST");
    assert.ok(request);
    const rawBody = (request.body as { readonly body?: Uint8Array }).body;
    assert.ok(rawBody);
    assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(rawBody)), {
      title: "Provider PR",
      description: "PR body",
      source: {
        branch: { name: "feature/provider" },
        repository: { full_name: "owner/t3code" },
      },
      destination: {
        branch: { name: "main" },
      },
    });
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect("reports the account Bitbucket confirms for the configured credential", () => {
  const { layer } = makeLayer({
    response: () => Response.json({ username: "bitbucket-user" }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const auth = yield* bitbucket.probeAuth;
    assert.strictEqual(auth.status, "authenticated");
    assert.deepStrictEqual(auth.account, Option.some("bitbucket-user"));
    assert.deepStrictEqual(auth.host, Option.some("bitbucket.org"));
  }).pipe(Effect.provide(layer));
});

it.effect("prefers credentials saved in settings over the environment, without a restart", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ username: "bitbucket-user" }),
  });
  const lastAuthorization = () => execute.mock.calls.at(-1)?.[0].headers.authorization;
  const basic = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`;

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;

    yield* bitbucket.probeAuth;
    assert.strictEqual(lastAuthorization(), basic("user@example.com", "token"));

    yield* settings.update({
      sourceControlHosts: {
        bitbucket: { email: "saved@example.com", apiToken: "saved-api-token" },
      },
    });
    yield* bitbucket.probeAuth;
    assert.strictEqual(lastAuthorization(), basic("saved@example.com", "saved-api-token"));

    yield* settings.update({
      sourceControlHosts: { bitbucket: { accessToken: "saved-access-token" } },
    });
    yield* bitbucket.probeAuth;
    assert.strictEqual(lastAuthorization(), "Bearer saved-access-token");

    yield* settings.update({
      sourceControlHosts: { bitbucket: { accessToken: "", apiToken: "" } },
    });
    yield* bitbucket.probeAuth;
    assert.strictEqual(lastAuthorization(), basic("user@example.com", "token"));
  }).pipe(Effect.provide(layer));
});

it.effect("never puts a saved token that is unsafe for an HTTP header on the wire", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ username: "bitbucket-user" }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;

    // Fetch would reject this header with an error quoting the token, and that error reaches
    // clients. The unusable token is ignored, so the environment credential is used instead.
    yield* settings.update({
      sourceControlHosts: { bitbucket: { accessToken: "saved\ntoken" } },
    });
    yield* bitbucket.probeAuth;
    assert.strictEqual(
      execute.mock.calls.at(-1)?.[0].headers.authorization,
      `Basic ${btoa("user@example.com:token")}`,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("reports saved credentials as configured when Bitbucket cannot confirm them", () => {
  const { execute, layer } = makeLayer({
    response: () => new Response(null, { status: 401 }),
    env: { T3CODE_BITBUCKET_API_BASE_URL: "https://api.test.local/2.0" },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;

    assert.strictEqual((yield* bitbucket.probeAuth).status, "unauthenticated");
    assert.strictEqual(execute.mock.calls.length, 0);

    yield* settings.update({
      sourceControlHosts: { bitbucket: { accessToken: "saved-access-token" } },
    });
    assert.deepStrictEqual(yield* bitbucket.probeAuth, {
      status: "unknown",
      account: Option.none(),
      host: Option.some("bitbucket.org"),
      detail: Option.some("An access token is configured."),
    });
  }).pipe(Effect.provide(layer));
});

it.effect("keeps Bitbucket response bodies out of checkout diagnostics", () => {
  const responseBody = '{"error":{"message":"credential=secret-value"}}';
  const { layer } = makeLayer({
    response: () => new Response(responseBody, { status: 403 }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const error = yield* bitbucket
      .checkoutPullRequest({ cwd: "/repo", reference: "42" })
      .pipe(Effect.flip);

    assert.instanceOf(error, BitbucketApi.BitbucketResponseError);
    assert.strictEqual(error.operation, "getPullRequest");
    assert.strictEqual(error.status, 403);
    assert.strictEqual(error.responseBodyLength, responseBody.length);
    assert.notProperty(error, "responseBody");
    assert.strictEqual(
      error.message,
      "Bitbucket API failed in getPullRequest: Bitbucket returned HTTP 403.",
    );
    assert.notInclude(error.message, "secret-value");
  }).pipe(Effect.provide(layer));
});

it.effect("checks out fork pull requests through an ensured fork remote", () => {
  const { git, layer } = makeLayer({
    response: (request) => {
      if (request.url.endsWith("/repositories/octocat/t3code")) {
        return Response.json({
          ...repositoryJson,
          full_name: "octocat/t3code",
          links: {
            html: { href: "https://bitbucket.org/octocat/t3code" },
            clone: [
              { name: "https", href: "https://bitbucket.org/octocat/t3code.git" },
              { name: "ssh", href: "git@bitbucket.org:octocat/t3code.git" },
            ],
          },
        });
      }
      return Response.json({
        ...bitbucketPullRequest,
        source: {
          branch: { name: "main" },
          repository: {
            full_name: "octocat/t3code",
            workspace: { slug: "octocat" },
          },
        },
      });
    },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.checkoutPullRequest({
      cwd: "/repo",
      reference: "42",
      force: true,
    });

    assert.deepStrictEqual(git.ensureRemote.mock.calls[0]?.[0], {
      cwd: "/repo",
      preferredName: "octocat",
      url: "git@bitbucket.org:octocat/t3code.git",
    });
    assert.deepStrictEqual(git.fetchRemoteBranch.mock.calls[0]?.[0], {
      cwd: "/repo",
      remoteName: "octocat",
      remoteBranch: "main",
      localBranch: "t3code/pr-42/main",
    });
    assert.deepStrictEqual(git.setBranchUpstream.mock.calls[0]?.[0], {
      cwd: "/repo",
      branch: "t3code/pr-42/main",
      remoteName: "octocat",
      remoteBranch: "main",
    });
    assert.deepStrictEqual(git.switchRef.mock.calls[0]?.[0], {
      cwd: "/repo",
      refName: "t3code/pr-42/main",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("refuses a url that points away from the configured Bitbucket", () => {
  const { layer, execute } = makeLayer({ response: () => new Response("{}", { status: 200 }) });
  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;

    const error = yield* Effect.flip(
      bitbucket.request({ method: "GET", url: "https://attacker.example/2.0/repositories" }),
    );

    assert.strictEqual(error._tag, "BitbucketUntrustedUrlError");
    assert.strictEqual(execute.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps only the host of a url it refuses, never its query", () =>
  Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;

    const error = yield* Effect.flip(
      bitbucket.request({
        method: "GET",
        url: "https://attacker.example/asset?signature=secret-token",
      }),
    );

    assert.strictEqual(error._tag, "BitbucketUntrustedUrlError");
    assert.strictEqual(
      error._tag === "BitbucketUntrustedUrlError" ? error.host : "",
      "https://attacker.example",
    );
    assert.notInclude(error.message, "secret-token");
  }).pipe(Effect.provide(makeLayer({ response: () => new Response("{}", { status: 200 }) }).layer)),
);

it.effect("does not follow a redirect off the configured Bitbucket", () =>
  Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;

    const error = yield* Effect.flip(
      bitbucket.request({ method: "GET", url: "/repositories/acme/web/pullrequests/1/diff" }),
    );

    assert.strictEqual(error._tag, "BitbucketUntrustedUrlError");
  }).pipe(
    Effect.provide(
      makeLayer({
        response: () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/stolen" },
          }),
      }).layer,
    ),
  ),
);

it.effect("follows a redirect that stays on the configured Bitbucket", () =>
  Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;

    const result = yield* bitbucket.request({
      method: "GET",
      url: "/repositories/acme/web/pullrequests/1/diff",
    });

    assert.strictEqual(result.body, "diff --git a/a.ts b/a.ts");
    assert.isFalse(result.truncated);
  }).pipe(
    Effect.provide(
      makeLayer({
        response: (request) =>
          request.url.endsWith("/pullrequests/1/diff")
            ? new Response(null, {
                status: 302,
                headers: { location: "https://api.test.local/2.0/repositories/acme/web/diff/abc" },
              })
            : new Response("diff --git a/a.ts b/a.ts", { status: 200 }),
      }).layer,
    ),
  ),
);

it.effect("cuts a response short rather than reading an unbounded diff into memory", () =>
  Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;

    const result = yield* bitbucket.request({
      method: "GET",
      url: "/repositories/acme/web/pullrequests/1/diff",
      maxBytes: 8,
    });

    assert.strictEqual(result.body, "12345678");
    assert.isTrue(result.truncated);
  }).pipe(
    Effect.provide(
      makeLayer({ response: () => new Response("1234567890", { status: 200 }) }).layer,
    ),
  ),
);

it.effect("pauses background reads after a 429 until Bitbucket's retry-after passes", () => {
  let answered = 0;
  const { execute, layer } = makeLayer({
    response: () => {
      answered += 1;
      return answered === 1
        ? new Response("Rate limit exceeded", { status: 429, headers: { "retry-after": "60" } })
        : Response.json({ values: [] });
    },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const lookup = bitbucket.listPullRequests({
      cwd: "/repo",
      headSelector: "feature/a",
      state: "all",
    });

    yield* Effect.flip(lookup);
    const paused = yield* Effect.flip(lookup);
    // Keyed by the repository host, where PullRequestService records its own backoff.
    assert.deepInclude(paused, {
      _tag: "SourceControlRateLimitPausedError",
      host: "bitbucket.org",
      retryAt: 60_000,
    });
    assert.strictEqual(execute.mock.calls.length, 1);

    // A user waiting on an answer is not held back by the background pause, and their success
    // does not end it early.
    yield* lookup.pipe(Effect.provideService(SourceControlRateLimit.Interactive, true));
    yield* bitbucket.request({
      method: "POST",
      url: "/repositories/acme/web/pullrequests/1/approve",
    });

    yield* TestClock.adjust("59 seconds");
    assert.strictEqual((yield* Effect.flip(lookup))._tag, "SourceControlRateLimitPausedError");

    yield* TestClock.adjust("1 second");
    yield* lookup;
  }).pipe(Effect.provide(layer));
});

it.effect("keeps a sweep over many branches to a few Bitbucket requests at a time", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<void>();
    const release = yield* Deferred.make<void>();
    let inFlight = 0;
    let peak = 0;
    const { layer } = makeLayer({
      response: () => Response.json({ values: [] }),
      answer: (response) =>
        Effect.gen(function* () {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          yield* Queue.offer(started, undefined);
          yield* Deferred.await(release);
          inFlight -= 1;
          return response;
        }),
    });

    yield* Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const sweep = yield* Effect.forEach(
        Array.from({ length: 12 }, (_, index) => `feature/${index}`),
        (branch) =>
          bitbucket.listPullRequests({ cwd: "/repo", headSelector: branch, state: "all" }),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.forkChild);
      for (let index = 0; index < 4; index += 1) yield* Queue.take(started);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(sweep);
    }).pipe(Effect.provide(layer));

    assert.strictEqual(peak, 4);
  }),
);

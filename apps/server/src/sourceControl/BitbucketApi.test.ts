import { assert, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConfigProvider, DateTime, Effect, FileSystem, Layer, Option } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as BitbucketApi from "./BitbucketApi.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";

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
  readonly git?: Partial<GitVcsDriver.GitVcsDriverShape>;
}) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, input.response(request))),
  );
  const gitMock = {
    readConfigValue: vi.fn<GitVcsDriver.GitVcsDriverShape["readConfigValue"]>(() =>
      Effect.succeed<string | null>("git@bitbucket.org:pingdotgg/t3code.git"),
    ),
    resolvePrimaryRemoteName: vi.fn<GitVcsDriver.GitVcsDriverShape["resolvePrimaryRemoteName"]>(
      () => Effect.succeed("origin"),
    ),
    ensureRemote: vi.fn<GitVcsDriver.GitVcsDriverShape["ensureRemote"]>(() =>
      Effect.succeed("octocat"),
    ),
    fetchRemoteBranch: vi.fn<GitVcsDriver.GitVcsDriverShape["fetchRemoteBranch"]>(
      () => Effect.void,
    ),
    fetchRemoteTrackingBranch: vi.fn<GitVcsDriver.GitVcsDriverShape["fetchRemoteTrackingBranch"]>(
      () => Effect.void,
    ),
    setBranchUpstream: vi.fn<GitVcsDriver.GitVcsDriverShape["setBranchUpstream"]>(
      () => Effect.void,
    ),
    switchRef: vi.fn<GitVcsDriver.GitVcsDriverShape["switchRef"]>((request) =>
      Effect.succeed({ refName: request.refName }),
    ),
    listLocalBranchNames: vi.fn<GitVcsDriver.GitVcsDriverShape["listLocalBranchNames"]>(() =>
      Effect.succeed([]),
    ),
  };
  const git = {
    ...gitMock,
    ...input.git,
  } satisfies Partial<GitVcsDriver.GitVcsDriverShape>;

  const driver = {
    listRemotes: () =>
      Effect.succeed({
        remotes: [
          {
            name: "origin",
            url: "git@bitbucket.org:pingdotgg/t3code.git",
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
  } satisfies Partial<VcsDriver.VcsDriverShape>;

  const layer = BitbucketApi.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () =>
          Effect.succeed({
            kind: "git",
            repository: {
              kind: "git",
              rootPath: "/repo",
              metadataPath: null,
              freshness: {
                source: "live-local" as const,
                observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
                expiresAt: Option.none(),
              },
            },
            driver: driver as unknown as VcsDriver.VcsDriverShape,
          }),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(git)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_BITBUCKET_API_BASE_URL: "https://api.test.local/2.0",
            T3CODE_BITBUCKET_EMAIL: "user@example.com",
            T3CODE_BITBUCKET_API_TOKEN: "token",
          },
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return { execute, git: gitMock, layer };
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

it.effect("lists closed pull requests with both closed Bitbucket states", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        values: [],
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.listPullRequests({
      cwd: "/repo",
      headSelector: "feature/closed",
      state: "closed",
      limit: 10,
    });

    assert.deepStrictEqual(execute.mock.calls[0]?.[0].urlParams.params, [
      ["pagelen", "10"],
      ["sort", "-updated_on"],
      [
        "q",
        'source.branch.name = "feature/closed" AND (state = "DECLINED" OR state = "SUPERSEDED")',
      ],
      ["state", "DECLINED"],
      ["state", "SUPERSEDED"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("expands all-state pull request listing instead of relying on Bitbucket defaults", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        values: [],
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.listPullRequests({
      cwd: "/repo",
      headSelector: "feature/all",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(execute.mock.calls[0]?.[0].urlParams.params, [
      ["pagelen", "10"],
      ["sort", "-updated_on"],
      [
        "q",
        'source.branch.name = "feature/all" AND (state = "OPEN" OR state = "MERGED" OR state = "DECLINED" OR state = "SUPERSEDED")',
      ],
      ["state", "OPEN"],
      ["state", "MERGED"],
      ["state", "DECLINED"],
      ["state", "SUPERSEDED"],
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

it.effect(
  "falls back to the repository main branch when the Bitbucket branching model is unavailable",
  () => {
    const { layer } = makeLayer({
      response: (request) =>
        request.url.endsWith("/branching-model")
          ? Response.json({ error: { message: "Not found" } }, { status: 404 })
          : Response.json(repositoryJson),
    });

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const defaultBranch = yield* bitbucket.getDefaultBranch({ cwd: "/repo" });

      assert.strictEqual(defaultBranch, "main");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("creates repositories through the Bitbucket REST API", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json(repositoryJson),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const cloneUrls = yield* bitbucket.createRepository({
      cwd: "/repo",
      repository: "pingdotgg/t3code",
      visibility: "private",
    });

    assert.deepStrictEqual(cloneUrls, {
      nameWithOwner: "pingdotgg/t3code",
      url: "https://bitbucket.org/pingdotgg/t3code.git",
      sshUrl: "git@bitbucket.org:pingdotgg/t3code.git",
    });

    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(request?.url, "https://api.test.local/2.0/repositories/pingdotgg/t3code");
    assert.strictEqual(request?.method, "POST");
    assert.ok(request);
    const rawBody = (request.body as { readonly body?: Uint8Array }).body;
    assert.ok(rawBody);
    assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(rawBody)), {
      scm: "git",
      is_private: true,
    });
  }).pipe(Effect.provide(layer));
});

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

it.effect("reports auth status through the Bitbucket REST /user endpoint", () => {
  const { layer } = makeLayer({
    response: () => Response.json({ username: "bitbucket-user" }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const auth = yield* bitbucket.probeAuth;

    assert.deepStrictEqual(auth, {
      status: "authenticated",
      account: Option.some("bitbucket-user"),
      host: Option.some("bitbucket.org"),
      detail: Option.none(),
    });
  }).pipe(Effect.provide(layer));
});

it.effect("checks out same-repository pull requests with the existing Bitbucket remote", () => {
  const { git, layer } = makeLayer({
    response: () =>
      Response.json({
        ...bitbucketPullRequest,
        source: {
          branch: { name: "feature/source-control" },
          repository: {
            full_name: "pingdotgg/t3code",
            workspace: { slug: "pingdotgg" },
          },
        },
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.checkoutPullRequest({
      cwd: "/repo",
      context: {
        provider: {
          kind: "bitbucket",
          name: "Bitbucket",
          baseUrl: "https://bitbucket.org",
        },
        remoteName: "origin",
        remoteUrl: "git@bitbucket.org:pingdotgg/t3code.git",
      },
      reference: "42",
      force: true,
    });

    assert.strictEqual(git.ensureRemote.mock.calls.length, 0);
    assert.deepStrictEqual(git.fetchRemoteBranch.mock.calls[0]?.[0], {
      cwd: "/repo",
      remoteName: "origin",
      remoteBranch: "feature/source-control",
      localBranch: "feature/source-control",
    });
    assert.deepStrictEqual(git.setBranchUpstream.mock.calls[0]?.[0], {
      cwd: "/repo",
      branch: "feature/source-control",
      remoteName: "origin",
      remoteBranch: "feature/source-control",
    });
    assert.deepStrictEqual(git.switchRef.mock.calls[0]?.[0], {
      cwd: "/repo",
      refName: "feature/source-control",
    });
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

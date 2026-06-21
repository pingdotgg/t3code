import { assert, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { GitCommandError } from "@t3tools/contracts";
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
  readonly requestFailure?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientError.HttpClientError;
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
}) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    input.requestFailure
      ? Effect.fail(input.requestFailure(request))
      : Effect.succeed(HttpClientResponse.fromWeb(request, input.response(request))),
  );
  const gitMock = {
    readConfigValue: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["readConfigValue"]>(() =>
      Effect.succeed<string | null>("git@bitbucket.org:pingdotgg/t3code.git"),
    ),
    resolvePrimaryRemoteName: vi.fn<
      GitVcsDriver.GitVcsDriver["Service"]["resolvePrimaryRemoteName"]
    >(() => Effect.succeed("origin")),
    ensureRemote: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["ensureRemote"]>(() =>
      Effect.succeed("octocat"),
    ),
    fetchRemoteBranch: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteBranch"]>(
      () => Effect.void,
    ),
    fetchRemoteTrackingBranch: vi.fn<
      GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"]
    >(() => Effect.void),
    setBranchUpstream: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["setBranchUpstream"]>(
      () => Effect.void,
    ),
    switchRef: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["switchRef"]>((request) =>
      Effect.succeed({ refName: request.refName }),
    ),
    listLocalBranchNames: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["listLocalBranchNames"]>(() =>
      Effect.succeed([]),
    ),
  };
  const git = {
    ...gitMock,
    ...input.git,
  } satisfies Partial<GitVcsDriver.GitVcsDriver["Service"]>;

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
  } satisfies Partial<VcsDriver.VcsDriver["Service"]>;

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
            driver: driver as unknown as VcsDriver.VcsDriver["Service"],
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
    // @effect-diagnostics-next-line preferSchemaOverJson:off
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
    // @effect-diagnostics-next-line preferSchemaOverJson:off
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

it.effect("preserves the HTTP client failure without deriving the domain message from it", () => {
  const transportCause = new Error("socket reset by peer");
  let requestFailure: HttpClientError.HttpClientError | undefined;
  const { layer } = makeLayer({
    response: () => Response.json({}),
    requestFailure: (request) => {
      requestFailure = new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          cause: transportCause,
        }),
      });
      return requestFailure;
    },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const error = yield* Effect.flip(
      bitbucket.getPullRequest({
        cwd: "/repo",
        reference: "42",
      }),
    );

    assert.instanceOf(error, BitbucketApi.BitbucketRequestError);
    assert.strictEqual(error.operation, "getPullRequest");
    assert.strictEqual(
      error.message,
      "Bitbucket API failed in getPullRequest: Failed to send the Bitbucket request.",
    );
    assert.strictEqual(error.cause, requestFailure);
    assert.strictEqual(requestFailure?.cause, transportCause);
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

it.effect("preserves Bitbucket response body read failures as their immediate cause", () => {
  const cause = new Error("response stream failed");
  const { layer } = makeLayer({
    response: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.error(cause),
        }),
        { status: 502 },
      ),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const error = yield* bitbucket
      .getPullRequest({ cwd: "/repo", reference: "42" })
      .pipe(Effect.flip);

    assert.instanceOf(error, BitbucketApi.BitbucketResponseBodyReadError);
    assert.strictEqual(error.operation, "getPullRequest");
    assert.strictEqual(error.status, 502);
    assert.instanceOf(error.cause, HttpClientError.HttpClientError);
    assert.strictEqual(error.cause.cause, cause);
    assert.strictEqual(
      error.message,
      "Bitbucket API failed in getPullRequest: Bitbucket returned HTTP 502.",
    );
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

it.effect("preserves Git checkout failures without deriving the domain message from them", () => {
  const gitCause = new GitCommandError({
    operation: "fetchRemoteBranch",
    command: "git fetch origin feature/source-control",
    cwd: "/repo",
    detail: "remote rejected the request",
  });
  const { layer } = makeLayer({
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
    git: {
      fetchRemoteBranch: () => Effect.fail(gitCause),
    },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const error = yield* Effect.flip(
      bitbucket.checkoutPullRequest({
        cwd: "/repo",
        reference: "42",
        force: true,
      }),
    );

    assert.instanceOf(error, BitbucketApi.BitbucketCheckoutError);
    assert.strictEqual(error.cwd, "/repo");
    assert.strictEqual(error.reference, "42");
    assert.strictEqual(
      error.message,
      "Bitbucket API failed in checkoutPullRequest: Failed to check out the Bitbucket pull request.",
    );
    assert.strictEqual(error.cause, gitCause);
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

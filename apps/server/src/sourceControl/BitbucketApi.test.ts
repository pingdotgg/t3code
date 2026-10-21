import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as BitbucketApi from "@t3tools/source-control-bitbucket/server/BitbucketApi";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

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
  readonly requestFailure?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientError.HttpClientError;
  readonly stall?: boolean;
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
  readonly env?: Record<string, string>;
}) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    input.stall
      ? Effect.never
      : input.requestFailure
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
    listRemotes: vi.fn(() =>
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
    ),
  } satisfies Partial<VcsDriver.VcsDriver["Service"]>;

  const resolve = vi.fn(() =>
    Effect.succeed({
      kind: "git" as const,
      repository: {
        kind: "git" as const,
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
  );

  const layer = BitbucketApi.layer.pipe(
    Layer.provide(ServerSourceControlHost.layer),
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)({})),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(git)),
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
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );

  return { execute, git: gitMock, resolve, listRemotes: driver.listRemotes, layer };
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

it.effect("prefers credentials saved in settings over the environment, without a restart", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ username: "bitbucket-user" }),
  });
  const lastAuthorization = () => execute.mock.calls.at(-1)?.[0].headers.authorization;
  const basic = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`;

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const settings = yield* ServerSettings.ServerSettingsService;

    yield* bitbucket.probeAuth;
    assert.strictEqual(lastAuthorization(), basic("user@example.com", "token"));

    yield* settings.updateSettings({
      sourceControlHosts: {
        bitbucket: { email: "saved@example.com", apiToken: "saved-api-token" },
      },
    });
    yield* bitbucket.probeAuth;
    assert.strictEqual(lastAuthorization(), basic("saved@example.com", "saved-api-token"));

    yield* settings.updateSettings({
      sourceControlHosts: { bitbucket: { accessToken: "saved-access-token" } },
    });
    yield* bitbucket.probeAuth;
    assert.strictEqual(lastAuthorization(), "Bearer saved-access-token");

    yield* settings.updateSettings({
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
    const settings = yield* ServerSettings.ServerSettingsService;

    // Fetch errors echo malformed header tokens to clients; ignore this token and use the environment credential.
    yield* settings.updateSettings({
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
  const { layer } = makeLayer({
    response: () => new Response(null, { status: 401 }),
    env: { T3CODE_BITBUCKET_API_BASE_URL: "https://api.test.local/2.0" },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const settings = yield* ServerSettings.ServerSettingsService;

    assert.strictEqual((yield* bitbucket.probeAuth).status, "unauthenticated");

    yield* settings.updateSettings({
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

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


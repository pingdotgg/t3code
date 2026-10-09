import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Redacted from "effect/Redacted";

import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import { KnownWorkflowRuns } from "./gitHubConditionalChecks.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const coreResponse = (pullRequest: Readonly<Record<string, unknown>> = {}) => ({
  data: {
    repository: {
      mergeCommitAllowed: true,
      squashMergeAllowed: false,
      rebaseMergeAllowed: true,
      viewerPermission: "WRITE",
      pullRequest: {
        number: 7,
        title: "Pull request 7",
        url: "https://github.com/acme/web/pull/7",
        headRefName: "feature",
        baseRefName: "main",
        headRefOid: "abc123",
        state: "OPEN",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-02T00:00:00Z",
        viewerCanUpdate: true,
        viewerDidAuthor: false,
        viewerCanUpdateBranch: true,
        baseRef: { compare: { behindBy: 2 } },
        reviewRequests: { nodes: [] },
        labels: { nodes: [] },
        commits: { nodes: [] },
        ...pullRequest,
      },
    },
  },
});

/** One request the CLI made, as the transport received it. */
type ApiCall =
  | ({ readonly kind: "graphql" } & GitHubApi.GitHubGraphQlInput)
  | ({ readonly kind: "rest" } & GitHubApi.GitHubRestInput);

type ApiAnswer = Effect.Effect<GitHubApi.GitHubRestResponse, GitHubApi.GitHubApiError>;

const mockedExecute = vi.fn<(call: ApiCall) => ApiAnswer>();
const defaultCredential = (host: string) =>
  Effect.succeed({ token: Redacted.make("token"), fingerprint: `${host}:token` });
const mockedCredential = vi.fn(defaultCredential);
const mockedStackMemberships = vi.fn<(call: ApiCall) => ApiAnswer>(() =>
  Effect.succeed(output('{"data":{}}')),
);

/**
 * A transport that answers from the mocks above but spends the real GraphQL quota from each
 * answer's headers, the way GitHubApi does, so the reserve behaviour is still the module's to prove.
 */
const mockApi = Layer.effect(
  GitHubApi.GitHubApi,
  Effect.gen(function* () {
    const quota = yield* GitHubQuota.GitHubQuota;
    return GitHubApi.GitHubApi.of({
      graphql: (input) =>
        SourceControlRateLimit.Interactive.pipe(
          Effect.flatMap((interactive) =>
            quota.admit(input.host, "graphql", {
              allowReserve: input.allowReserve ?? interactive,
            }),
          ),
          Effect.andThen(() =>
            (input.query.includes("query PullRequestStackMemberships")
              ? mockedStackMemberships
              : mockedExecute)({ kind: "graphql", ...input }),
          ),
          Effect.tap((answer) => quota.observe(input.host, answer.headers)),
          Effect.map((answer) => answer.body),
        ),
      rest: (input) => mockedExecute({ kind: "rest", ...input }),
      credential: (host) => mockedCredential(host),
    });
  }),
);

const layer = it.layer(
  GitHubPullRequestApi.layer.pipe(
    Layer.provideMerge(mockApi),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(TestSourceControlHost.layer()),
    Layer.provide(NodeServices.layer),
  ),
);

/** A successful answer; GraphQL reads take its body. */
function output(
  body: string,
  truncated = false,
  invalidUtf8 = false,
  headers: Readonly<Record<string, string>> = {},
): GitHubApi.GitHubRestResponse {
  return { status: 200, headers, body, truncated, invalidUtf8 };
}

/** GitHub's GraphQL quota headers, leaving `remaining` of 5,000 until `resetAt`. */
function graphqlQuota(remaining: number, resetAt = "2099-08-13T14:00:00Z") {
  return {
    "x-ratelimit-resource": "graphql",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(Date.parse(resetAt) / 1000),
  };
}

/**
 * Listing rows as GraphQL answers them. Overrides may use the flat shapes a test reads most
 * easily: `reviewRequests` as `[{ login }]` or `[{ slug }]`, and `checks` as the rollup state.
 */
function rows(
  count: number,
  firstNumber: number,
  overrides: (number: number) => Readonly<Record<string, unknown>> = () => ({}),
): ReadonlyArray<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => {
    const number = firstNumber + index;
    const { reviewRequests, checks, ...rest } = overrides(number) as {
      reviewRequests?: ReadonlyArray<Record<string, string>>;
      checks?: string;
    } & Record<string, unknown>;
    return {
      number,
      title: `Pull request ${number}`,
      url: `https://github.com/acme/web/pull/${number}`,
      headRefName: "feat/page",
      baseRefName: "main",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      repository: { nameWithOwner: "acme/web" },
      ...(reviewRequests === undefined
        ? {}
        : {
            reviewRequests: {
              nodes: reviewRequests.map((requestedReviewer) => ({ requestedReviewer })),
            },
          }),
      ...(checks === undefined
        ? {}
        : { commits: { nodes: [{ commit: { statusCheckRollup: { state: checks } } }] } }),
      ...rest,
    };
  });
}

/** A page of the searched listing. */
function pullRequests(
  count: number,
  firstNumber: number,
  overrides?: (number: number) => Readonly<Record<string, unknown>>,
): string {
  return encodeJson({
    data: {
      search: { pageInfo: { hasNextPage: false }, nodes: rows(count, firstNumber, overrides) },
    },
  });
}

/** A page of a repository's own list, which is what the search-free fallback reads. */
function listedPullRequests(
  count: number,
  firstNumber: number,
  overrides?: (number: number) => Readonly<Record<string, unknown>>,
): string {
  return encodeJson({
    data: {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false },
          nodes: rows(count, firstNumber, overrides),
        },
      },
    },
  });
}

/** A search that found nothing, which is also what GitHub says for a repository it does not index. */
const emptySearch = () => output(pullRequests(0, 1));
const emptyList = () => output(listedPullRequests(0, 1));

function pullRequestFiles(count: number, firstIndex: number): string {
  return encodeJson(
    Array.from({ length: count }, (_, index) => ({
      filename: `src/file${firstIndex + index}.ts`,
      status: "modified",
      patch: "@@ -1 +1 @@\n-old\n+new",
    })),
  );
}

/** One thread's comments as the GraphQL read returns them, cursor and all. */
function threadComments(
  ids: ReadonlyArray<string>,
  endCursor: string | null,
  totalCount = ids.length,
) {
  return {
    totalCount,
    pageInfo: { hasNextPage: endCursor !== null, endCursor },
    nodes: ids.map((id) => ({ id, body: id, createdAt: "2026-07-01T00:00:00Z" })),
  };
}

function thread(id: string, ...commentIds: ReadonlyArray<string>) {
  return {
    id,
    path: "src/a.ts",
    line: 1,
    diffSide: "RIGHT",
    isResolved: false,
    isOutdated: false,
    comments: threadComments(commentIds, null),
  };
}

function reviewThreadsPage(
  nodes: ReadonlyArray<Record<string, unknown>>,
  endCursor: string | null,
): string {
  return encodeJson({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            totalCount: nodes.length,
            pageInfo: { hasNextPage: endCursor !== null, endCursor },
            nodes,
          },
        },
      },
    },
  });
}

function threadCommentsPage(
  ids: ReadonlyArray<string>,
  endCursor: string | null,
  totalCount: number,
  pullRequestId = "PR_7",
): string {
  return encodeJson({
    data: {
      repository: { pullRequest: { id: "PR_7" } },
      node: {
        pullRequest: { id: pullRequestId },
        comments: threadComments(ids, endCursor, totalCount),
      },
    },
  });
}

/** What GitHub answers for a pull request it will not serve a whole diff for. */
const diffRefused = new GitHubApi.GitHubApiResponseError({
  host: "github.com",
  operation: "getPullRequestDiff",
  status: 406,
});

/** The nth request the CLI made. */
function callAt(index: number): ApiCall {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

/** The GraphQL variables of the nth request. */
function varsAt(index: number): Readonly<Record<string, unknown>> {
  const call = callAt(index);
  assert.strictEqual(call.kind, "graphql");
  return call.kind === "graphql" ? (call.variables ?? {}) : {};
}

/** The GraphQL document of the nth request. */
function queryAt(index: number): string {
  const call = callAt(index);
  return call.kind === "graphql" ? call.query : "";
}

/** The REST path of the nth request. */
function pathAt(index: number): string {
  const call = callAt(index);
  return call.kind === "rest" ? call.path : "";
}

/** The search the nth request carried, or undefined for a read that did not search. */
function searchOfCall(index: number): string | undefined {
  const q = callAt(index).kind === "graphql" ? varsAt(index)["q"] : undefined;
  return typeof q === "string" ? q : undefined;
}

/** One row as a search answers it, which is the listing's row one connection deeper. */
function searchItem(number: number, repository: string, updatedAt: string) {
  return {
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/${repository}/pull/${number}`,
    author: { login: "octocat", avatarUrl: "https://avatars/octocat" },
    headRefName: "feat/page",
    baseRefName: "main",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    repository: { nameWithOwner: repository },
    reviewRequests: { nodes: [{ requestedReviewer: { login: "hubot" } }] },
    labels: { nodes: [{ name: "bug", color: "ff0000" }] },
  };
}

function searchPage(nodes: ReadonlyArray<unknown>, hasNextPage = false) {
  return output(encodeJson({ data: { search: { pageInfo: { hasNextPage }, nodes } } }));
}

const searchQueryOfCall = searchOfCall;

/**
 * Answers every request with the body of the first route whose needle its GraphQL document or
 * REST path contains, and anything unrouted with an empty object, which a mutation never reads.
 */
function route(...routes: ReadonlyArray<readonly [needle: string, body: unknown]>): void {
  mockedExecute.mockImplementation((call) => {
    const target = call.kind === "graphql" ? call.query : call.path;
    const match = routes.find(([needle]) => target.includes(needle));
    return Effect.succeed(output(match === undefined ? "{}" : encodeJson(match[1])));
  });
}

/** The variables of every GraphQL request whose document contains `needle`, in order. */
function variablesOf(needle: string): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return mockedExecute.mock.calls.flatMap(([call]) =>
    call.kind === "graphql" && call.query.includes(needle) ? [call.variables ?? {}] : [],
  );
}

/** Every REST request whose path contains `needle`, in order. */
function restCallsTo(needle: string): ReadonlyArray<GitHubApi.GitHubRestInput> {
  return mockedExecute.mock.calls.flatMap(([call]) =>
    call.kind === "rest" && call.path.includes(needle) ? [call] : [],
  );
}

/**
 * The check that a client-given node hangs off the pull request it names. Routed before the node
 * id lookup, whose document it contains.
 */
const SUBJECT_SCOPE_QUERY = "node(id: $subjectId)";
const subjectScope = (subjectId: string, pullRequestId: string) => ({
  data: {
    repository: { pullRequest: { id: pullRequestId } },
    node: { id: subjectId, pullRequest: { id: pullRequestId } },
  },
});

/** One page of a head commit's check contexts, the read a rollup past one page is walked by. */
const checkContextsPage = (
  nodes: ReadonlyArray<Record<string, unknown>>,
  endCursor: string | null,
  headRefOid = "abc123",
) =>
  encodeJson({
    data: {
      repository: {
        pullRequest: {
          headRefOid,
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } },
                  },
                },
              },
            ],
          },
        },
      },
    },
  });

/** A pull request's base and head, as the REST read a file expansion starts from answers them. */
const pullRequestRefs = encodeJson({ base: { sha: "a1b2c3d" }, head: { sha: "b1c2d3e" } });

/** A cross-repository pull request whose head waits on a maintainer to run its workflows. */
const crossRepositoryDetail = (headRefOid = "abc123") =>
  coreResponse({
    headRefName: "feat/page",
    headRefOid,
    isCrossRepository: true,
    headRepositoryOwner: { login: "octocat" },
  });

/** Open pull requests on one head branch, every one of them from the same fork head. */
const heads = (numbers: ReadonlyArray<number>) => ({
  data: {
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: numbers.map((number) => ({
          number,
          headRefOid: "abc123",
          isCrossRepository: true,
          headRepositoryOwner: { login: "octocat" },
        })),
      },
    },
  },
});

const workflowRuns = (ids: ReadonlyArray<number>) => ({
  workflow_runs: ids.map((id) => ({
    id,
    name: id === 10 ? "build" : `run ${id}`,
    html_url: `https://example.com/${id}`,
  })),
});

/** Answers the reads an approval makes: the detail, the heads, the runs; approvals return nothing. */
function workflowApprovalRoutes(
  detail: () => unknown,
  headsAnswer: unknown,
  runsAnswer: unknown,
): void {
  mockedExecute.mockImplementation((call) =>
    Effect.sync(() =>
      output(
        call.kind === "rest"
          ? call.path.endsWith("/approve")
            ? ""
            : encodeJson(runsAnswer)
          : call.query.includes("headRefName: $head")
            ? encodeJson(headsAnswer)
            : encodeJson(detail()),
      ),
    ),
  );
}

/** The pull request node id lookup, which the layer caches for every test after the first. */
const NODE_ID_QUERY = "pullRequest(number: $number) { id }";
const nodeIdAnswer = (id: string) => ({ data: { repository: { pullRequest: { id } } } });

afterEach(() => {
  mockedExecute.mockReset();
  mockedStackMemberships.mockReset();
  mockedCredential.mockReset();
  mockedCredential.mockImplementation(defaultCredential);
});

it.effect(
  "keeps a verified credential through an auth switch and separates token fingerprints",
  () =>
    Effect.gen(function* () {
      let activeToken = "broad-credential";
      const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> =
        [];
      const credentials = Layer.succeed(
        GitHubCredentials.GitHubCredentials,
        GitHubCredentials.GitHubCredentials.of({
          get: (host) =>
            Effect.sync(() => ({
              host,
              token: Redacted.make(activeToken),
              source: "gh" as const,
              fingerprint: `${host}:${activeToken.length}${activeToken.at(-1)}`,
            })),
          invalidate: () => Effect.void,
        }),
      );
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push({ url: request.url, authorization: request.headers["authorization"] });
            const body = request.url.endsWith("/user")
              ? { id: 123, login: "same-account" }
              : { data: { repository: { pullRequest: { id: "PR_1" } }, addComment: {} } };
            return HttpClientResponse.fromWeb(request, new Response(encodeJson(body)));
          }),
        ),
      );
      const cli = yield* GitHubPullRequestApi.make.pipe(
        Effect.provide(
          GitHubApi.layer.pipe(
            Layer.provide(Layer.mergeAll(credentials, http)),
            Layer.provide(GitHubQuota.layer),
            Layer.provide(SourceControlRateLimit.layer),
            Layer.merge(TestSourceControlHost.layer()),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
      const input = { cwd: "/repo", host: "github.com" };
      const first = yield* cli.withVerifiedCredential(input, (identity) =>
        Effect.gen(function* () {
          activeToken = "restricted-credential";
          expect(yield* cli.getViewerLogin(input)).toBe("same-account");
          yield* cli.commentOnPullRequest({
            ...input,
            repository: "owner/repo",
            number: 1,
            body: "comment",
          });
          return identity;
        }),
      );
      const second = yield* cli.withVerifiedCredential(input, Effect.succeed);
      expect(first.accountId).toBe(second.accountId);
      expect(first.credentialFingerprint).not.toBe(second.credentialFingerprint);
      expect(encodeJson([first, second])).not.toContain("broad-credential");
      expect(encodeJson([first, second])).not.toContain("restricted-credential");
      // The comment was written under the credential the page verified, not the switched one.
      expect(
        requests
          .filter((request) => request.url.endsWith("/graphql"))
          .map((request) => request.authorization),
      ).toEqual(["Bearer broad-credential", "Bearer broad-credential"]);
      expect(
        requests
          .filter((request) => request.url.endsWith("/user"))
          .map((request) => request.authorization),
      ).toEqual(["Bearer broad-credential", "Bearer restricted-credential"]);
      expect(yield* cli.getRoutingIdentity(input)).toEqual({
        accountId: "123",
        viewer: "same-account",
      });
    }),
);

layer("GitHubPullRequestApi.layer", (it) => {
  it.effect("holds background previews once an answer reports the reserve, until it resets", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const quota = yield* GitHubQuota.GitHubQuota;
      const resetAt = "2099-08-13T14:00:00Z";
      yield* quota.observe("preview-budget.example", graphqlQuota(501, resetAt));
      // GitHub's count, not ours: the answer below reports the reserve has been reached.
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    number: 7,
                    title: "Fast previews",
                    url: "https://preview-budget.example/acme/web/pull/7",
                    state: "OPEN",
                    isDraft: false,
                    createdAt: "2026-07-01T00:00:00Z",
                    author: null,
                  },
                },
              },
            }),
            false,
            false,
            graphqlQuota(499, resetAt),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const input = {
        cwd: "/w",
        repository: "acme/web",
        host: "preview-budget.example",
        number: 7,
      };
      yield* cli.getPullRequestPreview(input);
      const held = yield* Effect.flip(cli.getPullRequestPreview({ ...input, number: 8 }));
      expect(held._tag).toBe("SourceControlRateLimitPausedError");
      expect(mockedExecute).toHaveBeenCalledTimes(1);
      yield* TestClock.setTime(Date.parse(resetAt));
      yield* cli.getPullRequestPreview(input);
      expect(mockedExecute).toHaveBeenCalledTimes(2);
      yield* TestClock.setTime(now);
    }),
  );

  it.effect("loads the complete hover card with one GraphQL request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    number: 7,
                    title: "Fast previews",
                    url: "https://github.example/acme/web/pull/7",
                    state: "MERGED",
                    isDraft: false,
                    createdAt: "2026-07-01T00:00:00Z",
                    author: {
                      login: "octocat",
                      name: "Octo Cat",
                      avatarUrl: "https://github.example/avatar.png",
                    },
                  },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const preview = yield* cli.getPullRequestPreview({
        cwd: "/w",
        repository: "acme/web",
        host: "github.example",
        number: 7,
      });
      expect(preview).toEqual({
        number: 7,
        title: "Fast previews",
        url: "https://github.example/acme/web/pull/7",
        state: "merged",
        isDraft: false,
        createdAt: "2026-07-01T00:00:00Z",
        author: {
          login: "octocat",
          name: "Octo Cat",
          avatarUrl: "https://github.example/avatar.png",
        },
      });
      expect(mockedExecute).toHaveBeenCalledTimes(1);
      expect(callAt(0)).toMatchObject({ kind: "graphql", host: "github.example" });
    }),
  );

  it.effect("coalesces concurrent identity verification for the same host and credential", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(() =>
        Effect.yieldNow.pipe(Effect.as(output('{"id":123,"login":"viewer"}'))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const results = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          cli.getRoutingIdentity({ cwd: "/w", host: "github.identity-flight.test" }),
        ),
        { concurrency: 4 },
      );
      expect(results).toEqual(
        Array.from({ length: 4 }, () => ({ accountId: "123", viewer: "viewer" })),
      );
      expect(mockedExecute).toHaveBeenCalledTimes(1);
      expect(pathAt(0)).toBe("user");
    }),
  );

  it.effect(
    "lets another identity reader continue when the first verification is interrupted",
    () =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        let verifications = 0;
        mockedExecute.mockImplementation(() =>
          Effect.gen(function* () {
            if (++verifications === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              return yield* Effect.never;
            }
            return output('{"id":123,"login":"viewer"}');
          }),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const input = { cwd: "/w", host: "github.identity-cancel.test" };
        const first = yield* cli.getRoutingIdentity(input).pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        // The second reader is queued on the same credential's lock behind the first.
        const second = yield* cli.getRoutingIdentity(input).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(first);
        expect(yield* Fiber.join(second)).toEqual({ accountId: "123", viewer: "viewer" });
        expect(verifications).toBe(2);
      }),
  );

  it.effect("reads linked pull requests on one host together, filed back by position", () =>
    Effect.gen(function* () {
      const node = (number: number) => ({
        number,
        title: `Pull request ${number}`,
        url: `https://github.com/acme/web/pull/${number}`,
        author: { __typename: "User", login: "octocat", name: "Octo Cat", avatarUrl: null },
        baseRefName: "main",
        headRefName: `feat/${number}`,
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        reviewDecision: null,
        latestReviews: { nodes: [{ state: "APPROVED", author: { login: "reviewer" } }] },
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        updatedAt: "2026-08-24T12:34:56.000Z",
        mergedAt: null,
        closedAt: null,
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      });
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: { s0: { pullRequest: node(7) }, s1: { pullRequest: node(8) } },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const reads = yield* Effect.forEach(
        [7, 8],
        (number) =>
          cli.getPullRequestSummary({
            cwd: "/w",
            repository: "acme/web",
            host: "github.com",
            number,
          }),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 millis");
      const [seven, eight] = yield* Fiber.join(reads);

      assert.deepStrictEqual(
        {
          number: seven?.number,
          state: seven?.state,
          headBranch: seven?.headBranch,
          author: seven?.author?.login,
          changedFiles: seven?.changedFiles,
          reviewDecision: seven?.reviewDecision,
          checksState: seven?.checksState,
          mergeability: seven?.mergeability,
        },
        {
          number: 7,
          state: "open",
          headBranch: "feat/7",
          author: "octocat",
          changedFiles: 2,
          reviewDecision: "approved",
          checksState: "passing",
          mergeability: "mergeable",
        },
      );
      assert.strictEqual(eight?.headBranch, "feat/8");
      expect(mockedExecute).toHaveBeenCalledOnce();
      expect(queryAt(0)).toContain(
        "s0: repository(owner: $s0_owner, name: $s0_name) { pullRequest(number: $s0_number)",
      );
      expect(varsAt(0)).toMatchObject({
        s0_owner: "acme",
        s0_name: "web",
        s0_number: 7,
        s1_number: 8,
      });
    }),
  );

  it.effect("fingerprints watched pull requests on one host in one read", () =>
    Effect.gen(function* () {
      const node = (comments: number) => ({
        state: "OPEN",
        mergeable: "MERGEABLE",
        headRefOid: "abc123",
        comments: { totalCount: comments, nodes: [] },
        reviews: { totalCount: 0, nodes: [] },
        reviewThreads: { totalCount: 0 },
        commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
      });
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              data: { w0: { pullRequest: node(1) }, w1: { pullRequest: null } },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const reads = yield* Effect.forEach(
        [7, 8],
        (number) =>
          cli.getPullRequestWatchFingerprint({
            cwd: "/w",
            repository: "acme/web",
            host: "github.com",
            number,
          }),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 millis");
      const [seven, eight] = yield* Fiber.join(reads);

      expect(seven?.remarks.startsWith("1 ")).toBe(true);
      // GitHub had no answer for #8, so its watch reads it in full.
      expect(eight).toBeNull();
      expect(mockedExecute).toHaveBeenCalledOnce();
      expect(queryAt(0)).toContain(
        "w1: repository(owner: $w1_owner, name: $w1_name) { pullRequest(number: $w1_number)",
      );
      expect(varsAt(0)).toMatchObject({ w1_owner: "acme", w1_name: "web", w1_number: 8 });
    }),
  );

  it.effect("reads a pull request the batch said nothing about on its own", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output('{"data":{"s0":{"pullRequest":null}}}')))
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              encodeJson({
                data: {
                  s0: {
                    pullRequest: {
                      number: 7,
                      title: "Reuse the summary",
                      url: "https://github.com/acme/web/pull/7",
                      author: { login: "octocat", name: "Octo Cat" },
                      baseRefName: "main",
                      headRefName: "feat/summary",
                      state: "OPEN",
                      isDraft: false,
                      mergeable: "MERGEABLE",
                      reviewDecision: "APPROVED",
                      additions: 12,
                      deletions: 3,
                      changedFiles: 2,
                      updatedAt: "2026-08-24T12:34:56.000Z",
                      commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
                    },
                  },
                },
              }),
            ),
          ),
        );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const read = yield* cli
        .getPullRequestSummary({ cwd: "/w", repository: "acme/web", host: "github.com", number: 7 })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("10 millis");
      const summary = yield* Fiber.join(read);

      assert.strictEqual(summary.headBranch, "feat/summary");
      assert.strictEqual(summary.checksState, "passing");
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(varsAt(1)).toEqual({ owner: "acme", name: "web", number: 7 });
    }),
  );

  it.effect("reads the stack a pull request is in through the stacks preview, on its host", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson([
              {
                id: 42,
                number: 3,
                url: "https://api.github.com/repos/acme/web/stacks/3",
                base: { ref: "main" },
                pull_requests: [
                  {
                    number: 6,
                    head: { ref: "feat/one" },
                    state: "closed",
                    merged_at: "2026-09-02",
                  },
                  { number: 7, head: { ref: "feat/two" }, state: "open", merged_at: null },
                ],
              },
            ]),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const stack = yield* cli.getPullRequestStack({
        cwd: "/w",
        repository: "acme/web",
        host: "ghe.example.com",
        number: 7,
      });

      assert.deepStrictEqual(stack, {
        id: "42",
        number: 3,
        url: "https://api.github.com/repos/acme/web/stacks/3",
        base: "main",
        layers: [
          { number: 6, headBranch: "feat/one", state: "merged" },
          { number: 7, headBranch: "feat/two", state: "open" },
        ],
      });
      expect(callAt(0)).toMatchObject({
        kind: "rest",
        host: "ghe.example.com",
        path: "repos/acme/web/stacks?pull_request=7",
      });
    }),
  );

  it.effect("fetches layer titles only when the caller asks for stack details", () =>
    Effect.gen(function* () {
      const minimal = {
        url: "https://api.github.com/repos/acme/web/stacks/3",
        number: 3,
        base: { ref: "main" },
        pull_requests: [
          { number: 7, head: { ref: "feat/two", sha: "abc123" }, state: "open", merged_at: null },
        ],
      };
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(encodeJson([minimal]))));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              ...minimal,
              pull_requests: [{ ...minimal.pull_requests[0], title: "Second layer", draft: false }],
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const stack = yield* cli.getPullRequestStack({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        includeDetails: true,
      });
      expect(stack?.layers[0]).toMatchObject({
        title: "Second layer",
        headSha: "abc123",
        isDraft: false,
      });
      expect(pathAt(1)).toBe("repos/acme/web/stacks/3");
    }),
  );

  it.effect("reads an empty stacks listing as not stacked", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const stack = yield* cli.getPullRequestStack({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.isNull(stack);
    }),
  );

  it.effect("reads a host that refuses the stacks preview as not stacked", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.fail(
          new GitHubApi.GitHubApiNotFoundError({
            host: "github.com",
            operation: "getPullRequestStack",
          }),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const stack = yield* cli.getPullRequestStack({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.isNull(stack);
    }),
  );

  it.effect("does not read a refused credential as an unstacked pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.fail(
          new GitHubApi.GitHubApiAuthenticationError({
            host: "github.com",
            operation: "getPullRequestStack",
          }),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestStack({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      assert.strictEqual(error._tag, "GitHubApiAuthenticationError");
    }),
  );

  it.effect("preserves transient stack failures instead of reporting no stack", () =>
    Effect.gen(function* () {
      const failure = new GitHubApi.GitHubApiResponseError({
        host: "github.com",
        operation: "getPullRequestStack",
        status: 503,
      });
      mockedExecute.mockReturnValueOnce(Effect.fail(failure));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const error = yield* Effect.flip(
        cli.getPullRequestStack({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );
      assert.strictEqual(error, failure);
    }),
  );

  it.effect("reports a stacks answer it cannot read against the stack read", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('[{"id":42}]')));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestStack({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      assert.strictEqual(error._tag, "GitHubPullRequestReadError");
      if (error._tag !== "GitHubPullRequestReadError") return;
      assert.strictEqual(error.operation, "getPullRequestStack");
    }),
  );

  it.effect("asks for one row more than the page, to probe for a next page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(3, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 3);
      assert.isFalse(batch.truncated);
      expect(callAt(0)).toMatchObject({ kind: "graphql", host: "github.com" });
      expect(searchOfCall(0)).toBe("is:pr is:open sort:updated-desc repo:acme/web");
      expect(queryAt(0)).toContain("first: 11");
    }),
  );

  it.effect("reports truncation from the extra row, counted before decoding", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(11, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 10);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("reports truncation when GitHub repeats a cursor before the page is full", () =>
    Effect.gen(function* () {
      // Two pages of 100 that hand back the same cursor, for a page of 250.
      const repeating = output(
        encodeJson({
          data: {
            search: {
              pageInfo: { hasNextPage: true, endCursor: "same" },
              nodes: rows(100, 1),
            },
          },
        }),
      );
      mockedExecute.mockReturnValue(Effect.succeed(repeating));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 250,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("excludes merged pull requests from the Closed tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.query.includes("pullRequests(")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "closed",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      // A closed pull request may also be a merged one, so the tab narrows through search.
      expect(searchOfCall(0)).toBe("is:pr is:closed is:unmerged sort:updated-desc repo:acme/web");
    }),
  );

  it.effect("narrows to the author on the authored tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.query.includes("pullRequests(")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "authored",
        viewer: "bilal",
        limit: 10,
      });

      expect(searchOfCall(0)).toBe("is:pr is:open author:bilal sort:updated-desc repo:acme/web");
    }),
  );

  it.effect("narrows through search on the reviewing tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.query.includes("pullRequests(")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
      });

      expect(searchOfCall(0)).toBe(
        "is:pr is:open review-requested:bilal sort:updated-desc repo:acme/web",
      );
    }),
  );

  it.effect("carries every repository and every qualifier into one search", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web", "pingdotgg/t3code"],
        state: "closed",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
        query: "pull requests page",
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 10 },
      });

      // One request for both repositories, carrying everything the per-repository read expresses
      // as a flag: the tab, the involvement, the reader's words, where to carry on from, and the
      // order the page reads in.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      assert.strictEqual(
        searchQueryOfCall(0),
        'is:pr is:closed is:unmerged review-requested:bilal "pull requests page" ' +
          "updated:<=2026-07-02T00:00:00Z sort:updated-desc repo:acme/web repo:pingdotgg/t3code",
      );
    }),
  );

  it.effect("narrows a search to the author, and to merged on the merged tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web"],
        state: "merged",
        involvement: "authored",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(
        searchQueryOfCall(0),
        "is:pr is:merged author:bilal sort:updated-desc repo:acme/web",
      );
    }),
  );

  it.effect("keeps a searched-for qualifier inside the phrase", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: 'x" is:merged repo:evil/repo',
      });

      // Quoted and escaped, so the words a reader typed narrow the listing rather than widening it.
      assert.strictEqual(
        searchQueryOfCall(0),
        'is:pr is:open "x\\" is:merged repo:evil/repo" sort:updated-desc repo:acme/web',
      );
    }),
  );

  it.effect("refuses to search for a repository GitHub cannot address", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const failure = yield* Effect.flip(
        cli.searchPullRequests({
          cwd: "/w",
          host: "github.com",
          repositories: ["acme/web", "acme/web is:merged"],
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
        }),
      );

      // Nothing is sent: a name that could end its own qualifier is refused rather than escaped.
      assert.strictEqual(failure._tag, "GitHubRepositorySelectorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("files each searched row under the repository it came from", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          searchPage([
            searchItem(7, "acme/web", "2026-07-03T00:00:00Z"),
            searchItem(9, "pingdotgg/t3code", "2026-07-02T00:00:00Z"),
            // Not a pull request, which `is:pr` excludes and a decode skips rather than fails on.
            {},
          ]),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web", "pingdotgg/t3code"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.deepStrictEqual(
        batch.items.map((item) => [item.repository, item.number, item.author?.avatarUrl]),
        [
          ["acme/web", 7, "https://avatars/octocat"],
          ["pingdotgg/t3code", 9, "https://avatars/octocat"],
        ],
      );
      // The listing leaves the line counts to a read of their own.
      assert.deepStrictEqual(
        batch.items.map((item) => [item.additions, item.deletions]),
        [
          [0, 0],
          [0, 0],
        ],
      );
      assert.isFalse(batch.truncated);
    }),
  );

  it.effect("reports truncation from the extra row, and from a page GitHub says has more", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            searchPage([
              searchItem(1, "acme/web", "2026-07-03T00:00:00Z"),
              searchItem(2, "acme/web", "2026-07-02T00:00:00Z"),
              searchItem(3, "acme/web", "2026-07-01T00:00:00Z"),
            ]),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(searchPage([searchItem(1, "acme/web", "2026-07-03T00:00:00Z")], true)),
        );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const read = () =>
        cli.searchPullRequests({
          cwd: "/w",
          host: "github.com",
          repositories: ["acme/web"],
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 2,
        });

      const overflowing = yield* read();
      const capped = yield* read();

      // The extra row is the probe, and it is not handed on.
      assert.strictEqual(overflowing.items.length, 2);
      assert.isTrue(overflowing.truncated);
      // A slice at GitHub's own ceiling has no extra row to probe with, so `hasNextPage` answers.
      assert.isTrue(capped.truncated);
    }),
  );

  it.effect("enriches only the visible fallback rows after filtering and widening", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listedPullRequests(3, 1, () => ({ isDraft: true })))),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listedPullRequests(6, 1, (number) => ({ isDraft: number < 4 })))),
      );
      mockedStackMemberships.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                s0: {
                  pullRequest: {
                    stack: { number: 3, size: 2, baseRefName: "main" },
                    stackEntry: { position: 1 },
                  },
                },
                s1: { pullRequest: { stack: null, stackEntry: null } },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 2,
        filters: { draft: "hide" },
      });
      expect(batch.items.map((item) => item.number)).toEqual([4, 5]);
      expect(batch.items[0]?.stack).toEqual({ number: 3, size: 2, base: "main", position: 1 });
      expect(batch.items[1]?.stack).toBeUndefined();
      expect(batch.truncated).toBe(true);
      expect(batch.continues).toBe(false);
      expect(mockedStackMemberships).toHaveBeenCalledTimes(1);
      const membership = mockedStackMemberships.mock.calls[0]?.[0];
      const numbers = Object.entries(
        membership?.kind === "graphql" ? (membership.variables ?? {}) : {},
      )
        .filter(([name]) => name.endsWith("_number"))
        .map(([, number]) => number);
      expect(numbers).toEqual([4, 5]);
    }),
  );

  it.effect("batches membership reads and keeps successful rows when one chunk fails", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(27, 1))));
      mockedStackMemberships.mockImplementation((input) =>
        input.kind === "graphql" && Object.values(input.variables ?? {}).includes(26)
          ? Effect.fail(
              new GitHubApi.GitHubApiResponseError({
                host: "github.com",
                operation: "listPullRequestStackMemberships",
                status: 502,
              }),
            )
          : Effect.succeed(
              output(
                encodeJson({
                  data: {
                    s0: {
                      pullRequest: {
                        stack: { number: 3, size: 2, baseRefName: "main" },
                        stackEntry: { position: 1 },
                      },
                    },
                  },
                }),
              ),
            ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 26,
      });
      expect(batch.items.map((item) => item.number)).toEqual(
        Array.from({ length: 26 }, (_, i) => i + 1),
      );
      expect(batch.items[0]?.stack).toEqual({ number: 3, size: 2, base: "main", position: 1 });
      expect(batch.items[25]?.stack).toBeUndefined();
      expect(batch.truncated).toBe(true);
      expect(batch.continues).toBe(true);
      expect(mockedStackMemberships).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("skips membership enrichment for empty pages and enterprise hosts", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptyList()));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(1, 7))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const input = {
        cwd: "/w",
        repository: "acme/web",
        state: "open" as const,
        involvement: "all" as const,
        viewer: "bilal",
        limit: 2,
      };
      const empty = yield* cli.listPullRequests({ ...input, host: "github.com" });
      const enterprise = yield* cli.listPullRequests({ ...input, host: "github.acme.test" });
      expect(empty.items).toEqual([]);
      expect(enterprise.items.map((item) => item.number)).toEqual([7]);
      expect(mockedStackMemberships).not.toHaveBeenCalled();
    }),
  );

  it.effect("reads the line counts in chunks, and files them back by position", () =>
    Effect.gen(function* () {
      const changeRequests = Array.from({ length: 26 }, (_, index) => ({
        repository: "acme/web",
        number: index + 1,
      }));
      mockedExecute.mockImplementation(() =>
        // Every chunk answers for its first alias only, so a row GitHub said nothing about is
        // dropped rather than shown as a change of no size.
        Effect.succeed(
          output(encodeJson({ data: { s0: { pullRequest: { additions: 4, deletions: 1 } } } })),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const stats = yield* cli.listPullRequestStats({
        cwd: "/w",
        host: "github.com",
        changeRequests,
      });

      // Twenty-five aliases a request, so twenty-six rows are two requests.
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      assert.deepStrictEqual(stats, [
        { repository: "acme/web", number: 1, additions: 4, deletions: 1 },
        { repository: "acme/web", number: 26, additions: 4, deletions: 1 },
      ]);
      expect(queryAt(0)).toContain("s0: repository(owner: $s0_owner, name: $s0_name)");
      expect(varsAt(0)).toMatchObject({ s0_owner: "acme", s0_name: "web", s24_number: 25 });
    }),
  );

  it.effect("refuses to look up counts for a repository GitHub cannot address", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const failure = yield* Effect.flip(
        cli.listPullRequestStats({
          cwd: "/w",
          host: "github.com",
          changeRequests: [{ repository: 'acme/web") { x } #', number: 1 }],
        }),
      );

      assert.strictEqual(failure._tag, "GitHubRepositorySelectorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("hands a search to GitHub rather than to the rows already read", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.query.includes("pullRequests(")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "pull requests page",
      });

      // The recency qualifier rides along, because free text would otherwise reorder the page
      // by relevance and truncation would drop the newest matches.
      expect(searchOfCall(0)).toBe(
        'is:pr is:open "pull requests page" sort:updated-desc repo:acme/web',
      );
    }),
  );

  it.effect("joins a search onto the tab's own qualifiers instead of replacing them", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.query.includes("pullRequests(")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "closed",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
        query: "page",
      });

      expect(searchOfCall(0)).toBe(
        'is:pr is:closed is:unmerged review-requested:bilal "page" sort:updated-desc repo:acme/web',
      );
    }),
  );

  it.effect("carries the further narrowings into the search as qualifiers", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.query.includes("pullRequests(")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: {
          draft: "hide",
          review: "changes-requested",
          checks: "failing",
          labels: [["needs design"], ['quo"te']],
          excludedLabels: ["wip"],
          author: "octocat",
        },
      });

      // Quotes around anything a reader typed, and the one character that could end a quoted
      // value early dropped rather than escaped.
      expect(searchOfCall(0)).toBe(
        'is:pr is:open label:"needs design" label:"quote" -label:"wip" author:"octocat" ' +
          "draft:false review:changes_requested status:failure sort:updated-desc repo:acme/web",
      );
    }),
  );

  it.effect('resolves an author filter of "me" to the viewer, not the literal word', () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.query.includes("pullRequests(")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: { author: "me" },
      });

      expect(searchOfCall(0)).toBe('is:pr is:open author:"bilal" sort:updated-desc repo:acme/web');
    }),
  );

  it.effect("sends one label qualifier per group, its names joined the way GitHub ors them", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.query.includes("pullRequests(")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: { labels: [["size:S", "size:XS"], ["bug"]] },
      });

      // One qualifier satisfied by either size, and a second one that must hold as well.
      expect(searchOfCall(0)).toBe(
        'is:pr is:open label:"size:S","size:XS" label:"bug" sort:updated-desc repo:acme/web',
      );
    }),
  );

  it.effect(
    "falls back for a repository the index does not cover under a checks filter, keeping only the matching rows",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              listedPullRequests(2, 1, (number) => ({
                checks: number === 1 ? "SUCCESS" : "FAILURE",
              })),
            ),
          ),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

        const batch = yield* cli.listPullRequests({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          filters: { checks: "passing" },
        });

        // The fallback's rows carry `checksState` exactly as a search's rows do, so `checks` is
        // now a filter the fallback judges itself, the same as `draft`: an empty search answer
        // under it is still ambiguous, and the row picked out afterwards is the one whose own
        // `checksState` reads "passing".
        expect(searchOfCall(1)).toBeUndefined();
        assert.deepStrictEqual(
          batch.items.map((item) => item.number),
          [1],
        );
      }),
  );

  it.effect("fails a checks filter for a row whose checks are still pending", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listedPullRequests(1, 1, () => ({ checks: "PENDING" })))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: { checks: "passing" },
      });

      // Pending equals neither "passing" nor "failing", so it satisfies neither filter value —
      // the same row would also be dropped by `checks: "failing"`.
      assert.deepStrictEqual(batch.items, []);
    }),
  );

  it.effect(
    "falls back for a repository the index does not cover even under a judgeable filter",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(output(listedPullRequests(2, 1, (number) => ({ isDraft: number === 1 })))),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

        const batch = yield* cli.listPullRequests({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          filters: { draft: "hide" },
        });

        // `draft` is a filter the fallback can judge over its own rows just as search judges it,
        // so an empty search answer under it alone is still ambiguous between "nothing matches"
        // and "this repository is not indexed" — and the fallback applies the filter itself,
        // keeping only the non-draft row.
        expect(searchOfCall(1)).toBeUndefined();
        expect(batch.items.map((item) => item.number)).toEqual([2]);
      }),
  );

  it.effect("carries the further narrowings into a batched search", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: { draft: "only", review: "none", labels: [["bug"]] },
      });

      assert.strictEqual(
        searchQueryOfCall(0),
        'is:pr is:open label:"bug" draft:true review:none sort:updated-desc repo:acme/web',
      );
    }),
  );

  it.effect("quotes a search, so it cannot add a qualifier or a flag of its own", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.query.includes("pullRequests(")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: '-- is:merged label:secret "widen me"',
      });

      // Every word stays inside one phrase: nothing before it, nothing after it, and the
      // leading dashes are text rather than the start of another argument.
      expect(searchOfCall(0)).toBe(
        String.raw`is:pr is:open "-- is:merged label:secret \"widen me\"" sort:updated-desc repo:acme/web`,
      );
    }),
  );

  it.effect("escapes a backslash before the quote it would otherwise let out", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.query.includes("pullRequests(")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: String.raw`a\" is:merged`,
      });

      // GitHub reads `\\` as one backslash and `\"` as one quote, so the phrase ends where
      // this says it does; escaping the quote alone would have closed it early.
      expect(searchOfCall(0)).toBe(
        String.raw`is:pr is:open "a\\\" is:merged" sort:updated-desc repo:acme/web`,
      );
    }),
  );

  it.effect("asks for nothing but the order when the reader typed only spaces", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.query.includes("pullRequests(")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "   ",
      });

      // An empty phrase would match nothing rather than everything, so it is left out; the
      // order the page reads rows in is asked for whether or not anything was typed.
      expect(searchOfCall(0)).toBe("is:pr is:open sort:updated-desc repo:acme/web");
    }),
  );

  it.effect("carries on from the instant the last slice ended on", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output(pullRequests(3, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 10 },
      });

      // Inclusive, so the rows already sent at that instant come back for the caller to drop —
      // which is what keeps the ones beside them from being skipped.
      expect(searchOfCall(0)).toBe(
        "is:pr is:open updated:<=2026-07-02T00:00:00Z sort:updated-desc repo:acme/web",
      );
      assert.isTrue(batch.continues);
    }),
  );

  it.effect("answers a search that found nothing with nothing, not with the whole repository", () =>
    Effect.gen(function* () {
      // The fallback is for a repository the index does not cover. Under a text search an empty
      // answer means the text matched nothing, and listing everything instead would fill the
      // page with rows the reader did not search for.
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "fdsfklj",
      });

      assert.strictEqual(batch.items.length, 0);
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("reads a repository GitHub will not search from its own list", () =>
    Effect.gen(function* () {
      // GitHub answers for a repository outside its search index with no rows and no error.
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listedPullRequests(3, 1, () => ({ state: "CLOSED" })))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "closed",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 3);
      // The fallback itself uses no search, then narrows the decoded rows locally. They arrive
      // newest-created first, so nothing can carry on from them.
      expect(searchOfCall(1)).toBeUndefined();
      expect(varsAt(1)).toMatchObject({ owner: "acme", name: "web", states: ["CLOSED", "MERGED"] });
      assert.isFalse(batch.continues);
    }),
  );

  it.effect("keeps state and involvement filters on the search-free fallback", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            listedPullRequests(4, 1, (number) => ({
              state: number === 4 ? "OPEN" : "CLOSED",
              ...(number === 3 ? { mergedAt: "2026-07-03T00:00:00Z" } : {}),
              reviewRequests:
                number === 2 ? [{ slug: "platform", name: "Platform" }] : [{ login: "bilal" }],
            })),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "closed",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
      });

      // Individual requests for this viewer and team requests survive. The fallback cannot
      // resolve team membership, so dropping team-routed reviews would hide legitimate work.
      expect(batch.items.map((item) => item.number)).toEqual([1, 2]);
      expect(searchOfCall(1)).toBeUndefined();
      assert.isFalse(batch.continues);
    }),
  );

  it.effect("grows the search-free fallback until it fills the filtered page", () =>
    Effect.gen(function* () {
      const unrelated = () => ({ reviewRequests: [{ login: "somebody-else" }] });
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listedPullRequests(3, 1, unrelated))),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            listedPullRequests(4, 1, (number) =>
              number === 4 ? { reviewRequests: [{ login: "bilal" }] } : unrelated(),
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 2,
      });

      expect(batch.items.map((item) => item.number)).toEqual([4]);
      expect(queryAt(1)).toContain("first: 3,");
      expect(queryAt(2)).toContain("first: 6,");
      assert.isFalse(batch.truncated);
    }),
  );

  it.effect("bounds a sparse search-free fallback and reports the unread tail", () =>
    Effect.gen(function* () {
      // A repository with far more pull requests than the bound, none of them for this reader.
      let listed = 0;
      mockedExecute.mockImplementation((call) => {
        if (call.kind !== "graphql" || !call.query.includes("pullRequests(")) {
          return Effect.succeed(emptySearch());
        }
        const first = Number(/first: (\d+)/.exec(call.query)?.[1]);
        const nodes = rows(first, listed + 1, () => ({
          reviewRequests: [{ login: "somebody-else" }],
        }));
        listed += first;
        return Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequests: { pageInfo: { hasNextPage: true, endCursor: `c${listed}` }, nodes },
                },
              },
            }),
          ),
        );
      });
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 2,
      });

      // The last widening reads a thousand rows, a page of a hundred at a time, and stops there.
      const last = mockedExecute.mock.calls.length - 1;
      expect(varsAt(last)["after"]).toBe(`c${listed - 100}`);
      expect(listed - (3 + 6 + 12 + 24 + 48 + 96 + 192 + 384 + 768)).toBe(1000);
      assert.strictEqual(batch.items.length, 0);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("takes an empty slice for a repository that has run out, not one to read again", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.query.includes("pullRequests(")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 10 },
      });

      // A repository that answered the search once answers it again, so an empty slice under a
      // cursor is the end of it rather than a repository search cannot reach.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  /** The state a merge or branch update reads first: behind its base and blocked on checks. */
  const actionState = (pullRequest: Readonly<Record<string, unknown>> = {}) => ({
    data: {
      repository: {
        pullRequest: {
          id: "PR_7",
          headRefOid: "abc123",
          isMergeQueueEnabled: false,
          mergeStateStatus: "BLOCKED",
          baseRef: { compare: { behindBy: 2 } },
          ...pullRequest,
        },
      },
    },
  });
  const mergeMessage = (body: string, isMergeQueueEnabled = false) => ({
    data: {
      repository: {
        pullRequest: { isMergeQueueEnabled, headRefOid: "abc123", viewerMergeBodyText: body },
      },
    },
  });

  it.effect("updates a stale branch with a merge commit unless asked to rebase", () =>
    Effect.gen(function* () {
      route(["query PullRequestActionState", actionState()]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "update-branch",
      });
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "update-branch",
        updateMethod: "rebase",
      });

      // GitHub's own default: a merge commit unless asked to rebase, pinned to the head it read.
      expect(variablesOf("updatePullRequestBranch(")).toEqual([
        { pullRequestId: "PR_7", expectedHeadOid: "abc123", updateMethod: "MERGE" },
        { pullRequestId: "PR_7", expectedHeadOid: "abc123", updateMethod: "REBASE" },
      ]);
    }),
  );

  it.effect("merges with the strategy it was asked for", () =>
    Effect.gen(function* () {
      route(["query PullRequestActionState", actionState()]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "merge",
        mergeMethod: "squash",
      });

      expect(variablesOf("mergePullRequest(")).toEqual([
        { input: { pullRequestId: "PR_7", mergeMethod: "SQUASH" } },
      ]);
      expect(variablesOf("enablePullRequestAutoMerge(")).toEqual([]);
    }),
  );

  it.effect.each(["merge", "enable-auto-merge"] as const)(
    "removes agent credits from the proposed message for %s",
    (action) =>
      Effect.gen(function* () {
        route(
          [
            "query PullRequestMergeMessage",
            mergeMessage(
              "Details\n\nCo-authored-by: Alice <alice@example.com>\nCo-authored-by: Claude <noreply@anthropic.com>",
            ),
          ],
          ["query PullRequestActionState", actionState()],
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        yield* cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action,
          mergeMethod: "squash",
          removeAgentCreditsOnMerge: true,
        });
        expect(variablesOf("query PullRequestMergeMessage")[0]?.["method"]).toBe("SQUASH");
        expect(
          variablesOf(action === "merge" ? "mergePullRequest(" : "enablePullRequestAutoMerge("),
        ).toEqual([
          {
            input: {
              pullRequestId: "PR_7",
              mergeMethod: "SQUASH",
              // Pinned to the head the message was read from, so it cannot describe other commits.
              expectedHeadOid: "abc123",
              commitBody: "Details\n\nCo-authored-by: Alice <alice@example.com>",
            },
          },
        ]);
      }),
  );

  it.effect.each([
    {
      description: "an unchanged message",
      body: "Details\n\nCo-authored-by: Alice <alice@example.com>",
      queued: false,
    },
    {
      description: "a merge queue",
      body: "Co-authored-by: Claude <noreply@anthropic.com>",
      queued: true,
    },
  ] as const)("keeps GitHub's default message for $description", ({ body, queued }) =>
    Effect.gen(function* () {
      route(
        ["query PullRequestMergeMessage", mergeMessage(body, queued)],
        ["query PullRequestActionState", actionState({ isMergeQueueEnabled: queued })],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "merge",
        removeAgentCreditsOnMerge: true,
      });
      expect(variablesOf("query PullRequestMergeMessage")[0]?.["method"]).toBe("MERGE");
      // A merge queue takes the pull request through auto-merge, with its own message.
      expect(variablesOf(queued ? "enablePullRequestAutoMerge(" : "mergePullRequest(")).toEqual([
        { input: { pullRequestId: "PR_7", mergeMethod: "MERGE" } },
      ]);
    }),
  );

  it.effect("passes an explicitly empty body when the proposed message only credits an agent", () =>
    Effect.gen(function* () {
      route(
        [
          "query PullRequestMergeMessage",
          mergeMessage("Co-authored-by: Claude <noreply@anthropic.com>"),
        ],
        ["query PullRequestActionState", actionState()],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "merge",
        removeAgentCreditsOnMerge: true,
      });
      expect(variablesOf("mergePullRequest(")).toEqual([
        {
          input: {
            pullRequestId: "PR_7",
            mergeMethod: "MERGE",
            expectedHeadOid: "abc123",
            commitBody: "",
          },
        },
      ]);
    }),
  );

  it.effect("does not fetch a message for rebase merges", () =>
    Effect.gen(function* () {
      route(["query PullRequestActionState", actionState()]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "merge",
        mergeMethod: "rebase",
        removeAgentCreditsOnMerge: true,
      });
      expect(variablesOf("query PullRequestMergeMessage")).toEqual([]);
      expect(variablesOf("mergePullRequest(")).toEqual([
        { input: { pullRequestId: "PR_7", mergeMethod: "REBASE" } },
      ]);
    }),
  );

  it.effect("refuses to merge when the proposed message cannot be read", () =>
    Effect.gen(function* () {
      route(
        ["query PullRequestMergeMessage", { data: { repository: { pullRequest: null } } }],
        ["query PullRequestActionState", actionState()],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const result = yield* Effect.result(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "merge",
          removeAgentCreditsOnMerge: true,
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(variablesOf("mergePullRequest(")).toEqual([]);
    }),
  );

  it.effect("arms auto-merge with the same strategy a merge would have used", () =>
    Effect.gen(function* () {
      route(["query PullRequestActionState", actionState()]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "enable-auto-merge",
        mergeMethod: "squash",
      });
      // No strategy asked for is GitHub's own default, exactly as it is for a merge now.
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "enable-auto-merge",
      });

      expect(variablesOf("enablePullRequestAutoMerge(")).toEqual([
        { input: { pullRequestId: "PR_7", mergeMethod: "SQUASH" } },
        { input: { pullRequestId: "PR_7", mergeMethod: "MERGE" } },
      ]);
      expect(variablesOf("mergePullRequest(")).toEqual([]);
    }),
  );

  it.effect("merges at once when auto-merge is asked of a pull request that is ready now", () =>
    Effect.gen(function* () {
      route(["query PullRequestActionState", actionState({ mergeStateStatus: "CLEAN" })]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "enable-auto-merge",
        mergeMethod: "squash",
      });

      expect(variablesOf("mergePullRequest(")).toEqual([
        { input: { pullRequestId: "PR_7", mergeMethod: "SQUASH" } },
      ]);
      expect(variablesOf("enablePullRequestAutoMerge(")).toEqual([]);
    }),
  );

  it.effect("takes auto-merge back off without naming a strategy", () =>
    Effect.gen(function* () {
      route([NODE_ID_QUERY, nodeIdAnswer("PR_7")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "disable-auto-merge",
        mergeMethod: "squash",
      });

      expect(variablesOf("disablePullRequestAutoMerge(")).toEqual([{ pullRequestId: "PR_7" }]);
    }),
  );

  it.effect("opens a pull request that reverts a merged pull request", () =>
    Effect.gen(function* () {
      route([NODE_ID_QUERY, nodeIdAnswer("PR_7")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "revert",
      });

      expect(variablesOf("revertPullRequest(")).toEqual([{ pullRequestId: "PR_7" }]);
    }),
  );

  it.effect("does not approve action-required runs for a same-repository pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson(
              coreResponse({
                number: 7,
                title: "Pull request 7",
                url: "https://github.com/acme/web/pull/7",
                headRefName: "feat/page",
                headRefOid: "abc123",
                isCrossRepository: false,
                headRepositoryOwner: { login: "acme" },
                baseRefName: "main",
                createdAt: "2026-07-01T00:00:00Z",
                updatedAt: "2026-07-02T00:00:00Z",
              }),
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "approve-workflows",
      });

      expect(mockedExecute).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("finds and approves every workflow waiting on a maintainer", () =>
    Effect.gen(function* () {
      workflowApprovalRoutes(() => crossRepositoryDetail(), heads([7]), workflowRuns([10, 11]));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "approve-workflows",
      });

      // Open pull requests on this head branch, and runs scoped to this exact head.
      expect(variablesOf("headRefName: $head")[0]).toEqual({
        owner: "acme",
        name: "web",
        head: "feat/page",
        after: null,
      });
      expect(restCallsTo("actions/runs?")[0]?.path).toBe(
        "repos/acme/web/actions/runs?head_sha=abc123&branch=feat%2Fpage&event=pull_request&status=action_required&per_page=100&page=1",
      );
      // Each run is approved only after the head is read again and still lists it.
      expect(restCallsTo("/approve").map((call) => [call.method, call.path])).toEqual([
        ["POST", "repos/acme/web/actions/runs/10/approve"],
        ["POST", "repos/acme/web/actions/runs/11/approve"],
      ]);
      assert.strictEqual(restCallsTo("actions/runs?").length, 3);
    }),
  );

  it.effect("counts revalidated runs that wait on a maintainer as GitHub reports them", () =>
    Effect.gen(function* () {
      workflowApprovalRoutes(() => crossRepositoryDetail(), heads([7]), workflowRuns([]));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const runs = yield* cli
        .listWorkflowRunsRequiringApproval({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          headSha: "abc123",
          headBranch: "feat/page",
          headRepositoryOwner: "octocat",
          isCrossRepository: true,
        })
        .pipe(
          Effect.provideService(KnownWorkflowRuns, {
            headSha: "abc123",
            runs: [
              // Live shape: waiting on approval is completed + action_required.
              {
                id: 10,
                status: "completed",
                conclusion: "action_required",
                head_branch: "feat/page",
              },
              { id: 11, status: "completed", conclusion: "success", head_branch: "feat/page" },
            ],
          }),
        );

      expect(runs.map((run) => run.id)).toEqual([10]);
      assert.strictEqual(restCallsTo("actions/runs?").length, 0);
    }),
  );

  it.effect("refuses a stale workflow approval after the pull request head changes", () =>
    Effect.gen(function* () {
      let detailReads = 0;
      workflowApprovalRoutes(
        () => crossRepositoryDetail(++detailReads === 1 ? "abc123" : "def456"),
        heads([7]),
        workflowRuns([10]),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "approve-workflows",
        }),
      );

      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalHeadChangedError",
        number: 7,
      });
      assert.strictEqual(detailReads, 2);
      expect(restCallsTo("/approve")).toEqual([]);
    }),
  );

  it.effect("reads workflow runs and their pull request scope concurrently", () =>
    Effect.gen(function* () {
      const headsStarted = yield* Deferred.make<void>();
      const runsStarted = yield* Deferred.make<void>();
      mockedExecute.mockImplementation((call) =>
        call.kind === "graphql"
          ? Deferred.succeed(headsStarted, undefined).pipe(
              Effect.andThen(Deferred.await(runsStarted)),
              Effect.as(output(encodeJson(heads([7])))),
            )
          : Deferred.succeed(runsStarted, undefined).pipe(
              Effect.andThen(Deferred.await(headsStarted)),
              Effect.as(output(encodeJson(workflowRuns([10])))),
            ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const runs = yield* cli.listWorkflowRunsRequiringApproval({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        headSha: "abc123",
        headBranch: "feat/page",
        headRepositoryOwner: "octocat",
        isCrossRepository: true,
      });

      expect(runs).toEqual([{ id: 10, name: "build", url: "https://example.com/10" }]);
    }),
  );

  it.effect("refuses workflow approval when one head belongs to several pull requests", () =>
    Effect.gen(function* () {
      workflowApprovalRoutes(() => crossRepositoryDetail(), heads([7, 8]), workflowRuns([]));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.listWorkflowRunsRequiringApproval({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          headSha: "abc123",
          headBranch: "feat/page",
          headRepositoryOwner: "octocat",
          isCrossRepository: true,
        }),
      );

      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalRefusedError",
        reason: "head-not-unique",
        number: 7,
        observedCount: 2,
        limit: 1_000,
      });
      expect(error.message).toContain("instead of uniquely matching #7");
    }),
  );

  it.effect("refuses workflow approval when the head list stops before its end", () =>
    Effect.gen(function* () {
      // GitHub hands the same cursor back, so the second page is never read past. #7 looks
      // unique on what was read, and an unread page could still hold another head like it.
      const repeating = heads([7]);
      repeating.data.repository.pullRequests.pageInfo = {
        hasNextPage: true,
        endCursor: "same",
      } as never;
      workflowApprovalRoutes(() => crossRepositoryDetail(), repeating, workflowRuns([]));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.listWorkflowRunsRequiringApproval({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          headSha: "abc123",
          headBranch: "feat/page",
          headRepositoryOwner: "octocat",
          isCrossRepository: true,
        }),
      );

      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalRefusedError",
        reason: "head-list-truncated",
      });
    }),
  );

  it.effect("refuses workflow approval when GitHub omits the head repository", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson(
              coreResponse({
                number: 7,
                title: "Pull request 7",
                url: "https://github.com/acme/web/pull/7",
                headRefName: "feat/page",
                headRefOid: "abc123",
                isCrossRepository: true,
                headRepositoryOwner: null,
                baseRefName: "main",
                createdAt: "2026-07-01T00:00:00Z",
                updatedAt: "2026-07-02T00:00:00Z",
              }),
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "approve-workflows",
        }),
      );

      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalHeadUnavailableError",
        number: 7,
      });
      expect(mockedExecute).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("surfaces a workflow run list beyond the safe approval bound", () =>
    Effect.gen(function* () {
      let runPages = 0;
      mockedExecute.mockImplementation((call) => {
        if (call.kind === "graphql") return Effect.succeed(output(encodeJson(heads([7]))));
        const page = runPages++;
        return Effect.succeed(
          output(
            encodeJson(
              workflowRuns(Array.from({ length: 100 }, (_, index) => page * 100 + index + 1)),
            ),
          ),
        );
      });
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.listWorkflowRunsRequiringApproval({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          headSha: "abc123",
          headBranch: "feat/page",
          headRepositoryOwner: "octocat",
          isCrossRepository: true,
        }),
      );

      // Paged a hundred at a time, it stops at the first page past the bound.
      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalRefusedError",
        reason: "run-list-truncated",
        number: 7,
        observedCount: 1_100,
        limit: 1_000,
      });
      expect(error.message).toContain("more than 1000 workflow runs");
      assert.strictEqual(runPages, 11);
    }),
  );

  it.effect("returns a pull request to draft by converting it", () =>
    Effect.gen(function* () {
      route([NODE_ID_QUERY, nodeIdAnswer("PR_7")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "draft",
      });

      expect(variablesOf("convertPullRequestToDraft(")).toEqual([{ pullRequestId: "PR_7" }]);
      expect(variablesOf("markPullRequestReadyForReview(")).toEqual([]);
    }),
  );

  it.effect("sends a comment body as a variable, never inside the document", () =>
    Effect.gen(function* () {
      route([NODE_ID_QUERY, nodeIdAnswer("PR_7")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.commentOnPullRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        body: "Looks good.",
      });

      expect(variablesOf("addComment(")).toEqual([{ subjectId: "PR_7", body: "Looks good." }]);
      expect(queryAt(mockedExecute.mock.calls.length - 1)).not.toContain("Looks good.");
    }),
  );

  it.effect("names the host on every repository it addresses", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.query.includes("pullRequests(")
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      // A request sent to github.com would read a different repository of the same name.
      assert.isAbove(mockedExecute.mock.calls.length, 0);
      expect(new Set(mockedExecute.mock.calls.map(([call]) => call.host))).toEqual(
        new Set(["github.acme.dev"]),
      );
      expect(searchOfCall(0)).toContain("repo:acme/web");
    }),
  );

  it.effect("asks a GitHub Enterprise host for its own review threads", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        number: 7,
      });

      expect(callAt(0).host).toBe("github.acme.dev");
      expect(varsAt(0)).toMatchObject({ owner: "acme", name: "web", number: 7 });
    }),
  );

  it.effect("serves a diff GitHub hands over whole in one request, with no next slice", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("diff --git a/a b/a")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(diff.patch, "diff --git a/a b/a");
      assert.isNull(diff.nextCursor);
      assert.isFalse(diff.truncated);
      // The common case pays for one request and not the files API on top of it.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      // GitHub's combined pull-request diff: one section per changed file, not one per commit.
      const call = callAt(0);
      assert.strictEqual(call.kind, "rest");
      if (call.kind === "rest") {
        assert.strictEqual(call.path, "repos/acme/web/pulls/7");
        assert.strictEqual(call.accept, "application/vnd.github.diff");
      }
    }),
  );

  it.effect("reads one files page when GitHub refuses the diff, and says it is the last", () =>
    Effect.gen(function* () {
      // GitHub answers 406 rather than a diff past 300 changed files.
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(2, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        number: 7,
      });

      assert.isFalse(diff.truncated);
      // A short page is the end of the change set, so there is nothing to carry on from.
      assert.isNull(diff.nextCursor);
      expect(diff.patch).toContain("diff --git a/src/file1.ts b/src/file1.ts");
      expect(diff.patch).toContain("diff --git a/src/file2.ts b/src/file2.ts");
      assert.strictEqual(callAt(1).host, "github.acme.dev");
      assert.strictEqual(pathAt(1), "repos/acme/web/pulls/7/files?per_page=100&page=1");
    }),
  );

  it.effect("hands back a cursor for the next page rather than walking on by itself", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(100, 0))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      // A full page means more files, which the reader asks for; it is not a truncated slice.
      assert.isFalse(diff.truncated);
      assert.isNotNull(diff.nextCursor);
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("carries on from a cursor without asking for the whole diff again", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(100, 0))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const target = { cwd: "/w", repository: "acme/web", host: "github.com", number: 7 };

      const first = yield* cli.getPullRequestDiff(target);
      assert.isNotNull(first.nextCursor);
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(4, 100))));
      const second = yield* cli.getPullRequestDiff({ ...target, cursor: first.nextCursor });

      assert.isNull(second.nextCursor);
      expect(second.patch).toContain("diff --git a/src/file100.ts b/src/file100.ts");
      // The second slice is one request: the cursor already says where to read.
      assert.strictEqual(mockedExecute.mock.calls.length, 3);
      assert.strictEqual(pathAt(2), "repos/acme/web/pulls/7/files?per_page=100&page=2");
    }),
  );

  it.effect("refuses a cursor it never handed out rather than reading it into a request", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          cursor: "1&per_page=1",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffCursorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("reads a named commit from the commit endpoint rather than the whole diff", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(`{"files":${pullRequestFiles(2, 1)}}`)),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        commit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      });

      // One request: the commit's own changes never take the whole-diff road.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      assert.isNull(diff.nextCursor);
      // The commit endpoint wraps its files in an object, which the decoder unwraps.
      expect(diff.patch).toContain("diff --git a/src/file1.ts b/src/file1.ts");
      assert.strictEqual(
        pathAt(0),
        "repos/acme/web/commits/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0?per_page=100&page=1",
      );
    }),
  );

  it.effect("pages inside a commit the way it pages the pull request's own files", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(`{"files":${pullRequestFiles(100, 0)}}`)),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const target = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        commit: "a1b2c3d",
      };

      const first = yield* cli.getPullRequestDiff(target);
      assert.isNotNull(first.nextCursor);
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(`{"files":${pullRequestFiles(4, 100)}}`)),
      );
      const second = yield* cli.getPullRequestDiff({ ...target, cursor: first.nextCursor });

      assert.isNull(second.nextCursor);
      expect(second.patch).toContain("src/file100.ts");
      assert.strictEqual(pathAt(1), "repos/acme/web/commits/a1b2c3d?per_page=100&page=2");
    }),
  );

  it.effect("refuses a commit that is not a sha rather than reading it into a request", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          commit: "../../pulls/8/files",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffCommitError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("expands a new file from a root commit without requiring a parent", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(encodeJson({ sha: "a1b2c3d", parents: [] }))),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("root contents\n")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const contents = yield* cli.getPullRequestDiffFileContents({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        commit: "a1b2c3d",
        changeType: "new",
        oldPath: "src/root.ts",
        newPath: "src/root.ts",
      });

      expect(contents).toEqual({ oldContents: "", newContents: "root contents\n" });
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      assert.strictEqual(pathAt(0), "repos/acme/web/commits/a1b2c3d");
      assert.strictEqual(pathAt(1), "repos/acme/web/contents/src/root.ts?ref=a1b2c3d");
    }),
  );

  it.effect("reports unusable diff revisions as a structured error", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("not-a-sha\tstill-not-a-sha\n")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          commit: "a1b2c3d",
          changeType: "change",
          oldPath: "src/a.ts",
          newPath: "src/a.ts",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffRevisionsUnavailableError");
      if (error._tag === "GitHubDiffRevisionsUnavailableError") {
        assert.strictEqual(error.number, 7);
        assert.strictEqual(error.commit, "a1b2c3d");
      }
    }),
  );

  it.effect("reports an oversized diff file with its path and reason", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestRefs)));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("partial", true)));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          changeType: "deleted",
          oldPath: "src/large.ts",
          newPath: "src/large.ts",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffFileContentsUnavailableError");
      if (error._tag === "GitHubDiffFileContentsUnavailableError") {
        assert.strictEqual(error.path, "src/large.ts");
        assert.strictEqual(error.reason, "oversized");
      }
      // A deleted file is read at the base revision only.
      assert.strictEqual(pathAt(1), "repos/acme/web/contents/src/large.ts?ref=a1b2c3d");
    }),
  );

  it.effect("reports undecodable diff file contents as binary", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestRefs)));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("binary�contents", false, true)));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          changeType: "deleted",
          oldPath: "assets/logo.png",
          newPath: "assets/logo.png",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffFileContentsUnavailableError");
      if (error._tag === "GitHubDiffFileContentsUnavailableError") {
        assert.strictEqual(error.path, "assets/logo.png");
        assert.strictEqual(error.reason, "binary");
      }
    }),
  );

  it.effect("returns valid text containing a literal replacement character", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestRefs)));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("before�after")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const contents = yield* cli.getPullRequestDiffFileContents({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        changeType: "deleted",
        oldPath: "docs/encoding.md",
        newPath: "docs/encoding.md",
      });

      assert.strictEqual(contents.oldContents, "before�after");
    }),
  );

  it.effect("ends the diff on a page with no files rather than asking for it again", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        cursor: "4",
      });

      assert.strictEqual(diff.patch, "");
      assert.isNull(diff.nextCursor);
    }),
  );

  it.effect("reports the refused diff when the files API cannot answer either", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("not json")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      assert.strictEqual(error, diffRefused);
    }),
  );

  it.effect("skips the avatar lookup when a listing named nobody", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const avatars = yield* cli.listActorAvatars({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        ids: [],
      });

      assert.strictEqual(avatars.size, 0);
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("looks up avatars by node id in one GraphQL read", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                nodes: [{ login: "octocat", avatarUrl: "https://avatars/octocat" }],
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const avatars = yield* cli.listActorAvatars({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        ids: ["MDQ6VXNlcjE="],
      });

      expect(varsAt(0)).toEqual({ ids: ["MDQ6VXNlcjE="] });
      expect(avatars.get("octocat")).toBe("https://avatars/octocat");
    }),
  );

  it.effect("fails when the authenticated account has no login", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("  ")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(cli.getViewerLogin({ cwd: "/w", host: "github.com" }));

      assert.strictEqual(error._tag, "GitHubViewerLoginUnavailableError");
    }),
  );

  it.effect("looks up the authenticated account on the requested enterprise host", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output('{"id":456,"login":"enterprise-user"}')),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const login = yield* cli.getViewerLogin({ cwd: "/w", host: "github.acme.com" });

      expect(login).toBe("enterprise-user");
      expect(mockedCredential).toHaveBeenCalledWith("github.acme.com");
      expect(callAt(0)).toMatchObject({ kind: "rest", host: "github.acme.com", path: "user" });
    }),
  );

  it.effect("reuses verified credentials offline and refuses an unverified replacement", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const input = { cwd: "/w", host: "github.identity-cache.test" };
      mockedCredential.mockImplementation((host) =>
        Effect.succeed({ token: Redacted.make("test-credential-a"), fingerprint: `${host}:a` }),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"id":123,"login":"maria-rcks"}')));
      expect(yield* cli.getRoutingIdentity(input)).toEqual({
        accountId: "123",
        viewer: "maria-rcks",
      });

      // The same credential again is answered from what was verified, without asking GitHub.
      expect(yield* cli.getRoutingIdentity(input)).toEqual({
        accountId: "123",
        viewer: "maria-rcks",
      });
      expect(mockedExecute).toHaveBeenCalledTimes(1);

      // A switched credential is not trusted on the strength of the old one's answer.
      mockedCredential.mockImplementation((host) =>
        Effect.succeed({ token: Redacted.make("test-credential-b"), fingerprint: `${host}:b` }),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.fail(
          new GitHubApi.GitHubApiResponseError({
            host: "github.com",
            operation: "getRoutingIdentity",
            status: 502,
          }),
        ),
      );
      // GitHub's own refusal is reported as itself, so the page can say what went wrong.
      const failure = yield* cli.getRoutingIdentity(input).pipe(Effect.flip);
      expect(failure._tag).toBe("GitHubApiResponseError");
      expect(String(failure)).not.toContain("test-credential-b");
      expect(mockedExecute).toHaveBeenCalledTimes(2);

      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"id":456,"login":"maria-rcks"}')));
      expect(yield* cli.getRoutingIdentity(input)).toEqual({
        accountId: "456",
        viewer: "maria-rcks",
      });
    }),
  );

  it.effect("sends a whole review as one request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.submitReview({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        verdict: "approve",
        body: "Looks right.",
        comments: [{ path: "src/a.ts", position: { kind: "added", newLine: 4 }, body: "nit" }],
      });

      // One request, so nothing is on the pull request until the verdict is.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(restCallsTo("/reviews")).toMatchObject([
        {
          method: "POST",
          path: "repos/acme/web/pulls/7/reviews",
          body: {
            event: "APPROVE",
            body: "Looks right.",
            comments: [{ path: "src/a.ts", line: 4, side: "RIGHT", body: "nit" }],
          },
        },
      ]);
    }),
  );

  it.effect("sends a reply body as a variable, never inside the document", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.replyToReviewThread({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        threadId: "PRRT_1",
        body: "Fixed in 42ff8ec.",
      });

      expect(variablesOf("addPullRequestReviewThreadReply(")).toEqual([
        { threadId: "PRRT_1", body: "Fixed in 42ff8ec." },
      ]);
      expect(queryAt(0)).not.toContain("Fixed in 42ff8ec.");
    }),
  );

  it.effect("resolves and unresolves through the mutation each one needs", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setReviewThreadResolution({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        threadId: "PRRT_1",
        resolved: true,
      });
      yield* cli.setReviewThreadResolution({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        threadId: "PRRT_1",
        resolved: false,
      });

      expect(queryAt(0)).toContain("resolveReviewThread(");
      expect(queryAt(0)).not.toContain("unresolveReviewThread(");
      expect(queryAt(1)).toContain("unresolveReviewThread(");
      expect([varsAt(0), varsAt(1)]).toEqual([{ threadId: "PRRT_1" }, { threadId: "PRRT_1" }]);
      // A GitHub Enterprise thread is resolved on its own host, not on github.com.
      expect([callAt(0).host, callAt(1).host]).toEqual(["github.acme.dev", "github.acme.dev"]);
    }),
  );

  it.effect("confirms a given subject belongs to the named pull request, then reacts to it", () =>
    Effect.gen(function* () {
      route([SUBJECT_SCOPE_QUERY, subjectScope("IC_1", "PR_kwDOA")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setReaction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        subjectId: "IC_1",
        content: "heart",
        reacted: true,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(variablesOf(SUBJECT_SCOPE_QUERY)).toEqual([
        { owner: "acme", name: "web", number: 7, subjectId: "IC_1" },
      ]);
      expect(variablesOf("addReaction(")).toEqual([{ subjectId: "IC_1", content: "HEART" }]);
    }),
  );

  it.effect("refuses a given subject that belongs to a different pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: { pullRequest: { id: "PR_thisOne" } },
                // A comment on pull request #99 of a different repository, named as though it
                // belonged to #7 here.
                node: { id: "IC_99", pullRequest: { id: "PR_someOtherOne" } },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.setReaction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          subjectId: "IC_99",
          content: "heart",
          reacted: true,
        }),
      );

      assert.strictEqual(error._tag, "GitHubSubjectScopeError");
      // Refused before any mutation was sent.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("looks up the pull request's own node id when no subject was given", () =>
    Effect.gen(function* () {
      route([NODE_ID_QUERY, nodeIdAnswer("PR_kwDOA")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      // Its own pull request: a node id looked up once is remembered for the life of the service.
      yield* cli.setReaction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 21,
        content: "rocket",
        reacted: true,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(variablesOf(NODE_ID_QUERY)).toEqual([{ owner: "acme", name: "web", number: 21 }]);
      expect(variablesOf("addReaction(")).toEqual([{ subjectId: "PR_kwDOA", content: "ROCKET" }]);
    }),
  );

  it.effect("takes a reaction back through the remove mutation", () =>
    Effect.gen(function* () {
      route([SUBJECT_SCOPE_QUERY, subjectScope("IC_1", "PR_kwDOA")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setReaction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        subjectId: "IC_1",
        content: "heart",
        reacted: false,
      });

      expect(variablesOf("removeReaction(")).toEqual([{ subjectId: "IC_1", content: "HEART" }]);
      expect(variablesOf("addReaction(")).toEqual([]);
    }),
  );

  it.effect("rewrites only the words a request named", () =>
    Effect.gen(function* () {
      route([NODE_ID_QUERY, nodeIdAnswer("PR_kwDOA")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const rewrite = (fields: { readonly title?: string; readonly body?: string }) =>
        cli.updatePullRequest({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 22,
          ...fields,
        });

      yield* rewrite({ title: "A better title" });
      yield* rewrite({ body: "A better description." });
      yield* rewrite({ title: "Both", body: "at once." });

      // One node id lookup for the pull request, then a mutation per rewrite.
      assert.strictEqual(variablesOf(NODE_ID_QUERY).length, 1);
      expect(variablesOf("updatePullRequest(")).toEqual([
        { pullRequestId: "PR_kwDOA", title: "A better title" },
        { pullRequestId: "PR_kwDOA", body: "A better description." },
        { pullRequestId: "PR_kwDOA", title: "Both", body: "at once." },
      ]);
    }),
  );

  it.effect("rewrites a remark through the mutation its kind needs", () =>
    Effect.gen(function* () {
      route([SUBJECT_SCOPE_QUERY, subjectScope("IC_1", "PR_kwDOA")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const rewrite = (kind: "issue-comment" | "review-comment") =>
        cli.updateComment({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          commentId: "IC_1",
          kind,
          body: "Reworded.",
        });

      yield* rewrite("issue-comment");
      yield* rewrite("review-comment");

      expect(variablesOf(SUBJECT_SCOPE_QUERY).map((variables) => variables["subjectId"])).toEqual([
        "IC_1",
        "IC_1",
      ]);
      expect(variablesOf("updateIssueComment(")).toEqual([
        { commentId: "IC_1", body: "Reworded." },
      ]);
      expect(variablesOf("updatePullRequestReviewComment(")).toEqual([
        { commentId: "IC_1", body: "Reworded." },
      ]);
    }),
  );

  it.effect("refuses a comment that belongs to a different pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: { pullRequest: { id: "PR_thisOne" } },
                node: { id: "IC_99", pullRequest: { id: "PR_someOtherOne" } },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.updateComment({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          commentId: "IC_99",
          kind: "issue-comment",
          body: "Reworded.",
        }),
      );

      assert.strictEqual(error._tag, "GitHubSubjectScopeError");
      if (error._tag === "GitHubSubjectScopeError")
        assert.strictEqual(error.operation, "updateComment");
      // Refused before any mutation was sent.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("fails the read when gh returns something unreadable", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"message":"not found"}')));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDetail({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      assert.strictEqual(error._tag, "GitHubPullRequestReadError");
    }),
  );

  it.effect("keeps the core detail read separate from conversation activity", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson(
              coreResponse({
                title: "Progressive detail",
                author: { login: "octocat" },
                body: "Core body",
                changedFiles: 2,
              }),
            ),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    author: { __typename: "User", login: "octocat", avatarUrl: "https://a/o" },
                    commits: { nodes: [] },
                    comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                    reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                  },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const input = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      } as const;

      const detail = yield* cli.getPullRequestDetail(input);
      const activity = yield* cli.getPullRequestActivity(input);

      expect(detail.body).toBe("Core body");
      expect(activity.author?.login).toBe("octocat");
      expect(varsAt(0)).toMatchObject({ number: 7, headRef: "refs/pull/7/head" });
      expect(queryAt(0)).toContain("viewerCanUpdateBranch");
      expect(queryAt(0)).not.toContain("reviews(");
      expect(detail.viewerAccess.mergeCapabilities).toEqual({
        merge: true,
        squash: false,
        rebase: true,
      });
      expect(detail.comparison).toEqual({ behindBy: 2, viewerCanUpdate: true });
      // Conversation activity is its own read, and asks for the head of the conversation once.
      expect(queryAt(1)).toContain("reviews(");
      expect(varsAt(1)).toMatchObject({ head: true, withComments: true, withReviews: true });
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("decodes reviewers, labels and workflow checks without another detail read", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson(
              coreResponse({
                baseRef: null,
                reviewRequests: {
                  nodes: [
                    { requestedReviewer: { login: "reviewer" } },
                    { requestedReviewer: { slug: "maintainers", name: "Maintainers" } },
                  ],
                },
                labels: { nodes: [{ name: "bug", color: "ff0000" }] },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          contexts: {
                            nodes: [
                              {
                                __typename: "CheckRun",
                                name: "build",
                                status: "COMPLETED",
                                conclusion: "SUCCESS",
                                checkSuite: { workflowRun: { workflow: { name: "linux" } } },
                              },
                              {
                                __typename: "CheckRun",
                                name: "build",
                                status: "COMPLETED",
                                conclusion: "FAILURE",
                                checkSuite: { workflowRun: { workflow: { name: "windows" } } },
                              },
                            ],
                            pageInfo: { hasNextPage: false },
                          },
                        },
                      },
                    },
                  ],
                },
              }),
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const detail = yield* cli.getPullRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });
      expect(mockedExecute).toHaveBeenCalledOnce();
      expect(detail.comparison).toBeNull();
      expect(detail.reviewRequestLogins).toEqual(["reviewer"]);
      expect(detail.hasTeamReviewRequest).toBe(true);
      expect(detail.labels).toEqual([{ name: "bug", color: "ff0000" }]);
      expect(detail.checks).toHaveLength(2);
      expect(detail.checksState).toBe("failing");
    }),
  );

  it.effect("reads every check when the combined response has another page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson(
              coreResponse({
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          contexts: {
                            nodes: [{ name: "first", status: "COMPLETED", conclusion: "SUCCESS" }],
                            pageInfo: { hasNextPage: true, endCursor: "c1" },
                          },
                        },
                      },
                    },
                  ],
                },
              }),
            ),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            checkContextsPage(
              [
                { name: "first", status: "COMPLETED", conclusion: "SUCCESS" },
                { name: "last", status: "COMPLETED", conclusion: "FAILURE" },
              ],
              null,
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const detail = yield* cli.getPullRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });
      expect(detail.checks).toHaveLength(2);
      expect(detail.checksState).toBe("failing");
      expect(detail.checksTruncated).toBe(false);
      // The whole rollup is walked from its start, so no check is counted twice or skipped.
      expect(varsAt(1)).toMatchObject({ number: 7, after: null });
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("refuses to combine checks from different head revisions", () =>
    Effect.gen(function* () {
      const response = coreResponse({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [],
                    pageInfo: { hasNextPage: true },
                  },
                },
              },
            },
          ],
        },
      });
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(encodeJson(response))));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              ...response.data.repository.pullRequest,
              headRefOid: "new-head",
              reviewRequests: [],
              labels: [],
              statusCheckRollup: [],
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const error = yield* Effect.flip(
        cli.getPullRequestDetail({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );
      expect(error._tag).toBe("GitHubPullRequestReadError");
    }),
  );

  it.effect("preserves the reserve for automatic detail reads and allows manual checks", () =>
    Effect.gen(function* () {
      const response = coreResponse();
      mockedExecute.mockReturnValue(
        Effect.succeed(output(encodeJson(response), false, false, graphqlQuota(499))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const input = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.core-reserve.test",
        number: 7,
      };
      yield* cli.getPullRequestDetail(input);
      const error = yield* Effect.flip(cli.getPullRequestDetail(input));
      expect(error._tag).toBe("SourceControlRateLimitPausedError");
      expect(mockedExecute).toHaveBeenCalledOnce();
      yield* cli
        .getPullRequestDetail(input)
        .pipe(Effect.provideService(SourceControlRateLimit.Interactive, true));
      expect(mockedExecute).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("fails a files page too large to read rather than calling the diff whole", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(1, 1), true)));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      // What matters is that it fails at all: an empty patch with no cursor would render as a
      // change with no files and report the rest of it as already read. The refusal that sent
      // the read down this road is the one reported, by design.
      assert.strictEqual(error, diffRefused);
    }),
  );

  it.effect("pages an oversized patch by file rather than handing back a severed one", () =>
    Effect.gen(function* () {
      // The whole diff came back, but cut at a byte, which lands mid-file.
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output("diff --git a/a b/a\n@@ -1 +1 @@", true)),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(1, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const slice = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      // The severed patch is thrown away; what comes back is assembled from whole files.
      assert.strictEqual(pathAt(1), "repos/acme/web/pulls/7/files?per_page=100&page=1");
      expect(slice.patch).toContain("src/file1.ts");
      expect(slice.patch).not.toContain("diff --git a/a b/a");
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("follows the cursor to the review threads the first page left behind", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(reviewThreadsPage([thread("PRRT_1", "c1")], "Y3Vyc29yOjE"))),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(reviewThreadsPage([thread("PRRT_2", "c2")], null))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const conversation = yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      // The first page asks from the beginning; the next carries on from where it stopped.
      expect(varsAt(0)["cursor"]).toBeNull();
      expect(varsAt(1)["cursor"]).toBe("Y3Vyc29yOjE");
      expect(conversation.comments.map((comment) => comment.id)).toEqual(["c1", "c2"]);
      assert.isFalse(conversation.truncated);
    }),
  );

  it.effect("stops at the thread bound and says the conversation was cut short", () =>
    Effect.gen(function* () {
      // A host that never runs out of pages: the walk has to end itself.
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            reviewThreadsPage(
              [{ ...thread("PRRT_1", "c1"), comments: threadComments(["c1"], "Y3Vyc29yOjI", 3) }],
              "Y3Vyc29yOjE",
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const conversation = yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 10);
      assert.isTrue(conversation.truncated);
      assert.isTrue(conversation.reviewThreadsTruncated);
    }),
  );

  it.effect("leaves a long thread paged until the reader asks for more", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            reviewThreadsPage(
              [{ ...thread("PRRT_1", "c1"), comments: threadComments(["c1"], "Y3Vyc29yOjI", 3) }],
              null,
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const conversation = yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(conversation.comments.map((comment) => comment.id)).toEqual(["c1"]);
      expect(conversation.reviewThreads[0]).toMatchObject({
        commentCount: 3,
        nextCommentsCursor: "Y3Vyc29yOjI",
      });
      assert.isTrue(conversation.truncated);
      assert.isFalse(conversation.reviewThreadsTruncated);
    }),
  );

  it.effect("reads one requested page from a review thread cursor", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(threadCommentsPage(["c2", "c3"], null, 3))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const page = yield* cli.getReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        threadId: "PRRT_1",
        cursor: "Y3Vyc29yOjI",
      });

      expect(varsAt(0)).toMatchObject({
        owner: "acme",
        name: "web",
        number: 7,
        threadId: "PRRT_1",
        cursor: "Y3Vyc29yOjI",
      });
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(page.comments.map((comment) => comment.id)).toEqual(["c2", "c3"]);
      expect(page.nextCursor).toBeNull();
    }),
  );

  it.effect("refuses a review thread from another pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(threadCommentsPage(["foreign"], null, 1, "PR_8"))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getReviewThreadComments({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          threadId: "PRRT_FOREIGN",
          cursor: "Y3Vyc29yOjI",
        }),
      );

      assert.strictEqual(error._tag, "GitHubSubjectScopeError");
    }),
  );

  it.effect(
    "asks for the reader's standing on the repository and on the pull request at once",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValue(
          Effect.succeed(
            output(
              encodeJson({
                data: {
                  repository: {
                    mergeCommitAllowed: true,
                    squashMergeAllowed: false,
                    rebaseMergeAllowed: true,
                    viewerPermission: "READ",
                    pullRequest: { viewerCanUpdate: true, viewerDidAuthor: true },
                  },
                },
              }),
            ),
          ),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

        const access = yield* cli.getViewerAccess({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        });

        // One request, because both answers hang off the same repository object.
        assert.strictEqual(mockedExecute.mock.calls.length, 1);
        expect(varsAt(0)).toMatchObject({ owner: "acme", name: "web", number: 7 });
        expect(queryAt(0)).toContain("mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed");
        expect(access).toEqual({
          mergeCapabilities: { merge: true, squash: false, rebase: true },
          canWrite: false,
          canTriage: false,
          canUpdate: true,
          didAuthor: true,
        });
      }),
  );

  it.effect("stops GraphQL reads at the protected reserve until reset", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  mergeCommitAllowed: true,
                  squashMergeAllowed: false,
                  rebaseMergeAllowed: true,
                  viewerPermission: "READ",
                  pullRequest: { viewerCanUpdate: true, viewerDidAuthor: true },
                },
              },
            }),
            false,
            false,
            graphqlQuota(499),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const input = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      } as const;

      yield* cli.getViewerAccess(input);

      const error = yield* Effect.flip(cli.getViewerAccess(input));

      assert.strictEqual(error._tag, "SourceControlRateLimitPausedError");
      if (error._tag !== "SourceControlRateLimitPausedError") return;
      assert.strictEqual(error.host, "github.com");
      assert.strictEqual(error.retryAt, Date.parse("2099-08-13T14:00:00Z"));
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      yield* TestClock.setTime(Date.parse("2100-01-01T00:00:00Z"));
    }),
  );

  it.effect("lets an interactive permission read use the protected reserve", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              encodeJson({
                data: {
                  repository: {
                    mergeCommitAllowed: true,
                    squashMergeAllowed: false,
                    rebaseMergeAllowed: true,
                    viewerPermission: "READ",
                    pullRequest: { viewerCanUpdate: true, viewerDidAuthor: true },
                  },
                },
              }),
              false,
              false,
              graphqlQuota(499),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              encodeJson({
                data: {
                  repository: {
                    mergeCommitAllowed: true,
                    squashMergeAllowed: false,
                    rebaseMergeAllowed: true,
                    viewerPermission: "READ",
                    pullRequest: { viewerCanUpdate: true, viewerDidAuthor: true },
                  },
                },
              }),
            ),
          ),
        );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.getViewerAccess({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });
      const access = yield* cli.getViewerAccess({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        allowReserve: true,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(access).toEqual({
        mergeCapabilities: { merge: true, squash: false, rebase: true },
        canWrite: false,
        canTriage: false,
        canUpdate: true,
        didAuthor: true,
      });
      yield* TestClock.setTime(Date.parse("2100-01-01T00:00:00Z"));
    }),
  );

  it.effect("asks GitHub to review, naming the collection a request is added to", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        reviewers: [
          { id: "octocat", kind: "user" },
          { id: "reviewers", kind: "team" },
        ],
        requested: true,
      });

      expect(callAt(0)).toMatchObject({
        kind: "rest",
        method: "POST",
        path: "repos/acme/web/pulls/7/requested_reviewers",
        body: { reviewers: ["octocat"], team_reviewers: ["reviewers"] },
      });
    }),
  );

  it.effect("takes a request back by deleting from the same collection it was added to", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        reviewers: [{ id: "octocat", kind: "user" }],
        requested: false,
      });

      expect(callAt(0)).toMatchObject({
        kind: "rest",
        method: "DELETE",
        path: "repos/acme/web/pulls/7/requested_reviewers",
        body: { reviewers: ["octocat"], team_reviewers: [] },
      });
    }),
  );

  it.effect("reads who may review and who already has in one request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  assignableUsers: {
                    pageInfo: { hasNextPage: false },
                    nodes: [{ login: "bilal" }, { login: "octocat" }, { login: "hubot" }],
                  },
                  pullRequest: {
                    author: { login: "bilal" },
                    reviewRequests: { nodes: [{ requestedReviewer: { login: "octocat" } }] },
                  },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const list = yield* cli.listReviewerCandidates({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      // The people, who has been asked and who opened the pull request all hang off the same
      // repository object, so the menu costs one request.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(varsAt(0)).toMatchObject({ owner: "acme", name: "web", number: 7 });
      expect(list.candidates.map((candidate) => [candidate.login, candidate.isRequested])).toEqual([
        ["octocat", true],
        ["hubot", false],
      ]);
    }),
  );

  it.effect("puts labels on by posting to the issue's own collection, all at once", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setLabels({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        labels: ["bug", "size:XL"],
        applied: true,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(callAt(0)).toMatchObject({
        kind: "rest",
        method: "POST",
        path: "repos/acme/web/issues/7/labels",
        body: { labels: ["bug", "size:XL"] },
      });
    }),
  );

  it.effect("takes labels off one at a time, naming each in the path encoded", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setLabels({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        labels: ["good first issue", "area/web"],
        applied: false,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(callAt(0)).toMatchObject({
        method: "DELETE",
        path: "repos/acme/web/issues/7/labels/good%20first%20issue",
      });
      expect(callAt(1)).toMatchObject({
        method: "DELETE",
        path: "repos/acme/web/issues/7/labels/area%2Fweb",
      });
    }),
  );

  it.effect("reads every page of viewed files, and says so when there are too many", () =>
    Effect.gen(function* () {
      const page = (index: number, hasNextPage: boolean) =>
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    files: {
                      pageInfo: { hasNextPage, endCursor: `cursor-${index}` },
                      nodes: [
                        { path: `src/file${index}.ts`, viewerViewedState: "VIEWED" },
                        { path: `src/other${index}.ts`, viewerViewedState: "UNVIEWED" },
                      ],
                    },
                  },
                },
              },
            }),
          ),
        );
      mockedExecute
        .mockReturnValueOnce(page(0, true))
        .mockReturnValueOnce(page(1, true))
        .mockReturnValueOnce(page(2, false));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const viewed = yield* cli.getPullRequestFilesViewed({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 3);
      // The first page asks from the start; each one after it carries the cursor before it.
      expect([varsAt(0)["after"], varsAt(1)["after"], varsAt(2)["after"]]).toEqual([
        null,
        "cursor-0",
        "cursor-1",
      ]);
      assert.isFalse(viewed.truncated);
      expect(viewed.files.map((file) => [file.path, file.state])).toEqual([
        ["src/file0.ts", "viewed"],
        ["src/other0.ts", "unviewed"],
        ["src/file1.ts", "viewed"],
        ["src/other1.ts", "unviewed"],
        ["src/file2.ts", "viewed"],
        ["src/other2.ts", "unviewed"],
      ]);
    }),
  );

  it.effect("stops paging viewed files rather than following a change without end", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    files: {
                      pageInfo: { hasNextPage: true, endCursor: "cursor" },
                      nodes: [{ path: "src/file.ts", viewerViewedState: "VIEWED" }],
                    },
                  },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const viewed = yield* cli.getPullRequestFilesViewed({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      // The same cursor twice is a page GitHub already gave, so reading stops there.
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      assert.isTrue(viewed.truncated);
    }),
  );

  it.effect("clears and restores a burst of files in one request", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(encodeJson({ data: { repository: { pullRequest: { id: "PR_1" } } } })),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setPullRequestFilesViewed({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 23,
        files: [
          { path: "src/a.ts", viewed: true },
          { path: "src/b.ts", viewed: false },
        ],
      });

      // One request to learn the pull request's node id, one for every press together.
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(queryAt(1)).toContain("f0: markFileAsViewed");
      expect(queryAt(1)).toContain("f1: unmarkFileAsViewed");
      expect(varsAt(1)).toEqual({
        pullRequestId: "PR_1",
        f0_path: "src/a.ts",
        f1_path: "src/b.ts",
      });
    }),
  );

  it.effect("asks the host nothing when nothing was pressed", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setPullRequestFilesViewed({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        files: [],
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("looks a pull request's node id up once, however often it is written to", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(encodeJson({ data: { repository: { pullRequest: { id: "PR_24" } } } })),
          ),
        )
        .mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const pullRequest = { cwd: "/w", repository: "acme/web", host: "github.com", number: 24 };

      yield* cli.setPullRequestFilesViewed({
        ...pullRequest,
        files: [{ path: "src/a.ts", viewed: true }],
      });
      yield* cli.setPullRequestFilesViewed({
        ...pullRequest,
        files: [{ path: "src/b.ts", viewed: true }],
      });
      yield* cli.updatePullRequest({ ...pullRequest, title: "Ticked through" });

      // One lookup, then a mutation per write, every one of them addressed by the id it answered.
      assert.strictEqual(mockedExecute.mock.calls.length, 4);
      expect(varsAt(0)).toEqual({ owner: "acme", name: "web", number: 24 });
      expect([1, 2, 3].map((index) => varsAt(index)["pullRequestId"])).toEqual([
        "PR_24",
        "PR_24",
        "PR_24",
      ]);
    }),
  );

  it.effect("does not remember a node id lookup that failed", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output('{"message":"not found"}')))
        .mockReturnValueOnce(
          Effect.succeed(
            output(encodeJson({ data: { repository: { pullRequest: { id: "PR_25" } } } })),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const write = () =>
        cli.setPullRequestFilesViewed({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 25,
          files: [{ path: "src/a.ts", viewed: true }],
        });

      const error = yield* Effect.flip(write());
      assert.strictEqual(error._tag, "GitHubPullRequestReadError");

      yield* write();

      assert.strictEqual(mockedExecute.mock.calls.length, 3);
      expect(varsAt(2)["pullRequestId"]).toEqual("PR_25");
    }),
  );
  it.effect("keeps the pull request being ticked through, not the one looked up first", () =>
    Effect.gen(function* () {
      // Ordered by insertion alone, a hit does not renew its entry, so the review the reader is
      // working down is the first thing evicted once a listing has walked a cache's worth of cold
      // pull requests, and every press after that pays a round trip again.
      // This block shares one cache, so these numbers are its own and it runs last.
      const HOT = 9_000;
      const lookupsOf = new Map<number, number>();
      mockedExecute.mockImplementation((input) => {
        if (input.kind !== "graphql" || !input.query.includes(NODE_ID_QUERY)) {
          return Effect.succeed(output("{}"));
        }
        const number = Number(input.variables?.["number"]);
        lookupsOf.set(number, (lookupsOf.get(number) ?? 0) + 1);
        return Effect.succeed(
          output(encodeJson({ data: { repository: { pullRequest: { id: `PR_${number}` } } } })),
        );
      });
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const tick = (number: number) =>
        cli.setPullRequestFilesViewed({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number,
          files: [{ path: "src/a.ts", viewed: true }],
        });

      yield* tick(HOT);
      // A cache's worth of cold pull requests, with the open one pressed in between each of them.
      for (let filled = 0; filled < GitHubPullRequestApi.NODE_ID_CACHE_CAPACITY; filled += 1) {
        yield* tick(HOT + 1 + filled);
        yield* tick(HOT);
      }

      assert.strictEqual(lookupsOf.get(HOT), 1);
    }),
  );
});

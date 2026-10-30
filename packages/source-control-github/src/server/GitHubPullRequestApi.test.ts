import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Redacted from "effect/Redacted";

import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import { KnownWorkflowRuns } from "./gitHubConditionalChecks.ts";
import * as GitHubAppAccess from "./GitHubAppAccess.ts";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";

const appSignedOut = Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
  enabled: false,
  token: () => Effect.succeedNone,
  invalidate: () => Effect.void,
});
const mockedAppToken = vi.fn<(host: string) => Effect.Effect<Option.Option<string>>>(
  () => Effect.succeedNone,
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// GitHub's field-level reviewer refusal; the surrounding response data is synthetic.
const refusedReviewer = {
  type: "FORBIDDEN",
  message: "Resource not accessible by integration",
  path: ["repository", "pullRequest", "reviewRequests", "nodes", 0, "requestedReviewer"],
};
const pullRequestInput = { cwd: "/w", repository: "acme/web", host: "github.com", number: 7 };
type PullRequestRead = (
  input: typeof pullRequestInput,
) => Effect.Effect<unknown, GitHubPullRequestApi.GitHubPullRequestApiError>;
const refusedReviewerResponse = () =>
  Effect.succeed(output(encodeJson({ ...coreResponse(), errors: [refusedReviewer] })));

const coreResponse = (pullRequest: Readonly<Record<string, unknown>> = {}) => ({
  data: {
    repository: {
      mergeCommitAllowed: true,
      squashMergeAllowed: false,
      rebaseMergeAllowed: true,
      autoMergeAllowed: true,
      viewerPermission: "WRITE",
      pullRequest: {
        number: 7,
        title: "Pull request 7",
        url: "https://github.com/acme/web/pull/7",
        body: "",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        reviewDecision: null,
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        mergedAt: null,
        closedAt: null,
        isCrossRepository: false,
        maintainerCanModify: true,
        headRepositoryOwner: null,
        headRepository: null,
        headRef: null,
        author: null,
        autoMergeRequest: null,
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

type ApiCall =
  | {
      readonly kind: "graphql";
      readonly authorization: string | undefined;
      readonly partial?: boolean;
      readonly operationName?: string;
      readonly host: string;
      readonly operation: string;
      readonly query: string;
      readonly variables?: Readonly<Record<string, unknown>>;
    }
  | ({ readonly kind: "rest" } & GitHubRest.GitHubRestInput);

type ApiAnswer = Effect.Effect<GitHubRest.GitHubRestResponse, GitHubRequestPolicy.GitHubApiError>;

const mockedExecute = vi.fn<(call: ApiCall) => ApiAnswer>();
const defaultCredential = (host: string) =>
  Effect.succeed({ token: Redacted.make("token"), fingerprint: `${host}:token` });
const mockedCredential =
  vi.fn<
    (
      host: string,
    ) => Effect.Effect<GitHubRequestPolicy.GitHubHeldCredential, GitHubRequestPolicy.GitHubApiError>
  >(defaultCredential);
const mockedStackMemberships = vi.fn<(call: ApiCall) => ApiAnswer>(() =>
  Effect.succeed(output('{"data":{}}')),
);

const mockApi = Layer.succeed(
  GitHubRest.GitHubRest,
  GitHubRest.GitHubRest.of({
    rest: (input) => mockedExecute({ kind: "rest", ...input }),
    credential: (host) => mockedCredential(host),
    appCredential: () => Effect.succeedNone,
  }),
);

const mockHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const host = new URL(request.url).hostname.replace(/^api\./, "");
      const sent =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
              readonly query: string;
              readonly operationName: string;
              readonly variables: Readonly<Record<string, unknown>>;
            })
          : { query: "", operationName: "", variables: {} };
      const call: ApiCall = {
        kind: "graphql",
        authorization: request.headers["authorization"],
        host,
        operation: "batch",
        operationName: sent.operationName,
        query: sent.query,
        variables: sent.variables,
        partial: true,
      };
      const answer = yield* (
        sent.query.startsWith("query PullRequestStackMembership(")
          ? mockedStackMemberships
          : mockedExecute
      )(call).pipe(
        Effect.catchTags({
          GitHubApiResponseError: (error) =>
            Effect.succeed(output('{"message":"Bad gateway"}', false, false, {}, error.status)),
        }),
        Effect.orDie,
      );
      // Empty mutation mocks still need the selected GraphQL root field.
      const body =
        answer.body === "{}" && sent.query.startsWith("mutation ")
          ? encodeJson(mutationAnswer(sent.query))
          : answer.body;
      return HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status: answer.status,
          headers: { "content-type": "application/json", ...answer.headers },
        }),
      );
    }),
  ),
);

const layer = it.layer(
  GitHubPullRequestApi.layer.pipe(
    Layer.provideMerge(GitHubAppAccess.layer),
    Layer.provideMerge(mockApi),
    Layer.provideMerge(GitHubRequestPolicy.layer),
    Layer.provideMerge(
      Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
        enabled: false,
        token: (host) => mockedAppToken(host),
        invalidate: () => Effect.void,
      }),
    ),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
    Layer.provideMerge(mockHttp),
    Layer.provideMerge(
      Layer.succeed(GitHubCredentials.GitHubCredentials, {
        get: (host) =>
          mockedCredential(host).pipe(
            Effect.map((held) => ({ source: "gh" as const, ...held, host })),
            Effect.mapError(() => new GitHubCredentials.GitHubCliMissingError({ host })),
          ),
        saved: () => Effect.succeedNone,
        fingerprint: (host, token) => Effect.succeed(`${host}:${token}`),
        invalidate: () => Effect.void,
      }),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(TestSourceControlHost.layer()),
    Layer.provide(NodeServices.layer),
  ),
);

function output(
  body: string,
  truncated = false,
  invalidUtf8 = false,
  headers: Readonly<Record<string, string>> = {},
  status = 200,
): GitHubRest.GitHubRestResponse {
  return { status, headers, body, truncated, invalidUtf8 };
}

function graphqlQuota(remaining: number, resetAt = "2099-08-13T14:00:00Z") {
  return {
    "x-ratelimit-resource": "graphql",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(Date.parse(resetAt) / 1000),
  };
}

const rowDefaults = {
  author: null,
  state: "OPEN",
  isDraft: false,
  mergeable: "UNKNOWN",
  reviewDecision: null,
  latestReviews: { nodes: [] },
  mergedAt: null,
  reviewRequests: { nodes: [] },
  labels: { nodes: [] },
  commits: { nodes: [] },
};

const lastPage = { hasNextPage: false, endCursor: null };

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
      ...rowDefaults,
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
              nodes: reviewRequests.map((requestedReviewer) => ({
                requestedReviewer: {
                  __typename: "slug" in requestedReviewer ? "Team" : "User",
                  ...requestedReviewer,
                },
              })),
            },
          }),
      ...(checks === undefined
        ? {}
        : { commits: { nodes: [{ commit: { statusCheckRollup: { state: checks } } }] } }),
      ...rest,
    };
  });
}

function pullRequests(
  count: number,
  firstNumber: number,
  overrides?: (number: number) => Readonly<Record<string, unknown>>,
): string {
  return encodeJson({
    data: {
      search: { pageInfo: lastPage, nodes: rows(count, firstNumber, overrides) },
    },
  });
}

function listedPullRequests(
  count: number,
  firstNumber: number,
  overrides?: (number: number) => Readonly<Record<string, unknown>>,
): string {
  return encodeJson({
    data: {
      repository: {
        pullRequests: {
          pageInfo: lastPage,
          nodes: rows(count, firstNumber, overrides),
        },
      },
    },
  });
}

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

function threadComments(
  ids: ReadonlyArray<string>,
  endCursor: string | null,
  totalCount = ids.length,
) {
  return {
    totalCount,
    pageInfo: { hasNextPage: endCursor !== null, endCursor },
    nodes: ids.map((id) => ({
      id,
      author: null,
      body: id,
      createdAt: "2026-07-01T00:00:00Z",
      lastEditedAt: null,
      url: `https://github.com/acme/web/pull/7#discussion_${id}`,
      reactionGroups: [],
    })),
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
  requestedReviewers: ReadonlyArray<Record<string, unknown>> = [],
): string {
  return encodeJson({
    data: {
      viewer: { login: "viewer" },
      repository: {
        pullRequest: {
          reviewThreads: {
            totalCount: nodes.length,
            pageInfo: { hasNextPage: endCursor !== null, endCursor },
            nodes,
          },
          viewerCanUpdate: true,
          viewerDidAuthor: false,
          author: null,
          reactionGroups: [],
          comments: { nodes: [] },
          reviews: { nodes: [] },
          reviewRequests: {
            nodes: requestedReviewers.map((requestedReviewer) => ({ requestedReviewer })),
          },
          latestReviews: { nodes: [] },
          reviewDismissals: { pageInfo: lastPage, nodes: [] },
          commits: { nodes: [] },
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
      viewer: { login: "viewer" },
      repository: { pullRequest: { id: "PR_7" } },
      node: {
        __typename: "PullRequestReviewThread",
        pullRequest: { id: pullRequestId },
        comments: threadComments(ids, endCursor, totalCount),
      },
    },
  });
}

const diffRefused = new GitHubRequestPolicy.GitHubApiResponseError({
  host: "github.com",
  operation: "getPullRequestDiff",
  status: 406,
});

function callAt(index: number): ApiCall {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

function varsAt(index: number): Readonly<Record<string, unknown>> {
  const call = callAt(index);
  assert.strictEqual(call.kind, "graphql");
  return call.kind === "graphql" ? (call.variables ?? {}) : {};
}

function queryAt(index: number): string {
  const call = callAt(index);
  return call.kind === "graphql" ? call.query : "";
}

function pathAt(index: number): string {
  const call = callAt(index);
  return call.kind === "rest" ? call.path : "";
}

function searchOfCall(index: number): string | undefined {
  const q = callAt(index).kind === "graphql" ? varsAt(index)["q"] : undefined;
  return typeof q === "string" ? q : undefined;
}

function searchItem(number: number, repository: string, updatedAt: string) {
  return {
    ...rowDefaults,
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/${repository}/pull/${number}`,
    author: {
      __typename: "User",
      login: "octocat",
      avatarUrl: "https://avatars/octocat",
      name: null,
    },
    headRefName: "feat/page",
    baseRefName: "main",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    repository: { nameWithOwner: repository },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "hubot" } }] },
    labels: { nodes: [{ name: "bug", color: "ff0000" }] },
  };
}

function searchPage(nodes: ReadonlyArray<unknown>, hasNextPage = false) {
  return output(
    encodeJson({
      data: {
        search: { pageInfo: { hasNextPage, endCursor: hasNextPage ? "next" : null }, nodes },
      },
    }),
  );
}

const searchQueryOfCall = searchOfCall;

function matches(call: ApiCall, needle: string): boolean {
  return call.kind === "graphql"
    ? call.operationName === needle || call.query.includes(needle)
    : call.path.includes(needle);
}

function route(...routes: ReadonlyArray<readonly [needle: string, body: unknown]>): void {
  mockedExecute.mockImplementation((call) => {
    const match = routes.find(([needle]) => matches(call, needle));
    return Effect.succeed(
      output(
        match !== undefined
          ? encodeJson(match[1])
          : call.kind === "graphql" && call.query.startsWith("mutation ")
            ? encodeJson(mutationAnswer(call.query))
            : "{}",
      ),
    );
  });
}

function mutationAnswer(query: string) {
  const root = /\)\{(\w+)(?:\(|\{|@)/.exec(query)?.[1];
  return { data: root === undefined ? {} : { [root]: null } };
}

function variablesOf(needle: string): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return mockedExecute.mock.calls.flatMap(([call]) =>
    call.kind === "graphql" && matches(call, needle) ? [call.variables ?? {}] : [],
  );
}

function restCallsTo(needle: string): ReadonlyArray<GitHubRest.GitHubRestInput> {
  return mockedExecute.mock.calls.flatMap(([call]) =>
    call.kind === "rest" && call.path.includes(needle) ? [call] : [],
  );
}

/** Route before the node-ID lookup, whose document is contained in this scope query. */
const SUBJECT_SCOPE_QUERY = "PullRequestSubject";
const subjectScope = (subjectId: string, pullRequestId: string) => ({
  data: {
    repository: { pullRequest: { id: pullRequestId } },
    node: { __typename: "IssueComment", id: subjectId, pullRequest: { id: pullRequestId } },
  },
});

const checkRun = (fields: Record<string, unknown>) => ({
  __typename: "CheckRun",
  name: "",
  status: "COMPLETED",
  conclusion: null,
  startedAt: null,
  completedAt: null,
  detailsUrl: null,
  checkSuite: { workflowRun: null },
  ...fields,
});

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

const pullRequestRefs = encodeJson({ base: { sha: "a1b2c3d" }, head: { sha: "b1c2d3e" } });
const pullRequestMergeBase = encodeJson({ merge_base_commit: { sha: "c1d2e3f" } });

const crossRepositoryDetail = (headRefOid = "abc123") =>
  coreResponse({
    headRefName: "feat/page",
    headRefOid,
    isCrossRepository: true,
    headRepositoryOwner: { __typename: "User", login: "octocat" },
  });

const heads = (numbers: ReadonlyArray<number>) => ({
  data: {
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: numbers.map((number) => ({
          number,
          headRefOid: "abc123",
          isCrossRepository: true,
          headRepositoryOwner: { __typename: "User", login: "octocat" },
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
          : call.operationName === "PullRequestHeads"
            ? encodeJson(headsAnswer)
            : encodeJson(detail()),
      ),
    ),
  );
}

/** Node IDs stay cached after the first test. */
const NODE_ID_QUERY = "PullRequestNodeId";
const nodeIdAnswer = (id: string) => ({ data: { repository: { pullRequest: { id } } } });

afterEach(() => {
  mockedExecute.mockReset();
  mockedStackMemberships.mockReset();
  mockedCredential.mockReset();
  mockedAppToken.mockReset();
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
          saved: () => Effect.succeedNone,
          fingerprint: (host, token) => Effect.succeed(`${host}:${token}`),
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
              : {
                  data: {
                    repository: { pullRequest: { id: "PR_1" } },
                    addComment: { clientMutationId: null },
                  },
                };
            return HttpClientResponse.fromWeb(
              request,
              new Response(encodeJson(body), { headers: { "content-type": "application/json" } }),
            );
          }),
        ),
      );
      const cli = yield* GitHubPullRequestApi.make.pipe(
        Effect.provide(
          GitHubAppAccess.layer.pipe(
            Layer.provideMerge(GitHubRest.layer),
            Layer.provideMerge(Layer.mergeAll(credentials, http, appSignedOut)),
            Layer.provideMerge(GitHubQuota.layer),
            Layer.provideMerge(SourceControlRateLimit.layer),
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
  it.effect("turns maintainer edits off without rewriting the pull request's text", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          output(
            encodeJson(
              call.kind === "graphql" && matches(call, NODE_ID_QUERY) ? nodeIdAnswer("PR_7") : {},
            ),
          ),
        ),
      );
      const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* api.updatePullRequest({ ...pullRequestInput, maintainerCanModify: false });
      expect(variablesOf("mutation UpdatePullRequest")).toEqual([
        { pullRequestId: "PR_7", maintainerCanModify: false },
      ]);
    }),
  );

  it.effect.each(["mixed", "merges", "unavailable"] as const)(
    "reads stats only for displayed non-merge commits (%s)",
    (kind) =>
      Effect.gen(function* () {
        const oids = kind === "merges" ? ["merge"] : ["regular", "merge"];
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              encodeJson({
                data: {
                  repository: {
                    pullRequest: {
                      author: null,
                      comments: { nodes: [], pageInfo: lastPage },
                      reviews: { nodes: [], pageInfo: lastPage },
                      commits: {
                        nodes: oids.map((oid) => ({
                          commit: {
                            id: "node-" + oid,
                            oid,
                            messageHeadline: oid,
                            committedDate: "2026-07-05T00:00:00Z",
                            parents: { totalCount: oid === "merge" ? 2 : 1 },
                            authors: { nodes: [] },
                          },
                        })),
                      },
                    },
                  },
                },
              }),
            ),
          ),
        );
        if (kind === "unavailable") {
          mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}", false, false, {}, 503)));
        } else if (kind !== "merges") {
          mockedExecute.mockReturnValueOnce(
            Effect.succeed(
              output(
                encodeJson({
                  data: {
                    nodes: [{ __typename: "Commit", oid: "regular", additions: 18, deletions: 7 }],
                  },
                }),
              ),
            ),
          );
        }
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const activity = yield* cli.getPullRequestActivity(pullRequestInput);
        expect(activity.commits.map((commit) => commit.oid)).toEqual(oids);
        expect(activity.commits.find((commit) => commit.oid === "merge")).not.toHaveProperty(
          "additions",
        );
        expect(activity.commits.find((commit) => commit.oid === "merge")).not.toHaveProperty(
          "deletions",
        );
        if (kind === "mixed") {
          expect(activity.commits[0]).toMatchObject({ additions: 18, deletions: 7 });
        } else if (kind === "unavailable") {
          expect(activity.commits[0]).not.toHaveProperty("additions");
        }
        expect(variablesOf("PullRequestCommitStats")).toEqual(
          kind === "merges" ? [] : [{ ids: ["node-regular"] }],
        );
        expect(mockedExecute).toHaveBeenCalledTimes(kind === "merges" ? 1 : 2);
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
                      __typename: "User",
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
        author: {
          __typename: "User",
          login: "octocat",
          name: "Octo Cat",
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
        },
        baseRefName: "main",
        headRefName: `feat/${number}`,
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        reviewDecision: null,
        latestReviews: {
          nodes: [{ state: "APPROVED", author: { __typename: "User", login: "reviewer" } }],
        },
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
              data: {
                _0_repository: { pullRequest: node(7) },
                _1_repository: { pullRequest: node(8) },
              },
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
        "_0_repository:repository(owner:$_0_owner name:$_0_name){pullRequest(number:$_0_number)",
      );
      expect(varsAt(0)).toMatchObject({
        _0_owner: "acme",
        _0_name: "web",
        _0_number: 7,
        _0_stacks: true,
        _1_number: 8,
      });
    }),
  );

  it.effect(
    "fails only the pull request GitHub cannot find, and answers the rest of its batch",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              encodeJson({
                data: {
                  _0_repository: { pullRequest: null },
                  _1_repository: {
                    pullRequest: {
                      number: 8,
                      title: "Still here",
                      url: "https://github.com/acme/web/pull/8",
                      author: null,
                      baseRefName: "main",
                      headRefName: "feat/eight",
                      state: "OPEN",
                      isDraft: false,
                      mergeable: "MERGEABLE",
                      reviewDecision: null,
                      latestReviews: { nodes: [] },
                      additions: 1,
                      deletions: 1,
                      changedFiles: 1,
                      updatedAt: "2026-08-24T12:34:56.000Z",
                      mergedAt: null,
                      closedAt: null,
                      commits: { nodes: [] },
                      stack: null,
                      stackEntry: null,
                    },
                  },
                },
                errors: [
                  {
                    type: "NOT_FOUND",
                    path: ["_0_repository", "pullRequest"],
                    message: "Could not resolve to a PullRequest with the number of 7.",
                  },
                ],
              }),
            ),
          ),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

        const reads = yield* Effect.forEach(
          [7, 8],
          (number) =>
            cli
              .getPullRequestSummary({
                cwd: "/w",
                repository: "acme/web",
                host: "github.com",
                number,
              })
              .pipe(Effect.result),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 millis");
        const [seven, eight] = yield* Fiber.join(reads);

        expect(Result.isFailure(seven!) ? seven.failure._tag : null).toBe("GitHubApiNotFoundError");
        expect(Result.isSuccess(eight!) ? eight.success.headBranch : null).toBe("feat/eight");
        expect(mockedExecute).toHaveBeenCalledOnce();
        expect(callAt(0)).toMatchObject({ kind: "graphql", partial: true });
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

  it.effect("revalidates a polled stack, per credential, so an unchanged one costs no quota", () =>
    Effect.gen(function* () {
      const listing = encodeJson([
        {
          number: 4,
          url: "https://api.github.com/repos/acme/poll/stacks/4",
          base: { ref: "main" },
          pull_requests: [
            { number: 9, head: { ref: "feat/nine" }, state: "open", merged_at: null },
          ],
        },
      ]);
      const read = Effect.flatMap(GitHubPullRequestApi.GitHubPullRequestApi, (cli) =>
        cli.getPullRequestStack({
          cwd: "/w",
          repository: "acme/poll",
          host: "github.com",
          number: 9,
        }),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listing, false, false, { etag: 'W/"v1"' })),
      );
      const first = yield* read;
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("", false, false, {}, 304)));
      const second = yield* read;
      mockedCredential.mockImplementationOnce(() =>
        Effect.succeed({ token: Redacted.make("other"), fingerprint: "github.com:other" }),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(listing)));
      yield* read;

      assert.deepStrictEqual(second, first);
      expect(callAt(0)).not.toHaveProperty("ifNoneMatch");
      expect(callAt(1)).toMatchObject({ ifNoneMatch: 'W/"v1"' });
      // Another account never revalidates the first account's answer.
      expect(callAt(2)).not.toHaveProperty("ifNoneMatch");
    }),
  );

  it.effect("reads a host that refuses the stacks preview as not stacked", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.fail(
          new GitHubRequestPolicy.GitHubApiNotFoundError({
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
          new GitHubRequestPolicy.GitHubApiAuthenticationError({
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
      const failure = new GitHubRequestPolicy.GitHubApiResponseError({
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

  /**
   * Lists a repository GitHub will not return, answering credential lookups in turn (the last
   * answer repeats; `undefined` is no credential), and returns the error with the tokens sent.
   */
  const listUnreadableRepository = (
    ...lookups: ReadonlyArray<
      | { readonly token: string; readonly source: GitHubCredentials.GitHubCredentialSource }
      | undefined
    >
  ) => {
    mockedExecute.mockClear();
    let lookup = 0;
    mockedCredential.mockImplementation((host) =>
      Effect.suspend(() => {
        const held = lookups[Math.min(lookup++, lookups.length - 1)];
        return held === undefined
          ? Effect.fail(
              new GitHubRequestPolicy.GitHubApiAuthenticationError({
                host,
                operation: "credential",
              }),
            )
          : Effect.succeed({
              token: Redacted.make(held.token),
              fingerprint: `${host}:${held.token}`,
              source: held.source,
            });
      }),
    );
    route(
      ["PullRequestSearch", { data: { search: { pageInfo: lastPage, nodes: [] } } }],
      [
        "PullRequestList",
        {
          data: { repository: null },
          errors: [
            {
              type: "NOT_FOUND",
              path: ["repository"],
              message: "Could not resolve to a Repository with the name 'acme/private'.",
            },
          ],
        },
      ],
    );
    return GitHubPullRequestProvider.make.pipe(
      Effect.flatMap((provider) =>
        Effect.flip(
          provider.listChangeRequests({
            cwd: "/w",
            repository: "acme/private",
            host: "github.com",
            state: "open",
            involvement: "all",
            viewer: "bilal",
            limit: 10,
          }),
        ),
      ),
      Effect.map((error) => ({
        error,
        sentWith: mockedExecute.mock.calls.map(([call]) =>
          call.kind === "graphql" ? call.authorization : undefined,
        ),
      })),
    );
  };

  it.effect("names the credential GitHub would not return a repository to", () =>
    Effect.gen(function* () {
      // The saved token is replaced mid-read; every request still goes out with the one named.
      const saved = yield* listUnreadableRepository(
        { token: "first", source: "settings" },
        { token: "replaced", source: "settings" },
      );
      expect(saved.error.accessHint).toContain("saved GitHub token");
      assert.isAbove(saved.sentWith.length, 1);
      for (const authorization of saved.sentWith) expect(authorization).toContain("first");

      // The policy hands what the app cannot see to the gh login, which GitHub refuses too.
      mockedAppToken.mockReturnValue(Effect.succeedSome("app"));
      const app = { token: "app", source: "app" } as const;
      const gh = { token: "personal", source: "gh" } as const;
      const retried = yield* listUnreadableRepository(app, gh);
      expect(retried.error.accessHint).toContain("gh login");
      expect(retried.sentWith).toEqual(["Bearer app", "Bearer app", "Bearer personal"]);

      // With no gh login when the app is refused, the app made the last request; a login that
      // turns up afterwards is not named.
      const appOnly = yield* listUnreadableRepository(app, undefined, gh);
      assert.isUndefined(appOnly.error.accessHint);
      expect(appOnly.sentWith).toEqual(["Bearer app", "Bearer app"]);
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

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      assert.strictEqual(
        searchQueryOfCall(0),
        'is:pr is:closed is:unmerged review-requested:bilal "pull requests page" ' +
          "updated:<=2026-07-02T00:00:00Z sort:updated-desc repo:acme/web repo:pingdotgg/t3code",
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

      assert.strictEqual(overflowing.items.length, 2);
      assert.isTrue(overflowing.truncated);
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
                _0_repository: {
                  pullRequest: {
                    stack: { number: 3, size: 2, baseRefName: "main" },
                    stackEntry: { position: 1 },
                  },
                },
                _1_repository: { pullRequest: { stack: null, stackEntry: null } },
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
              new GitHubRequestPolicy.GitHubApiResponseError({
                host: "github.com",
                operation: "listPullRequestStackMemberships",
                status: 502,
              }),
            )
          : Effect.succeed(
              output(
                encodeJson({
                  data: Object.fromEntries(
                    Object.keys(input.kind === "graphql" ? (input.variables ?? {}) : {})
                      .filter((name) => name.endsWith("_number"))
                      .map((name, index) => [
                        name.replace(/number$/, "repository"),
                        {
                          pullRequest:
                            index === 0
                              ? {
                                  stack: { number: 3, size: 2, baseRefName: "main" },
                                  stackEntry: { position: 1 },
                                }
                              : { stack: null, stackEntry: null },
                        },
                      ]),
                  ),
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

  it.effect("reads the line counts in chunks, and files them back by position", () =>
    Effect.gen(function* () {
      const changeRequests = Array.from({ length: 26 }, (_, index) => ({
        repository: "acme/web",
        number: index + 1,
      }));
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          output(
            encodeJson({
              data: Object.fromEntries(
                Object.keys(call.kind === "graphql" ? (call.variables ?? {}) : {})
                  .filter((name) => name.endsWith("_number"))
                  .map((name, index) => [
                    name.replace(/number$/, "repository"),
                    { pullRequest: index === 0 ? { additions: 4, deletions: 1 } : null },
                  ]),
              ),
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const stats = yield* cli.listPullRequestStats({
        cwd: "/w",
        host: "github.com",
        changeRequests,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      assert.deepStrictEqual(stats, [
        { repository: "acme/web", number: 1, additions: 4, deletions: 1 },
        { repository: "acme/web", number: 26, additions: 4, deletions: 1 },
      ]);
      expect(queryAt(0)).toContain("_0_repository:repository(owner:$_0_owner name:$_0_name)");
      expect(varsAt(0)).toMatchObject({ _0_owner: "acme", _0_name: "web", _24_number: 25 });
    }),
  );

  it.effect("carries the further narrowings into the search as qualifiers", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName === "PullRequestList"
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
          call.kind === "graphql" && call.operationName === "PullRequestList"
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
          call.kind === "graphql" && call.operationName === "PullRequestList"
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

      assert.deepStrictEqual(batch.items, []);
    }),
  );

  it.effect("escapes a backslash before the quote it would otherwise let out", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName === "PullRequestList"
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

      expect(searchOfCall(0)).toBe(
        String.raw`is:pr is:open "a\\\" is:merged" sort:updated-desc repo:acme/web`,
      );
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

      expect(searchOfCall(0)).toBe(
        "is:pr is:open updated:<=2026-07-02T00:00:00Z sort:updated-desc repo:acme/web",
      );
      assert.isTrue(batch.continues);
    }),
  );

  it.effect("answers a search that found nothing with nothing, not with the whole repository", () =>
    Effect.gen(function* () {
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
      expect(varsAt(1)["first"]).toBe(3);
      expect(varsAt(2)["first"]).toBe(6);
      assert.isFalse(batch.truncated);
    }),
  );

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

  it.effect.each([
    {
      description: "base-only write",
      basePermission: "WRITE",
      sourcePermission: "READ",
      headRef: { id: "REF" },
      expected: false,
      actionAllowed: false,
    },
    {
      description: "source-only write",
      basePermission: "READ",
      sourcePermission: "WRITE",
      headRef: { id: "REF" },
      expected: true,
      actionAllowed: true,
    },
    {
      description: "a deleted branch",
      basePermission: "READ",
      sourcePermission: "WRITE",
      headRef: null,
      expected: false,
      actionAllowed: true,
    },
    {
      description: "an unavailable source repository",
      basePermission: "WRITE",
      sourcePermission: null,
      headRef: { id: "REF" },
      expected: false,
      actionAllowed: false,
    },
  ])(
    "uses source branch access in both permission reads for $description",
    ({ basePermission, sourcePermission, headRef, expected, actionAllowed }) =>
      Effect.gen(function* () {
        const answer = coreResponse({
          headRepository:
            sourcePermission === null
              ? null
              : { nameWithOwner: "acme/web", viewerPermission: sourcePermission },
          headRef,
        });
        answer.data.repository.viewerPermission = basePermission;
        mockedExecute.mockReturnValue(Effect.succeed(output(encodeJson(answer))));
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const input = { cwd: "/w", repository: "acme/web", host: "github.com", number: 7 };
        expect((yield* cli.getViewerAccess(input)).canDeleteBranch).toBe(actionAllowed);
        expect((yield* cli.getPullRequestDetail(input)).viewerAccess.canDeleteBranch).toBe(
          expected,
        );
        expect(variablesOf("ViewerPermissions")).toHaveLength(1);
        expect(variablesOf("PullRequestCore")).toHaveLength(1);
      }),
  );

  it.effect("preserves the actual source fork name in provider detail", () =>
    Effect.gen(function* () {
      const answer = coreResponse({
        state: "MERGED",
        isCrossRepository: true,
        headRepository: { nameWithOwner: "contributor/web-fork", viewerPermission: "WRITE" },
        headRef: { id: "REF" },
      });
      mockedExecute.mockReturnValue(Effect.succeed(output(encodeJson(answer))));
      const provider = yield* GitHubPullRequestProvider.make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });
      expect(detail.headRepositoryNameWithOwner).toBe("contributor/web-fork");
      expect(detail.viewerPermissions.actions).toContain("delete-branch");
      expect(queryAt(0)).toContain("headRepository{nameWithOwner viewerPermission}");
    }),
  );

  const branchToDelete = (pullRequest: Readonly<Record<string, unknown>> = {}) => ({
    data: {
      repository: {
        pullRequest: {
          state: "MERGED",
          headRefName: "feat/delete",
          baseRefName: "main",
          headRefOid: "abc123",
          headRepository: { id: "FORK_REPO" },
          ...pullRequest,
        },
      },
    },
  });
  const sourceBranch = (repository: Readonly<Record<string, unknown>> = {}) => ({
    data: {
      node: {
        __typename: "Repository",
        defaultBranchRef: { name: "main" },
        ref: { target: { __typename: "Commit", oid: "abc123" } },
        ...repository,
      },
    },
  });

  it.effect.each(["MERGED", "CLOSED"])("deletes the exact remote fork branch of a %s PR", (state) =>
    Effect.gen(function* () {
      route(
        ["PullRequestBranchToDelete", branchToDelete({ state })],
        ["PullRequestSourceBranch", sourceBranch()],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.enterprise.test",
        number: 7,
        action: "delete-branch",
      });
      expect(variablesOf("PullRequestBranchToDelete")).toEqual([
        { owner: "acme", name: "web", number: 7 },
      ]);
      expect(variablesOf("PullRequestSourceBranch")).toEqual([
        { repositoryId: "FORK_REPO", ref: "refs/heads/feat/delete" },
      ]);
      expect(variablesOf("updateRefs(")).toEqual([
        {
          input: {
            repositoryId: "FORK_REPO",
            refUpdates: [
              {
                name: "refs/heads/feat/delete",
                beforeOid: "abc123",
                afterOid: "0000000000000000000000000000000000000000",
              },
            ],
          },
        },
      ]);
      expect(mockedExecute.mock.calls.at(-1)?.[0].host).toBe("github.enterprise.test");
      expect(variablesOf("mergePullRequest(")).toEqual([]);
      expect(variablesOf("closePullRequest(")).toEqual([]);
    }),
  );

  it.effect.each([
    { description: "an open PR", head: { state: "OPEN" }, source: {} },
    { description: "the base branch", head: { headRefName: "main" }, source: {} },
    {
      description: "the default branch",
      head: {},
      source: { defaultBranchRef: { name: "feat/delete" } },
    },
    {
      description: "a changed branch",
      head: {},
      source: { ref: { target: { __typename: "Commit", oid: "new-commit" } } },
    },
  ])("refuses to delete $description", ({ head, source }) =>
    Effect.gen(function* () {
      route(
        ["PullRequestBranchToDelete", branchToDelete(head)],
        [
          "PullRequestSourceBranch",
          source === null ? { data: { node: null } } : sourceBranch(source),
        ],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const error = yield* Effect.flip(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "delete-branch",
        }),
      );
      expect(error._tag).toBe("GitHubBranchDeletionRefusedError");
      expect(variablesOf("updateRefs(")).toEqual([]);
    }),
  );

  it.effect("accepts an already deleted source branch", () =>
    Effect.gen(function* () {
      route(
        ["PullRequestBranchToDelete", branchToDelete()],
        ["PullRequestSourceBranch", sourceBranch({ ref: null })],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "delete-branch",
      });
      expect(variablesOf("updateRefs(")).toEqual([]);
    }),
  );

  it.effect("keeps the source branch when GitHub refuses deletion", () =>
    Effect.gen(function* () {
      route(
        ["PullRequestBranchToDelete", branchToDelete()],
        ["PullRequestSourceBranch", sourceBranch()],
      );
      const answer = mockedExecute.getMockImplementation()!;
      mockedExecute.mockImplementation((call) =>
        call.kind === "graphql" && call.query.includes("updateRefs(")
          ? Effect.fail(
              new GitHubRequestPolicy.GitHubApiResponseError({
                host: call.host,
                operation: call.operation,
                status: 422,
              }),
            )
          : answer(call),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const error = yield* Effect.flip(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "delete-branch",
        }),
      );
      expect(error._tag).toBe("GitHubApiResponseError");
      expect(variablesOf("mergePullRequest(")).toEqual([]);
      expect(variablesOf("closePullRequest(")).toEqual([]);
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
                headRepositoryOwner: { __typename: "Organization", login: "acme" },
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

      expect(variablesOf("PullRequestHeads")[0]).toEqual({
        owner: "acme",
        name: "web",
        head: "feat/page",
      });
      expect(restCallsTo("actions/runs?")[0]?.path).toBe(
        "repos/acme/web/actions/runs?head_sha=abc123&branch=feat%2Fpage&event=pull_request&status=action_required&per_page=100&page=1",
      );
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
          call.kind === "graphql" && call.operationName === "PullRequestList"
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

      assert.isAbove(mockedExecute.mock.calls.length, 0);
      expect(new Set(mockedExecute.mock.calls.map(([call]) => call.host))).toEqual(
        new Set(["github.acme.dev"]),
      );
      expect(searchOfCall(0)).toContain("repo:acme/web");
    }),
  );

  it.effect("reads one files page when GitHub refuses the diff, and says it is the last", () =>
    Effect.gen(function* () {
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

      assert.isFalse(diff.truncated);
      assert.isNotNull(diff.nextCursor);
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
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

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      assert.isNull(diff.nextCursor);
      expect(diff.patch).toContain("diff --git a/src/file1.ts b/src/file1.ts");
      assert.strictEqual(
        pathAt(0),
        "repos/acme/web/commits/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0?per_page=100&page=1",
      );
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

  it.effect("expands a pull request file from its merge base, not the moved base tip", () =>
    Effect.gen(function* () {
      const answers: Record<string, string> = {
        "repos/acme/web/pulls/7": pullRequestRefs,
        "repos/acme/web/compare/a1b2c3d...b1c2d3e?per_page=1&page=2": pullRequestMergeBase,
        "repos/acme/web/contents/src/a.ts?ref=a1b2c3d": "base tip\n",
        "repos/acme/web/contents/src/a.ts?ref=c1d2e3f": "merge base\n",
        "repos/acme/web/contents/src/a.ts?ref=b1c2d3e": "head\n",
      };
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(output(call.kind === "rest" ? (answers[call.path] ?? "") : "")),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const contents = yield* cli.getPullRequestDiffFileContents({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        changeType: "change",
        oldPath: "src/a.ts",
        newPath: "src/a.ts",
      });

      expect(contents).toEqual({ oldContents: "merge base\n", newContents: "head\n" });
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

  it.effect("reports undecodable diff file contents as binary", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestRefs)));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestMergeBase)));
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
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestMergeBase)));
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

  it.effect("verifies a REST-forbidden account through GraphQL with the pinned credential", () =>
    Effect.gen(function* () {
      const input = { cwd: "/w", host: "github.identity-fallback.test" };
      const original = {
        token: Redacted.make("original-token"),
        fingerprint: `${input.host}:original`,
      };
      mockedCredential.mockReturnValue(Effect.succeed(original));
      mockedExecute.mockImplementation((call) =>
        Effect.gen(function* () {
          expect(yield* SourceControlRateLimit.CredentialScope).toBe(original.fingerprint);
          if (call.kind === "rest") {
            expect(call.path).toBe("user");
            expect(yield* GitHubRequestPolicy.PinnedGitHubCredential).toMatchObject({
              host: input.host,
              credentialFingerprint: original.fingerprint,
            });
            mockedCredential.mockReturnValue(
              Effect.succeed({
                token: Redacted.make("replacement-token"),
                fingerprint: `${input.host}:replacement`,
              }),
            );
            return yield* new GitHubRequestPolicy.GitHubApiResponseError({
              host: input.host,
              operation: "getRoutingIdentity",
              status: 403,
              githubErrors: ["Resource not accessible by integration"],
            });
          }
          expect(call.host).toBe(input.host);
          expect(call.authorization).toBe("Bearer original-token");
          expect(call.query).toMatch(/viewer\s*\{/);
          expect(call.query).toContain("databaseId");
          expect(call.query).toContain("login");
          return output(
            '{"data":{"viewer":{"databaseId":789,"login":"acme-app[bot]"}}}',
            false,
            false,
            graphqlQuota(0),
          );
        }),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const quota = yield* GitHubQuota.GitHubQuota;
      yield* quota
        .observe(input.host, graphqlQuota(1))
        .pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, original.fingerprint));
      const identity = { accountId: "789", viewer: "acme-app[bot]" };
      expect(yield* cli.getRoutingIdentity(input)).toEqual(identity);

      mockedCredential.mockReturnValue(Effect.succeed(original));
      expect(yield* cli.getRoutingIdentity(input)).toEqual(identity);
      expect(mockedExecute).toHaveBeenCalledTimes(2);

      const exhausted = yield* quota
        .admit(input.host, "graphql")
        .pipe(
          Effect.provideService(SourceControlRateLimit.CredentialScope, original.fingerprint),
          Effect.flip,
        );
      expect(exhausted._tag).toBe("SourceControlRateLimitPausedError");
      yield* quota
        .admit(input.host, "graphql")
        .pipe(
          Effect.provideService(
            SourceControlRateLimit.CredentialScope,
            `${input.host}:replacement`,
          ),
        );
    }),
  );

  it.effect("rejects a null GraphQL account id without caching it", () =>
    Effect.gen(function* () {
      const input = { cwd: "/w", host: "github.identity-null.test" };
      const forbidden = new GitHubRequestPolicy.GitHubApiResponseError({
        host: input.host,
        operation: "getRoutingIdentity",
        status: 403,
      });
      mockedExecute
        .mockReturnValueOnce(Effect.fail(forbidden))
        .mockReturnValueOnce(
          Effect.succeed(output('{"data":{"viewer":{"databaseId":null,"login":"acme-app[bot]"}}}')),
        )
        .mockReturnValueOnce(Effect.fail(forbidden))
        .mockReturnValueOnce(
          Effect.succeed(output('{"data":{"viewer":{"databaseId":789,"login":"acme-app[bot]"}}}')),
        );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const error = yield* cli.getRoutingIdentity(input).pipe(Effect.flip);
      expect(error._tag).toBe("GitHubViewerLoginUnavailableError");
      expect(yield* cli.getRoutingIdentity(input)).toEqual({
        accountId: "789",
        viewer: "acme-app[bot]",
      });
      expect(mockedExecute).toHaveBeenCalledTimes(4);
    }),
  );

  // regression: #18780 credentials that cannot read /user still load pull requests
  it.effect.each([
    new GitHubRequestPolicy.GitHubApiAuthenticationError({
      host: "github.identity-auth-error.test",
      operation: "getRoutingIdentity",
    }),
    new GitHubRequestPolicy.GitHubApiResponseError({
      host: "github.identity-server-error.test",
      operation: "getRoutingIdentity",
      status: 500,
    }),
  ])("preserves $_tag from REST identity verification without trying GraphQL", (error) =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.fail(error));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      expect(yield* cli.getRoutingIdentity({ cwd: "/w", host: error.host }).pipe(Effect.flip)).toBe(
        error,
      );
      expect(mockedExecute).toHaveBeenCalledTimes(1);
      expect(callAt(0)).toMatchObject({ kind: "rest", path: "user" });
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

      expect(yield* cli.getRoutingIdentity(input)).toEqual({
        accountId: "123",
        viewer: "maria-rcks",
      });
      expect(mockedExecute).toHaveBeenCalledTimes(1);

      mockedCredential.mockImplementation((host) =>
        Effect.succeed({ token: Redacted.make("test-credential-b"), fingerprint: `${host}:b` }),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.fail(
          new GitHubRequestPolicy.GitHubApiResponseError({
            host: "github.com",
            operation: "getRoutingIdentity",
            status: 502,
          }),
        ),
      );
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
                node: {
                  __typename: "IssueComment",
                  id: "IC_99",
                  pullRequest: { id: "PR_someOtherOne" },
                },
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
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  // regression: #19564 only a refused reviewer path is retried; other failures surface as-is
  it.effect.each([
    {
      name: "check path",
      errors: [
        {
          ...refusedReviewer,
          path: ["repository", "pullRequest", "commits", "nodes", 0, "commit", "statusCheckRollup"],
        },
      ],
    },
    { name: "HTTP 403", errors: [refusedReviewer], status: 403 },
    {
      name: "GraphQL rate limit",
      errors: [refusedReviewer, { message: "API rate limit exceeded", type: "RATE_LIMITED" }],
      tag: "GitHubApiRateLimitError",
    },
  ])("does not retry a reviewer refusal with $name", ({ name, errors, status = 200, tag }) =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson(status === 401 ? { message: "Bad credentials" } : { data: null, errors }),
            false,
            false,
            {},
            status,
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const reads: ReadonlyArray<PullRequestRead> = [
        cli.getPullRequestDetail,
        cli.listReviewThreadComments,
      ];
      for (const [index, read] of reads.entries()) {
        const error = yield* read({
          ...pullRequestInput,
          host: `github-${name.replaceAll(" ", "-")}-${index}.test`,
        }).pipe(Effect.asVoid, Effect.flip);
        expect(error._tag).toBe(tag ?? "GitHubApiResponseError");
        if (error._tag === "GitHubApiResponseError")
          expect(error).toMatchObject({ status, githubErrors: errors.map((e) => e.message) });
        expect(mockedExecute).toHaveBeenCalledTimes(index + 1);
      }
    }),
  );

  it.effect.each([false, true])(
    "keeps thread cursors and reviewers after a refusal (later page: %s)",
    (later) =>
      Effect.gen(function* () {
        if (later)
          mockedExecute.mockReturnValueOnce(
            Effect.succeed(
              output(
                reviewThreadsPage([thread("T1", "c1")], "next", [
                  {
                    __typename: "User",
                    login: "prior",
                    name: null,
                    avatarUrl: "https://avatars/prior",
                  },
                ]),
              ),
            ),
          );
        mockedExecute.mockReturnValueOnce(refusedReviewerResponse());
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(output(reviewThreadsPage([thread("T2", "c2")], "last"))),
        );
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(output(reviewThreadsPage([thread("T3", "c3")], null))),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const read = cli.listReviewThreadComments(pullRequestInput);
        const conversation = yield* read;
        expect(
          variablesOf("ReviewThreads").map((v) => [v["after"], v["requestedReviewers"]]),
        ).toEqual(
          later
            ? [
                [null, 50],
                ["next", 50],
                ["next", 0],
                ["last", 0],
              ]
            : [
                [null, 50],
                [null, 0],
                ["last", 0],
              ],
        );
        expect(conversation.comments.map((c) => c.id)).toEqual(
          later ? ["c1", "c2", "c3"] : ["c2", "c3"],
        );
        expect(conversation.reviewers.map((r) => r.login)).toEqual(later ? ["prior"] : []);
        expect(conversation.truncated).toBe(false);

        mockedExecute.mockReturnValueOnce(Effect.succeed(output(reviewThreadsPage([], null))));
        yield* read;
        expect(variablesOf("ReviewThreads").at(-1)).toMatchObject({
          after: null,
          requestedReviewers: 50,
        });
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
                    { requestedReviewer: { __typename: "User", login: "reviewer", name: null } },
                    {
                      requestedReviewer: {
                        __typename: "Team",
                        slug: "maintainers",
                        combinedSlug: "octo/maintainers",
                        teamName: "Maintainers",
                        teamAvatarUrl: "https://avatars.githubusercontent.com/t/1",
                      },
                    },
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
                              checkRun({
                                name: "build",
                                status: "COMPLETED",
                                conclusion: "SUCCESS",
                                checkSuite: { workflowRun: { workflow: { name: "linux" } } },
                              }),
                              checkRun({
                                name: "build",
                                status: "COMPLETED",
                                conclusion: "FAILURE",
                                checkSuite: { workflowRun: { workflow: { name: "windows" } } },
                              }),
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
      expect(detail.reviewRequestTeams).toEqual([
        {
          login: "octo/maintainers",
          name: "Maintainers",
          avatarUrl: "https://avatars.githubusercontent.com/t/1",
        },
      ]);
      expect(detail.labels).toEqual([{ name: "bug", color: "ff0000" }]);
      expect(detail.checks).toHaveLength(2);
      expect(detail.checksState).toBe("failing");
    }),
  );

  it.effect.each([false, true])(
    "reads every check when the combined response has another page (reviewer refusal: %s)",
    (refused) =>
      Effect.gen(function* () {
        if (refused) mockedExecute.mockReturnValueOnce(refusedReviewerResponse());
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
                              nodes: [
                                checkRun({
                                  name: "first",
                                  status: "COMPLETED",
                                  conclusion: "SUCCESS",
                                }),
                              ],
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
                  checkRun({ name: "first", status: "COMPLETED", conclusion: "SUCCESS" }),
                  checkRun({ name: "last", status: "COMPLETED", conclusion: "FAILURE" }),
                ],
                null,
              ),
            ),
          ),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const read = cli.getPullRequestDetail(pullRequestInput);
        const detail = yield* read;
        expect(detail.reviewRequestLogins).toEqual([]);
        expect(detail.reviewRequestTeams).toEqual([]);
        expect(detail.hasTeamReviewRequest).toBe(false);
        if (refused)
          expect(variablesOf("PullRequestCore").map((v) => v["requestedReviewers"])).toEqual([
            100, 0,
          ]);
        expect(detail.checks).toHaveLength(2);
        expect(detail.checksState).toBe("failing");
        expect(detail.checksTruncated).toBe(false);
        // The whole rollup is walked from its start, so no check is counted twice or skipped.
        expect(variablesOf("CheckContexts")).toEqual([expect.objectContaining({ number: 7 })]);
        expect(variablesOf("CheckContexts")[0]).not.toHaveProperty("after");
        expect(mockedExecute).toHaveBeenCalledTimes(refused ? 3 : 2);

        if (refused) {
          mockedExecute.mockReturnValueOnce(Effect.succeed(output(encodeJson(coreResponse()))));
          yield* read;
          expect(variablesOf("PullRequestCore").at(-1)).toMatchObject({ requestedReviewers: 100 });
        }
      }),
  );

  it.effect.each([false, true])(
    "refuses to combine checks from different head revisions (reviewer refusal: %s)",
    (refused) =>
      Effect.gen(function* () {
        if (refused) mockedExecute.mockReturnValueOnce(refusedReviewerResponse());
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
          Effect.succeed(output(checkContextsPage([], null, "new-head"))),
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

      assert.strictEqual(error, diffRefused);
    }),
  );

  it.effect("pages an oversized patch by file rather than handing back a severed one", () =>
    Effect.gen(function* () {
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

      expect(varsAt(0)["after"]).toBeNull();
      expect(varsAt(1)["after"]).toBe("Y3Vyc29yOjE");
      expect(conversation.comments.map((comment) => comment.id)).toEqual(["c1", "c2"]);
      assert.isFalse(conversation.truncated);
    }),
  );

  it.effect("stops at the thread bound and says the conversation was cut short", () =>
    Effect.gen(function* () {
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
        after: "Y3Vyc29yOjI",
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
                  autoMergeAllowed: true,
                  viewerPermission: "READ",
                  pullRequest: {
                    viewerCanUpdate: true,
                    viewerDidAuthor: true,
                    headRepository: null,
                  },
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
                    nodes: ["bilal", "octocat", "hubot"].map((login) => ({
                      login,
                      name: null,
                      avatarUrl: `https://avatars/${login}`,
                    })),
                  },
                  pullRequest: {
                    author: { __typename: "User", login: "bilal" },
                    reviewRequests: {
                      nodes: [
                        {
                          requestedReviewer: {
                            __typename: "User",
                            login: "octocat",
                            name: null,
                            avatarUrl: "https://avatars/octocat",
                          },
                        },
                      ],
                    },
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

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(varsAt(0)).toMatchObject({ owner: "acme", name: "web", number: 7 });
      expect(list.candidates.map((candidate) => [candidate.login, candidate.isRequested])).toEqual([
        ["octocat", true],
        ["hubot", false],
      ]);
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
      expect([varsAt(0)["after"], varsAt(1)["after"], varsAt(2)["after"]]).toEqual([
        undefined,
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

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      assert.isTrue(viewed.truncated);
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
      expect(varsAt(2)["_0_pullRequestId"]).toEqual("PR_25");
    }),
  );
  it.effect("keeps the pull request being ticked through, not the one looked up first", () =>
    Effect.gen(function* () {
      const HOT = 9_000;
      const lookupsOf = new Map<number, number>();
      mockedExecute.mockImplementation((input) => {
        if (input.kind !== "graphql" || input.operationName !== NODE_ID_QUERY) {
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
      for (let filled = 0; filled < GitHubPullRequestApi.NODE_ID_CACHE_CAPACITY; filled += 1) {
        yield* tick(HOT + 1 + filled);
        yield* tick(HOT);
      }

      assert.strictEqual(lookupsOf.get(HOT), 1);
    }),
  );
});

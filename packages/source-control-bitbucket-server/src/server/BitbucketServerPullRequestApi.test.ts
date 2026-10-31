import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { assert, describe, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as BitbucketServerApi from "./BitbucketServerApi.ts";
import * as BitbucketServerPullRequestApi from "./BitbucketServerPullRequestApi.ts";

const HOST = "https://bitbucket.example.com/bitbucket";
const API = `${HOST}/rest/api/1.0`;
const REPO = `${API}/projects/~JDOE/repos/testing-repo`;
const PR_URL =
  "https://bitbucket.example.com/bitbucket/users/jdoe/repos/testing-repo/pull-requests/2";

/** Captured from a Data Center 9.4 host, with the hostname scrubbed. */
const tokenUser = {
  name: "access-token-user/2/11754",
  active: true,
  displayName: "Access Token User - Doe, Jane testing-repo",
  id: 59666,
  slug: "access-token-user_2_11754",
  type: "SERVICE",
};
const jdoe = { name: "jdoe", displayName: "Doe, Jane", id: 30567, slug: "jdoe" };
const repository = {
  slug: "testing-repo",
  id: 11754,
  name: "testing-repo",
  project: { key: "~JDOE", id: 277, name: "Doe, Jane", type: "PERSONAL" },
};

function pullRequestJson(overrides: Record<string, unknown> = {}) {
  return {
    id: 2,
    version: 1,
    title: "Live verification PR",
    description: "Created by the T3 Code Data Center adapter (live verification).",
    state: "OPEN",
    draft: false,
    createdDate: 1789242749816,
    updatedDate: 1789245012563,
    closedDate: null,
    fromRef: {
      id: "refs/heads/feature/dc-live",
      displayId: "feature/dc-live",
      latestCommit: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
      repository,
    },
    toRef: {
      id: "refs/heads/main",
      displayId: "main",
      latestCommit: "a35a529320a97c51808f6647eb1f59518371b3e9",
      repository,
    },
    author: { user: tokenUser, role: "AUTHOR", approved: false, status: "UNAPPROVED" },
    reviewers: [{ user: jdoe, role: "REVIEWER", approved: true, status: "APPROVED" }],
    participants: [],
    links: { self: [{ href: PR_URL }] },
    ...overrides,
  };
}

function pageJson(values: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}) {
  return Response.json({
    size: values.length,
    limit: 100,
    isLastPage: true,
    start: 0,
    values,
    ...extra,
  });
}

const RAW_DIFF = [
  "diff --git src://LIVE.md dst://LIVE.md",
  "new file mode 100644",
  "index 0000000..e23fe64",
  "--- /dev/null",
  "+++ dst://LIVE.md",
  "@@ -0,0 +1 @@",
  "+live",
  "",
].join("\n");

function makeLayer(input: {
  readonly response: (request: HttpClientRequest.HttpClientRequest) => Response;
  readonly env?: Record<string, string>;
}) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, input.response(request))),
  );
  const layer = BitbucketServerPullRequestApi.layer.pipe(
    Layer.provide(BitbucketServerApi.layer),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
    // Repositories arrive by name here, so no checkout is ever consulted.
    Layer.provide(TestSourceControlHost.layer()),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: input.env ?? {
            T3CODE_BITBUCKET_SERVER_URL: `${HOST}/`,
            T3CODE_BITBUCKET_SERVER_TOKEN: "dc-token",
          },
        }),
      ),
    ),
    Layer.provide(SourceControlRateLimit.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  return { execute, layer };
}

/** The nth request sent, as method, url and the headers the host would see. */
function requestAt(execute: ReturnType<typeof makeLayer>["execute"], index: number) {
  const request = execute.mock.calls[index]?.[0];
  assert.isDefined(request);
  return request;
}

function urlOf(request: HttpClientRequest.HttpClientRequest): URL {
  const url = new URL(request.url);
  for (const [key, value] of request.urlParams.params)
    url.searchParams.append(key, Redacted.isRedacted(value) ? Redacted.value(value) : value);
  return url;
}

it.effect("names the token's account from the probe, with the bearer token on the wire", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json(
        { values: [] },
        { headers: { "X-AUSERNAME": "access-token-user%2F2%2F11754" } },
      ),
  });

  return Effect.gen(function* () {
    const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
    const viewer = yield* api.getViewer();

    assert.strictEqual(viewer, "access-token-user/2/11754");
    assert.strictEqual(requestAt(execute, 0).headers.authorization, "Bearer dc-token");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "reports a refused token as unauthenticated, and missing configuration the same way",
  () => {
    const refused = makeLayer({ response: () => new Response("", { status: 401 }) });
    const unconfigured = makeLayer({
      response: () => Response.json({}),
      env: { T3CODE_BITBUCKET_SERVER_TOKEN: "dc-token" },
    });

    return Effect.gen(function* () {
      const refusedError = yield* Effect.flip(
        Effect.flatMap(BitbucketServerPullRequestApi.BitbucketServerPullRequestApi, (api) =>
          api.getViewer(),
        ),
      ).pipe(Effect.provide(refused.layer));
      assert.strictEqual(refusedError._tag, "BitbucketServerViewerUnavailableError");
      assert.strictEqual(
        refusedError._tag === "BitbucketServerViewerUnavailableError" ? refusedError.reason : null,
        "unauthenticated",
      );

      const unconfiguredError = yield* Effect.flip(
        Effect.flatMap(BitbucketServerPullRequestApi.BitbucketServerPullRequestApi, (api) =>
          api.getViewer(),
        ),
      ).pipe(Effect.provide(unconfigured.layer));
      assert.strictEqual(unconfiguredError._tag, "BitbucketServerViewerUnavailableError");
      assert.match(
        unconfiguredError.detail,
        /T3CODE_BITBUCKET_SERVER_URL and T3CODE_BITBUCKET_SERVER_TOKEN/u,
      );
      assert.strictEqual(unconfigured.execute.mock.calls.length, 0);
    });
  },
);

it.effect("reads write permission from the repository search, matched on project and slug", () => {
  const { execute, layer } = makeLayer({
    response: () => pageJson([{ ...repository, project: { key: "OTHER" } }, repository]),
  });

  return Effect.gen(function* () {
    const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
    const canWrite = yield* api.getRepositoryPermission({ repository: "~jdoe/testing-repo" });

    assert.isTrue(canWrite);
    const url = urlOf(requestAt(execute, 0));
    assert.strictEqual(url.pathname, "/bitbucket/rest/api/1.0/repos");
    assert.strictEqual(url.searchParams.get("name"), "testing-repo");
    assert.strictEqual(url.searchParams.get("permission"), "REPO_WRITE");
  }).pipe(Effect.provide(layer));
});

it.effect("denies write where the search names other repositories only", () => {
  const { layer } = makeLayer({
    response: () => pageJson([{ ...repository, slug: "testing-repo-two" }]),
  });

  return Effect.gen(function* () {
    const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
    assert.isFalse(yield* api.getRepositoryPermission({ repository: "~JDOE/testing-repo" }));
  }).pipe(Effect.provide(layer));
});

it.effect("lists with state, involvement and free text as host-side filters", () => {
  const { execute, layer } = makeLayer({ response: () => pageJson([pullRequestJson()]) });

  return Effect.gen(function* () {
    const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
    const batch = yield* api.listPullRequests({
      repository: "~JDOE/testing-repo",
      state: "closed",
      involvement: "reviewing",
      viewer: "jdoe",
      limit: 50,
      query: " live ",
    });

    assert.strictEqual(batch.items.length, 1);
    assert.isFalse(batch.truncated);
    assert.strictEqual(batch.cursorAdvance, 1);
    assert.deepStrictEqual(batch.items[0]?.reviewRequestLogins, ["jdoe"]);
    const url = urlOf(requestAt(execute, 0));
    assert.strictEqual(
      url.pathname,
      "/bitbucket/rest/api/1.0/projects/~JDOE/repos/testing-repo/pull-requests",
    );
    assert.strictEqual(url.searchParams.get("state"), "DECLINED");
    assert.strictEqual(url.searchParams.get("role.1"), "REVIEWER");
    assert.strictEqual(url.searchParams.get("username.1"), "jdoe");
    assert.strictEqual(url.searchParams.get("filterText"), "live");
    assert.strictEqual(url.searchParams.get("order"), "NEWEST");
    assert.strictEqual(url.searchParams.get("start"), "0");
    assert.strictEqual(url.searchParams.get("limit"), "50");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "asks for the author role when listing authored, and no role at all for everything",
  () => {
    const { execute, layer } = makeLayer({ response: () => pageJson([]) });

    return Effect.gen(function* () {
      const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
      const target = { repository: "~JDOE/testing-repo", viewer: "jdoe", limit: 20 } as const;
      yield* api.listPullRequests({ ...target, state: "all", involvement: "authored" });
      yield* api.listPullRequests({ ...target, state: "open", involvement: "all" });

      const authored = urlOf(requestAt(execute, 0));
      assert.strictEqual(authored.searchParams.get("state"), "ALL");
      assert.strictEqual(authored.searchParams.get("role.1"), "AUTHOR");
      const everything = urlOf(requestAt(execute, 1));
      assert.strictEqual(everything.searchParams.get("state"), "OPEN");
      assert.isNull(everything.searchParams.get("role.1"));
      assert.isNull(everything.searchParams.get("filterText"));
    }).pipe(Effect.provide(layer));
  },
);

it.effect("carries on from the cursor's count and follows nextPageStart to fill the page", () => {
  const { execute, layer } = makeLayer({
    response: (request) => {
      const start = urlOf(request).searchParams.get("start");
      return start === "40"
        ? pageJson([pullRequestJson({ id: 41 }), pullRequestJson({ id: 42 })], {
            isLastPage: false,
            nextPageStart: 42,
          })
        : pageJson([pullRequestJson({ id: 43 }), pullRequestJson({ id: 44 })], {
            isLastPage: false,
            nextPageStart: 44,
          });
    },
  });

  return Effect.gen(function* () {
    const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
    const batch = yield* api.listPullRequests({
      repository: "~JDOE/testing-repo",
      state: "open",
      involvement: "all",
      viewer: "jdoe",
      limit: 3,
      cursor: { updatedBefore: "2026-09-12T20:30:12.563Z", delivered: 40 },
    });

    assert.deepStrictEqual(
      batch.items.map((item) => item.number),
      [41, 42, 43],
    );
    // The host handed back a fourth row it was not asked for; it is more to come and the cursor
    // stops before it.
    assert.isTrue(batch.truncated);
    assert.strictEqual(batch.cursorAdvance, 3);
    assert.strictEqual(urlOf(requestAt(execute, 0)).searchParams.get("start"), "40");
    assert.strictEqual(urlOf(requestAt(execute, 0)).searchParams.get("limit"), "3");
    assert.strictEqual(urlOf(requestAt(execute, 1)).searchParams.get("start"), "42");
    // Only the one row still wanted is asked for on the second page.
    assert.strictEqual(urlOf(requestAt(execute, 1)).searchParams.get("limit"), "1");
  }).pipe(Effect.provide(layer));
});

it.effect("reads the merge check, the head commit's build statuses and the commits", () => {
  const { execute, layer } = makeLayer({
    response: (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/merge")) {
        return Response.json({
          canMerge: false,
          conflicted: true,
          outcome: "CONFLICTED",
          vetoes: [],
        });
      }
      if (path.endsWith("/builds")) {
        return pageJson([
          { state: "SUCCESSFUL", key: "CI", name: "CI build", url: "https://ci/2", dateAdded: 2 },
        ]);
      }
      if (path.endsWith("/changes")) {
        return pageJson([
          { path: { toString: "LIVE.md" }, type: "ADD" },
          { path: { toString: "B.md" }, type: "MODIFY" },
        ]);
      }
      if (path.endsWith("/commits")) {
        return pageJson([
          {
            id: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
            author: jdoe,
            committerTimestamp: 1789242570000,
            message: "Newest",
          },
          {
            id: "a35a529320a97c51808f6647eb1f59518371b3e9",
            author: jdoe,
            committerTimestamp: 1789241851000,
            message: "Oldest",
          },
        ]);
      }
      return new Response("", { status: 404 });
    },
  });

  return Effect.gen(function* () {
    const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
    const target = { repository: "~JDOE/testing-repo", number: 2 };
    const mergeability = yield* api.getMergeability(target);
    const checks = yield* api.listChecks({
      repository: "~JDOE/testing-repo",
      commit: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
    });
    const commits = yield* api.listCommits(target);
    const changedFiles = yield* api.getChangedFileCount(target);

    assert.strictEqual(mergeability, "conflicting");
    assert.strictEqual(changedFiles, 2);
    assert.deepStrictEqual(checks, [
      { name: "CI build", status: "success", description: null, url: "https://ci/2" },
    ]);
    assert.deepStrictEqual(
      commits.map((commit) => commit.messageHeadline),
      ["Oldest", "Newest"],
    );
    assert.strictEqual(requestAt(execute, 0).url, `${REPO}/pull-requests/2/merge`);
    assert.strictEqual(
      new URL(requestAt(execute, 1).url).pathname,
      "/bitbucket/rest/api/1.0/projects/~JDOE/repos/testing-repo/commits/5e8770617aea7591ffda6a0fbe82149cf9a739a8/builds",
    );
    assert.strictEqual(
      new URL(requestAt(execute, 2).url).pathname,
      `/bitbucket/rest/api/1.0/projects/~JDOE/repos/testing-repo/pull-requests/2/commits`,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("walks the activities feed across pages and reports a cut-off walk as truncated", () => {
  const anchor = { line: 1, lineType: "ADDED", fileType: "TO", path: "LIVE.md", orphaned: false };
  const { execute, layer } = makeLayer({
    response: (request) => {
      const start = urlOf(request).searchParams.get("start");
      return start === "0"
        ? pageJson(
            [
              {
                id: 2,
                createdDate: 1789244976383,
                user: tokenUser,
                action: "COMMENTED",
                commentAction: "ADDED",
                comment: {
                  id: 211902,
                  text: "Inline",
                  author: tokenUser,
                  createdDate: 1789244976377,
                  anchor,
                  comments: [
                    {
                      id: 211904,
                      text: "Reply",
                      author: jdoe,
                      createdDate: 1789245011190,
                      comments: [],
                    },
                  ],
                },
              },
            ],
            { isLastPage: false, nextPageStart: 1 },
          )
        : pageJson([
            {
              id: 1,
              createdDate: 1789244975716,
              user: tokenUser,
              action: "COMMENTED",
              commentAction: "ADDED",
              comment: {
                id: 211901,
                text: "General",
                author: tokenUser,
                createdDate: 1789244975713,
              },
            },
            { id: 0, createdDate: 1789242750427, user: tokenUser, action: "OPENED" },
          ]);
    },
  });

  return Effect.gen(function* () {
    const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
    const activity = yield* api.listActivities({
      repository: "~JDOE/testing-repo",
      number: 2,
      pullRequestUrl: PR_URL,
    });

    assert.deepStrictEqual(
      activity.comments.map((comment) => [comment.id, comment.kind]),
      [
        ["211901", "issue-comment"],
        ["211902", "review-comment"],
        ["211904", "review-comment"],
      ],
    );
    assert.strictEqual(activity.threads.length, 1);
    assert.deepStrictEqual(
      activity.threads[0]?.comments.map((comment) => comment.id),
      ["211902", "211904"],
    );
    assert.isFalse(activity.truncated);
    assert.strictEqual(urlOf(requestAt(execute, 1)).searchParams.get("start"), "1");
  }).pipe(Effect.provide(layer));
});

it.effect("rewrites the raw patch to git's spelling, and asks a commit's endpoint for text", () => {
  const { execute, layer } = makeLayer({
    response: () => new Response(RAW_DIFF, { headers: { "content-type": "text/plain" } }),
  });

  return Effect.gen(function* () {
    const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
    const target = { repository: "~JDOE/testing-repo", number: 2 };
    const whole = yield* api.getPullRequestDiff(target);
    const one = yield* api.getPullRequestDiff({
      ...target,
      commit: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
    });

    assert.isFalse(whole.truncated);
    assert.match(whole.patch, /^diff --git a\/LIVE\.md b\/LIVE\.md\n/u);
    assert.include(whole.patch, "\n+++ b/LIVE.md\n");
    assert.strictEqual(one.patch, whole.patch);
    assert.strictEqual(requestAt(execute, 0).url, `${REPO}/pull-requests/2.diff`);
    assert.isUndefined(requestAt(execute, 0).headers.accept);
    assert.strictEqual(
      requestAt(execute, 1).url,
      `${REPO}/commits/5e8770617aea7591ffda6a0fbe82149cf9a739a8/diff`,
    );
    assert.strictEqual(requestAt(execute, 1).headers.accept, "text/plain");
  }).pipe(Effect.provide(layer));
});

it.effect("refuses a commit that is not a sha before anything is sent", () => {
  const { execute, layer } = makeLayer({ response: () => new Response(RAW_DIFF) });

  return Effect.gen(function* () {
    const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
    const error = yield* Effect.flip(
      api.getPullRequestDiff({ repository: "~JDOE/testing-repo", number: 2, commit: "../etc" }),
    );

    assert.strictEqual(error._tag, "BitbucketServerCommitShaError");
    assert.strictEqual(execute.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("reads both sides of a changed file at the merge base and the source tip", () => {
  const { execute, layer } = makeLayer({
    response: (request) => {
      const url = urlOf(request);
      if (url.pathname.endsWith("/pull-requests/2")) return Response.json(pullRequestJson());
      if (url.pathname.endsWith("/merge-base")) {
        return Response.json({
          id: "a35a529320a97c51808f6647eb1f59518371b3e9",
          displayId: "a35a529320a",
        });
      }
      return new Response(`contents at ${url.searchParams.get("at")}`);
    },
  });

  return Effect.gen(function* () {
    const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
    const contents = yield* api.getDiffFileContents({
      repository: "~JDOE/testing-repo",
      number: 2,
      changeType: "rename-changed",
      oldPath: "docs/old name.md",
      newPath: "docs/new.md",
    });

    assert.deepStrictEqual(contents, {
      oldContents: "contents at a35a529320a97c51808f6647eb1f59518371b3e9",
      newContents: "contents at 5e8770617aea7591ffda6a0fbe82149cf9a739a8",
    });
    const raw = execute.mock.calls
      .map((call) => call[0].url)
      .filter((url) => url.includes("/raw/"))
      .toSorted();
    assert.deepStrictEqual(raw, [
      `${REPO}/raw/docs/new.md?at=5e8770617aea7591ffda6a0fbe82149cf9a739a8`,
      `${REPO}/raw/docs/old%20name.md?at=a35a529320a97c51808f6647eb1f59518371b3e9`,
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "reads nothing for the missing side of a new or deleted file, and a commit's own parent",
  () => {
    const { execute, layer } = makeLayer({
      response: (request) => {
        const url = urlOf(request);
        if (url.pathname.endsWith("/commits/5e8770617aea7591ffda6a0fbe82149cf9a739a8")) {
          return Response.json({
            id: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
            parents: [{ id: "a35a529320a97c51808f6647eb1f59518371b3e9" }],
          });
        }
        return new Response(`contents at ${url.searchParams.get("at")}`);
      },
    });

    return Effect.gen(function* () {
      const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
      const target = {
        repository: "~JDOE/testing-repo",
        number: 2,
        commit: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
      };
      const added = yield* api.getDiffFileContents({
        ...target,
        changeType: "new",
        oldPath: "/dev/null",
        newPath: "LIVE.md",
      });
      const removed = yield* api.getDiffFileContents({
        ...target,
        changeType: "deleted",
        oldPath: "GONE.md",
        newPath: "/dev/null",
      });

      assert.deepStrictEqual(added, {
        oldContents: "",
        newContents: "contents at 5e8770617aea7591ffda6a0fbe82149cf9a739a8",
      });
      assert.deepStrictEqual(removed, {
        oldContents: "contents at a35a529320a97c51808f6647eb1f59518371b3e9",
        newContents: "",
      });
      const raw = execute.mock.calls
        .map((call) => call[0].url)
        .filter((url) => url.includes("/raw/"));
      assert.deepStrictEqual(raw, [
        `${REPO}/raw/LIVE.md?at=5e8770617aea7591ffda6a0fbe82149cf9a739a8`,
        `${REPO}/raw/GONE.md?at=a35a529320a97c51808f6647eb1f59518371b3e9`,
      ]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("surfaces a 429 with the instant the host asked to be retried at", () => {
  const { layer } = makeLayer({
    response: () => new Response("", { status: 429, headers: { "Retry-After": "30" } }),
  });

  return Effect.gen(function* () {
    const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
    const error = yield* Effect.flip(
      api.getPullRequest({ repository: "~JDOE/testing-repo", number: 2 }),
    );

    assert.strictEqual(error._tag, "BitbucketServerResponseError");
    if (error._tag === "BitbucketServerResponseError") {
      assert.strictEqual(error.status, 429);
      assert.isNumber(error.retryAt);
    }
  }).pipe(Effect.provide(layer));
});

it.effect("refuses a repository that is not PROJECTKEY/repo-slug without sending anything", () => {
  const { execute, layer } = makeLayer({ response: () => Response.json({}) });

  return Effect.gen(function* () {
    const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
    const error = yield* Effect.flip(api.getPullRequest({ repository: "testing-repo", number: 2 }));

    assert.strictEqual(error._tag, "BitbucketServerRepositoryUnsupportedError");
    assert.strictEqual(execute.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

/** The JSON document a write sent, as the host would read it. */
function bodyOf(request: HttpClientRequest.HttpClientRequest): unknown {
  const raw = (request.body as { readonly body?: Uint8Array }).body;
  assert.ok(raw);
  return JSON.parse(new TextDecoder().decode(raw));
}

const TARGET = { repository: "~JDOE/testing-repo", number: 2 };

/** Every write reads the pull request first for its version; the rest is per test. */
function writeHost(
  respond: (request: HttpClientRequest.HttpClientRequest, url: URL) => Response | undefined,
) {
  return (request: HttpClientRequest.HttpClientRequest): Response => {
    const url = urlOf(request);
    const answer = respond(request, url);
    if (answer !== undefined) return answer;
    if (request.method === "GET" && url.pathname.endsWith("/pull-requests/2")) {
      return Response.json(pullRequestJson({ version: 4 }));
    }
    return Response.json({}, { headers: { "X-AUSERNAME": "jdoe" } });
  };
}

describe("runAction", () => {
  it.effect("merges with the pull request's version and the host's name for the strategy", () => {
    const { execute, layer } = makeLayer({ response: writeHost(() => undefined) });

    return Effect.gen(function* () {
      const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
      yield* api.runAction({ ...TARGET, action: "merge", mergeMethod: "squash" });
      yield* api.runAction({ ...TARGET, action: "merge", mergeMethod: "rebase" });
      yield* api.runAction({ ...TARGET, action: "merge", mergeMethod: "merge" });
      yield* api.runAction({ ...TARGET, action: "merge" });

      const merges = execute.mock.calls
        .map((call) => call[0])
        .filter((request) => request.method === "POST");
      assert.strictEqual(merges.length, 4);
      for (const request of merges)
        assert.strictEqual(request.url, `${REPO}/pull-requests/2/merge`);
      assert.deepStrictEqual(merges.map(bodyOf), [
        { version: 4, strategyId: "squash" },
        { version: 4, strategyId: "rebase-no-ff" },
        { version: 4, strategyId: "no-ff" },
        { version: 4 },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("hands over the host's own words when the repository has disabled the strategy", () => {
    const { layer } = makeLayer({
      response: writeHost((request, url) =>
        request.method === "POST" && url.pathname.endsWith("/merge")
          ? Response.json(
              {
                errors: [
                  {
                    message: "The merge strategy 'squash' is not enabled for this repository.",
                    exceptionName: "com.atlassian.bitbucket.pull.PullRequestMergeVetoedException",
                  },
                ],
              },
              { status: 409 },
            )
          : undefined,
      ),
    });

    return Effect.gen(function* () {
      const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
      const error = yield* Effect.flip(
        api.runAction({ ...TARGET, action: "merge", mergeMethod: "squash" }),
      );

      assert.strictEqual(error._tag, "BitbucketServerResponseError");
      assert.include(
        error.detail,
        "HTTP 409: The merge strategy 'squash' is not enabled for this repository.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("declines and reopens through their own endpoints, each with the version", () => {
    const { execute, layer } = makeLayer({ response: writeHost(() => undefined) });

    return Effect.gen(function* () {
      const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
      yield* api.runAction({ ...TARGET, action: "close" });
      yield* api.runAction({ ...TARGET, action: "reopen" });

      const posts = execute.mock.calls
        .map((call) => call[0])
        .filter((request) => request.method === "POST");
      assert.deepStrictEqual(
        posts.map((request) => [request.url, bodyOf(request)]),
        [
          [`${REPO}/pull-requests/2/decline`, { version: 4 }],
          [`${REPO}/pull-requests/2/reopen`, { version: 4 }],
        ],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses an action this host has no endpoint for without sending anything", () => {
    const { execute, layer } = makeLayer({ response: writeHost(() => undefined) });

    return Effect.gen(function* () {
      const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
      const error = yield* Effect.flip(api.runAction({ ...TARGET, action: "draft" }));

      assert.strictEqual(error._tag, "BitbucketServerActionUnsupportedError");
      assert.strictEqual(execute.mock.calls.length, 0);
    }).pipe(Effect.provide(layer));
  });
});

describe("updateChangeRequest", () => {
  it.effect("rewrites the words asked for and sends the reviewers back so they survive", () => {
    const { execute, layer } = makeLayer({ response: writeHost(() => undefined) });

    return Effect.gen(function* () {
      const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
      yield* api.updateChangeRequest({ ...TARGET, title: "A new title" });
      yield* api.updateChangeRequest({ ...TARGET, body: "New body." });

      const puts = execute.mock.calls
        .map((call) => call[0])
        .filter((request) => request.method === "PUT");
      assert.strictEqual(puts.length, 2);
      assert.strictEqual(puts[0]?.url, `${REPO}/pull-requests/2`);
      // Left out of the PUT, the host reads the reviewer list as emptied, so the current one
      // travels with every rewrite. The description does survive being left out.
      assert.deepStrictEqual(bodyOf(puts[0]!), {
        version: 4,
        title: "A new title",
        reviewers: [{ user: { name: "jdoe" } }],
      });
      assert.deepStrictEqual(bodyOf(puts[1]!), {
        version: 4,
        description: "New body.",
        reviewers: [{ user: { name: "jdoe" } }],
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces a stale version as the host's own refusal", () => {
    const { layer } = makeLayer({
      response: writeHost((request) =>
        request.method === "PUT"
          ? Response.json(
              {
                errors: [
                  {
                    message:
                      "You are attempting to modify a pull request based on out-of-date information.",
                    exceptionName: "com.atlassian.bitbucket.pull.PullRequestOutOfDateException",
                  },
                ],
              },
              { status: 409 },
            )
          : undefined,
      ),
    });

    return Effect.gen(function* () {
      const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
      const error = yield* Effect.flip(api.updateChangeRequest({ ...TARGET, title: "Late" }));

      assert.strictEqual(error._tag, "BitbucketServerResponseError");
      if (error._tag === "BitbucketServerResponseError") {
        assert.strictEqual(error.status, 409);
        assert.include(error.detail, "out-of-date information");
      }
    }).pipe(Effect.provide(layer));
  });
});

describe("comments", () => {
  it.effect("posts a remark, a reply under its parent, and rewrites one with its version", () => {
    const { execute, layer } = makeLayer({
      response: writeHost((request, url) =>
        request.method === "GET" && url.pathname.endsWith("/comments/211903")
          ? Response.json({ id: 211903, version: 3, text: "old", createdDate: 1789244977593 })
          : undefined,
      ),
    });

    return Effect.gen(function* () {
      const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
      yield* api.comment({ ...TARGET, body: "true" });
      yield* api.replyToComment({ ...TARGET, commentId: "211902", body: "agreed" });
      yield* api.updateComment({ ...TARGET, commentId: "211903", body: "new" });

      const writes = execute.mock.calls
        .map((call) => call[0])
        .filter((request) => request.method !== "GET");
      assert.deepStrictEqual(
        writes.map((request) => [request.method, request.url, bodyOf(request)]),
        [
          ["POST", `${REPO}/pull-requests/2/comments`, { text: "true" }],
          ["POST", `${REPO}/pull-requests/2/comments`, { text: "agreed", parent: { id: 211902 } }],
          ["PUT", `${REPO}/pull-requests/2/comments/211903`, { version: 3, text: "new" }],
        ],
      );
    }).pipe(Effect.provide(layer));
  });
});

describe("submitReview", () => {
  it.effect("posts the line comments, then the summary, then approves as the viewer", () => {
    const { execute, layer } = makeLayer({
      response: writeHost((request, url) =>
        request.method === "GET" && url.pathname.endsWith("/users/jdoe")
          ? Response.json(jdoe)
          : undefined,
      ),
    });

    return Effect.gen(function* () {
      const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
      yield* api.submitReview({
        ...TARGET,
        verdict: "approve",
        body: "Looks good.",
        comments: [
          { path: "LIVE.md", position: { kind: "added", newLine: 1 }, body: "nice" },
          {
            path: "new.md",
            oldPath: "old.md",
            position: { kind: "context", oldLine: 2, newLine: 3, side: "left" },
            body: "hm",
          },
        ],
      });

      const writes = execute.mock.calls
        .map((call) => call[0])
        .filter((request) => request.method !== "GET");
      assert.deepStrictEqual(
        writes.map((request) => [request.method, request.url, bodyOf(request)]),
        [
          [
            "POST",
            `${REPO}/pull-requests/2/comments`,
            {
              text: "nice",
              anchor: {
                line: 1,
                lineType: "ADDED",
                fileType: "TO",
                path: "LIVE.md",
                diffType: "EFFECTIVE",
              },
            },
          ],
          [
            "POST",
            `${REPO}/pull-requests/2/comments`,
            {
              text: "hm",
              anchor: {
                line: 2,
                lineType: "CONTEXT",
                fileType: "FROM",
                path: "new.md",
                srcPath: "old.md",
                diffType: "EFFECTIVE",
              },
            },
          ],
          ["POST", `${REPO}/pull-requests/2/comments`, { text: "Looks good." }],
          ["PUT", `${REPO}/pull-requests/2/participants/jdoe`, { status: "APPROVED" }],
        ],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "finds a service account's slug among the participants when the host redirects its name",
    () => {
      const { execute, layer } = makeLayer({
        response: (request) => {
          const url = urlOf(request);
          if (request.method === "GET" && url.pathname.endsWith("/pull-requests/2")) {
            return Response.json(pullRequestJson());
          }
          if (request.method === "GET" && url.pathname.includes("/users/")) {
            return new Response(null, {
              status: 302,
              headers: { location: "https://login.example.com" },
            });
          }
          if (request.method === "GET" && url.pathname.endsWith("/participants")) {
            return pageJson([
              { user: jdoe, role: "REVIEWER", approved: false, status: "UNAPPROVED" },
              { user: tokenUser, role: "PARTICIPANT", approved: false, status: "UNAPPROVED" },
            ]);
          }
          return Response.json({}, { headers: { "X-AUSERNAME": "access-token-user%2F2%2F11754" } });
        },
      });

      return Effect.gen(function* () {
        const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
        yield* api.submitReview({ ...TARGET, verdict: "request-changes", body: "", comments: [] });

        const writes = execute.mock.calls
          .map((call) => call[0])
          .filter((request) => request.method !== "GET");
        assert.deepStrictEqual(
          writes.map((request) => [request.method, request.url, bodyOf(request)]),
          [
            [
              "PUT",
              `${REPO}/pull-requests/2/participants/access-token-user_2_11754`,
              { status: "NEEDS_WORK" },
            ],
          ],
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("posts a comment verdict without touching anybody's status", () => {
    const { execute, layer } = makeLayer({ response: writeHost(() => undefined) });

    return Effect.gen(function* () {
      const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
      yield* api.submitReview({
        ...TARGET,
        verdict: "comment",
        body: "Just a note.",
        comments: [],
      });

      assert.deepStrictEqual(
        execute.mock.calls.map((call) => [call[0].method, call[0].url]),
        [["POST", `${REPO}/pull-requests/2/comments`]],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets a refused token through as itself rather than as a missing account", () => {
    const { execute, layer } = makeLayer({
      response: (request) =>
        request.method === "GET" && urlOf(request).pathname.includes("/users/")
          ? new Response("", { status: 401 })
          : Response.json({}, { headers: { "X-AUSERNAME": "jdoe" } }),
    });

    return Effect.gen(function* () {
      const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
      const error = yield* Effect.flip(
        api.submitReview({ ...TARGET, verdict: "approve", body: "", comments: [] }),
      );

      assert.strictEqual(error._tag, "BitbucketServerResponseError");
      if (error._tag === "BitbucketServerResponseError") assert.strictEqual(error.status, 401);
      assert.isFalse(execute.mock.calls.some((call) => call[0].url.endsWith("/participants")));
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails by name when the host never says how it addresses the account", () => {
    const { layer } = makeLayer({
      response: (request) => {
        const url = urlOf(request);
        if (request.method === "GET" && url.pathname.includes("/users/")) {
          return new Response("", { status: 404 });
        }
        if (request.method === "GET" && url.pathname.endsWith("/participants")) {
          return pageJson([]);
        }
        return Response.json({}, { headers: { "X-AUSERNAME": "ghost" } });
      },
    });

    return Effect.gen(function* () {
      const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
      const error = yield* Effect.flip(
        api.submitReview({ ...TARGET, verdict: "approve", body: "", comments: [] }),
      );

      assert.strictEqual(error._tag, "BitbucketServerAccountSlugError");
      assert.include(error.detail, "ghost");
    }).pipe(Effect.provide(layer));
  });
});

describe("reviewers", () => {
  it.effect("lists everyone with read access but the author, marking who is already asked", () => {
    const { execute, layer } = makeLayer({
      response: writeHost((request, url) =>
        request.method === "GET" && url.pathname.endsWith("/rest/api/1.0/users")
          ? pageJson([{ name: "ARoe", displayName: "Roe, Alex", slug: "aroe" }, tokenUser, jdoe], {
              isLastPage: false,
              nextPageStart: 3,
            })
          : undefined,
      ),
    });

    return Effect.gen(function* () {
      const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
      const list = yield* api.listReviewerCandidates(TARGET);

      assert.deepStrictEqual(list, {
        candidates: [
          {
            id: "ARoe",
            kind: "user",
            login: "ARoe",
            name: "Roe, Alex",
            avatarUrl: null,
            isRequested: false,
          },
          {
            id: "jdoe",
            kind: "user",
            login: "jdoe",
            name: "Doe, Jane",
            avatarUrl: null,
            isRequested: true,
          },
        ],
        truncated: true,
      });
      const users = execute.mock.calls
        .map((call) => urlOf(call[0]))
        .find((url) => url.pathname.endsWith("/rest/api/1.0/users"));
      assert.isDefined(users);
      assert.deepStrictEqual(Object.fromEntries(users.searchParams), {
        "permission.1": "REPO_READ",
        "permission.1.projectKey": "~JDOE",
        "permission.1.repositorySlug": "testing-repo",
        limit: "100",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes the reviewer list whole, with the change applied to what is there", () => {
    const { execute, layer } = makeLayer({ response: writeHost(() => undefined) });

    return Effect.gen(function* () {
      const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
      yield* api.setReviewerRequest({
        ...TARGET,
        reviewers: [{ id: "ARoe" }],
        requested: true,
      });
      yield* api.setReviewerRequest({
        ...TARGET,
        reviewers: [{ id: "jdoe" }],
        requested: false,
      });

      const puts = execute.mock.calls
        .map((call) => call[0])
        .filter((request) => request.method === "PUT");
      assert.deepStrictEqual(puts.map(bodyOf), [
        {
          version: 4,
          reviewers: [{ user: { name: "jdoe" } }, { user: { name: "ARoe" } }],
        },
        { version: 4, reviewers: [] },
      ]);
    }).pipe(Effect.provide(layer));
  });
});

it.effect("resumes with the server's non-contiguous nextPageStart rather than a row count", () => {
  const { execute, layer } = makeLayer({
    response: () => pageJson([pullRequestJson()], { isLastPage: false, nextPageStart: 37 }),
  });
  return Effect.gen(function* () {
    const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
    const input = {
      repository: "PROJ/web",
      state: "open" as const,
      involvement: "all" as const,
      viewer: "jdoe",
      limit: 1,
    };
    const first = yield* api.listPullRequests(input);
    assert.strictEqual(first.resumeAfter, "37");
    yield* api.listPullRequests({
      ...input,
      cursor: {
        delivered: 1,
        updatedBefore: "2026-01-01T00:00:00Z",
        resumeAfter: first.resumeAfter,
      },
    });
    assert.strictEqual(urlOf(requestAt(execute, 1)).searchParams.get("start"), "37");
  }).pipe(Effect.provide(layer));
});

it.effect("refuses truncated structured responses and file contents", () =>
  Effect.gen(function* () {
    const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
    const target = { repository: "~JDOE/testing-repo", number: 2 };
    const detailError = yield* Effect.flip(api.getPullRequest(target));
    assert.strictEqual(detailError._tag, "BitbucketServerPullRequestReadError");
    const fileError = yield* Effect.flip(
      api.getDiffFileContents({
        ...target,
        commit: "abcdef1234",
        changeType: "new",
        oldPath: "/dev/null",
        newPath: "file.txt",
      }),
    );
    assert.strictEqual(fileError._tag, "BitbucketServerPullRequestReadError");
  }).pipe(
    Effect.provide(
      BitbucketServerPullRequestApi.layer.pipe(
        Layer.provide(
          Layer.mock(BitbucketServerApi.BitbucketServerApi)({
            probeAuth: Effect.never,
            request: ({ url }) =>
              Effect.succeed(
                url.endsWith("/commits/abcdef1234")
                  ? { body: JSON.stringify({ id: "abcdef1234", parents: [] }), truncated: false }
                  : {
                      body: url.includes("/raw/") ? "partial" : JSON.stringify(pullRequestJson()),
                      truncated: true,
                    },
              ),
          }),
        ),
      ),
    ),
  ),
);

it.effect("refuses file paths that escape the raw-file endpoint", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ id: "abcdef1234", parents: [] }),
  });
  return Effect.gen(function* () {
    const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;
    for (const newPath of ["../settings", "docs/../../settings", "/absolute", ""]) {
      const error = yield* Effect.flip(
        api.getDiffFileContents({
          repository: "~JDOE/testing-repo",
          number: 2,
          commit: "abcdef1234",
          changeType: "new",
          oldPath: "/dev/null",
          newPath,
        }),
      );
      assert.strictEqual(error._tag, "BitbucketServerPullRequestReadError");
    }
    assert.isTrue(
      execute.mock.calls.every(([request]) => request.url.endsWith("/commits/abcdef1234")),
    );
  }).pipe(Effect.provide(layer));
});

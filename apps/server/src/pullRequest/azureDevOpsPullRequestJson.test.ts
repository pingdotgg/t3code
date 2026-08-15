import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  decodePullRequestJson,
  decodePullRequestListJson,
  decodeThreadsJson,
  decodeViewerJson,
} from "./azureDevOpsPullRequestJson.ts";

const REST_URL =
  "https://dev.azure.com/acme/_apis/git/repositories/6f9c9b7f-0000-0000-0000-000000000000/pullRequests/42";

/** Shaped after Azure's `GitPullRequest`, trimmed to the fields that are read. */
function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pullRequestId: 42,
    title: "Add the change requests page",
    description: "Ships the page.",
    status: "active",
    isDraft: false,
    mergeStatus: "succeeded",
    createdBy: { displayName: "Bilal Hassan", uniqueName: "bilal@acme.dev" },
    sourceRefName: "refs/heads/feat/page",
    targetRefName: "refs/heads/main",
    creationDate: "2026-07-01T00:00:00Z",
    url: REST_URL,
    repository: { name: "web", project: { name: "platform" } },
    ...overrides,
  };
}

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

const asJson = (value: unknown) => JSON.stringify(value);

describe("decodePullRequestListJson", () => {
  it("reads a pull request as a change request", () => {
    const batch = expectSuccess(decodePullRequestListJson(asJson([pullRequest()])));

    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]).toMatchObject({
      number: 42,
      title: "Add the change requests page",
      // The login is an email, because that is what `az account show` reports to compare with.
      author: { login: "bilal@acme.dev", name: "Bilal Hassan" },
      // Azure prefixes its refs, which no other host does.
      headBranch: "feat/page",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
    });
  });

  it("assembles a browser url when Azure reports no web link", () => {
    const batch = expectSuccess(decodePullRequestListJson(asJson([pullRequest()])));

    expect(batch.items[0]?.url).toBe("https://dev.azure.com/acme/platform/_git/web/pullrequest/42");
  });

  it("prefers the web link Azure sends when asked for one", () => {
    const batch = expectSuccess(
      decodePullRequestListJson(
        asJson([
          pullRequest({
            _links: {
              web: { href: "https://dev.azure.com/acme/platform/_git/web/pullrequest/42" },
            },
          }),
        ]),
      ),
    );

    expect(batch.items[0]?.url).toBe("https://dev.azure.com/acme/platform/_git/web/pullrequest/42");
  });

  it.each([
    ["active", "open"],
    ["completed", "merged"],
    ["abandoned", "closed"],
    ["something new", "open"],
  ])("reads the %s status as %s", (status, expected) => {
    const batch = expectSuccess(decodePullRequestListJson(asJson([pullRequest({ status })])));

    expect(batch.items[0]?.state).toBe(expected);
  });

  it.each([
    ["succeeded", "mergeable"],
    ["conflicts", "conflicting"],
    ["rejectedByPolicy", "conflicting"],
    ["queued", "unknown"],
    ["notSet", "unknown"],
  ])("reads the %s merge status as %s", (mergeStatus, expected) => {
    const batch = expectSuccess(decodePullRequestListJson(asJson([pullRequest({ mergeStatus })])));

    expect(batch.items[0]?.mergeability).toBe(expected);
  });

  it("stands the closing time in for a last-touched time Azure does not keep", () => {
    const batch = expectSuccess(
      decodePullRequestListJson(
        asJson([pullRequest({ status: "completed", closedDate: "2026-07-05T00:00:00Z" })]),
      ),
    );

    expect(batch.items[0]).toMatchObject({
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-05T00:00:00Z",
    });
  });

  it("skips a malformed row but still counts it, so paging does not stop early", () => {
    const batch = expectSuccess(
      decodePullRequestListJson(asJson([{ pullRequestId: "nope" }, pullRequest()])),
    );

    expect(batch.items).toHaveLength(1);
    expect(batch.rawCount).toBe(2);
    expect(batch.rawIndexes).toEqual([1]);
  });
});

describe("decodePullRequestJson", () => {
  it("reads reviewers as review requests", () => {
    const detail = expectSuccess(
      decodePullRequestJson(
        asJson(
          pullRequest({
            reviewers: [{ displayName: "Julius", uniqueName: "julius@acme.dev", vote: 10 }],
          }),
        ),
      ),
    );

    expect(detail?.reviewRequestLogins).toEqual(["julius@acme.dev"]);
    expect(detail?.reviewers).toEqual([
      { login: "julius@acme.dev", name: "Julius", avatarUrl: null },
    ]);
  });

  it("reads auto-complete from whoever armed it, and its absence as nobody", () => {
    const armed = expectSuccess(
      decodePullRequestJson(
        asJson(pullRequest({ autoCompleteSetBy: { displayName: "Bilal Hassan" } })),
      ),
    );
    expect(armed?.autoMergeEnabled).toBe(true);

    // Azure leaves the field out entirely rather than sending it empty, so its absence is the
    // whole of what it says about auto-complete being off.
    expect(expectSuccess(decodePullRequestJson(asJson(pullRequest())))?.autoMergeEnabled).toBe(
      false,
    );
  });

  it("works out where the conversation lives from what Azure returned", () => {
    const detail = expectSuccess(decodePullRequestJson(asJson(pullRequest())));

    expect(detail?.threadsUrl).toBe(
      "https://dev.azure.com/acme/platform/_apis/git/repositories/web/pullRequests/42/threads",
    );
  });

  it("reports no conversation url when Azure said too little to build one", () => {
    // A web link places the pull request, but without the REST url and repository there is
    // nothing to hang a threads collection off.
    const detail = expectSuccess(
      decodePullRequestJson(
        asJson(
          pullRequest({
            url: null,
            repository: null,
            _links: {
              web: { href: "https://dev.azure.com/acme/platform/_git/web/pullrequest/42" },
            },
          }),
        ),
      ),
    );

    expect(detail?.threadsUrl).toBeNull();
  });

  it("returns nothing when Azure gave no way to place the pull request at all", () => {
    const detail = expectSuccess(
      decodePullRequestJson(asJson(pullRequest({ url: null, repository: null }))),
    );

    expect(detail).toBeNull();
  });
});

describe("decodeViewerJson", () => {
  it("reads the signed-in account name", () => {
    expect(expectSuccess(decodeViewerJson(asJson({ user: { name: "bilal@acme.dev" } })))).toBe(
      "bilal@acme.dev",
    );
  });

  it("returns nothing when nobody is signed in", () => {
    expect(expectSuccess(decodeViewerJson(asJson({ user: null })))).toBeNull();
  });
});

describe("decodeThreadsJson", () => {
  it("takes every real comment of every thread, oldest first", () => {
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            {
              id: 2,
              comments: [
                {
                  id: 1,
                  content: "Second remark.",
                  author: { displayName: "Julius", uniqueName: "julius@acme.dev" },
                  publishedDate: "2026-07-03T00:00:00Z",
                },
              ],
            },
            {
              id: 1,
              comments: [
                // Azure's own activity notes are events rather than remarks.
                { id: 1, content: "Bilal voted", commentType: "system", publishedDate: "x" },
                {
                  id: 2,
                  content: "First remark.",
                  author: { displayName: "Bilal", uniqueName: "bilal@acme.dev" },
                  publishedDate: "2026-07-02T00:00:00Z",
                },
              ],
            },
          ],
        }),
      ),
    );

    expect(comments.map((comment) => comment.body)).toEqual(["First remark.", "Second remark."]);
    expect(comments[0]).toMatchObject({
      kind: "issue-comment",
      author: { login: "bilal@acme.dev" },
    });
  });

  it("reads a thread pinned to a file as a review comment", () => {
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            {
              id: 3,
              threadContext: { filePath: "/src/app.ts" },
              comments: [{ id: 1, content: "Rename this.", publishedDate: "2026-07-02T00:00:00Z" }],
            },
          ],
        }),
      ),
    );

    expect(comments[0]).toMatchObject({ kind: "review-comment", path: "/src/app.ts" });
  });

  it("keeps the replies under a thread, which are as much of the conversation", () => {
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            {
              id: 4,
              threadContext: { filePath: "/src/app.ts" },
              comments: [
                { id: 1, content: "Rename this.", publishedDate: "2026-07-02T00:00:00Z" },
                { id: 2, content: "Renamed.", publishedDate: "2026-07-02T01:00:00Z" },
                { id: 3, content: "Thanks.", publishedDate: "2026-07-02T02:00:00Z" },
              ],
            },
          ],
        }),
      ),
    );

    expect(comments.map((comment) => comment.id)).toEqual(["4:1", "4:2", "4:3"]);
  });

  it("drops deleted threads and threads with nothing to show", () => {
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            {
              id: 1,
              isDeleted: true,
              comments: [{ id: 1, content: "gone", publishedDate: "2026-07-02T00:00:00Z" }],
            },
            { id: 2, comments: [] },
            {
              id: 3,
              comments: [{ id: 1, content: "   ", publishedDate: "2026-07-02T00:00:00Z" }],
            },
          ],
        }),
      ),
    );

    expect(comments).toEqual([]);
  });
});

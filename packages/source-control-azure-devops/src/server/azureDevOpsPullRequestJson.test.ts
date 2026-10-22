import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeItemContentJson,
  decodeIterationChangesJson,
  decodeIterationsJson,
  decodePullRequestJson,
  decodePullRequestListJson,
  decodeThreadsJson,
  decodeDiscussionJson,
  decodeCommitsJson,
  decodeCommitChangesJson,
} from "./azureDevOpsPullRequestJson.ts";

const REST_URL =
  "https://dev.azure.com/acme/_apis/git/repositories/6f9c9b7f-0000-0000-0000-000000000000/pullRequests/42";

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
  it.each([
    [10, "approved"],
    [5, "approved-with-suggestions"],
    [0, "none"],
    [-5, "waiting-for-author"],
    [-10, "rejected"],
    [99, undefined],
  ])("preserves the current reviewer vote %s independently of comments", (vote, reviewState) => {
    const result = expectSuccess(
      decodePullRequestJson(
        asJson(
          pullRequest({
            reviewers: [{ displayName: "Reviewer", uniqueName: "reviewer@acme.dev", vote }],
          }),
        ),
      ),
    );
    expect(result?.reviewers).toEqual([
      {
        login: "reviewer@acme.dev",
        name: "Reviewer",
        avatarUrl: null,
        ...(reviewState === undefined ? {} : { reviewState }),
      },
    ]);
  });

  it("reads a pull request as a change request", () => {
    const batch = expectSuccess(decodePullRequestListJson(asJson([pullRequest()])));

    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]).toMatchObject({
      number: 42,
      title: "Add the change requests page",
      author: { login: "bilal@acme.dev", name: "Bilal Hassan" },
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

  it.each([
    ["completed", "merged"],
    ["something new", "open"],
  ])("reads the %s status as %s", (status, expected) => {
    const batch = expectSuccess(decodePullRequestListJson(asJson([pullRequest({ status })])));

    expect(batch.items[0]?.state).toBe(expected);
  });

  it.each([
    ["succeeded", "mergeable"],
    ["conflicts", "conflicting"],
    ["queued", "unknown"],
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
      { login: "julius@acme.dev", name: "Julius", avatarUrl: null, reviewState: "approved" },
    ]);
  });

  it("keeps the strategy stored with auto-complete", () => {
    const armed = expectSuccess(
      decodePullRequestJson(
        asJson(
          pullRequest({
            autoCompleteSetBy: { displayName: "Bilal Hassan" },
            completionOptions: { mergeStrategy: "squash" },
          }),
        ),
      ),
    );

    expect(armed).toMatchObject({ autoMergeEnabled: true, autoMergeMethod: "squash" });

    const unspecified = expectSuccess(
      decodePullRequestJson(
        asJson(
          pullRequest({
            autoCompleteSetBy: { displayName: "Bilal Hassan" },
            completionOptions: { squashMerge: false },
          }),
        ),
      ),
    );
    expect(unspecified?.autoMergeEnabled).toBe(true);
    expect(unspecified?.autoMergeMethod).toBeUndefined();
  });

  it("works out where the repository lives from what Azure returned", () => {
    const detail = expectSuccess(decodePullRequestJson(asJson(pullRequest())));

    expect(detail?.location).toEqual({ project: "platform", repository: "web" });
  });

  it("reports no repository location when Azure said too little to name one", () => {
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

    expect(detail?.location).toBeNull();
  });

  it("returns nothing when Azure gave no way to place the pull request at all", () => {
    const detail = expectSuccess(
      decodePullRequestJson(asJson(pullRequest({ url: null, repository: null }))),
    );

    expect(detail).toBeNull();
  });
});

describe("decodeThreadsJson", () => {
  it("preserves reply targets within their Azure thread, including missing parents", () => {
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [17, 18].map((id) => ({
            id,
            comments: [
              {
                id: 1,
                parentCommentId: 0,
                content: "Original",
                publishedDate: "2026-07-01T00:00:00Z",
              },
              {
                id: 2,
                parentCommentId: 1,
                content: "Reply",
                publishedDate: "2026-07-02T00:00:00Z",
              },
              {
                id: 3,
                parentCommentId: 2,
                content: "Nested reply",
                publishedDate: "2026-07-03T00:00:00Z",
              },
              {
                id: 4,
                parentCommentId: 99,
                content: "Parent removed",
                publishedDate: "2026-07-04T00:00:00Z",
              },
            ],
          })),
        }),
      ),
    );

    expect(comments.filter((comment) => comment.body === "Original")).toEqual([
      expect.not.objectContaining({ replyToCommentId: expect.any(String) }),
      expect.not.objectContaining({ replyToCommentId: expect.any(String) }),
    ]);
    expect(comments.filter((comment) => comment.body !== "Original")).toMatchObject([
      { id: "17:2", replyToCommentId: "17:1" },
      { id: "18:2", replyToCommentId: "18:1" },
      { id: "17:3", replyToCommentId: "17:2" },
      { id: "18:3", replyToCommentId: "18:2" },
      { id: "17:4", replyToCommentId: "17:99" },
      { id: "18:4", replyToCommentId: "18:99" },
    ]);
    expect(comments.map((comment) => comment.threadId)).toEqual([
      "17",
      "18",
      "17",
      "18",
      "17",
      "18",
      "17",
      "18",
    ]);
  });

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

describe("decodeIterationsJson", () => {
  const iteration = (id: number, head: string, base: string) => ({
    id,
    sourceRefCommit: { commitId: head },
    commonRefCommit: { commitId: base },
    targetRefCommit: { commitId: base },
  });

  it("reads every push in order, oldest first", () => {
    const iterations = expectSuccess(
      decodeIterationsJson(
        asJson({ value: [iteration(2, "bbb", "base"), iteration(1, "aaa", "base")] }),
      ),
    );

    expect(iterations.map((entry) => entry.id)).toEqual([1, 2]);
    expect(iterations.at(-1)).toMatchObject({ id: 2, headCommit: "bbb", mergeBaseCommit: "base" });
  });

  it("skips a push Azure could not place both ends of", () => {
    const iterations = expectSuccess(
      decodeIterationsJson(
        asJson({
          value: [{ id: 1, sourceRefCommit: { commitId: "aaa" } }, iteration(2, "bbb", "base")],
        }),
      ),
    );

    expect(iterations.map((entry) => entry.id)).toEqual([2]);
  });
});

describe("decodeIterationChangesJson", () => {
  it("names each changed file without the slash Azure leads its paths with", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          changeEntries: [
            { changeType: "add", item: { path: "/DEMO.md", objectId: "ec00" } },
            {
              changeType: "edit",
              item: { path: "/README.md", objectId: "8f80", originalObjectId: "0ca4" },
            },
            { changeType: "delete", item: { path: "/OLD.md", originalObjectId: "1111" } },
          ],
        }),
      ),
    );

    expect(page.changes.map((change) => [change.path, change.changeKind])).toEqual([
      ["DEMO.md", "new"],
      ["README.md", "change"],
      ["OLD.md", "deleted"],
    ]);
  });

  it("keeps a space at the end of a file's name, which belongs to the name", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          changeEntries: [
            { changeType: "edit", item: { path: "/docs/readme.md ", objectId: "ec00" } },
            {
              changeType: "rename",
              sourceServerItem: "/docs/old.md ",
              item: { path: "/docs/moved.md", objectId: "aaaa", originalObjectId: "aaaa" },
            },
          ],
        }),
      ),
    );

    expect(page.changes.map((change) => [change.path, change.oldPath])).toEqual([
      ["docs/readme.md ", "docs/readme.md "],
      ["docs/moved.md", "docs/old.md "],
    ]);
  });

  it("reads a rename as one file that moved, and says whether it also changed", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          changeEntries: [
            {
              changeType: "rename",
              sourceServerItem: "/docs/old.md",
              item: { path: "/docs/new.md", objectId: "aaaa", originalObjectId: "aaaa" },
            },
            {
              changeType: "edit, rename",
              sourceServerItem: "/src/old.ts",
              item: { path: "/src/new.ts", objectId: "bbbb", originalObjectId: "cccc" },
            },
          ],
        }),
      ),
    );

    expect(page.changes).toEqual([
      {
        path: "docs/new.md",
        oldPath: "docs/old.md",
        changeKind: "rename-pure",
        objectId: "aaaa",
        originalObjectId: "aaaa",
      },
      {
        path: "src/new.ts",
        oldPath: "src/old.ts",
        changeKind: "rename-changed",
        objectId: "bbbb",
        originalObjectId: "cccc",
      },
    ]);
  });

  it("drops the folders Azure lists alongside the files that changed", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          changeEntries: [
            { changeType: "add", item: { path: "/docs", isFolder: true, gitObjectType: "tree" } },
            { changeType: "add", item: { path: "/docs/page.md", objectId: "dddd" } },
          ],
        }),
      ),
    );

    expect(page.changes.map((change) => change.path)).toEqual(["docs/page.md"]);
  });

  it("reads where a rename came from out of either of the two places Azure names it", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          changeEntries: [
            {
              changeType: "rename",
              originalPath: "/docs/old.md",
              item: { path: "/docs/new.md", objectId: "aaaa", originalObjectId: "aaaa" },
            },
          ],
        }),
      ),
    );

    expect(page.changes.at(0)?.oldPath).toBe("docs/old.md");
  });
});

describe("decodeItemContentJson", () => {
  it("reads an empty file as empty rather than as a failure to look", () => {
    expect(expectSuccess(decodeItemContentJson(asJson({ path: "/a.md" })))).toEqual({
      contents: "",
      isBinary: false,
    });
  });
});

/**
 * These are the shapes a real organisation answered with, read back through `az devops invoke`
 * rather than `az rest`: the extension hands over the route's own body with one key of its own
 * added, and a live repository leaves out fields the contract documents.
 */
describe("what az devops invoke answers with", () => {
  it("reads the envelope the extension adds its own continuation token to", () => {
    // Set on every JSON body it returns, from a response header these routes do not send, so it
    // arrives as null rather than not at all.
    expect(
      expectSuccess(decodeThreadsJson(asJson({ value: [], count: 0, continuation_token: null }))),
    ).toEqual([]);

    expect(
      expectSuccess(
        decodeIterationsJson(
          asJson({
            count: 1,
            continuation_token: null,
            value: [
              {
                id: 1,
                sourceRefCommit: { commitId: "f4031105213c68f197cd46ea303bb5e72acc889a" },
                commonRefCommit: { commitId: "acbc805382edd6c38b8d6de6ba9f9bba9da4ad35" },
              },
            ],
          }),
        ),
      ),
    ).toEqual([
      {
        id: 1,
        headCommit: "f4031105213c68f197cd46ea303bb5e72acc889a",
        mergeBaseCommit: "acbc805382edd6c38b8d6de6ba9f9bba9da4ad35",
        update: { id: 1, createdAt: null, author: null, description: "" },
      },
    ]);
  });

  it("keeps the files of a change that names neither their object type nor their page after it", () => {
    // A live iteration states `changeType`, `item.path` and `item.objectId` and nothing else: no
    // `gitObjectType`, no `isFolder`, and no `nextSkip` on the only page.
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          continuation_token: null,
          changeEntries: [
            { changeType: "add", item: { path: "/DEMO.md", objectId: "EC005DB24" } },
            { changeType: "edit", item: { path: "/README.md", objectId: "8F8047A49" } },
          ],
        }),
      ),
    );

    expect(page.nextSkip).toBeNull();
    expect(page.changes).toEqual([
      {
        path: "DEMO.md",
        oldPath: "DEMO.md",
        changeKind: "new",
        objectId: "EC005DB24",
        originalObjectId: null,
      },
      {
        path: "README.md",
        oldPath: "README.md",
        changeKind: "change",
        objectId: "8F8047A49",
        originalObjectId: null,
      },
    ]);
  });

  it("reads a text file whose content type Azure calls a stream", () => {
    // `contentMetadata` comes back for a markdown file with `application/octet-stream` on it and
    // no `isBinary` at all, so the content type is not the field to ask, and its absence is the
    // answer that the text is text.
    expect(
      expectSuccess(
        decodeItemContentJson(
          asJson({
            path: "/README.md",
            objectId: "8f8047a49",
            gitObjectType: "blob",
            content: "# T3Demo\n",
            contentMetadata: {
              contentType: "application/octet-stream",
              encoding: 65001,
              extension: "md",
              fileName: "README.md",
            },
            continuation_token: null,
          }),
        ),
      ),
    ).toEqual({ contents: "# T3Demo\n", isBinary: false });
  });
});

it("retains Azure discussion status and edit time while omitting deleted remarks", () => {
  for (const status of ["active", "pending", "fixed", "wontFix", "closed", "byDesign"]) {
    const decoded = decodeThreadsJson(
      JSON.stringify({
        value: [
          {
            id: 7824,
            status,
            comments: [
              {
                id: 1,
                content: "This is a test for the app t3code",
                publishedDate: "2026-10-15T10:00:00Z",
                lastContentUpdatedDate: "2026-10-15T10:01:00Z",
                commentType: "text",
              },
              {
                id: 2,
                content: "Deleted reply",
                publishedDate: "2026-10-15T10:00:00Z",
                isDeleted: true,
              },
            ],
          },
        ],
      }),
    );
    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) throw new Error("decode failed");
    expect(decoded.success).toHaveLength(1);
    expect(decoded.success[0]).toMatchObject({
      id: "7824:1",
      threadId: "7824",
      threadStatus: status,
      editedAt: "2026-10-15T10:01:00Z",
    });
  }
});

it("keeps nullable native identities, tracked ranges, and system activity", () => {
  const date = "2026-10-15T10:00:00Z";
  const decoded = expectSuccess(
    decodeDiscussionJson(
      JSON.stringify({
        value: [
          {
            id: 1,
            identities: null,
            comments: [{ id: 1, content: "General comment", publishedDate: date }],
          },
          {
            id: 2,
            identities: null,
            threadContext: {
              filePath: "/renamed.ts",
              rightFileStart: { line: 0 },
              rightFileEnd: { line: 0 },
            },
            pullRequestThreadContext: {
              iterationContext: { firstComparingIteration: 1, secondComparingIteration: 1 },
              trackingCriteria: {
                origFilePath: "/old.ts",
                origRightFileStart: { line: 4 },
                origRightFileEnd: { line: 8 },
              },
            },
            comments: [{ id: 1, content: "Review range", publishedDate: date }],
          },
          {
            id: 3,
            comments: [
              { id: 1, commentType: "system", content: "Branch updated", publishedDate: date },
            ],
          },
        ],
      }),
    ),
  );
  expect(decoded.comments.map((comment) => comment.body)).toEqual([
    "General comment",
    "Review range",
  ]);
  expect(decoded.reviewThreads[0]).toMatchObject({
    path: "renamed.ts",
    side: "right",
    line: null,
    endLine: null,
    isOutdated: true,
    originalPath: "old.ts",
    originalLine: 4,
    originalEndLine: 8,
    originalUpdate: 1,
  });
  expect(decoded.events).toEqual([
    { id: "azure-event:3:1", createdAt: date, actor: null, body: "Branch updated" },
  ]);
});

describe("Azure system activity", () => {
  const author = { displayName: "Reviewer", uniqueName: "reviewer@example.com" };
  const system = { displayName: "Microsoft.VisualStudio.Services.TFS" };
  const date = "2026-10-21T10:00:00Z";
  const decode = (properties: Record<string, unknown>, content = "Raw Azure event") =>
    expectSuccess(
      decodeDiscussionJson(
        JSON.stringify({
          value: [
            {
              id: 1,
              properties: Object.fromEntries(
                Object.entries(properties).map(([key, value]) => [key, { $value: value }]),
              ),
              identities: {
                "1": author,
                "2": { displayName: "Second reviewer", uniqueName: "second@example.com" },
              },
              comments: [
                { id: 1, author: system, commentType: "system", content, publishedDate: date },
              ],
            },
          ],
        }),
      ),
    );

  it.each([
    [10, "approved", "approved the pull request"],
    [5, "approved", "approved the pull request with suggestions"],
    [0, "review", "reset their vote"],
    [-5, "review", "is waiting for the author"],
    [-10, "changes-requested", "rejected the pull request"],
  ])("describes vote %s using the voter identity", (vote, kind, action) => {
    const discussion = decode({
      CodeReviewThreadType: "VoteUpdate",
      CodeReviewVoteResult: String(vote),
      CodeReviewVotedByIdentity: "1",
    });
    expect(discussion.comments).toEqual([]);
    expect(discussion.events).toEqual([
      {
        id: "azure-event:1:1",
        createdAt: date,
        kind,
        body: `Reviewer ${action}`,
        actor: { name: "Reviewer", login: "reviewer@example.com", avatarUrl: null },
      },
    ]);
  });

  it("supports Azure's older display-name properties", () => {
    expect(
      decode({
        CodeReviewThreadType: "VoteUpdate",
        CodeReviewVoteResult: 10,
        CodeReviewVotedByDisplayName: "Legacy reviewer",
      }).events[0]?.body,
    ).toBe("Legacy reviewer approved the pull request");
  });

  it.each([1, 2, 0])("attributes a push of %s commits to the person who pushed", (count) => {
    expect(
      decode({
        CodeReviewThreadType: "RefUpdate",
        CodeReviewRefNewCommitsCount: count,
        CodeReviewRefUpdatedByIdentity: "1",
        CodeReviewRefName: "refs/heads/topic",
      }).events[0],
    ).toMatchObject({
      kind: "push",
      actor: { login: "reviewer@example.com" },
      body:
        count === 0
          ? "Reviewer updated topic"
          : `Reviewer pushed ${count} commit${count === 1 ? "" : "s"}`,
    });
  });

  it.each([
    ["Completed", "merged", "completed"],
    ["Abandoned", "closed", "abandoned"],
    ["Active", "reopened", "reactivated"],
  ])("describes status %s", (status, kind, action) => {
    expect(
      decode({
        CodeReviewThreadType: "StatusUpdate",
        CodeReviewStatus: status,
        CodeReviewStatusUpdatedByIdentity: "1",
      }).events[0],
    ).toMatchObject({ kind, body: `Reviewer ${action} the pull request` });
  });

  it("names reviewers added by policy instead of reporting a generic policy update", () => {
    expect(
      decode({
        CodeReviewThreadType: "PolicyStatusUpdate",
        CodeReviewRequiredReviewerExampleReviewerIdentities: '["1","2"]',
      }).events[0],
    ).toMatchObject({
      kind: "reviewers",
      body: "Reviewer and Second reviewer were added as reviewers.",
    });
  });

  it.each([
    { CodeReviewThreadType: "VoteUpdate", CodeReviewVoteResult: "99" },
    { CodeReviewThreadType: "VoteUpdate", CodeReviewVoteResult: { invalid: true } },
    {
      CodeReviewThreadType: "PolicyStatusUpdate",
      CodeReviewRequiredReviewerExampleReviewerIdentities: "invalid JSON",
    },
    {
      CodeReviewThreadType: "PolicyStatusUpdate",
      CodeReviewRequiredReviewerExampleReviewerIdentities: '["missing"]',
    },
    { CodeReviewThreadType: "FutureEvent" },
  ])("preserves unfamiliar or incomplete activity: %j", (properties) => {
    expect(decode(properties).events[0]).toMatchObject({
      body: "Raw Azure event",
      actor: { name: system.displayName },
    });
    expect(decode(properties).events[0]?.kind).toBeUndefined();
  });

  it("does not interpret a user's comment as a system event", () => {
    const discussion = expectSuccess(
      decodeDiscussionJson(
        JSON.stringify({
          value: [
            {
              id: 1,
              properties: {
                CodeReviewThreadType: { $value: "VoteUpdate" },
                CodeReviewVoteResult: { $value: "10" },
              },
              comments: [
                {
                  id: 1,
                  author,
                  commentType: "text",
                  content: "Reviewer voted 10",
                  publishedDate: date,
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(discussion.comments[0]?.body).toBe("Reviewer voted 10");
    expect(discussion.events).toEqual([]);
  });
});

it("decodes likes against the DevOps viewer and excludes the viewer from named actors", () => {
  const decoded = expectSuccess(
    decodeThreadsJson(
      JSON.stringify({
        value: [
          {
            id: 8,
            comments: [
              {
                id: 1,
                content: "Test",
                publishedDate: "2026-10-15T10:00:00Z",
                usersLiked: [
                  { uniqueName: "READER@example.com" },
                  { uniqueName: "colleague@example.com" },
                ],
              },
            ],
          },
        ],
      }),
      "reader@example.com",
    ),
  );
  expect(decoded[0]?.reactions).toEqual([
    { content: "thumbs-up", count: 2, viewerHasReacted: true, actors: ["colleague@example.com"] },
  ]);
});

it("pins Azure inline threads to their native side and line while keeping general discussions unanchored", () => {
  const decoded = decodeDiscussionJson(
    JSON.stringify({
      value: [
        {
          id: 1,
          status: "fixed",
          threadContext: { filePath: "/sample.ts", rightFileStart: { line: 2, offset: 1 } },
          comments: [{ id: 1, content: "test", publishedDate: "2026-10-15T10:00:00Z" }],
        },
        {
          id: 2,
          status: "active",
          threadContext: { filePath: "/removed.ts", leftFileStart: { line: 4, offset: 1 } },
          comments: [{ id: 1, content: "old line", publishedDate: "2026-10-15T10:00:00Z" }],
        },
        {
          id: 3,
          status: "active",
          comments: [{ id: 1, content: "general", publishedDate: "2026-10-15T10:00:00Z" }],
        },
      ],
    }),
  );
  expect(Result.isSuccess(decoded)).toBe(true);
  if (Result.isFailure(decoded)) return;
  expect(decoded.success.comments).toHaveLength(3);
  expect(decoded.success.reviewThreads).toMatchObject([
    { id: "1", path: "sample.ts", line: 2, side: "right", isResolved: true },
    { id: "2", path: "removed.ts", line: 4, side: "left", isResolved: false },
  ]);
});
it("reads commit history and reports truncated commit diffs", () => {
  const commits = decodeCommitsJson(
    JSON.stringify({
      value: [
        {
          commitId: "a".repeat(40),
          comment: "First line\nBody",
          committer: { date: "2026-10-15T10:00:00Z" },
          author: { name: "Tester", email: "tester@example.com", date: "2026-10-15T10:00:00Z" },
        },
      ],
    }),
  );
  expect(Result.isSuccess(commits) && commits.success[0]).toMatchObject({
    messageHeadline: "First line",
    authors: [{ login: "tester@example.com" }],
  });
  const changes = decodeCommitChangesJson(
    JSON.stringify({
      changes: [{ changeType: "edit", item: { path: "/sample.ts" } }],
      allChangesIncluded: false,
    }),
  );
  expect(Result.isSuccess(changes) && changes.success).toMatchObject({
    truncated: true,
    changes: [{ path: "sample.ts" }],
  });
});

it("retains original anchors for later validation when Azure omits tracking criteria", () => {
  const thread = {
    id: 7913,
    status: "active",
    threadContext: {
      filePath: "/tracking-example.txt",
      rightFileStart: { line: 2, offset: 1 },
      rightFileEnd: { line: 2, offset: 1 },
    },
    pullRequestThreadContext: {
      changeTrackingId: 1,
      iterationContext: { firstComparingIteration: 1, secondComparingIteration: 1 },
    },
    comments: [
      {
        id: 1,
        content: "This is a test for the app t3code.",
        publishedDate: "2026-10-15T10:00:00Z",
      },
    ],
  };
  const decode = (value: unknown, iteration: number) =>
    expectSuccess(decodeDiscussionJson(JSON.stringify({ value: [value] }), undefined, iteration))
      .reviewThreads[0];
  expect(decode(thread, 1)?.isOutdated).toBe(false);
  expect(decode(thread, 3)).toMatchObject({
    isOutdated: false,
    originalPath: "tracking-example.txt",
    originalLine: 2,
    originalUpdate: 1,
  });
  expect(
    decode({ ...thread, threadContext: { filePath: "/tracking-example.txt" } }, 3)?.isOutdated,
  ).toBe(false);
  expect(
    decode(
      {
        ...thread,
        pullRequestThreadContext: {
          ...thread.pullRequestThreadContext,
          trackingCriteria: {
            origFilePath: "/tracking-example.txt",
            origRightFileStart: { line: 2, offset: 1 },
          },
        },
      },
      3,
    )?.isOutdated,
  ).toBe(false);
});

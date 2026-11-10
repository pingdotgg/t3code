import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeItemContentJson,
  decodeIterationChangesJson,
  decodeIterationsJson,
  decodePullRequestJson,
  decodePullRequestListJson,
  decodeThreadsJson,
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

const JANE_ID = "d6245f20-2af8-44f4-9451-8107cb2767db";
const BILAL_ID = "8c8c7d32-6b1b-47f4-b2e9-30b477b5ab3d";

function reviewersById() {
  const detail = expectSuccess(
    decodePullRequestJson(
      asJson(
        pullRequest({
          reviewers: [
            { id: JANE_ID, displayName: "Jane Doe", uniqueName: "jane@acme.dev", vote: 10 },
            { id: BILAL_ID, displayName: "Bilal Hassan", uniqueName: "bilal@acme.dev", vote: -10 },
          ],
        }),
      ),
    ),
  );
  if (detail === null) throw new Error("expected a pull request");
  return detail.reviewersById;
}

/** Azure's documented shape: a service account authors the comment; properties name the voter. */
function voteThread(input: {
  readonly id: number;
  readonly vote: string | number | null;
  readonly voterId: string;
  readonly voterName: string;
}) {
  return {
    id: input.id,
    properties: {
      CodeReviewThreadType: { $type: "System.String", $value: "VoteUpdate" },
      ...(input.vote === null
        ? {}
        : { CodeReviewVoteResult: { $type: "System.String", $value: input.vote } }),
      CodeReviewVotedByTfId: { $type: "System.String", $value: input.voterId },
      CodeReviewVotedByDisplayName: { $type: "System.String", $value: input.voterName },
    },
    comments: [
      {
        id: 1,
        content: `${input.voterName} voted ${input.vote}`,
        commentType: "system",
        author: {
          id: "41113706-0000-0000-0000-000000000000",
          displayName: "[DefaultCollection]\\Project Collection Service Accounts",
          isContainer: true,
        },
        publishedDate: `2026-07-0${input.id}T00:00:00Z`,
      },
    ],
  };
}

describe("decodePullRequestListJson", () => {
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

  it.each([
    ["approved by a required reviewer", [{ vote: 10, isRequired: true }], [], "approved"],
    ["rejected", [{ vote: -10 }], [], "changes-requested"],
    ["not yet voted on", [{ vote: 0, isRequired: true }], ["me@example.com"], "review-required"],
    [
      "approved but waiting on a required reviewer",
      [{ vote: 10 }, { uniqueName: "jane@example.com", vote: 0, isRequired: true }],
      ["jane@example.com"],
      "review-required",
    ],
    [
      "approved with suggestions, with an optional reviewer still to vote",
      [{ vote: 5 }, { uniqueName: "jane@example.com", vote: 0 }],
      ["jane@example.com"],
      "approved",
    ],
    [
      "sent back to its author despite an approval",
      [{ vote: -5 }, { uniqueName: "jane@example.com", vote: 10, isRequired: true }],
      [],
      "changes-requested",
    ],
    ["without reviewers", [], [], null],
    ["approved only by its author", [{ uniqueName: "bilal@acme.dev", vote: 10 }], [], null],
  ])(
    "reads the reviewers' votes on a pull request %s",
    (_case, votes, reviewRequestLogins, reviewDecision) => {
      const detail = expectSuccess(
        decodePullRequestJson(
          asJson(
            pullRequest({
              reviewers: votes.map((vote) => ({
                displayName: "Reviewer",
                uniqueName: "me@example.com",
                ...vote,
              })),
            }),
          ),
        ),
      );

      expect(detail).toMatchObject({ reviewRequestLogins, reviewDecision });
    },
  );

  it("returns nothing when Azure gave no way to place the pull request at all", () => {
    const detail = expectSuccess(
      decodePullRequestJson(asJson(pullRequest({ url: null, repository: null }))),
    );

    expect(detail).toBeNull();
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

  it("reads a thread pinned to a file as a review comment on the path its diff uses", () => {
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

    expect(comments[0]).toMatchObject({ kind: "review-comment", path: "src/app.ts" });
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

  it("reads a reviewer's vote, which Azure records as a system thread, as their review", () => {
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            voteThread({ id: 2, vote: "10", voterId: JANE_ID, voterName: "Jane Doe" }),
            // Azure writes the same identity id without dashes and in either case.
            voteThread({
              id: 3,
              vote: "-10",
              voterId: BILAL_ID.replaceAll("-", "").toUpperCase(),
              voterName: "Bilal Hassan",
            }),
          ],
        }),
        reviewersById(),
      ),
    );

    expect(comments).toMatchObject([
      { kind: "review", reviewState: "APPROVED", author: { login: "jane@acme.dev" } },
      { kind: "review", reviewState: "CHANGES_REQUESTED", author: { login: "bilal@acme.dev" } },
    ]);
  });

  it("keeps voters who are no longer reviewers apart even when they share a display name", () => {
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            voteThread({
              id: 2,
              vote: "10",
              voterId: "0f0f0f0f-0000-0000-0000-000000000000",
              voterName: "Sam Lee",
            }),
            voteThread({
              id: 3,
              vote: "-10",
              voterId: "0e0e0e0e-0000-0000-0000-000000000000",
              voterName: "Sam Lee",
            }),
          ],
        }),
        reviewersById(),
      ),
    );

    expect(comments).toMatchObject([
      {
        reviewState: "APPROVED",
        author: { login: "0f0f0f0f000000000000000000000000", name: "Sam Lee" },
      },
      {
        reviewState: "CHANGES_REQUESTED",
        author: { login: "0e0e0e0e000000000000000000000000", name: "Sam Lee" },
      },
    ]);
  });

  it("reads a reset vote as withdrawing the verdict, in either value type, and skips a missing one", () => {
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            voteThread({ id: 2, vote: "10", voterId: JANE_ID, voterName: "Jane Doe" }),
            voteThread({ id: 3, vote: 0, voterId: JANE_ID, voterName: "Jane Doe" }),
            voteThread({ id: 4, vote: null, voterId: JANE_ID, voterName: "Jane Doe" }),
          ],
        }),
        reviewersById(),
      ),
    );

    expect(comments.map((comment) => [comment.author?.login, comment.reviewState])).toEqual([
      ["jane@acme.dev", "APPROVED"],
      ["jane@acme.dev", "DISMISSED"],
    ]);
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
    expect(iterations.at(-1)).toEqual({ id: 2, headCommit: "bbb", mergeBaseCommit: "base" });
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

describe("what az devops invoke answers with", () => {
  it("reads the envelope the extension adds its own continuation token to", () => {
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
      },
    ]);
  });

  it("keeps the files of a change that names neither their object type nor their page after it", () => {
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

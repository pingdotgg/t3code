import * as Result from "effect/Result";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  bitbucketServerCommentAnchor,
  decodeActivitiesJson,
  decodeCommentVersionJson,
  decodeParticipantSlugJson,
  decodeUserSlugJson,
  decodeUsersPageJson,
  decodeBuildStatusesJson,
  decodeChangesPageJson,
  decodeCommitParentJson,
  decodeCommitsJson,
  decodeMergeCheckJson,
  decodePullRequestJson,
  decodePullRequestPageJson,
  decodeRepositoryPermissionJson,
  normalizeUnifiedDiff,
} from "./bitbucketServerPullRequestJson.ts";

const PR_URL = "https://bitbucket.example.com/users/jdoe/repos/testing-repo/pull-requests/2";

/** Captured from a Data Center 9.4 host; the token's account is a repository access token. */
const tokenUser = {
  name: "access-token-user/2/11754",
  active: true,
  displayName: "Access Token User - Doe, Jane testing-repo",
  id: 59666,
  slug: "access-token-user_2_11754",
  type: "SERVICE",
  links: { self: [{ href: "https://bitbucket.example.com/bots/access-token-user_2_11754" }] },
};

const jdoe = {
  name: "jdoe",
  emailAddress: "jane.doe@example.com",
  active: true,
  displayName: "Doe, Jane",
  id: 30567,
  slug: "jdoe",
  type: "NORMAL",
  links: { self: [{ href: "https://bitbucket.example.com/users/jdoe" }] },
};

const repository = {
  slug: "testing-repo",
  id: 11754,
  name: "testing-repo",
  scmId: "git",
  state: "AVAILABLE",
  project: { key: "~JDOE", id: 277, name: "Doe, Jane", type: "PERSONAL" },
};

const pullRequest = {
  id: 2,
  version: 1,
  title: "Live verification PR",
  description: "Created by the T3 Code Data Center adapter (live verification).",
  state: "OPEN",
  open: true,
  closed: false,
  draft: false,
  createdDate: 1789242749816,
  updatedDate: 1789245012563,
  closedDate: null,
  fromRef: {
    id: "refs/heads/feature/dc-live",
    displayId: "feature/dc-live",
    latestCommit: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
    type: "BRANCH",
    repository,
  },
  toRef: {
    id: "refs/heads/main",
    displayId: "main",
    latestCommit: "a35a529320a97c51808f6647eb1f59518371b3e9",
    type: "BRANCH",
    repository,
  },
  locked: false,
  author: { user: tokenUser, role: "AUTHOR", approved: false, status: "UNAPPROVED" },
  reviewers: [{ user: jdoe, role: "REVIEWER", approved: false, status: "UNAPPROVED" }],
  participants: [],
  properties: null,
  links: { self: [{ href: PR_URL }] },
};

function page(values: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    size: values.length,
    limit: 25,
    isLastPage: true,
    start: 0,
    values,
    ...extra,
  });
}

function success<A>(result: Result.Result<A, unknown>): A {
  assert.isTrue(Result.isSuccess(result));
  return (result as Result.Success<A, unknown>).success;
}

describe("decodePullRequestJson", () => {
  it("reads the account name as the login, and reviewers as review requests", () => {
    const decoded = success(decodePullRequestJson(JSON.stringify(pullRequest)));

    expect(decoded).toEqual({
      number: 2,
      version: 1,
      title: "Live verification PR",
      url: PR_URL,
      author: {
        login: "access-token-user/2/11754",
        name: "Access Token User - Doe, Jane testing-repo",
        avatarUrl: null,
      },
      headBranch: "feature/dc-live",
      headCommit: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
      headRepositoryNameWithOwner: "~JDOE/testing-repo",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      createdAt: "2026-09-12T19:52:29.816Z",
      updatedAt: "2026-09-12T20:30:12.563Z",
      closedAt: null,
      body: "Created by the T3 Code Data Center adapter (live verification).",
      reviewers: [{ login: "jdoe", name: "Doe, Jane", avatarUrl: null }],
      reviewRequestLogins: ["jdoe"],
    });
  });

  it("maps DECLINED to closed with its closing instant, and honours the draft flag", () => {
    const decoded = success(
      decodePullRequestJson(
        JSON.stringify({
          ...pullRequest,
          state: "DECLINED",
          draft: true,
          closedDate: 1789245100000,
        }),
      ),
    );

    expect(decoded.state).toBe("closed");
    expect(decoded.isDraft).toBe(true);
    expect(decoded.closedAt).toBe("2026-09-12T20:31:40.000Z");
  });

  it("skips a malformed row on a page and reports the next offset", () => {
    const decoded = success(
      decodePullRequestPageJson(
        page([pullRequest, { id: "not a pull request" }], { isLastPage: false, nextPageStart: 25 }),
      ),
    );

    expect(decoded.items.map((item) => item.number)).toEqual([2]);
    expect(decoded.rawCount).toBe(2);
    expect(decoded.nextPageStart).toBe(25);
  });
});

describe("decodeRepositoryPermissionJson", () => {
  it("grants only when the row names this project and slug, whatever the case", () => {
    const locator = { projectKey: "~jdoe", repoSlug: "testing-repo" };
    expect(success(decodeRepositoryPermissionJson(page([repository]), locator)).granted).toBe(true);
    expect(
      success(
        decodeRepositoryPermissionJson(
          page([{ ...repository, project: { key: "OTHER" } }]),
          locator,
        ),
      ).granted,
    ).toBe(false);
    expect(success(decodeRepositoryPermissionJson(page([]), locator)).granted).toBe(false);
  });
});

describe("decodeMergeCheckJson", () => {
  it("reads a conflict as conflicting and any other veto as a mergeable branch", () => {
    expect(
      success(
        decodeMergeCheckJson(
          JSON.stringify({ canMerge: true, conflicted: false, outcome: "CLEAN", vetoes: [] }),
        ),
      ),
    ).toBe("mergeable");
    expect(
      success(
        decodeMergeCheckJson(
          JSON.stringify({
            canMerge: false,
            conflicted: false,
            outcome: "UNKNOWN",
            vetoes: [{ summaryMessage: "Requires approvals" }],
          }),
        ),
      ),
    ).toBe("mergeable");
    expect(
      success(
        decodeMergeCheckJson(JSON.stringify({ canMerge: false, conflicted: true, vetoes: [] })),
      ),
    ).toBe("conflicting");
  });
});

describe("decodeActivitiesJson", () => {
  const anchor = {
    fromHash: "a35a529320a97c51808f6647eb1f59518371b3e9",
    toHash: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
    line: 1,
    lineType: "ADDED",
    fileType: "TO",
    path: "LIVE.md",
    diffType: "EFFECTIVE",
    orphaned: false,
  };
  const comment = (
    id: number,
    text: string,
    createdDate: number,
    extra: Record<string, unknown> = {},
  ) => ({
    properties: { repositoryId: 11754 },
    id,
    version: 0,
    text,
    author: tokenUser,
    createdDate,
    updatedDate: createdDate,
    comments: [],
    threadResolved: false,
    severity: "NORMAL",
    state: "OPEN",
    permittedOperations: { editable: true, transitionable: true, deletable: true },
    ...extra,
  });
  const activities = [
    {
      id: 3798424,
      createdDate: 1789245012573,
      user: tokenUser,
      action: "UPDATED",
      addedReviewers: [jdoe],
      removedReviewers: [],
    },
    {
      id: 3798420,
      createdDate: 1789244976383,
      user: tokenUser,
      action: "COMMENTED",
      commentAction: "ADDED",
      comment: comment(211902, "Inline fixture comment on line 1", 1789244976377, {
        anchor,
        comments: [
          comment(211904, "Reply to the inline fixture comment", 1789245011190, { anchor }),
        ],
      }),
      commentAnchor: anchor,
    },
    {
      id: 3798421,
      createdDate: 1789244977595,
      user: tokenUser,
      action: "COMMENTED",
      commentAction: "ADDED",
      comment: comment(211903, "Task fixture comment", 1789244977593, { severity: "BLOCKER" }),
    },
    {
      id: 3798419,
      createdDate: 1789244975716,
      user: tokenUser,
      action: "COMMENTED",
      commentAction: "ADDED",
      comment: comment(211901, "General fixture comment", 1789244975713),
    },
    { id: 3798409, createdDate: 1789242750427, user: tokenUser, action: "OPENED" },
  ];

  it("flattens roots and nested replies into comments, and anchors threads to file and line", () => {
    const decoded = success(decodeActivitiesJson(page(activities), PR_URL));
    const comments = decoded.items.flatMap((item) => item.comments);
    const threads = decoded.items.flatMap((item) => item.threads);

    expect(comments.map((entry) => [entry.id, entry.kind, entry.path])).toEqual([
      ["211902", "review-comment", "LIVE.md"],
      ["211904", "review-comment", "LIVE.md"],
      ["211903", "issue-comment", null],
      ["211901", "issue-comment", null],
    ]);
    expect(comments[0]?.url).toBe(`${PR_URL}/overview?commentId=211902`);
    // A task is a comment with a severity, and nothing in the conversation is hidden.
    expect(comments[2]?.body).toBe("Task fixture comment");
    expect(threads).toEqual([
      {
        id: "211902",
        path: "LIVE.md",
        line: 1,
        side: "right",
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            id: "211902",
            author: {
              login: "access-token-user/2/11754",
              name: "Access Token User - Doe, Jane testing-repo",
              avatarUrl: null,
            },
            body: "Inline fixture comment on line 1",
            createdAt: "2026-09-12T20:29:36.377Z",
            url: `${PR_URL}/overview?commentId=211902`,
          },
          {
            id: "211904",
            author: {
              login: "access-token-user/2/11754",
              name: "Access Token User - Doe, Jane testing-repo",
              avatarUrl: null,
            },
            body: "Reply to the inline fixture comment",
            createdAt: "2026-09-12T20:30:11.190Z",
            url: `${PR_URL}/overview?commentId=211904`,
          },
        ],
      },
    ]);
  });

  it("pins a removed-side comment to the left at its old path, and marks orphaned and resolved threads", () => {
    const decoded = success(
      decodeActivitiesJson(
        page([
          {
            id: 1,
            createdDate: 1789244976383,
            user: tokenUser,
            action: "COMMENTED",
            commentAction: "ADDED",
            comment: comment(10, "Gone", 1789244976377, {
              anchor: {
                ...anchor,
                line: 4,
                lineType: "REMOVED",
                fileType: "FROM",
                srcPath: "OLD.md",
                orphaned: true,
              },
              state: "RESOLVED",
            }),
          },
        ]),
        PR_URL,
      ),
    );

    // A comment on the removed side of a renamed file belongs to the name the file had.
    expect(decoded.items[0]?.comments[0]?.path).toBe("OLD.md");
    expect(decoded.items[0]?.threads[0]).toMatchObject({
      path: "OLD.md",
      line: 4,
      side: "left",
      isResolved: true,
      isOutdated: true,
    });
  });

  it("reads verdict activities as reviews and ignores the rest of the feed", () => {
    const decoded = success(
      decodeActivitiesJson(
        page([
          { id: 5, createdDate: 1789245100000, user: jdoe, action: "APPROVED" },
          { id: 6, createdDate: 1789245200000, user: jdoe, action: "REVIEWED" },
          { id: 7, createdDate: 1789245300000, user: jdoe, action: "UNAPPROVED" },
          { id: 8, createdDate: 1789245400000, user: jdoe, action: "RESCOPED" },
        ]),
        PR_URL,
      ),
    );

    expect(
      decoded.items.flatMap((item) => item.comments).map((entry) => [entry.id, entry.reviewState]),
    ).toEqual([
      ["activity:5", "approved"],
      ["activity:6", "changes_requested"],
      ["activity:7", "dismissed"],
    ]);
  });
});

describe("decodeCommitsJson", () => {
  it("reads the committer instant and the author account", () => {
    const decoded = success(
      decodeCommitsJson(
        JSON.stringify({
          values: [
            {
              id: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
              displayId: "5e8770617ae",
              author: jdoe,
              authorTimestamp: 1789242570000,
              committer: jdoe,
              committerTimestamp: 1789242570000,
              message: "Live verification branch\n\nWith a body.",
              parents: [
                { id: "a35a529320a97c51808f6647eb1f59518371b3e9", displayId: "a35a529320a" },
              ],
            },
          ],
          size: 1,
          isLastPage: true,
          start: 0,
          limit: 25,
          nextPageStart: null,
        }),
      ),
    );

    expect(decoded.items).toEqual([
      {
        oid: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
        messageHeadline: "Live verification branch",
        committedDate: "2026-09-12T19:49:30.000Z",
        authors: [{ login: "jdoe", name: "Doe, Jane", avatarUrl: null }],
      },
    ]);
    expect(decoded.nextPageStart).toBeNull();
  });
});

describe("decodeBuildStatusesJson", () => {
  it("maps build states and keeps the newest run under a reused key", () => {
    const decoded = success(
      decodeBuildStatusesJson(
        page([
          { state: "FAILED", key: "CI", name: "CI build", url: "https://ci/1", dateAdded: 1 },
          { state: "SUCCESSFUL", key: "CI", name: "CI build", url: "https://ci/2", dateAdded: 2 },
          { state: "INPROGRESS", key: "LINT", url: "https://ci/3", description: "Linting" },
        ]),
      ),
    );

    expect(decoded.items).toEqual([
      { name: "CI build", status: "success", description: null, url: "https://ci/2" },
      { name: "LINT", status: "pending", description: "Linting", url: "https://ci/3" },
    ]);
  });
});

describe("decodeCommitParentJson", () => {
  it("names the first parent, and none on a root commit", () => {
    expect(
      success(
        decodeCommitParentJson(
          JSON.stringify({ id: "5e87", parents: [{ id: "a35a" }, { id: "ffff" }] }),
        ),
      ),
    ).toBe("a35a");
    expect(success(decodeCommitParentJson(JSON.stringify({ id: "a35a", parents: [] })))).toBeNull();
  });
});

describe("normalizeUnifiedDiff", () => {
  it("rewrites Data Center's src:// and dst:// headers to git's a/ and b/", () => {
    const patch = [
      "diff --git src://LIVE.md dst://LIVE.md",
      "new file mode 100644",
      "index 0000000..e23fe64",
      "--- /dev/null",
      "+++ dst://LIVE.md",
      "@@ -0,0 +1,2 @@",
      "+live",
      "+++ dst://literal",
      "diff --git src://old.md dst://new.md",
      "rename from src://old.md",
      "rename to dst://new.md",
      "--- src://old.md",
      "+++ dst://new.md",
      "@@ -1,2 +1,2 @@",
      "-src://kept",
      "--- src://literal",
      "+dst://kept",
      "+++ dst://literal",
    ].join("\n");

    expect(normalizeUnifiedDiff(patch).split("\n")).toEqual([
      "diff --git a/LIVE.md b/LIVE.md",
      "new file mode 100644",
      "index 0000000..e23fe64",
      "--- /dev/null",
      "+++ b/LIVE.md",
      "@@ -0,0 +1,2 @@",
      "+live",
      "+++ dst://literal",
      "diff --git a/old.md b/new.md",
      "rename from old.md",
      "rename to new.md",
      "--- a/old.md",
      "+++ b/new.md",
      "@@ -1,2 +1,2 @@",
      "-src://kept",
      "--- src://literal",
      "+dst://kept",
      "+++ dst://literal",
    ]);
  });
});

describe("decodeChangesPageJson", () => {
  it("counts the files on a page and reports the next offset", () => {
    expect(
      success(
        decodeChangesPageJson(
          page([{ type: "ADD" }, { type: "MODIFY" }], { isLastPage: false, nextPageStart: 2 }),
        ),
      ),
    ).toEqual({ count: 2, nextPageStart: 2 });
    expect(success(decodeChangesPageJson(page([])))).toEqual({ count: 0, nextPageStart: null });
  });
});

describe("decodeUsersPageJson", () => {
  it("offers each account by name, skipping rows without one", () => {
    const decoded = decodeUsersPageJson(
      JSON.stringify({
        values: [
          { name: "ARoe", displayName: "Roe, Alex", slug: "aroe" },
          { displayName: "nameless" },
          jdoe,
        ],
        isLastPage: false,
        nextPageStart: 5,
      }),
    );

    assert.ok(Result.isSuccess(decoded));
    expect(decoded.success).toEqual({
      items: [
        {
          id: "ARoe",
          kind: "user",
          login: "ARoe",
          name: "Roe, Alex",
          avatarUrl: null,
        },
        { id: "jdoe", kind: "user", login: "jdoe", name: "Doe, Jane", avatarUrl: null },
      ],
      nextPageStart: 5,
      rawCount: 3,
    });
  });
});

describe("account slugs", () => {
  it("reads the slug off a user resource", () => {
    const decoded = decodeUserSlugJson(JSON.stringify(tokenUser));
    assert.ok(Result.isSuccess(decoded));
    expect(decoded.success).toBe("access-token-user_2_11754");
  });

  it("finds the named participant's slug and nobody else's", () => {
    const page = JSON.stringify({
      values: [
        { user: tokenUser, role: "AUTHOR", approved: false, status: "UNAPPROVED" },
        { user: jdoe, role: "REVIEWER", approved: false, status: "UNAPPROVED" },
      ],
      isLastPage: true,
    });

    const found = decodeParticipantSlugJson(page, "access-token-user/2/11754");
    assert.ok(Result.isSuccess(found));
    expect(found.success).toEqual({ slug: "access-token-user_2_11754", nextPageStart: null });

    const missing = decodeParticipantSlugJson(page, "nobody");
    assert.ok(Result.isSuccess(missing));
    expect(missing.success.slug).toBeNull();
  });
});

describe("decodeCommentVersionJson", () => {
  it("reads the version a rewrite must send back", () => {
    const decoded = decodeCommentVersionJson(
      JSON.stringify({ id: 211903, version: 3, text: "x", createdDate: 1789244977593 }),
    );
    assert.ok(Result.isSuccess(decoded));
    expect(decoded.success).toBe(3);
  });
});

describe("bitbucketServerCommentAnchor", () => {
  it("counts an added line on the TO side and a removed one on the FROM side", () => {
    expect(
      bitbucketServerCommentAnchor({
        path: "LIVE.md",
        position: { kind: "added", newLine: 4 },
        body: "x",
      }),
    ).toEqual({
      line: 4,
      lineType: "ADDED",
      fileType: "TO",
      path: "LIVE.md",
      diffType: "EFFECTIVE",
    });
    expect(
      bitbucketServerCommentAnchor({
        path: "LIVE.md",
        position: { kind: "deleted", oldLine: 9 },
        body: "x",
      }),
    ).toEqual({
      line: 9,
      lineType: "REMOVED",
      fileType: "FROM",
      path: "LIVE.md",
      diffType: "EFFECTIVE",
    });
  });

  it("anchors a context line to whichever side was selected, naming both paths of a rename", () => {
    expect(
      bitbucketServerCommentAnchor({
        path: "new.md",
        oldPath: "old.md",
        position: { kind: "context", oldLine: 2, newLine: 3, side: "left" },
        body: "x",
      }),
    ).toEqual({
      line: 2,
      lineType: "CONTEXT",
      fileType: "FROM",
      path: "new.md",
      srcPath: "old.md",
      diffType: "EFFECTIVE",
    });
    expect(
      bitbucketServerCommentAnchor({
        path: "new.md",
        position: { kind: "context", oldLine: 2, newLine: 3, side: "right" },
        body: "x",
      }).line,
    ).toBe(3);
  });
});

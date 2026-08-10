import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeCommentsJson,
  decodeCommitsJson,
  decodeConflictsJson,
  decodeDiffstatJson,
  decodePullRequestJson,
  decodePullRequestPageJson,
  decodeRepositoryPermissionJson,
  decodeStatusesJson,
  decodeViewerJson,
} from "./bitbucketPullRequestJson.ts";

/** Shaped after a real api.bitbucket.org pull request, trimmed to the fields that are read. */
function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 897,
    title: "Add trustabl-pipe",
    description: "# Add trustabl-pipe",
    state: "OPEN",
    draft: false,
    created_on: "2026-06-16T05:04:32.258456+00:00",
    updated_on: "2026-06-16T05:04:33.750542+00:00",
    author: { display_name: "Bilal Hassan", nickname: "bilal", type: "user" },
    source: { branch: { name: "feat/page" } },
    destination: { branch: { name: "master" } },
    links: { html: { href: "https://bitbucket.org/acme/web/pull-requests/897" } },
    ...overrides,
  };
}

function page(values: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ pagelen: 50, page: 1, size: values.length, values, ...extra });
}

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("decodePullRequestPageJson", () => {
  it("reads a pull request as a change request", () => {
    const decoded = expectSuccess(decodePullRequestPageJson(page([pullRequest()])));

    expect(decoded.items).toHaveLength(1);
    expect(decoded.items[0]).toMatchObject({
      number: 897,
      title: "Add trustabl-pipe",
      url: "https://bitbucket.org/acme/web/pull-requests/897",
      author: { login: "bilal", name: "Bilal Hassan" },
      headBranch: "feat/page",
      baseBranch: "master",
      state: "open",
      isDraft: false,
      // Bitbucket says nothing about conflicts on the pull request itself.
      mergeability: "unknown",
    });
    expect(decoded.next).toBeNull();
  });

  it("normalizes Bitbucket's offset timestamps, which the page sorts against other hosts", () => {
    const decoded = expectSuccess(decodePullRequestPageJson(page([pullRequest()])));

    expect(decoded.items[0]).toMatchObject({
      createdAt: "2026-06-16T05:04:32.258Z",
      updatedAt: "2026-06-16T05:04:33.750Z",
    });
  });

  it("reports the next page as the whole URL Bitbucket sends", () => {
    const next = "https://api.bitbucket.org/2.0/repositories/acme/web/pullrequests?page=2";
    const decoded = expectSuccess(decodePullRequestPageJson(page([pullRequest()], { next })));

    expect(decoded.next).toBe(next);
  });

  it.each([
    ["MERGED", "merged"],
    ["DECLINED", "closed"],
    ["SUPERSEDED", "closed"],
    ["OPEN", "open"],
    ["something new", "open"],
  ])("reads the %s state as %s", (state, expected) => {
    const decoded = expectSuccess(decodePullRequestPageJson(page([pullRequest({ state })])));

    expect(decoded.items[0]?.state).toBe(expected);
  });

  it("skips a malformed row rather than failing the page", () => {
    const decoded = expectSuccess(
      decodePullRequestPageJson(page([{ id: "not a number" }, pullRequest()])),
    );

    expect(decoded.items).toHaveLength(1);
  });

  it("fails when Bitbucket did not answer with a page", () => {
    expect(Result.isFailure(decodePullRequestPageJson(JSON.stringify({ error: "nope" })))).toBe(
      true,
    );
  });
});

describe("decodePullRequestJson", () => {
  it("reads reviewers as review requests", () => {
    const decoded = expectSuccess(
      decodePullRequestJson(
        JSON.stringify(
          pullRequest({
            reviewers: [{ nickname: "julius", display_name: "Julius" }],
          }),
        ),
      ),
    );

    expect(decoded.reviewRequestLogins).toEqual(["julius"]);
    expect(decoded.reviewers).toEqual([{ login: "julius", name: "Julius", avatarUrl: null }]);
  });

  it("reads a participant's vote as a review", () => {
    const decoded = expectSuccess(
      decodePullRequestJson(
        JSON.stringify(
          pullRequest({
            participants: [
              {
                user: { nickname: "julius", display_name: "Julius" },
                role: "REVIEWER",
                approved: true,
                state: "approved",
                participated_on: "2026-06-17T09:00:00+00:00",
              },
              // Added as a reviewer but has not voted, so there is no verdict to show.
              {
                user: { nickname: "sam", display_name: "Sam" },
                role: "REVIEWER",
                approved: false,
                state: null,
                participated_on: null,
              },
            ],
          }),
        ),
      ),
    );

    expect(decoded.reviews).toHaveLength(1);
    expect(decoded.reviews[0]).toMatchObject({
      kind: "review",
      author: { login: "julius" },
      reviewState: "approved",
      createdAt: "2026-06-17T09:00:00.000Z",
    });
  });
});

describe("decodeViewerJson", () => {
  it("reads the signed-in nickname", () => {
    const decoded = decodeViewerJson(JSON.stringify({ nickname: "bilal", display_name: "Bilal" }));

    expect(expectSuccess(decoded)).toBe("bilal");
  });

  it("falls back to the display name, which app accounts have instead", () => {
    const decoded = decodeViewerJson(JSON.stringify({ display_name: "Release Bot" }));

    expect(expectSuccess(decoded)).toBe("Release Bot");
  });

  it("returns nothing when the account has neither", () => {
    expect(expectSuccess(decodeViewerJson(JSON.stringify({})))).toBeNull();
  });
});

describe("decodeCommentsJson", () => {
  it("keeps a posted comment and drops deleted and unposted ones", () => {
    const decoded = expectSuccess(
      decodeCommentsJson(
        page([
          {
            id: 797230941,
            content: { raw: "The issue is ready for review." },
            user: { display_name: "Release Bot", type: "app_user" },
            created_on: "2026-05-15T01:58:38.220690+00:00",
            deleted: false,
            pending: false,
            links: { html: { href: "https://bitbucket.org/acme/web/pull-requests/892#c1" } },
          },
          {
            id: 2,
            content: { raw: "gone" },
            created_on: "2026-05-15T02:00:00+00:00",
            deleted: true,
          },
          {
            id: 3,
            content: { raw: "wip" },
            created_on: "2026-05-15T02:00:00+00:00",
            pending: true,
          },
          { id: 4, content: { raw: "   " }, created_on: "2026-05-15T02:00:00+00:00" },
        ]),
      ),
    );

    expect(decoded.comments).toHaveLength(1);
    expect(decoded.comments[0]).toMatchObject({
      id: "797230941",
      kind: "issue-comment",
      // An app account has no nickname, so its display name is the only handle it has.
      author: { login: "Release Bot" },
      createdAt: "2026-05-15T01:58:38.220Z",
    });
  });

  it("reads a comment pinned to a file as a review comment", () => {
    const decoded = expectSuccess(
      decodeCommentsJson(
        page([
          {
            id: 5,
            content: { raw: "Rename this." },
            created_on: "2026-05-15T02:00:00+00:00",
            inline: { path: "src/app.ts" },
          },
        ]),
      ),
    );

    expect(decoded.comments[0]).toMatchObject({ kind: "review-comment", path: "src/app.ts" });
  });
});

describe("decodeCommitsJson", () => {
  it("returns commits oldest first with only the subject line", () => {
    const decoded = expectSuccess(
      decodeCommitsJson(
        page([
          { hash: "bbb", message: "second\n\nbody text\n", date: "2026-06-16T04:51:00+00:00" },
          {
            hash: "aaa",
            message: "first\n",
            date: "2026-06-16T04:50:49+00:00",
            author: {
              raw: "Ada Lovelace <ada@example.com>",
              user: { nickname: "ada", display_name: "Ada Lovelace" },
            },
          },
        ]),
      ),
    );

    expect(decoded.items.map((commit) => commit.oid)).toEqual(["aaa", "bbb"]);
    expect(decoded.items[0]?.authors).toEqual([
      { login: "ada", name: "Ada Lovelace", avatarUrl: null },
    ]);
    expect(decoded.items[1]?.messageHeadline).toBe("second");
    expect(decoded.next).toBeNull();
  });

  it("skips commits whose hash is empty", () => {
    const decoded = expectSuccess(
      decodeCommitsJson(
        page([
          { hash: "   ", message: "invalid", date: "2026-06-16T04:51:00+00:00" },
          { hash: "aaa", date: "2026-06-16T04:50:49+00:00" },
        ]),
      ),
    );

    expect(decoded.items.map((commit) => commit.oid)).toEqual(["aaa"]);
  });
});

describe("decodeStatusesJson", () => {
  it("reads a build status as a check", () => {
    const decoded = expectSuccess(
      decodeStatusesJson(
        page([
          {
            key: "custom:check-version-and-pr",
            name: "Pipeline - custom: check-version-and-pr",
            state: "SUCCESSFUL",
            description: "",
            url: "https://bitbucket.org/acme/web/pipelines/results/8126",
          },
        ]),
      ),
    );

    expect(decoded).toEqual({
      items: [
        {
          name: "Pipeline - custom: check-version-and-pr",
          status: "success",
          description: null,
          url: "https://bitbucket.org/acme/web/pipelines/results/8126",
        },
      ],
      next: null,
    });
  });

  it.each([
    ["SUCCESSFUL", "success"],
    ["FAILED", "failure"],
    ["INPROGRESS", "pending"],
    ["STOPPED", "cancelled"],
    ["something new", "neutral"],
  ])("reads the %s build state as %s", (state, expected) => {
    const decoded = expectSuccess(decodeStatusesJson(page([{ name: "Pipeline", state }])));

    expect(decoded.items[0]?.status).toBe(expected);
  });
});

describe("decodeDiffstatJson", () => {
  it("adds up the per-file counts", () => {
    const decoded = expectSuccess(
      decodeDiffstatJson(
        page([
          { lines_added: 9, lines_removed: 2 },
          { lines_added: 32, lines_removed: 14 },
        ]),
      ),
    );

    expect(decoded).toEqual({ additions: 41, deletions: 16, changedFiles: 2, next: null });
  });
});

describe("decodeConflictsJson", () => {
  it("calls an empty conflict list mergeable", () => {
    expect(expectSuccess(decodeConflictsJson(page([])))).toBe("mergeable");
  });

  it("calls any reported conflict conflicting", () => {
    expect(expectSuccess(decodeConflictsJson(page([{ path: "src/app.ts" }])))).toBe("conflicting");
  });
});

describe("repository permission decoding", () => {
  const permissionPage = (permission: string) =>
    page([{ type: "repository_permission", permission }]);

  it("counts admin and write as write, and read as not", () => {
    expect(expectSuccess(decodeRepositoryPermissionJson(permissionPage("admin")))).toBe(true);
    expect(expectSuccess(decodeRepositoryPermissionJson(permissionPage("write")))).toBe(true);
    expect(expectSuccess(decodeRepositoryPermissionJson(permissionPage("read")))).toBe(false);
  });

  it("grants write where Bitbucket named no permission at all", () => {
    // An empty page is Bitbucket declining to say, which is an unknown standing rather than a
    // refusal — and an unknown one is granted.
    expect(expectSuccess(decodeRepositoryPermissionJson(page([])))).toBe(true);
  });
});

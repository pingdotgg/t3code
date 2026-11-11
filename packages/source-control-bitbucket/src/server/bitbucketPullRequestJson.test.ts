import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeCommentsJson,
  decodeCommitsJson,
  decodePullRequestJson,
  decodePullRequestPageJson,
  decodeRepositoryPermissionJson,
  decodeStatusesJson,
  decodeViewerJson,
} from "./bitbucketPullRequestJson.ts";

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
    source: {
      branch: { name: "feat/page" },
      commit: { hash: "9f3a7c2d8b1e6f045a9c3d7e2b8f1a6c0d4e5f93", type: "commit" },
      repository: { full_name: "fork/web" },
    },
    destination: { branch: { name: "master" }, commit: { hash: "base-commit" } },
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
      headSha: "9f3a7c2d8b1e6f045a9c3d7e2b8f1a6c0d4e5f93",
      headRepositoryNameWithOwner: "fork/web",
      baseBranch: "master",
      state: "open",
      isDraft: false,
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

  it.each([
    ["MERGED", "merged"],
    ["DECLINED", "closed"],
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
});

describe("decodePullRequestJson", () => {
  // regression: #18402 a pull request with no head commit hash still decodes, headSha null
  it.each([
    { metadata: "absent commit", commit: undefined },
    { metadata: "null commit", commit: null },
    { metadata: "absent hash", commit: {} },
    { metadata: "null hash", commit: { hash: null } },
  ])("reads detail and list payloads with $metadata", ({ commit }) => {
    const raw = pullRequest({ source: { branch: { name: "feat/page" }, commit } });
    const detail = expectSuccess(decodePullRequestJson(JSON.stringify(raw)));
    const list = expectSuccess(decodePullRequestPageJson(page([raw])));

    expect(detail).toMatchObject({ number: 897, headBranch: "feat/page", headSha: null });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ number: 897, headBranch: "feat/page", headSha: null });
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
  it("falls back to the display name, which app accounts have instead", () => {
    const decoded = decodeViewerJson(JSON.stringify({ display_name: "Release Bot" }));

    expect(expectSuccess(decoded)).toBe("Release Bot");
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
    ["something new", "neutral"],
  ])("reads the %s build state as %s", (state, expected) => {
    const decoded = expectSuccess(decodeStatusesJson(page([{ name: "Pipeline", state }])));

    expect(decoded.items[0]?.status).toBe(expected);
  });

  it("keeps two statuses that share a display name but have different keys", () => {
    const decoded = expectSuccess(
      decodeStatusesJson(
        page([
          { key: "build", name: "Pipeline", state: "SUCCESSFUL" },
          { key: "deploy", name: "Pipeline", state: "FAILED" },
        ]),
      ),
    );

    expect(decoded.items.map((check) => [check.name, check.status])).toEqual([
      ["deploy / Pipeline", "failure"],
      ["build / Pipeline", "success"],
    ]);
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
    expect(expectSuccess(decodeRepositoryPermissionJson(page([])))).toBe(true);
  });
});

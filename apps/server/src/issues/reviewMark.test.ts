import { describe, expect, it } from "@effect/vitest";

import {
  decodeIssueDetailJson,
  issueDetailOf,
  issueSearchGraphQlQuery,
  linkedPullRequestsGraphQlQuery,
  linkedPullRequestsOf,
  pullRequestOf,
  reviewStatusOf,
} from "./gitHubIssues.ts";

const commit = (state: string, creator: string | null) => ({
  oid: "abc123",
  status: { context: { state, creator: creator === null ? null : { login: creator } } },
});

describe("reviewStatusOf", () => {
  it.each([
    ["SUCCESS", "success"],
    ["FAILURE", "failure"],
    ["ERROR", "failure"],
    ["PENDING", "pending"],
    ["EXPECTED", "pending"],
  ] as const)("reads %s as %s with its poster", (state, expected) => {
    expect(reviewStatusOf(commit(state, "LukeMaj"))).toEqual({
      state: expected,
      creator: "LukeMaj",
    });
  });

  it.each([
    ["an unknown state", commit("SOMETHING_NEW", "lukemaj")],
    ["no status", { oid: "abc123", status: null }],
    ["no review context", { oid: "abc123", status: { context: null } }],
    ["no commit", null],
  ])("reads nothing from %s", (_label, head) => {
    expect(reviewStatusOf(head)).toBeNull();
  });

  it("keeps a deleted poster as no creator", () => {
    expect(reviewStatusOf(commit("SUCCESS", null))).toEqual({ state: "success", creator: null });
  });
});

const node = {
  number: 7,
  url: "https://github.com/toolboxmd/t3code/pull/7",
  state: "OPEN",
  isDraft: true,
  headRefName: "feat/29-issue-status",
  headRefOid: "abc123",
  repository: { nameWithOwner: "toolboxmd/t3code" },
  headRef: { target: commit("PENDING", "lukemaj") },
};

describe("pullRequestOf", () => {
  it("reads an open pull request with its head's review status", () => {
    expect(pullRequestOf("github.com", node)).toEqual({
      host: "github.com",
      repository: "toolboxmd/t3code",
      number: 7,
      url: "https://github.com/toolboxmd/t3code/pull/7",
      state: "open",
      isDraft: true,
      headRefName: "feat/29-issue-status",
      headSha: "abc123",
      review: { state: "pending", creator: "lukemaj" },
    });
  });

  it("counts only the status on the head GitHub reports", () => {
    const moved = { ...node, headRef: { target: { ...commit("SUCCESS", "lukemaj"), oid: "def" } } };
    expect(pullRequestOf("github.com", moved).review).toBeNull();
  });

  it.each([
    ["MERGED", "merged"],
    ["CLOSED", "closed"],
  ] as const)("reads %s without a head branch", (state, expected) => {
    expect(pullRequestOf("github.com", { ...node, state, headRef: null })).toMatchObject({
      state: expected,
      headSha: "abc123",
      review: null,
    });
  });
});

describe("linkedPullRequestsOf", () => {
  it("reads the aliased pull requests and skips the rest of the answer", () => {
    const raw = JSON.stringify({
      data: {
        viewer: { login: "lukemaj" },
        search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        linked0: node,
        // Gone, or not a pull request.
        linked1: null,
        linked2: {},
      },
    });
    expect(linkedPullRequestsOf("github.com", raw).map((pr) => pr.number)).toEqual([7]);
  });
});

describe("issueSearchGraphQlQuery", () => {
  it("reads each valid linked pull request under its own alias, and nothing else", () => {
    const query = issueSearchGraphQlQuery(
      10,
      [
        { repository: "toolboxmd/t3code", number: 36 },
        { repository: 'evil") { x } #', number: 1 },
        { repository: "toolboxmd/t3code", number: 0 },
      ],
      "github.com",
    );
    expect(query).toContain(
      'linked0: resource(url: "https://github.com/toolboxmd/t3code/pull/36")',
    );
    expect(query).not.toContain("evil");
    expect(query).not.toContain("linked1");
    expect(query).not.toContain("linked2");
  });
});

describe("linkedPullRequestsGraphQlQuery", () => {
  it("reads only the viewer and the linked pull requests", () => {
    const query = linkedPullRequestsGraphQlQuery(
      [{ repository: "toolboxmd/t3code", number: 36 }],
      "github.com",
    );
    expect(query).toContain("viewer { login }");
    expect(query).toContain(
      'linked0: resource(url: "https://github.com/toolboxmd/t3code/pull/36")',
    );
    expect(query).not.toContain("search(");
  });
});

describe("issueDetailOf", () => {
  it("decodes the detail read and maps its closing pull requests, dropping null nodes", () => {
    const raw = JSON.stringify({
      data: {
        repository: {
          issue: {
            number: 26,
            title: "Prism settings",
            url: "https://github.com/toolboxmd/t3code/issues/26",
            state: "CLOSED",
            stateReason: "COMPLETED",
            repository: { nameWithOwner: "toolboxmd/t3code" },
            body: "Body",
            createdAt: "2026-09-20T10:00:00Z",
            updatedAt: "2026-09-21T10:00:00Z",
            locked: false,
            viewerCanClose: true,
            viewerCanReopen: true,
            author: { login: "lukemaj" },
            // A pull request in a repository the viewer cannot see answers null.
            closedByPullRequestsReferences: { nodes: [{ ...node, state: "MERGED" }, null] },
            comments: { totalCount: 0, nodes: [] },
          },
        },
      },
    });
    const decoded = decodeIssueDetailJson(raw);
    if (decoded._tag !== "Success") throw new Error("the detail fixture did not decode");
    const detail = issueDetailOf("github.com", decoded.success.data.repository!.issue!);
    expect(detail.state).toBe("done");
    expect(detail.closingPullRequests).toEqual([
      {
        host: "github.com",
        repository: "toolboxmd/t3code",
        number: 7,
        url: "https://github.com/toolboxmd/t3code/pull/7",
        state: "merged",
        isDraft: true,
        headRefName: "feat/29-issue-status",
        headSha: "abc123",
        review: { state: "pending", creator: "lukemaj" },
      },
    ]);
  });
});

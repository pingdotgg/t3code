import { describe, expect, it } from "vite-plus/test";

import {
  DISCUSSION_TEXT_SEARCH_PAGE_SIZE,
  decodeDiscussionDetailBody,
  decodeDiscussionListBody,
  decodeDiscussionListPage,
  decodeIssueDetailBody,
  decodeIssueSearchBody,
  discussionListPath,
  hashReferenceSearchPaths,
} from "./gitHubHashReferences.ts";

describe("hashReferenceSearchPaths", () => {
  it("builds issue search and paginated discussion paths for a text query", () => {
    expect(hashReferenceSearchPaths({ repository: "acme/web", query: "login", limit: 12 })).toEqual(
      {
        owner: "acme",
        name: "web",
        number: null,
        issueSearchPath:
          "search/issues?q=is%3Aissue%20repo%3Aacme%2Fweb%20%22login%22%20sort%3Aupdated-desc&per_page=12",
        discussionListPath: `repos/acme/web/discussions?per_page=${DISCUSSION_TEXT_SEARCH_PAGE_SIZE}&page=1&sort=updated`,
        discussionListPerPage: DISCUSSION_TEXT_SEARCH_PAGE_SIZE,
        paginateDiscussions: true,
        issueDetailPath: null,
        discussionDetailPath: null,
      },
    );
  });

  it("keeps recent discussion lists limit-sized without pagination", () => {
    expect(hashReferenceSearchPaths({ repository: "acme/web", limit: 12 })).toEqual({
      owner: "acme",
      name: "web",
      number: null,
      issueSearchPath:
        "search/issues?q=is%3Aissue%20repo%3Aacme%2Fweb%20sort%3Aupdated-desc&per_page=12",
      discussionListPath: "repos/acme/web/discussions?per_page=12&page=1&sort=updated",
      discussionListPerPage: 12,
      paginateDiscussions: false,
      issueDetailPath: null,
      discussionDetailPath: null,
    });
  });

  it("builds detail paths for a numeric query", () => {
    expect(hashReferenceSearchPaths({ repository: "acme/web", query: "42", limit: 12 })).toEqual({
      owner: "acme",
      name: "web",
      number: 42,
      issueSearchPath: null,
      discussionListPath: "repos/acme/web/discussions?per_page=12&page=1&sort=updated",
      discussionListPerPage: 12,
      paginateDiscussions: false,
      issueDetailPath: "repos/acme/web/issues/42",
      discussionDetailPath: "repos/acme/web/discussions/42",
    });
  });

  it("rejects malformed repository selectors", () => {
    expect(hashReferenceSearchPaths({ repository: "not-a-repo", limit: 5 })).toBeNull();
  });

  it("numbers discussion list pages", () => {
    expect(discussionListPath({ owner: "acme", name: "web", perPage: 100, page: 3 })).toBe(
      "repos/acme/web/discussions?per_page=100&page=3&sort=updated",
    );
  });
});

describe("decode hash reference bodies", () => {
  it("keeps issues and drops pull requests from issue search", () => {
    expect(
      decodeIssueSearchBody(
        JSON.stringify({
          items: [
            {
              number: 7,
              title: "Fix login",
              html_url: "https://github.com/acme/web/issues/7",
              state: "open",
              updated_at: "2026-01-01T00:00:00Z",
            },
            {
              number: 8,
              title: "Ship login",
              html_url: "https://github.com/acme/web/pull/8",
              state: "open",
              updated_at: "2026-01-02T00:00:00Z",
              pull_request: {},
            },
          ],
        }),
      ),
    ).toEqual([
      {
        kind: "issue",
        number: 7,
        title: "Fix login",
        url: "https://github.com/acme/web/issues/7",
        state: "open",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("returns null for a pull request masquerading as an issue detail", () => {
    expect(
      decodeIssueDetailBody(
        JSON.stringify({
          number: 8,
          title: "Ship login",
          html_url: "https://github.com/acme/web/pull/8",
          state: "open",
          updated_at: "2026-01-02T00:00:00Z",
          pull_request: {},
        }),
      ),
    ).toBeNull();
  });

  it("filters discussion list rows by query words and reports the raw page size", () => {
    const body = JSON.stringify([
      {
        number: 9,
        title: "RFC: dark mode",
        html_url: "https://github.com/acme/web/discussions/9",
        updated_at: "2026-01-03T00:00:00Z",
        category: { name: "Ideas" },
      },
      {
        number: 10,
        title: "Welcome",
        html_url: "https://github.com/acme/web/discussions/10",
        updated_at: "2026-01-04T00:00:00Z",
      },
    ]);
    expect(decodeDiscussionListPage(body, "dark")).toEqual({
      rawCount: 2,
      items: [
        {
          kind: "discussion",
          number: 9,
          title: "RFC: dark mode",
          url: "https://github.com/acme/web/discussions/9",
          state: "open",
          updatedAt: "2026-01-03T00:00:00Z",
          category: "Ideas",
        },
      ],
    });
    expect(decodeDiscussionListBody(body, "dark")).toEqual([
      {
        kind: "discussion",
        number: 9,
        title: "RFC: dark mode",
        url: "https://github.com/acme/web/discussions/9",
        state: "open",
        updatedAt: "2026-01-03T00:00:00Z",
        category: "Ideas",
      },
    ]);
  });

  it("marks closed discussions from state_reason", () => {
    expect(
      decodeDiscussionDetailBody(
        JSON.stringify({
          number: 11,
          title: "Resolved RFC",
          html_url: "https://github.com/acme/web/discussions/11",
          updated_at: "2026-01-05T00:00:00Z",
          state_reason: "resolved",
        }),
      ),
    ).toMatchObject({ kind: "discussion", number: 11, state: "closed" });
  });
});

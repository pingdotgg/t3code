import { describe, expect, it } from "vite-plus/test";

import {
  decodeIssueDetailBody,
  decodeIssueListBody,
  hashReferenceSearchPaths,
} from "./gitLabHashReferences.ts";

describe("hashReferenceSearchPaths", () => {
  it("builds an issue list path for a text query", () => {
    expect(hashReferenceSearchPaths({ repository: "acme/web", query: "login", limit: 12 })).toEqual(
      {
        number: null,
        issueListPath:
          "projects/acme%2Fweb/issues?state=all&order_by=updated_at&sort=desc&per_page=12&search=login",
        issueDetailPath: null,
      },
    );
  });

  it("URL-encodes search text so it cannot add a parameter of its own", () => {
    expect(
      hashReferenceSearchPaths({
        repository: "acme/web",
        query: '-a&per_page=1 "b"',
        limit: 10,
      })?.issueListPath,
    ).toContain("search=-a%26per_page%3D1%20%22b%22");
  });

  it("builds a detail path for a numeric query", () => {
    expect(hashReferenceSearchPaths({ repository: "acme/web", query: "42", limit: 12 })).toEqual({
      number: 42,
      issueListPath: null,
      issueDetailPath: "projects/acme%2Fweb/issues/42",
    });
  });

  it("rejects an empty repository selector", () => {
    expect(hashReferenceSearchPaths({ repository: "  ", limit: 5 })).toBeNull();
  });
});

describe("decode issue bodies", () => {
  it("maps opened and closed issues from a list", () => {
    expect(
      decodeIssueListBody(
        JSON.stringify([
          {
            iid: 7,
            title: "Fix login",
            web_url: "https://gitlab.com/acme/web/-/issues/7",
            state: "opened",
            updated_at: "2026-01-01T00:00:00Z",
          },
          {
            iid: 8,
            title: "Closed bug",
            web_url: "https://gitlab.com/acme/web/-/issues/8",
            state: "closed",
            updated_at: "2026-01-02T00:00:00Z",
          },
          { iid: "bad", title: "skip" },
        ]),
      ),
    ).toEqual([
      {
        kind: "issue",
        number: 7,
        title: "Fix login",
        url: "https://gitlab.com/acme/web/-/issues/7",
        state: "open",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        kind: "issue",
        number: 8,
        title: "Closed bug",
        url: "https://gitlab.com/acme/web/-/issues/8",
        state: "closed",
        updatedAt: "2026-01-02T00:00:00Z",
      },
    ]);
  });

  it("decodes a single issue detail", () => {
    expect(
      decodeIssueDetailBody(
        JSON.stringify({
          iid: 9,
          title: "Exact",
          web_url: "https://gitlab.com/acme/web/-/issues/9",
          state: "opened",
          updated_at: "2026-01-03T00:00:00Z",
        }),
      ),
    ).toEqual({
      kind: "issue",
      number: 9,
      title: "Exact",
      url: "https://gitlab.com/acme/web/-/issues/9",
      state: "open",
      updatedAt: "2026-01-03T00:00:00Z",
    });
  });
});

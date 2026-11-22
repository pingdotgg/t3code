import { describe, expect, it } from "@effect/vitest";

import {
  hostReviewerQuery,
  mergeReviewerCandidates,
  reviewerCandidateView,
} from "./pullRequestReviewers.ts";

const reviewer = (
  login: string,
  { isRequested = false, name = null, kind = "user" } = {} as {
    isRequested?: boolean;
    name?: string | null;
    kind?: "user" | "team";
  },
) => ({ login, name, avatarUrl: null, id: login, kind, isRequested });

describe("mergeReviewerCandidates", () => {
  it("narrows the loaded candidates by login or name", () => {
    const loaded = [
      reviewer("ada"),
      reviewer("grace", { name: "Grace Hopper" }),
      reviewer("linus"),
    ];
    expect(mergeReviewerCandidates(loaded, [], "HOP").map((entry) => entry.login)).toEqual([
      "grace",
    ]);
  });

  it("adds candidates only the host's search found, after the loaded ones", () => {
    const loaded = [reviewer("ada"), reviewer("adam")];
    const searched = [reviewer("adam"), reviewer("adalbert")];
    expect(mergeReviewerCandidates(loaded, searched, "ada").map((entry) => entry.login)).toEqual([
      "ada",
      "adam",
      "adalbert",
    ]);
  });

  it("keeps the loaded entry for somebody both lists name, since a request updates that one", () => {
    const loaded = [reviewer("ada", { isRequested: true })];
    expect(mergeReviewerCandidates(loaded, [reviewer("ada")], "ada")).toEqual(loaded);
  });

  it("keeps a host match on a field absent from the loaded row", () => {
    const loaded = [reviewer("ada", { isRequested: true })];
    expect(mergeReviewerCandidates(loaded, [reviewer("ada")], "ada@example.com")).toEqual(loaded);
  });

  it("tells a team from a person sharing its id", () => {
    const loaded = [reviewer("core", { kind: "team", isRequested: true })];
    expect(
      mergeReviewerCandidates(loaded, [reviewer("core")], "core").map((entry) => entry.kind),
    ).toEqual(["team", "user"]);
  });
});

describe("reviewerCandidateView", () => {
  const firstPage = { candidates: [reviewer("ada"), reviewer("grace")], truncated: true };
  const idle = { data: null, isPending: false, error: null };

  it.each([
    {
      name: "a host without search, as from an older server, narrows the loaded page itself",
      searchable: false,
      query: "zed",
      debouncedQuery: "zed",
      search: idle,
      expected: { hostQuery: null, logins: [], searchPending: false, truncation: "unsearchable" },
    },
    {
      name: "a searchable host is asked once the debounce catches up",
      searchable: true,
      query: "zed",
      debouncedQuery: "zed",
      search: {
        data: { candidates: [reviewer("zed")], truncated: false },
        isPending: false,
        error: null,
      },
      expected: { hostQuery: "zed", logins: ["zed"], searchPending: false, truncation: null },
    },
    {
      name: "results for text the debounce has not reached are neither shown nor a no-match",
      searchable: true,
      query: "zed",
      debouncedQuery: "ze",
      search: {
        data: { candidates: [reviewer("zelda")], truncated: false },
        isPending: false,
        error: null,
      },
      expected: { hostQuery: "ze", logins: [], searchPending: true, truncation: null },
    },
    {
      name: "a failed search falls back to the loaded page and says so",
      searchable: true,
      query: "gr",
      debouncedQuery: "gr",
      search: { data: null, isPending: false, error: "rate limited" },
      expected: {
        hostQuery: "gr",
        logins: ["grace"],
        searchPending: false,
        truncation: "search-failed",
      },
    },
    {
      name: "an empty query lists the loaded page and offers search",
      searchable: true,
      query: "",
      debouncedQuery: "",
      search: idle,
      expected: {
        hostQuery: null,
        logins: ["ada", "grace"],
        searchPending: false,
        truncation: "searchable",
      },
    },
  ])("$name", ({ searchable, query, debouncedQuery, search, expected }) => {
    const input = { loaded: firstPage, searchable, query, debouncedQuery };
    const view = reviewerCandidateView({ ...input, search });
    expect({
      hostQuery: hostReviewerQuery(input),
      logins: view.candidates.map((entry) => entry.login),
      searchPending: view.searchPending,
      truncation: view.truncation,
    }).toEqual(expected);
  });
});

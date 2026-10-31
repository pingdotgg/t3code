import { describe, expect, it } from "vite-plus/test";

import {
  filterComposerRepoReferenceMatches,
  withLinkedComposerRepoReferencesFirst,
} from "./composerRepoReferenceMatches.ts";

describe("filterComposerRepoReferenceMatches", () => {
  it("keeps exact numbers ahead of linked PRs and newer rows", () => {
    expect(
      filterComposerRepoReferenceMatches({
        entries: [
          {
            kind: "issue",
            number: 42,
            projectId: "p1",
            repository: "acme/web",
            updatedAt: "2026-01-01T00:00:00Z",
          },
          {
            kind: "pull-request",
            number: 420,
            projectId: "p1",
            repository: "acme/web",
            updatedAt: "2026-02-01T00:00:00Z",
          },
        ],
        linked: [
          {
            kind: "pull-request",
            number: 4,
            projectId: "p1",
            repository: "acme/web",
            updatedAt: "2026-03-01T00:00:00Z",
            title: "Linked",
            headBranch: "feat",
          },
        ],
        projectId: "p1",
        repository: "acme/web",
        query: "42",
        limit: 10,
      }).map((entry) => `${entry.kind}#${entry.number}`),
    ).toEqual(["issue#42", "pull-request#420"]);
  });

  it("allows the same number for different kinds", () => {
    expect(
      filterComposerRepoReferenceMatches({
        entries: [
          {
            kind: "issue",
            number: 5,
            projectId: "p1",
            repository: "acme/web",
            updatedAt: "2026-01-01T00:00:00Z",
          },
          {
            kind: "pull-request",
            number: 5,
            projectId: "p1",
            repository: "acme/web",
            updatedAt: "2026-01-02T00:00:00Z",
          },
        ],
        projectId: "p1",
        repository: "acme/web",
        query: "5",
        limit: 10,
      }).map((entry) => `${entry.kind}#${entry.number}`),
    ).toEqual(["pull-request#5", "issue#5"]);
  });
});

describe("withLinkedComposerRepoReferencesFirst", () => {
  it("keeps linked PRs that match the text query ahead of search hits", () => {
    expect(
      withLinkedComposerRepoReferencesFirst({
        matches: [
          {
            kind: "issue",
            number: 9,
            projectId: "p1",
            repository: "acme/web",
            updatedAt: "2026-01-01T00:00:00Z",
            title: "Login",
          },
        ],
        linked: [
          {
            kind: "pull-request",
            number: 3,
            projectId: "p1",
            repository: "acme/web",
            updatedAt: "2026-01-01T00:00:00Z",
            title: "Fix login form",
            headBranch: "fix-login",
          },
        ],
        query: "login",
        limit: 10,
      }).map((entry) => `${entry.kind}#${entry.number}`),
    ).toEqual(["pull-request#3", "issue#9"]);
  });
});

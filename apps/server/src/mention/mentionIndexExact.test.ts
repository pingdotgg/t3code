import { describe, expect, it } from "vite-plus/test";

import {
  parseExactFigmaQuery,
  parseExactIssueQuery,
  parseExactJiraQuery,
  parseExactPullRequestQuery,
} from "./mentionIndexExact.ts";

describe("mentionIndexExact", () => {
  it("parses exact pull request presence from numbers, repo refs, and URLs", () => {
    expect(parseExactPullRequestQuery("42")).toEqual({ number: 42 });
    expect(parseExactPullRequestQuery("#42")).toEqual({ number: 42 });
    expect(parseExactPullRequestQuery("acme/app#7")).toEqual({
      number: 7,
      repository: "acme/app",
    });
    expect(parseExactPullRequestQuery("https://github.com/acme/app/pull/9")).toEqual({
      number: 9,
      repository: "acme/app",
    });
    expect(parseExactPullRequestQuery("improve chips")).toBeNull();
  });

  it("parses exact issue presence from numbers and issue URLs", () => {
    expect(parseExactIssueQuery("11")).toEqual({ number: 11 });
    expect(parseExactIssueQuery("https://github.com/acme/app/issues/11")).toEqual({
      number: 11,
      repository: "acme/app",
      url: "https://github.com/acme/app/issues/11",
    });
    expect(parseExactIssueQuery("https://github.com/acme/app/pull/11")).toBeNull();
  });

  it("parses exact Jira keys and browse URLs", () => {
    expect(parseExactJiraQuery("PROJ-123")).toBe("PROJ-123");
    expect(parseExactJiraQuery("https://acme.atlassian.net/browse/PROJ-123")).toBe("PROJ-123");
    expect(parseExactJiraQuery("proj-123")).toBeNull();
  });

  it("parses exact Figma file keys and design URLs", () => {
    expect(parseExactFigmaQuery("AbCdEfGhIjKlMnOp")).toBe("AbCdEfGhIjKlMnOp");
    expect(parseExactFigmaQuery("https://www.figma.com/design/AbCdEfGhIjKlMnOp/Name")).toBe(
      "AbCdEfGhIjKlMnOp",
    );
    expect(parseExactFigmaQuery("42")).toBeNull();
  });
});

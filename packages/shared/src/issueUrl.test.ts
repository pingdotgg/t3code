import { describe, expect, it } from "vite-plus/test";

import { parseIssueUrl } from "./issueUrl.ts";

describe("parseIssueUrl", () => {
  it("uses the configured tracker before a hostname that resembles another provider", () => {
    const url = "https://github.company.net/team/repo/issues/7";
    expect(parseIssueUrl(url)?.tracker).toBe("github");
    expect(parseIssueUrl(url, { tracker: "forgejo", host: "github.company.net" })?.tracker).toBe(
      "forgejo",
    );
    expect(parseIssueUrl(url, { tracker: "forgejo", host: "other.company.net" })?.tracker).toBe(
      "github",
    );
  });
  it.each([
    [
      "https://github.com/T3Tools/T3Code/issues/123",
      { tracker: "github", host: "github.com", scope: "t3tools/t3code", key: "123" },
    ],
    [
      "https://github.acme.test/platform/api/issues/7#issuecomment-1",
      { tracker: "github", host: "github.acme.test", scope: "platform/api", key: "7" },
    ],
    [
      "https://gitlab.com/group/sub/repo/-/issues/42",
      { tracker: "gitlab", host: "gitlab.com", scope: "group/sub/repo", key: "42" },
    ],
    [
      "https://git.internal/team/repo/-/issues/9",
      { tracker: "gitlab", host: "git.internal", scope: "team/repo", key: "9" },
    ],
    [
      "https://dev.azure.com/Org/Project/_workitems/edit/55",
      { tracker: "azure-devops", host: "dev.azure.com", scope: "org/project", key: "55" },
    ],
    [
      "https://dev.azure.com/Acme/My%20Project/_workitems/edit/55",
      { tracker: "azure-devops", host: "dev.azure.com", scope: "acme/my project", key: "55" },
    ],
    [
      "https://acme.visualstudio.com/platform/_workitems/edit/55",
      { tracker: "azure-devops", host: "acme.visualstudio.com", scope: "acme/platform", key: "55" },
    ],
    [
      "https://acme.visualstudio.com/DefaultCollection/My%20Project/_workitems/edit/55",
      {
        tracker: "azure-devops",
        host: "acme.visualstudio.com",
        scope: "acme/my project",
        key: "55",
      },
    ],
    [
      "https://dev.azure.com/acme/My%2520Project/_workitems/edit/55",
      { tracker: "azure-devops", host: "dev.azure.com", scope: "acme/my%20project", key: "55" },
    ],
    [
      "https://codeberg.org/forgejo/forgejo/issues/3",
      { tracker: "forgejo", host: "codeberg.org", scope: "forgejo/forgejo", key: "3" },
    ],
    [
      "https://linear.app/acme/issue/ENG-123/fix-the-bug?view=all#comment",
      {
        tracker: "linear",
        host: "linear.app",
        scope: "acme/eng",
        key: "ENG-123",
        workspace: "acme",
      },
    ],
    [
      "https://linear.app/Other-Workspace/issue/eng-123",
      {
        tracker: "linear",
        host: "linear.app",
        scope: "other-workspace/eng",
        key: "ENG-123",
        workspace: "other-workspace",
      },
    ],
    [
      "https://tenant.atlassian.net/browse/ENG-123?focusedCommentId=42",
      { tracker: "jira", host: "tenant.atlassian.net", scope: "eng", key: "ENG-123" },
    ],
  ])("reads %s", (url, expected) => {
    expect(parseIssueUrl(url)).toEqual(expected);
  });

  it.each([
    "https://github.com/T3Tools/T3Code/pull/123",
    "https://github.com/T3Tools/T3Code/issues",
    "https://example.com/owner/repo/issues/1",
    "https://linear.app/acme/issue/ENG-0",
    "https://linear.app/acme/issue/ENG-123/title/another-path",
    "https://linear.app.evil.test/acme/issue/ENG-123",
    "http://linear.app/acme/issue/ENG-123",
    "https://linear.app:8443/acme/issue/ENG-123",
    "https://tenant.atlassian.net/browse/ENG-0",
    "https://tenant.atlassian.net/browse/ENG-123/another-path",
    "https://tenant.atlassian.net.evil.test/browse/ENG-123",
    "https://example.com/browse/ENG-123",
    "https://dev.azure.com/acme/My%2FProject/_workitems/edit/55",
    "https://dev.azure.com/acme/My%5CProject/_workitems/edit/55",
    "https://dev.azure.com/acme/My%ZZProject/_workitems/edit/55",
    "https://acme.visualstudio.com/My%2FProject/_workitems/edit/55",
    "https://acme.visualstudio.com/DefaultCollection/My%ZZProject/_workitems/edit/55",
    "javascript:alert(1)",
    "not a url",
  ])("leaves %s alone", (url) => {
    expect(parseIssueUrl(url)).toBeNull();
  });

  it.each(["github", "forgejo"])(
    "reads a configured %s host without guessing its name",
    (tracker) => {
      const url = "https://git.acme.test/team/repo/issues/7";
      expect(parseIssueUrl(url)).toBeNull();
      expect(parseIssueUrl(url, { tracker, host: "git.acme.test" })).toEqual({
        tracker,
        host: "git.acme.test",
        scope: "team/repo",
        key: "7",
      });
      expect(parseIssueUrl(url, { tracker, host: "other.acme.test" })).toBeNull();
    },
  );

  it.each([
    ["github", "https://git.acme.test:3000/team/repo/issues/7"],
    ["gitlab", "https://git.acme.test:3000/team/repo/-/issues/7"],
    ["forgejo", "https://git.acme.test:3000/team/repo/issues/7"],
  ])("keeps the configured %s install's port", (tracker, url) => {
    expect(parseIssueUrl(url, { tracker, host: "git.acme.test:3000" })).toEqual({
      tracker,
      host: "git.acme.test:3000",
      scope: "team/repo",
      key: "7",
    });
    if (tracker !== "gitlab") {
      expect(parseIssueUrl(url, { tracker, host: "git.acme.test:4000" })).toBeNull();
    }
  });

  it.each([
    ["https://github.acme.test:3000/team/repo/issues/7", "github.acme.test:3000"],
    ["https://gitlab.acme.test:3000/team/repo/-/issues/7", "gitlab.acme.test:3000"],
    ["https://forgejo.acme.test:3000/team/repo/issues/7", "forgejo.acme.test:3000"],
    ["https://github.acme.test:443/team/repo/issues/7", "github.acme.test"],
    ["http://forgejo.acme.test:80/team/repo/issues/7", "forgejo.acme.test"],
  ])("keeps the native host identity for %s", (url, host) => {
    expect(parseIssueUrl(url)?.host).toBe(host);
  });
});

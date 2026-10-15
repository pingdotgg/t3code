import { describe, expect, it } from "vite-plus/test";

import { parseIssueUrl } from "./issueUrl.ts";

describe("parseIssueUrl", () => {
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
      "https://codeberg.org/forgejo/forgejo/issues/3",
      { tracker: "forgejo", host: "codeberg.org", scope: "forgejo/forgejo", key: "3" },
    ],
  ])("reads %s", (url, expected) => {
    expect(parseIssueUrl(url)).toEqual(expected);
  });

  it.each([
    "https://github.com/T3Tools/T3Code/pull/123",
    "https://github.com/T3Tools/T3Code/issues",
    "https://example.com/owner/repo/issues/1",
    "https://linear.app/acme/issue/ENG-123",
    "javascript:alert(1)",
    "not a url",
  ])("leaves %s alone", (url) => {
    expect(parseIssueUrl(url)).toBeNull();
  });
});

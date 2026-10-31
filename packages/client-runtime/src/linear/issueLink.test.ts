import { describe, expect, it } from "vite-plus/test";

import {
  linearIssueMatchesRoute,
  parseLinearIssueUrl,
  resolveLinearIssueLinkIdentifier,
} from "./issueLink.ts";

describe("parseLinearIssueUrl", () => {
  it.each([
    ["https://linear.app/acme/issue/ABC-12/some-title", "acme", "ABC-12"],
    ["https://linear.app/acme/issue/ABC-12", "acme", "ABC-12"],
    ["https://linear.app/acme/issue/ABC-12/", "acme", "ABC-12"],
    ["https://linear.app/acme/issue/abc-12/slug?x=1#comment-2", "acme", "ABC-12"],
    ["http://LINEAR.app/Acme/issue/A_b2-7", "Acme", "A_B2-7"],
    ["  https://linear.app/acme/issue/ABC-12  ", "acme", "ABC-12"],
  ])("accepts %s", (url, organizationUrlKey, identifier) => {
    expect(parseLinearIssueUrl(url)).toEqual({ organizationUrlKey, identifier });
  });

  it.each([
    "https://linear.app.evil.com/acme/issue/ABC-12",
    "https://notlinear.app/acme/issue/ABC-12",
    "https://evil.com/linear.app/acme/issue/ABC-12",
    "ftp://linear.app/acme/issue/ABC-12",
    "https://linear.app/acme/project/ABC-12",
    "https://linear.app/acme/view/ABC-12",
    "https://linear.app/acme/team/ABC/all",
    "https://linear.app/new",
    "https://linear.app/acme/issue",
    "https://linear.app/acme/issue/ABC",
    "https://linear.app/acme/issue/12-34",
    "https://linear.app/acme/issue/ABC-x",
    "https://linear.app/issue/ABC-12",
    "mailto:a@linear.app",
    "not a url",
  ])("rejects %s", (url) => {
    expect(parseLinearIssueUrl(url)).toBeNull();
  });
});

describe("resolveLinearIssueLinkIdentifier", () => {
  const connected = { state: "connected", organization: { urlKey: "Acme" } } as never;
  const url = "https://linear.app/acme/issue/abc-1/x";

  it("matches the connected organization case-insensitively", () => {
    expect(resolveLinearIssueLinkIdentifier(url, connected)).toBe("ABC-1");
  });

  it.each([
    ["another organization", "https://linear.app/other/issue/ABC-1", connected],
    ["a disconnected workspace", url, { state: "disconnected", organization: null } as never],
    ["unloaded status", url, null],
  ])("falls through for %s", (_name, link, status) => {
    expect(resolveLinearIssueLinkIdentifier(link, status)).toBeNull();
  });
});

describe("linearIssueMatchesRoute", () => {
  const issue = { id: "uuid-1", identifier: "ABC-12" };
  it("accepts the id or the identifier in any case", () => {
    expect(linearIssueMatchesRoute(issue, "uuid-1")).toBe(true);
    expect(linearIssueMatchesRoute(issue, "abc-12")).toBe(true);
    expect(linearIssueMatchesRoute(issue, "ABC-13")).toBe(false);
  });
});

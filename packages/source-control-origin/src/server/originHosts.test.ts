import { assert, describe, it } from "@effect/vitest";

import * as OriginHosts from "./originHosts.ts";

describe("originHosts", () => {
  it("knows the remote and web hosts", () => {
    assert.isTrue(OriginHosts.isOriginRemoteHost("Origin.Cursor.com"));
    assert.isTrue(OriginHosts.isOriginWebHost("cursor.com"));
    assert.isTrue(OriginHosts.isOriginWebHost("www.cursor.com"));
    assert.isTrue(OriginHosts.isOriginServedHost("origin.cursor.com"));
    assert.isTrue(OriginHosts.isOriginServedHost("cursor.com"));
    for (const host of ["github.com", "evil.origin.cursor.com", "cursor.com.evil"]) {
      assert.isFalse(OriginHosts.isOriginRemoteHost(host), host);
      assert.isFalse(OriginHosts.isOriginWebHost(host), host);
    }
  });

  it.each([
    ["https://origin.cursor.com/team/project.git/", "team/project"],
    ["https://origin.cursor.com/git/team/project.git", "team/project"],
    ["git@origin.cursor.com:team/project.git", "team/project"],
    ["ssh://git@origin.cursor.com/git/team/project.git", "team/project"],
  ])("reads the repository of %s", (url, repository) => {
    assert.deepStrictEqual(OriginHosts.parseOriginRemote(url), {
      host: "origin.cursor.com",
      repository,
    });
  });

  it.each([
    "https://cursor.com/codebase/team/project",
    "https://evil.origin.cursor.com/team/project.git",
    "https://origin.cursor.com/team/nested/project.git",
    "team/project",
  ])("is not an Origin repository remote: %s", (url) => {
    assert.isNull(OriginHosts.parseOriginRemote(url));
  });

  it("shortens refs/heads branches", () => {
    assert.strictEqual(OriginHosts.shortBranchName("refs/heads/feature"), "feature");
    assert.strictEqual(OriginHosts.shortBranchName("feature"), "feature");
  });
});

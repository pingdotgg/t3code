import { assert, describe, it } from "@effect/vitest";

import * as GitCafeHosts from "./gitCafeHosts.ts";

describe("gitCafeHosts", () => {
  it("knows exactly the production and staging hosts", () => {
    assert.deepStrictEqual([...GitCafeHosts.GITCAFE_HOSTS], ["git.cafe", "staging.git.cafe"]);
    assert.isTrue(GitCafeHosts.isGitCafeHost("Git.Cafe"));
    assert.isTrue(GitCafeHosts.isGitCafeHost("staging.git.cafe"));
    for (const host of ["cafe", "evil.git.cafe", "git.cafe.example.com", "github.com"]) {
      assert.isFalse(GitCafeHosts.isGitCafeHost(host), host);
    }
  });

  it.each([
    ["https://git.cafe/team/project.git", "git.cafe"],
    ["https://git.cafe/team/project", "git.cafe"],
    ["https://staging.git.cafe/team/project.git/", "staging.git.cafe"],
    ["ssh@git.cafe:team/project.git", "git.cafe"],
    ["git@staging.git.cafe:team/project.git", "staging.git.cafe"],
    ["ssh://git@git.cafe/team/project.git", "git.cafe"],
  ])("reads the host and repository of %s", (url, host) => {
    assert.deepStrictEqual(GitCafeHosts.parseGitCafeRemote(url), {
      host,
      repository: "team/project",
    });
  });

  it.each([
    "https://github.com/team/project.git",
    "https://evil.git.cafe/team/project.git",
    "https://git.cafe/team/nested/project.git",
    "https://git.cafe/team",
    "team/project",
  ])("is not a GitCafe repository: %s", (url) => {
    assert.isNull(GitCafeHosts.parseGitCafeRemote(url));
  });
});

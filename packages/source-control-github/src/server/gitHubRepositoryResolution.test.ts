import { assert, describe, it } from "@effect/vitest";

import {
  gitHubApiHostForRemote,
  resolveGitHubRepository,
  selectGitHubBaseRepository,
} from "./gitHubRepositoryResolution.ts";

describe("selectGitHubBaseRepository", () => {
  const remotes = (...entries: ReadonlyArray<readonly [string, string]>) =>
    entries
      .flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
      .join("\n");
  const select = (input: { remotes: string; resolved?: string }) =>
    selectGitHubBaseRepository({ resolved: "", host: "github.com", ...input });

  it("picks the repository gh reads without a prompt", () => {
    assert.deepStrictEqual(select({ remotes: remotes(["fork", "git@github.com:me/web.git"]) }), {
      owner: "me",
      name: "web",
    });
    const fork = remotes(
      ["origin", "git@github.com:me/web.git"],
      ["upstream", "https://github.com/Acme/Web.git"],
    );
    assert.deepStrictEqual(select({ remotes: fork }), { owner: "acme", name: "web" });
    assert.deepStrictEqual(select({ remotes: fork, resolved: "remote.origin.gh-resolved base" }), {
      owner: "me",
      name: "web",
    });
    assert.deepStrictEqual(
      select({ remotes: fork, resolved: "remote.origin.gh-resolved acme/other" }),
      { owner: "acme", name: "other" },
    );
    const partialClone = fork.replaceAll("(fetch)", "(fetch) [blob:none]");
    assert.deepStrictEqual(
      select({ remotes: partialClone, resolved: "remote.origin.gh-resolved base" }),
      { owner: "me", name: "web" },
    );
    assert.deepStrictEqual(
      select({
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["Upstream", "git@github.com:acme/web.git"],
        ),
      }),
      { owner: "acme", name: "web" },
    );
  });

  it("leaves gh to choose when it might weigh the remotes differently", () => {
    for (const input of [
      { remotes: "" },
      {
        remotes: remotes(["a", "git@github.com:me/web.git"], ["b", "git@github.com:acme/web.git"]),
      },
      {
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["mirror", "git@gitlab.com:me/web.git"],
        ),
      },
      { remotes: remotes(["origin", "git@github-work:me/web.git"]) },
      {
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["Origin", "git@github.com:acme/web.git"],
        ),
      },
      {
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["upstream", "git@github.com:acme/web.git"],
        ),
        resolved: "remote.origin.gh-resolved base\nremote.upstream.gh-resolved base",
      },
    ]) {
      assert.strictEqual(select(input), null);
    }
  });
});

describe("gitHubApiHostForRemote", () => {
  it("reads an SSH alias through github.com and a real host as itself", () => {
    assert.strictEqual(gitHubApiHostForRemote("git@github:acme/web.git"), "github.com");
    assert.strictEqual(
      gitHubApiHostForRemote("git@github.example.com:a/b.git"),
      "github.example.com",
    );
    assert.strictEqual(gitHubApiHostForRemote("git@gitlab.com:a/b.git"), null);
  });
});

describe("repository credential selector spelling", () => {
  it.each([
    "https://github.com/OwnerA/Repo.git",
    "ssh://git@github.com/OwnerA/Repo.git",
    "git@github.com:OwnerA/Repo.git",
    "git@github-work:OwnerA/Repo.git",
    "https://github.com/OwnerA/Repo.git/",
    "ssh://git@github.com/OwnerA/Repo.git/",
    "git@github.com:OwnerA/Repo.git/",
    "git@github-work:OwnerA/Repo.git/",
  ])("preserves %s only when requested", (remote) => {
    const input = {
      remotes: `origin\t${remote} (fetch)`,
      resolved: "",
      hostHint: undefined,
      defaultHost: "github.com",
    };
    assert.deepStrictEqual(resolveGitHubRepository(input).locator, {
      host: "github.com",
      owner: "ownera",
      name: "repo",
    });
    assert.deepStrictEqual(
      resolveGitHubRepository({ ...input, preserveRepositoryCase: true }).locator,
      { host: "github.com", owner: "OwnerA", name: "Repo" },
    );
  });

  it("preserves an explicit gh-resolved selector independently of its checkout", () => {
    const input = {
      remotes: "origin\tgit@github.com:Other/Repo.git (fetch)",
      resolved: "remote.origin.gh-resolved OwnerA/Repo",
      hostHint: undefined,
      defaultHost: "github.com",
    };
    assert.deepStrictEqual(resolveGitHubRepository(input).locator, {
      host: "github.com",
      owner: "ownera",
      name: "repo",
    });
    assert.deepStrictEqual(
      resolveGitHubRepository({ ...input, preserveRepositoryCase: true }).locator,
      { host: "github.com", owner: "OwnerA", name: "Repo" },
    );
  });
});

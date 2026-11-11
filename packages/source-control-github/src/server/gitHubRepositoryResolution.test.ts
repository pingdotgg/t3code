import { assert, describe, it } from "@effect/vitest";

import {
  gitHubApiHostForRemote,
  resolveGitHubRepository,
  parseGitHubRepositorySelector,
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

  it("honors a marked SSH alias origin over upstream", () => {
    for (const url of [
      "git@github.com-scale:me/web.git",
      "ssh://git@github.com-scale:22/me/web.git",
      "git@github-work:me/web.git",
    ]) {
      const input = {
        remotes: remotes(["origin", url], ["upstream", "https://github.com/acme/web.git"]),
        resolved: "remote.origin.gh-resolved base",
      };
      assert.deepStrictEqual(select(input), { owner: "me", name: "web" }, url);
      assert.deepStrictEqual(
        resolveGitHubRepository({ ...input, hostHint: undefined, defaultHost: "github.com" }),
        { host: "github.com", locator: { host: "github.com", owner: "me", name: "web" } },
        url,
      );
    }
  });

  it("does not honor a github.com mark on a different or unrecognized host", () => {
    for (const url of [
      "git@github.com-evil.example:me/web.git",
      "git@github.com.evil.example:me/web.git",
      "git@evil-github.com:me/web.git",
      "https://github.com-scale/me/web.git",
      "git@work:me/web.git",
    ]) {
      const input = {
        remotes: remotes(["origin", url], ["upstream", "https://github.com/acme/web.git"]),
        resolved: "remote.origin.gh-resolved base",
      };
      assert.strictEqual(select(input), null, url);
      assert.deepStrictEqual(
        resolveGitHubRepository({ ...input, hostHint: "github.com", defaultHost: "github.com" }),
        { host: "github.com", locator: { host: "github.com", owner: "acme", name: "web" } },
        url,
      );
    }
  });

  it("preserves selection behavior for real hosts with explicit ports", () => {
    const input = {
      remotes: remotes(["origin", "https://github.example.com:8443/me/web.git"]),
      resolved: "remote.origin.gh-resolved acme/other",
    };
    assert.strictEqual(
      selectGitHubBaseRepository({ ...input, host: "github.example.com:8443" }),
      null,
    );
    assert.deepStrictEqual(
      resolveGitHubRepository({ ...input, hostHint: undefined, defaultHost: "github.com" }),
      {
        host: "github.example.com:8443",
        locator: { host: "github.example.com:8443", owner: "me", name: "web" },
      },
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
      { remotes: remotes(["origin", "git@work:me/web.git"]) },
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

describe("parseGitHubRepositorySelector", () => {
  it("drops a clone URL's .git suffix wherever the selector ends", () => {
    for (const [selector, host, name] of [
      ["https://github.com/acme/web.git", "github.com", "web"],
      ["https://github.com/acme/web.git/", "github.com", "web"],
      ["https://github.com/acme/web.git?tab=readme", "github.com", "web"],
      ["https://github.com/acme/web.git.git", "github.com", "web.git"],
      ["https://github.com/acme/web.git.git/", "github.com", "web.git"],
      ["acme/web.git/", "github.com", "web"],
      ["ghe.example.com/acme/web.git/", "ghe.example.com", "web"],
    ] as const) {
      assert.deepStrictEqual(parseGitHubRepositorySelector(selector, "github.com"), {
        host,
        owner: "acme",
        name,
      });
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

describe("github.com-<name> SSH aliases", () => {
  it("reads a per-account alias through github.com", () => {
    for (const url of [
      "git@github.com-scale:scalable-so/scalablev2.git",
      "git@GitHub.com-Work:acme/web.git",
      "ssh://git@github.com-personal/acme/web.git",
      "ssh://git@github.com-scale:22/acme/web.git",
    ]) {
      assert.strictEqual(gitHubApiHostForRemote(url), "github.com", url);
    }
  });

  it("never maps a hostile or real DNS host onto github.com", () => {
    for (const [url, host] of [
      ["git@github.com-evil.example:acme/web.git", "github.com-evil.example"],
      ["ssh://git@github.com-evil.example/acme/web.git", "github.com-evil.example"],
      ["git@github.com.evil.example:acme/web.git", "github.com.evil.example"],
      ["git@evil-github.com:acme/web.git", null],
      ["https://github.com-scale/acme/web.git", "github.com-scale"],
    ] as const) {
      assert.strictEqual(gitHubApiHostForRemote(url), host, url);
    }
  });

  it("resolves the API host and repository from an alias remote and its host hint", () => {
    const remotes = [
      "origin\tgit@github.com-scale:scalable-so/scalablev2.git (fetch)",
      "origin\tgit@github.com-scale:scalable-so/scalablev2.git (push)",
    ].join("\n");
    const expected = {
      host: "github.com",
      locator: { host: "github.com", owner: "scalable-so", name: "scalablev2" },
    };
    for (const hostHint of ["github.com-scale", undefined]) {
      assert.deepStrictEqual(
        resolveGitHubRepository({ remotes, resolved: "", hostHint, defaultHost: "github.com" }),
        expected,
      );
    }
  });

  it.each([false, true])("preserves an HTTPS alias-shaped host hint (upstream: %s)", (upstream) => {
    const remotes = [
      "origin\thttps://github.com-scale/me/web.git (fetch)",
      ...(upstream ? ["upstream\thttps://github.com/acme/web.git (fetch)"] : []),
    ].join("\n");
    assert.deepStrictEqual(
      resolveGitHubRepository({
        remotes,
        resolved: "",
        hostHint: "github.com-scale",
        defaultHost: "github.com",
      }),
      {
        host: "github.com-scale",
        locator: { host: "github.com-scale", owner: "me", name: "web" },
      },
    );
  });

  it("requires matching SSH evidence to normalize a dotted hint", () => {
    for (const remotes of [
      "",
      "origin\tgit@github.com-work:me/web.git (fetch)",
      "origin\tgit@github.com-scale:me/web.git (push)",
    ]) {
      assert.deepStrictEqual(
        resolveGitHubRepository({
          remotes,
          resolved: "",
          hostHint: "GitHub.com-Scale",
          defaultHost: "github.com",
        }),
        { host: "github.com-scale", locator: null },
      );
    }
  });

  it("preserves a dotted hint when matching remotes use both transports", () => {
    const entries = [
      "origin\thttps://github.com-scale/me/web.git (fetch)",
      "upstream\tgit@github.com-scale:acme/web.git (fetch)",
    ];
    for (const [remotes, hostHint, resolved] of [
      [entries.join("\n"), "github.com-scale", "remote.origin.gh-resolved base"],
      [entries.join("\n"), "github.com-scale", ""],
      [entries.toReversed().join("\n"), undefined, "remote.origin.gh-resolved base"],
      [entries.toReversed().join("\n"), undefined, ""],
    ] as const) {
      assert.deepStrictEqual(
        resolveGitHubRepository({
          remotes,
          resolved,
          hostHint,
          defaultHost: "github.com",
        }),
        {
          host: "github.com-scale",
          locator: { host: "github.com-scale", owner: "me", name: "web" },
        },
      );
    }
  });

  it("retains dotless hint compatibility without remote evidence", () => {
    for (const hostHint of ["github", "github-work", "workgithub"]) {
      assert.deepStrictEqual(
        resolveGitHubRepository({ remotes: "", resolved: "", hostHint, defaultHost: hostHint }),
        { host: "github.com", locator: null },
      );
    }
  });

  it("keeps a hostile host hint and its remote off github.com", () => {
    const remotes = "origin\tgit@github.com-evil.example:acme/web.git (fetch)";
    assert.deepStrictEqual(
      resolveGitHubRepository({
        remotes,
        resolved: "",
        hostHint: "github.com-evil.example",
        defaultHost: "github.com-evil.example",
      }),
      {
        host: "github.com-evil.example",
        locator: { host: "github.com-evil.example", owner: "acme", name: "web" },
      },
    );
  });
});

describe("parseGitHubRepositorySelector", () => {
  it("reads host/owner/name only when the host is a plain hostname", () => {
    assert.deepStrictEqual(parseGitHubRepositorySelector("GHE.corp:8443/acme/web", "github.com"), {
      host: "ghe.corp:8443",
      owner: "acme",
      name: "web",
    });
    for (const selector of [
      "evil.com#.ghe.com/acme/web",
      "evil.com?.ghe.com/acme/web",
      "token@evil.com/acme/web",
      "evil.com\\.ghe.com/acme/web",
      "-evil.com/acme/web",
    ]) {
      assert.strictEqual(parseGitHubRepositorySelector(selector, "github.com"), null, selector);
    }
  });
});

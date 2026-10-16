import { describe, expect, it } from "vite-plus/test";

import {
  gitHubOwnersOnHost,
  gitHubRepositoryOf,
  groupGitHubAccounts,
  nextGitHubHosts,
  nextGitHubRules,
} from "./githubAccounts.ts";

describe("groupGitHubAccounts", () => {
  it("groups logins by host, keeping broken and environment logins out of the picker", () => {
    expect(
      groupGitHubAccounts([
        { host: "github.com", account: "personal", active: true, authenticated: true },
        { host: "github.com", account: "work", active: false, authenticated: true },
        { host: "github.com", account: "old", active: false, authenticated: false, error: "bad" },
        {
          host: "github.com",
          account: "bot",
          active: false,
          authenticated: true,
          environmentVariable: "GH_TOKEN",
        },
        { host: "ghe.acme.test", account: "jm", active: false, authenticated: true },
      ]),
    ).toEqual([
      {
        host: "github.com",
        activeAccount: "personal",
        selectable: ["personal", "work"],
        broken: [
          { host: "github.com", account: "old", active: false, authenticated: false, error: "bad" },
        ],
        environmentVariable: "GH_TOKEN",
      },
      {
        host: "ghe.acme.test",
        activeAccount: "jm",
        selectable: ["jm"],
        broken: [],
        environmentVariable: null,
      },
    ]);
  });
});

describe("nextGitHubHosts", () => {
  it("pins an account, keeps other hosts, and drops a host back on gh's defaults", () => {
    const other = { "ghe.acme.test": { enabled: false } };
    const pinned = nextGitHubHosts(other, "github.com", { account: "work" });
    expect(pinned).toEqual({ ...other, "github.com": { enabled: true, account: "work" } });

    const disabled = nextGitHubHosts(pinned, "github.com", { enabled: false });
    expect(disabled["github.com"]).toEqual({ enabled: false, account: "work" });

    expect(nextGitHubHosts(disabled, "github.com", { enabled: true, account: null })).toEqual(
      other,
    );
  });
});

describe("owner rules", () => {
  it("keeps a host that only has owner rules, and drops it once the last rule goes", () => {
    const owners = nextGitHubRules(undefined, "Acme", "work");
    expect(owners).toEqual({ acme: "work" });
    const withRule = nextGitHubHosts({}, "github.com", { owners });
    expect(withRule).toEqual({ "github.com": { enabled: true, owners: { acme: "work" } } });

    // Pinning the host's account leaves the owner's rule alone.
    const pinned = nextGitHubHosts(withRule, "github.com", { account: "personal" });
    expect(pinned["github.com"]).toEqual({
      enabled: true,
      account: "personal",
      owners: { acme: "work" },
    });

    const cleared = nextGitHubRules(pinned["github.com"]?.owners, "acme", null);
    expect(nextGitHubHosts(pinned, "github.com", { account: null, owners: cleared })).toEqual({});
  });

  it("keeps a repository's rule beside its owner's, and drops the host once both go", () => {
    const owners = nextGitHubRules(undefined, "acme", "work");
    const repositories = nextGitHubRules(undefined, "Acme/Handbook", "personal");
    const hosts = nextGitHubHosts(nextGitHubHosts({}, "github.com", { owners }), "github.com", {
      repositories,
    });
    expect(hosts).toEqual({
      "github.com": {
        enabled: true,
        owners: { acme: "work" },
        repositories: { "acme/handbook": "personal" },
      },
    });

    const withoutOwner = nextGitHubHosts(hosts, "github.com", {
      owners: nextGitHubRules(owners, "acme", null),
    });
    expect(withoutOwner["github.com"]?.repositories).toEqual({ "acme/handbook": "personal" });
    expect(
      nextGitHubHosts(withoutOwner, "github.com", {
        repositories: nextGitHubRules(repositories, "acme/handbook", null),
      }),
    ).toEqual({});
  });

  it("keys a project's repository by its GitHub host and lowercased owner/name", () => {
    const locator = {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "git@github.com:Acme/Handbook.git",
    };
    expect(
      gitHubRepositoryOf({
        canonicalKey: "github.com/Acme/Handbook",
        locator,
        provider: "github",
        owner: "Acme",
        name: "Handbook",
      }),
    ).toEqual({ host: "github.com", repository: "acme/handbook" });
    expect(gitHubRepositoryOf({ canonicalKey: "github.com/acme", locator, owner: "acme" })).toBe(
      null,
    );
    expect(gitHubRepositoryOf(null)).toBe(null);
  });

  it("lists the owners of the host's projects and of every rule, once each", () => {
    const identity = (canonicalKey: string, owner: string) => ({
      canonicalKey,
      locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: canonicalKey },
      owner,
    });
    expect(
      gitHubOwnersOnHost(
        "github.com",
        [
          identity("github.com/Acme/web", "Acme"),
          identity("github.com/acme/api", "acme"),
          identity("github.com/me/blog", "me"),
          identity("gitlab.com/elsewhere/app", "elsewhere"),
          null,
        ],
        { gone: "work" },
      ),
    ).toEqual(["acme", "gone", "me"]);
  });
});

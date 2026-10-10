import { describe, expect, it } from "vite-plus/test";

import { groupGitHubAccounts, nextGitHubHosts } from "./GitHubAccountSettings.logic";

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

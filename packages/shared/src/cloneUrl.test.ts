import { describe, expect, it } from "vite-plus/test";

import { cloneUrlForProtocol, cloneUrlProtocol } from "./cloneUrl.ts";

describe("cloneUrlForProtocol", () => {
  it.each([
    ["ordinary", "user:password"],
    ["an embedded at sign", "user:pa@rt"],
    ["multiple at signs", "user:pa@rt@word"],
    ["encoded", "us%40er:pa%40ss%3Aword"],
  ])("separates Azure hosts from credentials (%s)", (_label, userinfo) => {
    const https = `https://${userinfo}@dev.azure.com/org/Project%20One/_git/repo%40name`;
    const ssh = `ssh://${userinfo}@ssh.dev.azure.com/v3/org/Project%20One/repo%40name`;
    expect(cloneUrlProtocol(https)).toBe("https");
    expect(cloneUrlProtocol(ssh)).toBe("ssh");
    expect(cloneUrlForProtocol(https, "ssh")).toBe(
      "git@ssh.dev.azure.com:v3/org/Project%20One/repo%40name",
    );
    expect(cloneUrlForProtocol(ssh, "https")).toBe(
      "https://dev.azure.com/org/Project%20One/_git/repo%40name",
    );
    expect(cloneUrlForProtocol(https, "https")).toBe(https);
    expect(cloneUrlForProtocol(ssh, "ssh")).toBe(ssh);
  });

  it.each([
    ["https", "ssh", "dev.azure.com", "org/project/_git/repo"],
    ["ssh", "https", "ssh.dev.azure.com", "v3/org/project/repo"],
    ["https", "ssh", "host.example", "org/repo.git"],
    ["ssh", "https", "host.example", "org/repo.git"],
  ] as const)(
    "refuses credential-bearing %s URLs with custom ports on %s switches",
    (from, to, host, path) => {
      const url = `${from}://user:pa@rt@${host}:8443/${path}`;
      expect(cloneUrlForProtocol(url, to)).toBeNull();
      expect(cloneUrlForProtocol(url, from)).toBe(url);
    },
  );

  it("drops all userinfo on generic hosts without consuming at signs in paths", () => {
    expect(cloneUrlForProtocol("https://user:pa@rt@github.com/org/repo@branch.git", "ssh")).toBe(
      "git@github.com:org/repo@branch.git",
    );
    expect(cloneUrlForProtocol("ssh://user:pa@rt@github.com/org/repo@branch.git", "https")).toBe(
      "https://github.com/org/repo@branch.git",
    );
    expect(cloneUrlForProtocol("https://github.com/org/repo@branch.git", "ssh")).toBe(
      "git@github.com:org/repo@branch.git",
    );
  });

  it.each(["https://user:pa@rt@/org/repo", "ssh://user:pa@rt@/org/repo"])(
    "refuses a credential-bearing URL without a hostname (%s)",
    (url) => {
      expect(cloneUrlProtocol(url)).toBeNull();
      expect(cloneUrlForProtocol(url, "ssh")).toBeNull();
      expect(cloneUrlForProtocol(url, "https")).toBeNull();
    },
  );

  it.each([
    "git@ssh.dev.azure.com:v3/Fabrikam/Project1/fab_repo",
    "ssh://git@ssh.dev.azure.com/v3/Fabrikam/Project1/fab_repo",
    "git@SSH.DEV.AZURE.COM:v3/Fabrikam/Project1/fab_repo",
  ])("uses Azure's HTTPS host and repository path for %s", (url) => {
    expect(cloneUrlForProtocol(url, "https")).toBe(
      "https://dev.azure.com/Fabrikam/Project1/_git/fab_repo",
    );
  });

  it.each([
    "https://dev.azure.com/Fabrikam/Project1/_git/fab_repo",
    "https://Fabrikam@dev.azure.com/Fabrikam/Project1/_git/fab_repo",
    "https://DEV.AZURE.COM/Fabrikam/Project1/_git/fab_repo",
  ])("uses Azure's SSH host and repository path for %s", (url) => {
    expect(cloneUrlForProtocol(url, "ssh")).toBe(
      "git@ssh.dev.azure.com:v3/Fabrikam/Project1/fab_repo",
    );
  });

  it("preserves encoded Azure repository components and same-protocol URLs", () => {
    const ssh = "git@ssh.dev.azure.com:v3/Fabrikam/Project%20One/fab%20repo";
    const https = "https://dev.azure.com/Fabrikam/Project%20One/_git/fab%20repo";
    expect(cloneUrlForProtocol(ssh, "https")).toBe(https);
    expect(cloneUrlForProtocol(https, "ssh")).toBe(ssh);
    expect(cloneUrlForProtocol(ssh, "ssh")).toBe(ssh);
    expect(cloneUrlForProtocol(https, "https")).toBe(https);
  });

  it("refuses Azure rewrites when the project is missing or a custom port is set", () => {
    expect(cloneUrlForProtocol("git@ssh.dev.azure.com:v3/Fabrikam/fab_repo", "https")).toBeNull();
    expect(cloneUrlForProtocol("https://dev.azure.com/Fabrikam/_git/fab_repo", "ssh")).toBeNull();
    expect(
      cloneUrlForProtocol("git@ssh.dev.azure.com:v3/Fabrikam?token/Project1/fab_repo", "https"),
    ).toBeNull();
    expect(
      cloneUrlForProtocol("https://dev.azure.com/Fabrikam/Project1/_git/fab_repo#main", "ssh"),
    ).toBeNull();
    expect(
      cloneUrlForProtocol(
        "ssh://git@ssh.dev.azure.com:2222/v3/Fabrikam/Project1/fab_repo",
        "https",
      ),
    ).toBeNull();
    expect(
      cloneUrlForProtocol("https://dev.azure.com:8443/Fabrikam/Project1/_git/fab_repo", "ssh"),
    ).toBeNull();
  });

  it("switches between scp-style SSH and HTTPS", () => {
    expect(cloneUrlForProtocol("git@github.com:pingdotgg/t3code.git", "https")).toBe(
      "https://github.com/pingdotgg/t3code.git",
    );
    expect(cloneUrlForProtocol("https://github.com/pingdotgg/t3code.git", "ssh")).toBe(
      "git@github.com:pingdotgg/t3code.git",
    );
    expect(cloneUrlForProtocol("ssh://git@gitlab.com/group/sub/repo.git", "https")).toBe(
      "https://gitlab.com/group/sub/repo.git",
    );
  });

  it("keeps the URL as is for its own protocol and drops HTTPS credentials on switch", () => {
    expect(cloneUrlForProtocol("https://token@github.com/a/b.git", "https")).toBe(
      "https://token@github.com/a/b.git",
    );
    expect(cloneUrlForProtocol("https://token@github.com/a/b.git", "ssh")).toBe(
      "git@github.com:a/b.git",
    );
  });

  it("refuses rewrites that would guess wrong", () => {
    expect(cloneUrlForProtocol("ssh://git@host.example:2222/a/b.git", "https")).toBeNull();
    expect(cloneUrlForProtocol("https://host.example:8443/a/b.git", "ssh")).toBeNull();
    expect(cloneUrlForProtocol("https://host.example:8443/a/b.git", "https")).toBe(
      "https://host.example:8443/a/b.git",
    );
    expect(cloneUrlForProtocol("/srv/git/repo.git", "https")).toBeNull();
    expect(cloneUrlProtocol("file:///srv/git/repo.git")).toBeNull();
  });
});

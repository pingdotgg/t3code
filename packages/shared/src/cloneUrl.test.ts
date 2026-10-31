import { describe, expect, it } from "vite-plus/test";

import { cloneUrlForProtocol, cloneUrlProtocol } from "./cloneUrl.ts";

describe("cloneUrlForProtocol", () => {
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

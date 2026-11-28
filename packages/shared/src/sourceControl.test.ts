import { describe, expect, it } from "vite-plus/test";

import { isSshRemoteUrl } from "./sourceControl.ts";

describe("isSshRemoteUrl", () => {
  it.each([
    "git@github.com:owner/repo.git",
    "alice+ci@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo.git",
    "github.com:owner/repo.git",
    "github-work:owner/repo.git",
    "gitserver:repo.git",
    "ssh.dev.azure.com:v3/Org/My Project/My Repo",
  ])("reads %s as SSH", (remoteUrl) => {
    expect(isSshRemoteUrl(remoteUrl)).toBe(true);
  });

  it.each([
    "https://github.com/owner/repo.git",
    "C:/repos/repo",
    "/srv/git/repo.git",
    "./team:group/repo",
    "file:///srv/git/repo.git",
    "hg::owner/repo",
    "C:repo.git",
    "ssh.dev.azure.com :v3/Org/MyProject/MyRepo",
    "-oProxyCommand=x@github.com:owner/repo.git",
    "@github.com:owner/repo.git",
    ".\\dir@github.com:owner/repo",
  ])("does not read %s as SSH", (remoteUrl) => {
    expect(isSshRemoteUrl(remoteUrl)).toBe(false);
  });
});

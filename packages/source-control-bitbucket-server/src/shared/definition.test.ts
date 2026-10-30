import { describe, expect, it } from "vite-plus/test";
import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
import { definition, repositoryNameFromRemoteUrl } from "./definition.ts";

describe("Data Center URLs", () => {
  it.each([
    [
      "https://code.example.com:8443/stash/projects/PROJ/repos/web/pull-requests/42/diff",
      "proj/web",
      "https://code.example.com:8443/stash/projects/PROJ/repos/web",
    ],
    [
      "https://code.example.com/users/jane/repos/web/pull-requests/42",
      "~jane/web",
      "https://code.example.com/users/jane/repos/web",
    ],
  ])("parses %s without losing the mount or personal project", (url, repository, repositoryUrl) => {
    expect(definition.parseChangeRequestUrl(new URL(url))).toMatchObject({
      number: 42,
      host: "code.example.com",
      repository,
      repositoryUrl,
    });
    expect(
      definition.changeRequestUrl({
        host: "code.example.com",
        repository,
        number: 43,
        remoteUrl: "ssh://git@code.example.com:7999/PROJ/web.git",
        webUrl: repositoryUrl,
      }),
    ).toBe(`${repositoryUrl}/pull-requests/43`);
  });

  it("only constructs PR links when the web address is known", () => {
    const input = { host: "code.example.com", repository: "PROJ/web", number: 43 };
    for (const remoteUrl of [
      "ssh://git@code.example.com:7999/PROJ/web.git",
      "git@code.example.com:PROJ/web.git",
      undefined,
    ]) {
      expect(
        definition.changeRequestUrl({ ...input, ...(remoteUrl ? { remoteUrl } : {}) }),
      ).toBeNull();
    }
    const remoteUrl = "https://code.example.com:8443/stash/scm/PROJ/web.git";
    for (const host of ["code.example.com", "CODE.EXAMPLE.COM:8443"]) {
      expect(definition.changeRequestUrl({ ...input, host, remoteUrl })).toBe(
        "https://code.example.com:8443/stash/projects/PROJ/repos/web/pull-requests/43",
      );
    }
    for (const host of ["other.example.com", "code.example.com:9443"]) {
      expect(definition.changeRequestUrl({ ...input, host, remoteUrl })).toBeNull();
    }
  });

  it("matches repositories and read access against the configured web authority", () => {
    for (const authority of ["code.example.com:8443", "code.example.com"]) {
      const identity = {
        canonicalKey: "ssh.example.com/proj/web",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "ssh://git@ssh.example.com:7999/PROJ/web.git",
        },
        displayName: "PROJ/web",
        webUrl: `https://${authority}/stash/projects/PROJ/repos/web`,
      };
      const own = { host: authority, repository: "proj/web", number: 42 };
      expect(definition.isChangeRequestInRepository(identity, own)).toBe(true);
      expect(definition.canReadChangeRequestOnHost(identity, own)).toBe(true);
      const otherRepository = { ...own, repository: "proj/other" };
      expect(definition.isChangeRequestInRepository(identity, otherRepository)).toBe(false);
      expect(definition.canReadChangeRequestOnHost(identity, otherRepository)).toBe(true);
      for (const host of ["other.example.com", "code.example.com:9443"]) {
        const otherHost = { ...own, host: "code.example.com", authority: host };
        expect(definition.isChangeRequestInRepository(identity, otherHost)).toBe(false);
        expect(definition.canReadChangeRequestOnHost(identity, otherHost)).toBe(false);
      }
    }
  });

  it.each([
    "https://code.example.com/scm/PROJ/web.git",
    "https://bitbucket.example.com/stash/scm/PROJ/web.git",
    "ssh://git@bitbucket.example.com:7999/PROJ/web.git",
    "git@bitbucket.example.com:PROJ/web.git",
  ])("recognizes %s and strips clone mounts", (remote) => {
    expect(recognizeRemoteWith(definition, remote)?.kind).toBe("bitbucket-server");
    expect(repositoryNameFromRemoteUrl(remote)).toBe("PROJ/web");
  });

  it("leaves Cloud and unrelated hosts alone", () => {
    for (const remote of [
      "git@bitbucket.org:team/web.git",
      "ssh://git@ssh.bitbucket.org:443/team/web.git",
      "git@github.com:team/web.git",
    ])
      expect(recognizeRemoteWith(definition, remote)).toBeNull();
    expect(
      definition.parseChangeRequestUrl(new URL("https://bitbucket.org/team/web/pull-requests/42")),
    ).toBeNull();
  });
});

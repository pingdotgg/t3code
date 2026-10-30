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
        webUrl: repositoryUrl,
      }),
    ).toBe(`${repositoryUrl}/pull-requests/43`);
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

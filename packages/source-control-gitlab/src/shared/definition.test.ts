import {
  makeSourceControlDefinitionRegistry,
  recognizeRemoteWith,
} from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";

import { definition } from "./definition.ts";

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

describe("GitLab change request URLs", () => {
  it("reads a merge request on any host, nested groups and all", () => {
    expect(parse("https://gitlab.com/t3tools/platform/t3code/-/merge_requests/42")).toEqual({
      host: "gitlab.com",
      repository: "t3tools/platform/t3code",
      number: 42,
      repositoryUrl: "https://gitlab.com/t3tools/platform/t3code",
    });
    expect(parse("https://code.acme.test/team/project/-/merge_requests/9")).toMatchObject({
      host: "code.acme.test",
      repository: "team/project",
      number: 9,
    });
  });

  it("keeps pull-like segments inside nested repository paths", () => {
    expect(
      parse("https://gitlab.example.test/group/pull/123/repo/-/merge_requests/42")?.repositoryUrl,
    ).toBe("https://gitlab.example.test/group/pull/123/repo");
  });

  it("leaves issues and single-segment paths alone", () => {
    expect(parse("https://gitlab.com/t3tools/t3code/-/issues/12")).toBeNull();
    expect(parse("https://gitlab.com/t3code/-/merge_requests/12")).toBeNull();
  });

  it("recognizes only merge request URLs it can parse", () => {
    for (const url of [
      "https://gitlab.com/g/p?x=/-/merge_requests/5",
      "https://gitlab.com/g/p#/-/merge_requests/5",
      "https://gitlab.com?x=/g/p/-/merge_requests/5",
      "https://gitlab.com#/g/p/-/merge_requests/5",
      "https://gitlab.com/t3code/-/merge_requests/12",
      "https://gitlab.com/g//-/merge_requests/5",
    ]) {
      expect(definition.isChangeRequestReference(url), url).toBe(false);
      expect(parse(url), url).toBeNull();
    }
    for (const url of [
      "https://code.acme.test/a/b/c/-/merge_requests/7?tab=diffs",
      "http://git.internal/a/b/c/-/merge_requests/7#note_1",
      "https://code.acme.test/a/b/c/-/merge_requests/7/diffs",
    ]) {
      expect(definition.isChangeRequestReference(url), url).toBe(true);
      expect(parse(url), url).toMatchObject({ repository: "a/b/c", number: 7 });
    }
  });

  it("builds merge request URLs below the repository", () => {
    expect(
      definition.changeRequestUrl({
        host: "gitlab.com",
        repository: "group/sub/project",
        number: 4,
      }),
    ).toBe("https://gitlab.com/group/sub/project/-/merge_requests/4");
    expect(
      definition.changeRequestUrl({
        host: "gitlab.internal",
        repository: "team/app",
        number: 5,
        remoteUrl: "http://gitlab.internal:8080/team/app.git",
      }),
    ).toBe("http://gitlab.internal:8080/team/app/-/merge_requests/5");
    expect(
      definition.changeRequestUrl({
        host: "gitlab.internal",
        repository: "team/app",
        number: 5,
        remoteUrl: "git@gitlab.internal:team/app.git",
      }),
    ).toBe("https://gitlab.internal/team/app/-/merge_requests/5");
    expect(
      definition.changeRequestUrl({
        host: "gitlab.com",
        repository: "group/sub/project",
        number: 4,
        webUrl: "https://gitlab.com/group/sub/project",
      }),
    ).toBe("https://gitlab.com/group/sub/project/-/merge_requests/4");
  });

  it.each([
    [
      "altssh.gitlab.com",
      "https://gitlab.com",
      "ssh://git@altssh.gitlab.com:443/group/sub/project.git",
    ],
    [
      "altssh.gitlab.example.com",
      "https://altssh.gitlab.example.com",
      "ssh://git@altssh.gitlab.example.com:443/group/sub/project.git",
    ],
  ])("builds merge request and commit URLs for %s on %s", (host, origin, remoteUrl) => {
    const sha = "a".repeat(40);
    expect(
      definition.changeRequestUrl({ host, repository: "group/sub/project", number: 4, remoteUrl }),
    ).toBe(`${origin}/group/sub/project/-/merge_requests/4`);
    expect(definition.commitUrl({ host, repository: "group/sub/project", sha, remoteUrl })).toBe(
      `${origin}/group/sub/project/-/commit/${sha}`,
    );
  });

  it("links authors, bots included, to their profile on the repository's host", () => {
    expect(definition.authorProfileUrl("TonybynMp4", "https://gitlab.com/group/sub/project")).toBe(
      "https://gitlab.com/TonybynMp4",
    );
    expect(
      definition.authorProfileUrl(
        "project_278964_bot_89f97e2c",
        "http://gitlab.internal:8080/team/app/-/merge_requests/5",
      ),
    ).toBe("http://gitlab.internal:8080/project_278964_bot_89f97e2c");
  });
});

describe("GitLab CLI commands", () => {
  it("recognizes shell merges and closes, including glab's `accept` alias", () => {
    for (const command of ["glab mr merge 7 --yes", "glab mr accept 7 --yes", "glab mr close 7"]) {
      expect(definition.changeRequestCloseCommand.test(command), command).toBe(true);
    }
    expect(definition.changeRequestCloseCommand.test("glab mr view 7")).toBe(false);
  });

  it("recognizes shell creates, including glab's `new` alias", () => {
    for (const command of ["glab mr create --fill --yes", "glab mr new --fill --yes"]) {
      expect(definition.changeRequestCreateCommand.test(command), command).toBe(true);
    }
    expect(definition.changeRequestCreateCommand.test("glab mr view 7")).toBe(false);
  });
});

describe("GitLab remotes", () => {
  const recognize = (url: string) => recognizeRemoteWith(definition, url);

  it("keeps an HTTP port in the base URL and drops an SSH one", () => {
    expect(recognize("https://gitlab.com:8443/group/repo.git")).toEqual({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.com:8443",
    });
    expect(recognize("ssh://git@gitlab.example.test:24/group/repo.git")).toEqual({
      kind: "gitlab",
      name: "GitLab Self-Hosted",
      baseUrl: "https://gitlab.example.test",
    });
    expect(recognize("gitlab@gitlab.example.com:group/project.git")?.baseUrl).toBe(
      "https://gitlab.example.com",
    );
  });

  it("matches complete DNS labels only", () => {
    expect(recognize("https://notgitlab.example.com/group/repo.git")).toBeNull();
  });

  it.each([
    "ssh://git@altssh.gitlab.com:443/group/project.git",
    "git@altssh.gitlab.com:group/project.git",
  ])("recognizes GitLab.com's port 443 SSH host in %s", (url) => {
    expect(recognize(url)).toEqual({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.com",
    });
  });

  it("reads a self-hosted altssh host as its own server", () => {
    expect(recognize("ssh://git@altssh.gitlab.example.com:443/group/project.git")).toEqual({
      kind: "gitlab",
      name: "GitLab Self-Hosted",
      baseUrl: "https://altssh.gitlab.example.com",
    });
  });
});

describe("GitLab repository keys", () => {
  const registry = makeSourceControlDefinitionRegistry([definition]);

  it.each([
    "git@gitlab.com:Group/Sub/Project.git",
    "ssh://git@altssh.gitlab.com:443/Group/Sub/Project.git",
    "git@altssh.gitlab.com:Group/Sub/Project.git",
    "https://gitlab.com/Group/Sub/Project.git",
  ])("names %s on gitlab.com, where its merge requests live", (remoteUrl) => {
    const canonicalKey = registry.repositoryKeyFromRemote(remoteUrl);
    expect(canonicalKey).toBe("gitlab.com/group/sub/project");
    const link = parse("https://gitlab.com/group/sub/project/-/merge_requests/5")!;
    expect(
      definition.isChangeRequestInRepository(
        {
          canonicalKey,
          displayName: "group/sub/project",
          locator: { source: "git-remote", remoteName: "origin", remoteUrl },
        },
        link,
      ),
    ).toBe(true);
    expect(registry.changeRequestHost({ canonicalKey }, "gitlab")).toBe("gitlab.com");
  });

  it("matches merge requests for a key saved under altssh.gitlab.com", () => {
    const canonicalKey = "altssh.gitlab.com/group/sub/project";
    expect(registry.canonicalRepositoryKey(canonicalKey)).toBe("gitlab.com/group/sub/project");
    const identity = {
      canonicalKey,
      displayName: "group/sub/project",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "ssh://git@altssh.gitlab.com:443/group/sub/project.git",
      },
    };
    const link = parse("https://gitlab.com/group/sub/project/-/merge_requests/5")!;
    expect(definition.isChangeRequestInRepository(identity, link)).toBe(true);
    expect(definition.canReadChangeRequestOnHost(identity, link)).toBe(true);
  });

  it.each([
    [
      "ssh://git@altssh.gitlab.example.com:443/team/project.git",
      "altssh.gitlab.example.com/team/project",
    ],
    [
      "git@altssh.gitlab.com.evil.example:team/project.git",
      "altssh.gitlab.com.evil.example/team/project",
    ],
  ])("leaves the key of %s alone", (remoteUrl, key) => {
    expect(registry.repositoryKeyFromRemote(remoteUrl)).toBe(key);
    expect(registry.canonicalRepositoryKey(key)).toBe(key);
  });
});

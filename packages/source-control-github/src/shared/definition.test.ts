import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";

import { definition } from "./definition.ts";

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

describe("GitHub change request URLs", () => {
  it("reads a pull request on any host, lower-casing host and repository", () => {
    expect(parse("https://github.com/T3Tools/T3Code/pull/123/files?w=1#diff")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
      repositoryUrl: "https://github.com/T3Tools/T3Code",
    });
    expect(parse("https://GHE.Example.com:8443/acme/web/pull/42/")).toEqual({
      host: "ghe.example.com",
      repository: "acme/web",
      number: 42,
      repositoryUrl: "https://ghe.example.com:8443/acme/web",
    });
  });

  it("claims only the two-segment pull route", () => {
    for (const url of [
      "https://github.com/t3tools/t3code/issues/123",
      "https://github.com/t3tools/t3code/pulls/123",
      "https://github.com/t3tools/t3code/pull/abc",
      "https://github.com/t3tools/t3code/pull/0",
      "https://github.com/group/sub/repo/pull/1",
      "ftp://github.com/t3tools/t3code/pull/1",
    ]) {
      expect(parse(url), url).toBeNull();
    }
  });

  it("builds pull request URLs below the repository, keeping an HTTP remote's origin", () => {
    expect(
      definition.changeRequestUrl({
        host: "github.acme.test",
        repository: "platform/api",
        number: 7,
        remoteUrl: "http://token@github.acme.test:8443/team/default.git",
      }),
    ).toBe("http://github.acme.test:8443/platform/api/pull/7");
    for (const remoteUrl of [
      "git@github.acme.test:team/default.git",
      "git://github.acme.test/team/default.git",
      "http://other.test/team/default.git",
    ]) {
      expect(
        definition.changeRequestUrl({
          host: "github.acme.test",
          repository: "platform/api",
          number: 9,
          remoteUrl,
        }),
        remoteUrl,
      ).toBe("https://github.acme.test/platform/api/pull/9");
    }
    expect(
      definition.changeRequestUrl({
        host: "github.com",
        repository: "pull/1",
        number: 43,
        webUrl: "https://github.com/pull/1",
      }),
    ).toBe("https://github.com/pull/1/pull/43");
  });

  // regression: #8507 the browser fallback must not open a bogus URL
  it("builds nothing from an invalid repository, number, or host", () => {
    for (const [host, repository, number] of [
      ["github.com", "acme", 1],
      ["github.com", "../repository", 1],
      ["github.com", "acme/%2e%2e", 1],
      ["github.com", "acme/repository?tab=1", 1],
      ["github.com", "acme/repository", 0],
      ["bad host", "acme/repository", 1],
    ] as const) {
      expect(definition.changeRequestUrl({ host, repository, number })).toBeNull();
    }
  });

  it("turns GitHub's shared issue route into a pull request candidate", () => {
    const candidate = (url: string) =>
      definition.changeRequestUrlFromReferenceAutolink(new URL(url));
    expect(candidate("https://github.com/pingdotgg/t3code/issues/8600#issuecomment-1")).toBe(
      "https://github.com/pingdotgg/t3code/pull/8600#issuecomment-1",
    );
    expect(candidate("https://code.github.example.com/acme/web/issues/42")).toBe(
      "https://code.github.example.com/acme/web/pull/42",
    );
    expect(candidate("https://github.com/pingdotgg/t3code/issues/not-a-number")).toBeNull();
    expect(candidate("https://code.example.test/acme/web/issues/42")).toBeNull();
  });
});

describe("GitHub remotes", () => {
  const recognize = (url: string) => recognizeRemoteWith(definition, url);

  it("recognises github.com, ghe.com subdomains and hosts with a github label", () => {
    expect(recognize("deploy@github.com:owner/repo.git")).toEqual({
      kind: "github",
      name: "GitHub",
      baseUrl: "https://github.com",
    });
    expect(recognize("https://acme.ghe.com/owner/repo.git")).toEqual({
      kind: "github",
      name: "GitHub Self-Hosted",
      baseUrl: "https://acme.ghe.com",
    });
    expect(recognize("git@acme.ghe.com:owner/repo.git")?.kind).toBe("github");
    expect(recognize("https://github.example.com:8443/owner/repo.git")?.baseUrl).toBe(
      "https://github.example.com:8443",
    );
  });

  it("does not claim ghe.com itself or a label that only contains github", () => {
    expect(recognize("https://ghe.com/owner/repo.git")).toBeNull();
    expect(recognize("https://notgithub.example.com/owner/repo.git")).toBeNull();
  });
});

describe("GitHub media URLs", () => {
  const media = (url: string) => definition.mediaUrl(new URL(url));

  it("fetches every spelling of an upload or committed file from one canonical URL", () => {
    expect(
      media("https://github.com/user-attachments/assets/1a1842fb-6383-492f-873c-57aa0033fa6c"),
    ).toEqual({
      fetchUrl: "https://github.com/user-attachments/assets/1a1842fb-6383-492f-873c-57aa0033fa6c",
      fileName: "1a1842fb-6383-492f-873c-57aa0033fa6c",
      kind: "video",
      immutable: true,
    });
    expect(media("https://github.com/owner/repo/blob/main/docs/shot.png")).toEqual({
      fetchUrl: "https://raw.githubusercontent.com/owner/repo/main/docs/shot.png",
      fileName: "shot.png",
    });
    expect(media("https://github.com/owner/repo/assets/45952064/1a1842fb")?.fetchUrl).toBe(
      "https://github.com/owner/repo/assets/45952064/1a1842fb",
    );
    expect(media("https://media.githubusercontent.com/media/owner/repo/main/a.mp4")).toEqual({
      fetchUrl: "https://media.githubusercontent.com/media/owner/repo/main/a.mp4",
      fileName: "a.mp4",
    });
    expect(media("https://raw.githubusercontent.com/o/r/main/100%.png")?.fileName).toBe("100%.png");
  });

  it("marks only uploads and files at a full commit SHA as immutable", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    for (const url of [
      "https://github.com/user-attachments/assets/1a1842fb-6383-492f-873c-57aa0033fa6c",
      "https://github.com/owner/repo/assets/45952064/1a1842fb",
      `https://github.com/owner/repo/blob/${sha}/docs/shot.png`,
      `https://raw.githubusercontent.com/owner/repo/${sha}/docs/shot.png`,
    ]) {
      expect(media(url)?.immutable, url).toBe(true);
    }
    for (const url of [
      "https://raw.githubusercontent.com/owner/repo/0123456789ab/docs/shot.png",
      `https://media.githubusercontent.com/media/owner/repo/${sha}/a.mp4`,
    ]) {
      expect(media(url)?.immutable, url).toBeUndefined();
    }
  });

  it("claims nothing a request without a credential loads just as well", () => {
    for (const url of [
      "https://example.com/shot.png",
      "http://github.com/user-attachments/assets/1a1842fb",
      "https://github.com/owner/repo/pull/1",
      "https://github.com/owner/repo/blob/main/",
      "https://objects.githubusercontent.com/github-production-user-asset/shot.png",
    ]) {
      expect(media(url), url).toBeNull();
    }
  });
});

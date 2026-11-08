import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";

import { canonicalizePullRequestUrl, definition, parsePullRequestUrl } from "./definition.ts";

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

describe("GitCafe change request URLs", () => {
  it.each(["git.cafe", "staging.git.cafe"])("normalizes links for storage on %s", (host) => {
    for (const repository of ["web", "pull", "pulls"]) {
      for (const route of ["pull", "pulls"]) {
        const url = `https://${host}/Acme/${repository}/${route}/42/files?w=1#diff`;
        expect(parsePullRequestUrl(url)).toMatchObject({
          host,
          repository: `acme/${repository}`,
          number: 42,
        });
        expect(definition.isChangeRequestReference(url)).toBe(true);
        expect(canonicalizePullRequestUrl(url)).toBe(`https://${host}/acme/${repository}/pulls/42`);
      }
    }
  });

  it("preserves other URLs and rejects invalid GitCafe references", () => {
    for (const url of [
      "https://github.com/team/repo/pull/7",
      "https://forge.example/team/repo/pulls/7",
      "https://not.git.cafe/team/repo/pull/7",
      "https://git.cafe.evil.test/team/repo/pull/7",
      "https://git.cafe/tfs/collection/project/_git/repo/pullrequest/7",
      "https://git.cafe/team/repo/pull/0",
      "https://git.cafe/team/repo/pulls/9007199254740992",
      "https://staging.git.cafe/team/repo/pull/7suffix",
      "ftp://git.cafe/team/repo/pull/7",
      "not a url",
    ]) {
      expect(parsePullRequestUrl(url), url).toBeNull();
      expect(definition.isChangeRequestReference(url), url).toBe(false);
      expect(canonicalizePullRequestUrl(url), url).toBe(url);
    }
  });

  it("reads its canonical /pull/ path and the older /pulls/ path on its own hosts", () => {
    for (const path of ["pull", "pulls"]) {
      expect(parse(`https://git.cafe/PingDotGG/T3Code/${path}/23897`), path).toEqual({
        host: "git.cafe",
        repository: "pingdotgg/t3code",
        number: 23897,
        repositoryUrl: "https://git.cafe/PingDotGG/T3Code",
      });
    }
    expect(parse("https://staging.git.cafe/team/repo/pull/7/files")).toMatchObject({
      host: "staging.git.cafe",
      repository: "team/repo",
      number: 7,
    });
  });

  it("leaves other hosts and routes alone", () => {
    for (const url of [
      "https://github.com/team/repo/pull/7",
      "https://forge.example/team/repo/pulls/7",
      "https://git.cafe/pingdotgg/t3code/issues/23897",
      "https://git.cafe/pingdotgg/t3code/pull/abc",
      "https://git.cafe/pingdotgg/t3code",
    ]) {
      expect(parse(url), url).toBeNull();
    }
  });

  it("builds pull request URLs below the repository", () => {
    expect(
      definition.changeRequestUrl({ host: "git.cafe", repository: "team/repo", number: 8 }),
    ).toBe("https://git.cafe/team/repo/pulls/8");
    expect(
      definition.changeRequestUrl({
        host: "git.cafe",
        repository: "team/repo",
        number: 8,
        webUrl: "https://git.cafe/Team/Repo/",
      }),
    ).toBe("https://git.cafe/Team/Repo/pulls/8");
  });
});

describe("GitCafe remotes", () => {
  it("recognises its own hosts only, without a port", () => {
    expect(recognizeRemoteWith(definition, "https://git.cafe:8443/a/b")).toEqual({
      kind: "gitcafe",
      name: "GitCafe",
      baseUrl: "https://git.cafe",
    });
    expect(recognizeRemoteWith(definition, "git@staging.git.cafe:team/repo.git")?.kind).toBe(
      "gitcafe",
    );
    expect(recognizeRemoteWith(definition, "https://cafe.example/a/b")).toBeNull();
  });
});

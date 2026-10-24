import { describe, expect, it } from "vite-plus/test";

import { definition } from "./definition.ts";

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

describe("GitCafe change request URLs", () => {
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

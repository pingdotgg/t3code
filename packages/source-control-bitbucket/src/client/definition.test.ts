import { recognizeRemoteWith } from "@t3tools/source-control-core/client/definition";
import { describe, expect, it } from "vite-plus/test";

import { definition } from "./definition.ts";

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

describe("Bitbucket change request URLs", () => {
  it("reads a pull request on Bitbucket hosts", () => {
    expect(parse("https://bitbucket.org/workspace/repo/pull-requests/5/diff")).toEqual({
      host: "bitbucket.org",
      repository: "workspace/repo",
      number: 5,
      repositoryUrl: "https://bitbucket.org/workspace/repo",
    });
    expect(parse("https://code.bitbucket.example.test/team/repo/pull-requests/6")).toMatchObject({
      host: "code.bitbucket.example.test",
      number: 6,
    });
  });

  it("leaves other hosts alone", () => {
    expect(parse("https://scm.example.test/workspace/repo/pull-requests/5")).toBeNull();
  });

  it("builds pull request URLs below the repository", () => {
    expect(
      definition.changeRequestUrl({ host: "bitbucket.org", repository: "w/repo", number: 5 }),
    ).toBe("https://bitbucket.org/w/repo/pull-requests/5");
    expect(
      definition.changeRequestUrl({
        host: "bitbucket.org",
        repository: "w/repo",
        number: 5,
        webUrl: "https://bitbucket.org/w/repo",
      }),
    ).toBe("https://bitbucket.org/w/repo/pull-requests/5");
  });
});

describe("Bitbucket remotes", () => {
  const recognize = (url: string) => recognizeRemoteWith(definition, url);

  it("recognises bitbucket.org and hosts with a bitbucket label", () => {
    expect(recognize("git@bitbucket.org:workspace/repo.git")).toEqual({
      kind: "bitbucket",
      name: "Bitbucket",
      baseUrl: "https://bitbucket.org",
    });
    expect(recognize("https://bitbucket.example.com/workspace/repo.git")?.name).toBe(
      "Bitbucket Self-Hosted",
    );
    expect(recognize("https://notbitbucket.example.com/workspace/repo.git")).toBeNull();
  });
});

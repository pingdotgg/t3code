import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
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
        host: "gitlab.com",
        repository: "group/sub/project",
        number: 4,
        webUrl: "https://gitlab.com/group/sub/project",
      }),
    ).toBe("https://gitlab.com/group/sub/project/-/merge_requests/4");
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
});

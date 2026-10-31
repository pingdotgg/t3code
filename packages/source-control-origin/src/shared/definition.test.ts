import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";

import { canonicalizePullRequestUrl, definition, parsePullRequestUrl } from "./definition.ts";

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

describe("Origin change request URLs", () => {
  it("parses codebase pull request URLs on cursor.com", () => {
    for (const host of ["cursor.com", "www.cursor.com"]) {
      const url = `https://${host}/codebase/Acme/Rocket/pull/17/files?w=1#diff`;
      expect(parsePullRequestUrl(url)).toMatchObject({
        host,
        repository: "acme/rocket",
        number: 17,
      });
      expect(definition.isChangeRequestReference(url)).toBe(true);
      expect(canonicalizePullRequestUrl(url)).toBe(
        "https://cursor.com/codebase/acme/rocket/pull/17",
      );
    }
  });

  it("rejects other hosts and routes", () => {
    for (const url of [
      "https://github.com/team/repo/pull/7",
      "https://origin.cursor.com/acme/rocket/pull/17",
      "https://cursor.com/acme/rocket/pull/17",
      "https://cursor.com/codebase/acme/rocket/issues/17",
      "https://evil.cursor.com/codebase/acme/rocket/pull/17",
      "not a url",
    ]) {
      expect(parsePullRequestUrl(url), url).toBeNull();
      expect(definition.isChangeRequestReference(url), url).toBe(false);
      expect(canonicalizePullRequestUrl(url), url).toBe(url);
    }
  });

  it("parses the canonical path shape", () => {
    expect(parse("https://cursor.com/codebase/PingDotGG/T3Code/pull/23897")).toEqual({
      host: "cursor.com",
      repository: "pingdotgg/t3code",
      number: 23897,
      repositoryUrl: "https://cursor.com/codebase/pingdotgg/t3code",
    });
  });

  it("builds pull request and commit URLs on cursor.com", () => {
    expect(
      definition.changeRequestUrl({
        host: "origin.cursor.com",
        repository: "team/repo",
        number: 8,
      }),
    ).toBe("https://cursor.com/codebase/team/repo/pull/8");
    const sha = "9a41f0c3d2b8e7f6a5c4d3e2f1b0a9c8d7e6f5a4";
    expect(
      definition.commitUrl({
        host: "origin.cursor.com",
        repository: "team/repo",
        sha,
      }),
    ).toBe(`https://cursor.com/codebase/team/repo/commit/${sha}`);
    expect(
      definition.parseCommitUrl(new URL(`https://cursor.com/codebase/team/repo/commit/${sha}`)),
    ).toMatchObject({
      host: "cursor.com",
      repository: "team/repo",
      sha,
    });
  });
});

describe("Origin remotes", () => {
  it("recognises origin.cursor.com only", () => {
    expect(recognizeRemoteWith(definition, "https://origin.cursor.com/a/b")).toEqual({
      kind: "origin",
      name: "Origin",
      baseUrl: "https://origin.cursor.com",
    });
    expect(recognizeRemoteWith(definition, "git@origin.cursor.com:team/repo.git")?.kind).toBe(
      "origin",
    );
    expect(recognizeRemoteWith(definition, "https://cursor.com/codebase/a/b")).toBeNull();
    expect(recognizeRemoteWith(definition, "https://github.com/a/b")).toBeNull();
  });
});

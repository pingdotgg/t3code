import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";

import { definition } from "./definition.ts";

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

describe("Bitbucket change request URLs", () => {
  it("reads a pull request on Bitbucket hosts", () => {
    expect(
      definition.isChangeRequestReference(
        "https://bitbucket.org/workspace/repo/pull-requests/5/diff",
      ),
    ).toBe(true);
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
    expect(
      definition.isChangeRequestReference(
        "https://scm.example.test/workspace/repo/pull-requests/5",
      ),
    ).toBe(false);
    expect(
      definition.isChangeRequestReference("https://bitbucket.org/workspace/repo/src/main"),
    ).toBe(false);
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

describe("Bitbucket media", () => {
  it.each([
    ["https://bitbucket.org/acme/app/downloads/shot.png", "downloads/shot.png"],
    ["https://www.bitbucket.org/acme/app/downloads/shot.png", "downloads/shot.png"],
    ["https://bitbucket.org/acme/app/raw/abc123/docs/shot.png", "src/abc123/docs/shot.png"],
    ["https://bitbucket.org/acme/app/src/main/docs/shot.png?raw=1", "src/main/docs/shot.png"],
    [
      "https://api.bitbucket.org/2.0/repositories/acme/app/downloads/shot.png",
      "downloads/shot.png",
    ],
    ["https://api.bitbucket.org/2.0/repositories/acme/app/src/main/shot.png", "src/main/shot.png"],
  ])("recognizes private media at %s", (source, path) => {
    expect(definition.mediaUrl?.(new URL(source))).toEqual({
      fetchUrl: `https://api.bitbucket.org/2.0/repositories/acme/app/${path}`,
      fileName: "shot.png",
    });
  });

  it.each([
    "https://example.com/acme/app/downloads/shot.png",
    "http://bitbucket.org/acme/app/downloads/shot.png",
    "https://bitbucket.org.evil.test/acme/app/downloads/shot.png",
    "https://user:token@bitbucket.org/acme/app/downloads/shot.png",
    "https://bitbucket.org:8443/acme/app/downloads/shot.png",
    "https://bitbucket.org/acme/app/pull-requests/1",
    "https://bitbucket.org/acme/app/src/main/",
    "https://bitbucket.org/acme/app/src/main",
    "https://api.bitbucket.org/2.0/repositories/acme/app/raw/main/shot.png",
    "https://api.bitbucket.org/2.0/users/acme/app/downloads/shot.png",
  ])("leaves non-media and untrusted URLs alone: %s", (source) => {
    expect(definition.mediaUrl?.(new URL(source))).toBeNull();
  });

  it.each([
    ["shot%20one.png", "shot one.png"],
    ["100%.png", "100%.png"],
    ["%00%2Fshot.png", "shot.png"],
  ])("uses a safe display name for %s", (segment, fileName) => {
    expect(
      definition.mediaUrl?.(new URL(`https://bitbucket.org/acme/app/downloads/${segment}`))
        ?.fileName,
    ).toBe(fileName);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { forgejoMediaUrl } from "./forgejoMedia.ts";

const media = (url: string) => forgejoMediaUrl(new URL(url));

describe("Forgejo media URLs", () => {
  it("claims a repository file below its raw route", () => {
    expect(media("http://git.example.test:3000/team/repo/raw/branch/main/shots/a.png")).toEqual({
      fetchUrl: "http://git.example.test:3000/team/repo/raw/branch/main/shots/a.png",
      fileName: "a.png",
    });
    expect(media("https://forge.example/team/repo/media/branch/main/a.png")?.fetchUrl).toBe(
      "https://forge.example/team/repo/media/branch/main/a.png",
    );
  });

  it("keeps a nested owner and marks a commit ref immutable", () => {
    const sha = "1b66d2869a3bc7500a06940b05313d1ec7b1b3e2";
    expect(media(`https://forge.example/group/team/repo/raw/commit/${sha}/a.png`)).toEqual({
      fetchUrl: `https://forge.example/group/team/repo/raw/commit/${sha}/a.png`,
      fileName: "a.png",
      immutable: true,
    });
    expect(media("https://forge.example/team/repo/raw/tag/v1/a.png")?.immutable).toBeUndefined();
  });

  it("leaves the pages and spellings it cannot vouch for alone", () => {
    for (const url of [
      "https://forge.example/team/repo/src/branch/main/a.png",
      "https://forge.example/team/repo/raw/main/a.png",
      "https://forge.example/team/repo/raw/branch/main",
      "https://forge.example/raw/branch/main/a.png",
      "https://forge.example/team/repo/pulls/7",
      "ftp://forge.example/team/repo/raw/branch/main/a.png",
    ])
      expect(media(url)).toBeNull();
  });
});

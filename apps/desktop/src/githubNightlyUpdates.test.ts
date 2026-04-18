import { describe, expect, it } from "vitest";

import {
  resolveElectronUpdaterChannelFileName,
  resolveLatestGitHubNightlyUpdateFeed,
  selectLatestGitHubNightlyUpdateFeed,
} from "./githubNightlyUpdates.ts";

describe("resolveElectronUpdaterChannelFileName", () => {
  it("matches electron-updater channel metadata names", () => {
    expect(resolveElectronUpdaterChannelFileName("nightly", "win32", "x64")).toBe("nightly.yml");
    expect(resolveElectronUpdaterChannelFileName("nightly", "darwin", "arm64")).toBe(
      "nightly-mac.yml",
    );
    expect(resolveElectronUpdaterChannelFileName("nightly", "linux", "x64")).toBe(
      "nightly-linux.yml",
    );
    expect(resolveElectronUpdaterChannelFileName("nightly", "linux", "arm64")).toBe(
      "nightly-linux-arm64.yml",
    );
  });
});

describe("selectLatestGitHubNightlyUpdateFeed", () => {
  it("selects the newest nightly release that has updater metadata", () => {
    expect(
      selectLatestGitHubNightlyUpdateFeed(
        [
          {
            tag_name: "v0.0.20",
            prerelease: false,
            draft: false,
            assets: [{ name: "latest.yml" }],
          },
          {
            tag_name: "nightly-v0.0.21-nightly.20260417.55",
            prerelease: true,
            draft: false,
            assets: [{ name: "nightly.yml" }],
          },
          {
            tag_name: "nightly-v0.0.21-nightly.20260417.58",
            prerelease: true,
            draft: false,
            assets: [{ name: "nightly.yml" }],
          },
        ],
        { owner: "pingdotgg", repo: "t3code" },
        "nightly.yml",
      ),
    ).toEqual({
      tag: "nightly-v0.0.21-nightly.20260417.58",
      version: "0.0.21-nightly.20260417.58",
      feedUrl:
        "https://github.com/pingdotgg/t3code/releases/download/nightly-v0.0.21-nightly.20260417.58/",
    });
  });

  it("ignores prereleases without the requested platform channel file", () => {
    expect(
      selectLatestGitHubNightlyUpdateFeed(
        [
          {
            tag_name: "nightly-v0.0.21-nightly.20260417.58",
            prerelease: true,
            draft: false,
            assets: [{ name: "nightly.yml" }],
          },
        ],
        { owner: "pingdotgg", repo: "t3code" },
        "nightly-mac.yml",
      ),
    ).toBeNull();
  });
});

describe("resolveLatestGitHubNightlyUpdateFeed", () => {
  it("loads releases from GitHub and returns the selected feed", async () => {
    const requestedUrls: string[] = [];
    const feed = await resolveLatestGitHubNightlyUpdateFeed({
      repository: { owner: "pingdotgg", repo: "t3code" },
      channelFileName: "nightly.yml",
      fetcher: async (url) => {
        requestedUrls.push(String(url));
        return new Response(
          JSON.stringify([
            {
              tag_name: "nightly-v0.0.21-nightly.20260417.58",
              prerelease: true,
              draft: false,
              assets: [{ name: "nightly.yml" }],
            },
          ]),
        );
      },
    });

    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=50",
    ]);
    expect(feed?.version).toBe("0.0.21-nightly.20260417.58");
  });
});

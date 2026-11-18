import * as NodeModule from "node:module";

import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";
import { describe, expect, it } from "vite-plus/test";

type ProviderArgs = ConstructorParameters<typeof GitHubProvider>;

// electron-updater's own dependency, which apps/desktop does not declare.
const semver = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("electron-updater"),
)("semver") as { parse: (version: string) => ProviderArgs[1]["currentVersion"] };

const REPO = "/pingdotgg/t3code";
const nightly = (build: number) => `v0.1.10-nightly.20261112.${build}`;

const atomFeed = (tags: ReadonlyArray<string>) =>
  `<feed xmlns="http://www.w3.org/2005/Atom">${tags
    .map(
      (tag) =>
        `<entry><link rel="alternate" type="text/html" href="https://github.com${REPO}/releases/tag/${tag}"/><title>${tag}</title><content type="html">${tag} feed notes</content></entry>`,
    )
    .join("")}</feed>`;

/**
 * The release a nightly install on 4580 is offered when GitHub serves this feed, this `update-feed`
 * pointer, and this newest nightly from the REST API scan.
 */
const offeredRelease = async (
  feedTags: ReadonlyArray<string>,
  pointerTag: string | undefined,
  listedTag?: string | Error,
) => {
  let apiScans = 0;
  const request = async ({ path = "" }: { readonly path?: string | null }) => {
    if (path === `${REPO}/releases.atom`) return atomFeed(feedTags);
    if (path === `${REPO}/releases/download/update-feed/nightly.json`) {
      if (pointerTag === undefined) throw new Error("404");
      return JSON.stringify({ tag_name: pointerTag, name: pointerTag, body: "pointer notes" });
    }
    const manifest = /\/releases\/download\/v([^/]+)\/nightly\.yml$/.exec(path ?? "");
    if (manifest) return `version: ${manifest[1]}\npath: T3-Code.exe\nsha512: abc\n`;
    apiScans += 1;
    if (listedTag instanceof Error) throw listedTag;
    return JSON.stringify(listedTag ? [{ tag_name: listedTag, body: "API notes" }] : []);
  };
  const provider = new GitHubProvider(
    { provider: "github", owner: "pingdotgg", repo: "t3code" },
    // Only the four fields the provider reads; a real AppUpdater needs Electron.
    {
      allowPrerelease: true,
      channel: "nightly",
      currentVersion: semver.parse("0.1.10-nightly.20261112.4580"),
      fullChangelog: true,
    } as ProviderArgs[1],
    {
      isUseMultipleRangeRequest: false,
      platform: "win32",
      executor: { request },
    } as ProviderArgs[2],
  );
  const { tag, releaseNotes } = await provider.getLatestVersion();
  return { tag, releaseNotes, apiScans };
};

// What filled releases.atom on 2026-11-12: ten tags, none of them a nightly.
const crowdedFeed = Array.from({ length: 10 }, (_, i) => `v0.1.10-preview.20261112.${4550 + i}`);

describe("GitHubProvider nightly lookup", () => {
  it.each([
    ["other tags fill the feed", crowdedFeed],
    ["the feed's first nightly is an older one", [nightly(4603)]],
  ])("finds the newest nightly at the fixed pointer when %s", async (_case, feedTags) => {
    expect(await offeredRelease(feedTags, nightly(4606))).toEqual({
      tag: nightly(4606),
      releaseNotes: "pointer notes",
      apiScans: 0,
    });
  });

  it("still scans the API when the feed has no nightly and the pointer offers nothing new", async () => {
    expect(await offeredRelease(crowdedFeed, nightly(4580), nightly(4606))).toEqual({
      tag: nightly(4606),
      releaseNotes: "API notes",
      apiScans: 1,
    });
  });

  it("keeps the pointer's answer when the API scan fails", async () => {
    const rateLimited = new Error("403");
    expect(await offeredRelease(crowdedFeed, nightly(4580), rateLimited)).toMatchObject({
      tag: nightly(4580),
      apiScans: 1,
    });
  });

  it.each([
    ["the feed is newer than the pointer", nightly(4603)],
    ["there is no pointer", undefined],
    ["the pointer names another channel", "v0.1.10-preview.20261112.4700"],
  ])("keeps the feed's nightly when %s", async (_case, pointerTag) => {
    expect(await offeredRelease([nightly(4606)], pointerTag)).toEqual({
      tag: nightly(4606),
      releaseNotes: [{ version: nightly(4606).slice(1), note: `${nightly(4606)} feed notes` }],
      apiScans: 0,
    });
  });
});

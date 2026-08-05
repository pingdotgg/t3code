import { describe, expect, it } from "vite-plus/test";

import { makeDemoSeedMarker, resolveDemoSeedStaleness } from "./seedState";

const currentVersion = "fixture-v2";

function resolve(
  seedVersion: string | null,
  legacyPanelSeedVersion: string | null = null,
  legacyCatalogSeedVersion: string | null = null,
) {
  return resolveDemoSeedStaleness({
    seedVersion,
    legacyPanelSeedVersion,
    legacyCatalogSeedVersion,
    currentVersion,
  });
}

describe("resolveDemoSeedStaleness", () => {
  it("accepts the original combined marker without forcing a migration reset", () => {
    expect(resolve(currentVersion, "old", "pending")).toEqual({
      stalePanelFixtures: false,
      staleCatalogFixtures: false,
    });
  });

  it("migrates split panel and catalog markers independently", () => {
    expect(resolve(null, currentVersion, currentVersion)).toEqual({
      stalePanelFixtures: false,
      staleCatalogFixtures: false,
    });
  });

  it("tracks either failed storage surface without retrying the successful one", () => {
    expect(resolve(makeDemoSeedMarker("panels-pending", currentVersion))).toEqual({
      stalePanelFixtures: true,
      staleCatalogFixtures: false,
    });
    expect(resolve(makeDemoSeedMarker("catalog-pending", currentVersion))).toEqual({
      stalePanelFixtures: false,
      staleCatalogFixtures: true,
    });
  });

  it("ignores obsolete split keys after the unified state marker is written", () => {
    expect(resolve(makeDemoSeedMarker("current", currentVersion), "old", "old")).toEqual({
      stalePanelFixtures: false,
      staleCatalogFixtures: false,
    });
  });

  it("re-seeds both storage surfaces for a prior fixture generation", () => {
    expect(resolve(makeDemoSeedMarker("current", "fixture-v1"))).toEqual({
      stalePanelFixtures: true,
      staleCatalogFixtures: true,
    });
  });
});

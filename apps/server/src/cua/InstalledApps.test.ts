import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { parseSpotlightAppLine, parseSpotlightAppList } from "./InstalledApps.ts";

describe("InstalledApps spotlight parsing", () => {
  it("reads path, bundle id, and display name from an attribute line", () => {
    NodeAssert.deepEqual(
      parseSpotlightAppLine(
        "/Applications/Helium.app   kMDItemCFBundleIdentifier = net.imput.helium   kMDItemDisplayName = Helium",
      ),
      { name: "Helium", bundleId: "net.imput.helium", path: "/Applications/Helium.app" },
    );
    NodeAssert.deepEqual(
      parseSpotlightAppLine(
        "/Applications/T3 Code (Alpha).app   kMDItemCFBundleIdentifier = com.t3tools.t3code   kMDItemDisplayName = T3 Code (Alpha).app",
      ),
      {
        name: "T3 Code (Alpha)",
        bundleId: "com.t3tools.t3code",
        path: "/Applications/T3 Code (Alpha).app",
      },
    );
  });

  it("drops malformed lines, dedupes bundle ids, and sorts by name", () => {
    const apps = parseSpotlightAppList(
      [
        "/Applications/Zed.app   kMDItemCFBundleIdentifier = dev.zed.Zed   kMDItemDisplayName = Zed",
        "/Applications/Helium.app   kMDItemCFBundleIdentifier = net.imput.helium   kMDItemDisplayName = Helium",
        "/Applications/Copy of Helium.app   kMDItemCFBundleIdentifier = net.imput.helium   kMDItemDisplayName = Helium",
        "/Applications/Broken.app   kMDItemCFBundleIdentifier = (null)   kMDItemDisplayName = Broken",
        "",
      ].join("\n"),
    );
    NodeAssert.deepEqual(
      apps.map((app) => app.bundleId),
      ["net.imput.helium", "dev.zed.Zed"],
    );
  });
});

import { describe, expect, it } from "vite-plus/test";

import { matchInstalledApps } from "./composerApps";

const apps = [
  { name: "Helium", bundleId: "net.imput.helium", path: "/Applications/Helium.app" },
  {
    name: "Screen Studio",
    bundleId: "com.timpler.screenstudio",
    path: "/Applications/Screen Studio.app",
  },
  {
    name: "System Settings",
    bundleId: "com.apple.systempreferences",
    path: "/System/Applications/System Settings.app",
  },
  { name: "Safari", bundleId: "com.apple.Safari", path: "/Applications/Safari.app" },
];

describe("matchInstalledApps", () => {
  it("offers nothing for a bare @ so files stay first", () => {
    expect(matchInstalledApps(apps, "")).toEqual([]);
    expect(matchInstalledApps(apps, "   ")).toEqual([]);
  });

  it("ranks name prefixes before word prefixes and bounds the list", () => {
    expect(matchInstalledApps(apps, "s").map((app) => app.name)).toEqual([
      "Safari",
      "Screen Studio",
      "System Settings",
    ]);
    expect(matchInstalledApps(apps, "stu").map((app) => app.name)).toEqual(["Screen Studio"]);
    expect(matchInstalledApps(apps, "s", 1).map((app) => app.name)).toEqual(["Safari"]);
    expect(matchInstalledApps(apps, "zz")).toEqual([]);
  });
});

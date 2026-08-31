import { describe, expect, it } from "vitest";

import {
  findLatestDesktopDmg,
  mergeP2pEnabledSetting,
  parseInstallDesktopLocalArgs,
  resolveInstalledAppPath,
} from "./install-desktop-local.ts";

describe("install-desktop-local", () => {
  it("parses local install flags", () => {
    const parsed = parseInstallDesktopLocalArgs(
      [
        "--arch",
        "x64",
        "--applications-dir",
        "/tmp/Apps",
        "--release-dir",
        "/tmp/release",
        "--skip-build",
        "--open",
        "--enable-p2p",
        "--verbose",
      ],
      {
        arch: "arm64",
        applicationsDir: "/Applications",
        releaseDir: "/repo/release",
      },
    );

    expect(parsed).toEqual({
      arch: "x64",
      applicationsDir: "/tmp/Apps",
      releaseDir: "/tmp/release",
      skipBuild: true,
      open: true,
      enableP2p: true,
      verbose: true,
      help: false,
    });
  });

  it("rejects unknown flags", () => {
    expect(
      parseInstallDesktopLocalArgs(["--nope"], {
        arch: "arm64",
        applicationsDir: "/Applications",
        releaseDir: "/repo/release",
      }),
    ).toEqual({ error: "Unexpected argument: --nope" });
  });

  it("picks the newest T3 Pear DMG by mtime", () => {
    expect(
      findLatestDesktopDmg([
        { name: "T3-Pear-0.0.1-arm64.dmg", mtimeMs: 10 },
        { name: "notes.txt", mtimeMs: 99 },
        { name: "T3-Pear-0.0.2-arm64.dmg", mtimeMs: 20 },
        { name: "T3-Code-0.0.9-arm64.dmg", mtimeMs: 50 },
      ]),
    ).toBe("T3-Pear-0.0.2-arm64.dmg");
  });

  it("resolves the installed app path from the product name", () => {
    expect(
      resolveInstalledAppPath({
        applicationsDir: "/Applications",
        productName: "T3 Pear",
      }),
    ).toBe("/Applications/T3 Pear.app");
  });

  it("merges p2pEnabled into existing remoteAccess settings", () => {
    expect(
      mergeP2pEnabledSetting({
        theme: "dark",
        remoteAccess: { tunnelEnabled: true },
      }),
    ).toEqual({
      theme: "dark",
      remoteAccess: {
        tunnelEnabled: true,
        p2pEnabled: true,
      },
    });
  });
});

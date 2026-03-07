import { describe, expect, it } from "vitest";

import {
  getBundledCopilotPlatformPackages,
  normalizeCopilotCliPathOverride,
  resolveBundledCopilotCliPathFrom,
} from "./copilotCliPath.ts";

describe("copilotCliPath", () => {
  it("prefers unpacked platform binaries for packaged builds", () => {
    const packagedBinaryPath =
      "/Applications/T3 Code.app/Contents/Resources/app.asar.unpacked/node_modules/@github/copilot-darwin-arm64/copilot";
    const packedBinaryPath =
      "/Applications/T3 Code.app/Contents/Resources/app.asar/node_modules/@github/copilot-darwin-arm64/copilot";

    const resolved = resolveBundledCopilotCliPathFrom({
      currentDir:
        "/Applications/T3 Code.app/Contents/Resources/app.asar/apps/server/dist/provider/Layers",
      resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
      sdkEntrypoint:
        "/Applications/T3 Code.app/Contents/Resources/app.asar/node_modules/@github/copilot-sdk/dist/index.js",
      platform: "darwin",
      arch: "arm64",
      exists: (path) => path === packagedBinaryPath || path === packedBinaryPath,
    });

    expect(resolved).toBe(packagedBinaryPath);
  });

  it("falls back to the sibling copilot npm loader next to the sdk package", () => {
    const npmLoaderPath = "/tmp/app/node_modules/@github/copilot/npm-loader.js";

    const resolved = resolveBundledCopilotCliPathFrom({
      currentDir: "/tmp/app/apps/server/dist/provider/Layers",
      sdkEntrypoint: "/tmp/app/node_modules/@github/copilot-sdk/dist/index.js",
      exists: (path) => path === npmLoaderPath,
    });

    expect(resolved).toBe(npmLoaderPath);
  });

  it("maps runtime platform and arch to the matching binary package name", () => {
    expect(getBundledCopilotPlatformPackages("darwin", "x64")).toEqual(["copilot-darwin-x64"]);
    expect(getBundledCopilotPlatformPackages("darwin", "arm64")).toEqual(["copilot-darwin-arm64"]);
    expect(getBundledCopilotPlatformPackages("linux", "x64")).toEqual(["copilot-linux-x64"]);
    expect(getBundledCopilotPlatformPackages("win32", "arm64")).toEqual(["copilot-win32-arm64"]);
    expect(getBundledCopilotPlatformPackages("freebsd", "x64")).toEqual([]);
  });

  it("ignores bare copilot command overrides so bundled resolution still works", () => {
    expect(normalizeCopilotCliPathOverride("copilot")).toBeUndefined();
    expect(normalizeCopilotCliPathOverride("Copilot.EXE")).toBeUndefined();
    expect(normalizeCopilotCliPathOverride("/usr/local/bin/copilot")).toBe("/usr/local/bin/copilot");
    expect(normalizeCopilotCliPathOverride("./bin/copilot")).toBe("./bin/copilot");
  });
});

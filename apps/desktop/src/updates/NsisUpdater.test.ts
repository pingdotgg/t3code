// @effect-diagnostics nodeBuiltinImport:off -- Exercise the installed dependency patch through its CommonJS API.
import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";

interface InstallerFile {
  url: URL;
  info: { url: string };
}
const require = NodeModule.createRequire(import.meta.url);
const { NsisUpdater } = require("electron-updater/out/NsisUpdater.js") as {
  NsisUpdater: {
    filterFilesForArch: (files: InstallerFile[], isArm64Windows: boolean) => InstallerFile[];
  };
};
const file = (name: string): InstallerFile => ({
  url: new URL(`https://example.invalid/${name}`),
  info: { url: name },
});
const legacy = file("T3-Code-1.0.0.exe");
const arm64 = file("T3-Code-1.0.0-arm64.exe");
const x64 = file("T3-Code-1.0.0-x64.exe");

describe.each(["arm64", "x64"] as const)("NSIS dependency on %s", (arch) => {
  it("preserves legacy untagged installers", () => {
    const original = Object.getOwnPropertyDescriptor(process, "arch")!;
    Object.defineProperty(process, "arch", { ...original, value: arch });
    try {
      expect(NsisUpdater.filterFilesForArch([legacy], true)).toEqual([legacy]);
    } finally {
      Object.defineProperty(process, "arch", original);
    }
  });
  it("prefers explicit ARM64 installers on ARM64 hosts", () => {
    expect(NsisUpdater.filterFilesForArch([legacy, x64, arm64], true)).toEqual([arm64]);
  });
});
it("rejects explicit x64-only installers on native ARM64", () => {
  const original = Object.getOwnPropertyDescriptor(process, "arch")!;
  Object.defineProperty(process, "arch", { ...original, value: "arm64" });
  try {
    expect(NsisUpdater.filterFilesForArch([x64], true)).toEqual([]);
  } finally {
    Object.defineProperty(process, "arch", original);
  }
});
it("excludes ARM64 installers on x64 hosts", () => {
  expect(NsisUpdater.filterFilesForArch([x64, arm64], false)).toEqual([x64]);
});

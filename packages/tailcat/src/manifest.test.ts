import { describe, expect, it } from "vite-plus/test";

import {
  TAILCAT_PINNED_VERSION,
  isCompatibleTailcatVersion,
  normalizeTailcatVersion,
  tailcatExecutableName,
  tailcatManifest,
  tailcatPlatformKey,
} from "./manifest.ts";

describe("tailcat manifest", () => {
  it("pins a version with per-platform digests", () => {
    expect(TAILCAT_PINNED_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
    for (const asset of Object.values(tailcatManifest.assets)) {
      expect(asset.file).toContain(TAILCAT_PINNED_VERSION);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(tailcatManifest.source.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(tailcatManifest.source.url).toContain(`v${TAILCAT_PINNED_VERSION}`);
    expect(tailcatManifest.releaseBaseUrl).toContain(`v${TAILCAT_PINNED_VERSION}`);
  });

  it("normalizes and checks versions", () => {
    expect(normalizeTailcatVersion("v0.5.0\n")).toBe("0.5.0");
    expect(normalizeTailcatVersion("0.5.0-dirty")).toBe("0.5.0");
    expect(normalizeTailcatVersion("unknown")).toBeNull();
    expect(isCompatibleTailcatVersion(TAILCAT_PINNED_VERSION)).toBe(true);
    expect(isCompatibleTailcatVersion("9.0.0")).toBe(false);
  });

  it("maps supported platforms", () => {
    expect(tailcatPlatformKey("linux", "x64")).toBe("linux-x64");
    expect(tailcatPlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(tailcatPlatformKey("win32", "arm64")).toBe("win32-arm64");
    expect(tailcatPlatformKey("freebsd", "x64")).toBeUndefined();
    expect(tailcatPlatformKey("linux", "ia32" as NodeJS.Architecture)).toBeUndefined();
    expect(tailcatExecutableName("win32")).toBe("tailcat.exe");
    expect(tailcatExecutableName("darwin")).toBe("tailcat");
  });
});

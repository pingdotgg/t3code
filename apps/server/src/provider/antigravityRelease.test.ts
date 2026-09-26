import { describe, expect, it } from "@effect/vitest";

import { antigravityReleaseArch, resolveAntigravityReleaseAsset } from "./antigravityRelease.ts";

describe("antigravityRelease", () => {
  it("maps Node, uname, and ACP-registry CPU names onto the pinned asset keys", () => {
    expect(antigravityReleaseArch("arm64")).toBe("arm64");
    expect(antigravityReleaseArch("aarch64")).toBe("arm64");
    expect(antigravityReleaseArch("AARCH64")).toBe("arm64");
    expect(antigravityReleaseArch("x64")).toBe("x64");
    expect(antigravityReleaseArch("x86_64")).toBe("x64");
    expect(antigravityReleaseArch("amd64")).toBe("x64");
    expect(antigravityReleaseArch("ia32")).toBeNull();
    expect(antigravityReleaseArch("arm")).toBeNull();
  });

  it("selects the linux-arm64 runtime for Node arm64 and uname aarch64", () => {
    const arm64 = resolveAntigravityReleaseAsset("linux", "arm64");
    const aarch64 = resolveAntigravityReleaseAsset("linux", "aarch64");
    expect(arm64?.url).toContain("linux-arm64.zip");
    expect(aarch64).toEqual(arm64);
    expect(aarch64?.archiveBytes).toBe(656_572_786);
  });

  it("prefers the host machine when Node was compiled for a different CPU", () => {
    const fromX64NodeOnArm = resolveAntigravityReleaseAsset("linux", "x64", "aarch64");
    expect(fromX64NodeOnArm).toEqual(resolveAntigravityReleaseAsset("linux", "arm64"));
    const fromArmNodeOnX64 = resolveAntigravityReleaseAsset("linux", "arm64", "x86_64");
    expect(fromArmNodeOnX64).toEqual(resolveAntigravityReleaseAsset("linux", "x64"));
  });

  it("does not invent an archive for unpublished CPUs", () => {
    expect(resolveAntigravityReleaseAsset("linux", "ia32")).toBeNull();
    expect(resolveAntigravityReleaseAsset("linux", "arm")).toBeNull();
    expect(resolveAntigravityReleaseAsset("freebsd", "arm64")).toBeNull();
  });
});

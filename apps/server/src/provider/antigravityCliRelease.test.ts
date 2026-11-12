import { describe, expect, it } from "@effect/vitest";
import { antigravityCliTarget, parseAntigravityCliRelease } from "./antigravityCliRelease.ts";

const manifest = {
  version: "1.5.7",
  url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.7-123/darwin-arm/cli_mac_arm64.tar.gz",
  sha512: "a".repeat(128),
};

describe("Antigravity CLI release manifests", () => {
  it.each([
    ["darwin", "arm64", false, "darwin_arm64", "darwin-arm/cli_mac_arm64.tar.gz"],
    ["darwin", "x64", false, "darwin_amd64", "darwin-x64/cli_mac_x64.tar.gz"],
    ["linux", "arm64", false, "linux_arm64", "linux-arm/cli_linux_arm64.tar.gz"],
    ["linux", "x64", false, "linux_amd64", "linux-x64/cli_linux_x64.tar.gz"],
    ["linux", "arm64", true, "linux_arm64_musl", "linux-arm-musl/cli_linux_arm64_musl.tar.gz"],
    ["linux", "x64", true, "linux_amd64_musl", "linux-x64-musl/cli_linux_x64_musl.tar.gz"],
    ["win32", "arm64", false, "windows_arm64", "windows-arm/cli_windows_arm64.exe"],
    ["win32", "x64", false, "windows_amd64", "windows-x64/cli_windows_x64.exe"],
  ] as const)("selects Google's %s-%s release (musl %s)", (platform, arch, musl, target, file) => {
    expect(antigravityCliTarget(platform, arch, musl)).toBe(target);
    expect(
      parseAntigravityCliRelease(
        {
          ...manifest,
          url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.7-123/${file}`,
        },
        platform,
        arch,
        musl,
      ),
    ).toMatchObject({
      version: "1.5.7",
      format: platform === "win32" ? "executable" : "tar.gz",
      executable: { name: platform === "win32" ? "agy.exe" : "antigravity" },
    });
  });

  it.each([
    { sha512: "invalid" },
    { version: "1.4.5" },
    { url: manifest.url.replace("https:", "http:") },
    { url: manifest.url.replace("storage.googleapis.com", "storage.googleapis.com.evil.test") },
    { url: manifest.url.replace("antigravity-public", "another-bucket") },
    { url: manifest.url.replace("darwin-arm", "linux-arm") },
    { url: `${manifest.url}?redirect=elsewhere` },
    { url: manifest.url.replace("1.5.7-123", "1.5.6-123") },
  ])("rejects invalid or mismatched release metadata: %j", (change) => {
    expect(parseAntigravityCliRelease({ ...manifest, ...change }, "darwin", "arm64")).toBeNull();
  });
});

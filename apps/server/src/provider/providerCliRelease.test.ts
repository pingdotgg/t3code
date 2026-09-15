import { describe, expect, it } from "vite-plus/test";
import { providerCliAssetName } from "./providerCliRelease.ts";

describe("official CLI release selection", () => {
  it("selects the complete Codex package, including companion binaries", () => {
    expect(providerCliAssetName("codex", "darwin", "arm64", false)).toBe(
      "codex-package-aarch64-apple-darwin.tar.gz",
    );
    expect(providerCliAssetName("codex", "linux", "x64", false)).toBe(
      "codex-package-x86_64-unknown-linux-musl.tar.gz",
    );
    expect(providerCliAssetName("codex", "win32", "arm64", false)).toBe(
      "codex-package-aarch64-pc-windows-msvc.tar.gz",
    );
  });
  it("handles musl and older x64 CPUs for OpenCode", () => {
    expect(providerCliAssetName("opencode", "linux", "x64", true)).toBe(
      "opencode-linux-x64-baseline-musl.tar.gz",
    );
    expect(providerCliAssetName("opencode", "linux", "arm64", false)).toBe(
      "opencode-linux-arm64.tar.gz",
    );
    expect(providerCliAssetName("opencode", "win32", "x64", false)).toBe(
      "opencode-windows-x64-baseline.zip",
    );
    expect(providerCliAssetName("opencode", "darwin", "arm64", false)).toBe(
      "opencode-darwin-arm64.zip",
    );
  });
  it("does not substitute a binary for an unsupported host", () => {
    expect(providerCliAssetName("codex", "freebsd", "x64", false)).toBeNull();
    expect(providerCliAssetName("opencode", "linux", "riscv64", false)).toBeNull();
  });
});

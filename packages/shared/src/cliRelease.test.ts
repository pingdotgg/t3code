import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliReleaseDownloadBaseUrl,
  isArchiveDistributedVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("names archives by version and platform, zip only on Windows", () => {
    expect(cliArchiveFileName("1.2.3-preview.20260911.4", "linux-x64")).toBe(
      "t3-1.2.3-preview.20260911.4-linux-x64.tar.gz",
    );
    expect(cliArchiveFileName("1.2.3", "win32-arm64")).toBe("t3-1.2.3-win32-arm64.zip");
  });

  it("only maps platforms and architectures that have a release archive", () => {
    expect(cliArchivePlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(cliArchivePlatformKey("freebsd", "x64")).toBeUndefined();
    expect(cliArchivePlatformKey("linux", "ia32")).toBeUndefined();
  });

  it("resolves download URLs under the tagged release, honoring a mirror", () => {
    expect(cliReleaseDownloadBaseUrl("1.2.3")).toBe(
      "https://github.com/pingdotgg/t3code/releases/download/v1.2.3",
    );
    expect(cliReleaseDownloadBaseUrl("1.2.3", "https://mirror.example/t3/")).toBe(
      "https://mirror.example/t3/v1.2.3",
    );
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("treats only preview builds as archive-distributed", () => {
    expect(isArchiveDistributedVersion("1.2.3-preview.20260911.4")).toBe(true);
    expect(isArchiveDistributedVersion("1.2.3-nightly.20260911.4")).toBe(false);
    expect(isArchiveDistributedVersion("1.2.3")).toBe(false);
  });
});

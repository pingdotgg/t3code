import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliReleaseAssetUrl,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
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

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft fork release on the requested channel", () => {
    const releases = [
      { tag_name: "pseudocode-v1.2.5", draft: true },
      { tag_name: "v1.2.4" },
      { tag_name: "pseudocode-v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "pseudocode-v1.2.3" },
    ];
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "stable")).toBeUndefined();
  });

  it("downloads release files and lists releases from the fork", () => {
    expect(cliReleaseAssetUrl("1.2.3", "SHA256SUMS")).toBe(
      "https://github.com/pseudoseed/t3code_dev/releases/download/pseudocode-v1.2.3/SHA256SUMS",
    );
    expect(cliReleaseAssetUrl("1.2.3", "SHA256SUMS", "https://mirror.example.com/t3/?t=1")).toBe(
      "https://mirror.example.com/t3/pseudocode-v1.2.3/SHA256SUMS?t=1",
    );
    expect(cliReleaseIndexPageUrl(2)).toBe(
      "https://api.github.com/repos/pseudoseed/t3code_dev/releases?per_page=100&page=2",
    );
  });
});

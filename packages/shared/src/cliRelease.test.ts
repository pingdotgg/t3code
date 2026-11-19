import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliInstallCommand,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it.each([
    [false, undefined, "pingdotgg/t3code", "curl -fsSL https://t3.codes/install.sh | sh"],
    [
      true,
      "1.2.3",
      "pingdotgg/t3code",
      '$env:T3CODE_VERSION="1.2.3"; irm https://t3.codes/install.ps1 | iex',
    ],
    [
      false,
      "1.2.3",
      "fork/t3code",
      "curl -fsSL https://raw.githubusercontent.com/fork/t3code/main/scripts/install.sh | T3CODE_RELEASE_REPOSITORY=fork/t3code T3CODE_VERSION=1.2.3 sh",
    ],
    [
      true,
      undefined,
      "fork/t3code",
      '$env:T3CODE_RELEASE_REPOSITORY="fork/t3code"; irm https://raw.githubusercontent.com/fork/t3code/main/scripts/install.ps1 | iex',
    ],
  ])(
    "install command (windows %s, version %s) installs from %s",
    (windows, version, repo, command) => {
      expect(cliInstallCommand(windows, version, repo)).toBe(command);
    },
  );

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

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});

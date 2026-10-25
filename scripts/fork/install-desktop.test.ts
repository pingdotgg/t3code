// @effect-diagnostics nodeBuiltinImport:off globalDate:off - tests the script, which only uses Node built-ins.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildEnvironment,
  cacheDirectory,
  localBuildVersion,
  parseArguments,
  parseChecksums,
  parseDesktopEntryName,
  releaseAssetName,
  renderLauncher,
  replace,
} from "./install-desktop.ts";

describe("releaseAssetName", () => {
  it("names each platform's build the way electron-builder writes it", () => {
    const version = "0.0.46-preview.20261011.3";
    expect(releaseAssetName(version, "linux", "x64")).toBe(`T3-Code-${version}-x86_64.AppImage`);
    expect(releaseAssetName(version, "linux", "arm64")).toBe(`T3-Code-${version}-arm64.AppImage`);
    expect(releaseAssetName(version, "darwin", "arm64")).toBe(`T3-Code-${version}-arm64.dmg`);
    expect(releaseAssetName(version, "darwin", "x64")).toBe(`T3-Code-${version}-x64.dmg`);
    expect(releaseAssetName(version, "win32", "x64")).toBe(`T3-Code-${version}-x64.exe`);
    expect(releaseAssetName(version, "win32", "arm64")).toBe(`T3-Code-${version}-arm64.exe`);
  });

  it("has nothing for a target the release does not build", () => {
    expect(releaseAssetName("0.0.46", "linux", "ia32")).toBeUndefined();
    expect(releaseAssetName("0.0.46", "freebsd", "x64")).toBeUndefined();
  });
});

describe("parseChecksums", () => {
  it("reads text and binary mode lines, keyed by file name", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    const sums = parseChecksums(`${a}  T3-Code-1-x64.exe\n${b} *t3-1-linux-x64.tar.gz\n\nnoise\n`);
    expect([...sums]).toEqual([
      ["T3-Code-1-x64.exe", a],
      ["t3-1-linux-x64.tar.gz", "b".repeat(64)],
    ]);
  });
});

describe("parseArguments", () => {
  it("defaults to the latest release and takes a version without its v", () => {
    expect(parseArguments([])).toEqual({ fromSource: false });
    expect(parseArguments(["--version", "v0.0.46-preview.20261011.3"])).toEqual({
      fromSource: false,
      version: "0.0.46-preview.20261011.3",
    });
    expect(parseArguments(["--from-source"])).toEqual({ fromSource: true });
  });

  it("refuses a version for a source build, a flag as a version, and unknown arguments", () => {
    expect(() => parseArguments(["--from-source", "--version", "1.0.0"])).toThrow();
    expect(() => parseArguments(["--version", "--from-source"])).toThrow();
    expect(() => parseArguments(["--version"])).toThrow();
    expect(() => parseArguments(["--latest"])).toThrow();
  });
});

describe("localBuildVersion", () => {
  it("takes the release form with run 0, which no workflow run has", () => {
    const date = new Date("2026-10-11T23:30:00Z");
    expect(localBuildVersion("0.0.45", date)).toBe("0.0.46-preview.20261011.0");
    expect(localBuildVersion("0.0.45-preview.20261010.4", date)).toBe("0.0.46-preview.20261011.0");
    expect(() => localBuildVersion("next", date)).toThrow();
  });
});

describe("buildEnvironment", () => {
  it("passes on only the version of the build options, and nothing that adds a publish feed", () => {
    const env = buildEnvironment(
      {
        PATH: "/usr/bin",
        Cargo_Target_Dir: "/tmp/cargo",
        GITHUB_REPOSITORY: "martinothamar/t3code",
        T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
        GITHUB_TOKEN: "token",
        gh_token: "token",
        t3code_desktop_version: "0.0.45-fork.abc",
        T3CODE_DESKTOP_OUTPUT_DIR: "/tmp/out",
      },
      "0.0.46-preview.20261011.3",
    );

    expect(env).toEqual({
      PATH: "/usr/bin",
      T3CODE_DESKTOP_VERSION: "0.0.46-preview.20261011.3",
    });
  });
});

describe("cacheDirectory", () => {
  it("uses each platform's user cache directory, not the temp directory", () => {
    expect(cacheDirectory("linux", {}, "/home/a")).toBe("/home/a/.cache/t3code-fork-install");
    expect(cacheDirectory("linux", { XDG_CACHE_HOME: "/c" }, "/home/a")).toBe(
      "/c/t3code-fork-install",
    );
    expect(cacheDirectory("darwin", {}, "/Users/a")).toBe(
      "/Users/a/Library/Caches/t3code-fork-install",
    );
    expect(cacheDirectory("win32", { LOCALAPPDATA: "/l" }, "/h")).toBe("/l/t3code-fork-install");
  });
});

describe("parseDesktopEntryName", () => {
  it("reads the untranslated Name of the Desktop Entry group", () => {
    const entry = [
      "# comment",
      "[Desktop Action New]",
      "Name=New Window",
      "[Desktop Entry]",
      "Name[de]=T3 Code (Nächtlich)",
      "Name = T3 Code (Nightly)",
      "Exec=AppRun --no-sandbox %U",
    ].join("\n");

    expect(parseDesktopEntryName(entry)).toBe("T3 Code (Nightly)");
  });

  it("returns undefined without a Name", () => {
    expect(parseDesktopEntryName("[Desktop Entry]\nExec=AppRun\n")).toBeUndefined();
  });
});

describe("renderLauncher", () => {
  it("quotes an Exec path only when it has reserved characters", () => {
    const exec = (execPath: string) =>
      renderLauncher({ name: "T3 Code", execPath, iconPath: "/icon.png" })
        .split("\n")
        .find((line) => line.startsWith("Exec="));

    expect(exec("/home/martin/.local/bin/t3code")).toBe("Exec=/home/martin/.local/bin/t3code %U");
    expect(exec('/home/a b/100%$"x\\/t3code')).toBe(
      'Exec="/home/a b/100%%\\\\$\\\\"x\\\\\\\\/t3code" %U',
    );
  });
});

describe("replace", () => {
  let dir: string;
  afterEach(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  const setup = () => {
    dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "install-desktop-test-"));
    const app = NodePath.join(dir, "T3 Code.app");
    NodeFS.mkdirSync(app);
    NodeFS.writeFileSync(NodePath.join(app, "version"), "old");
    return app;
  };

  it("swaps a directory in and leaves nothing beside it", () => {
    const app = setup();

    replace(app, (staged) => {
      NodeFS.mkdirSync(staged);
      NodeFS.writeFileSync(NodePath.join(staged, "version"), "new");
    });

    expect(NodeFS.readFileSync(NodePath.join(app, "version"), "utf8")).toBe("new");
    expect(NodeFS.readdirSync(dir)).toEqual(["T3 Code.app"]);
  });

  it("keeps the installed copy when writing the new one fails", () => {
    const app = setup();

    expect(() =>
      replace(app, (staged) => {
        NodeFS.mkdirSync(staged);
        throw new Error("copy failed");
      }),
    ).toThrow("copy failed");

    expect(NodeFS.readFileSync(NodePath.join(app, "version"), "utf8")).toBe("old");
    expect(NodeFS.readdirSync(dir)).toEqual(["T3 Code.app"]);
  });
});

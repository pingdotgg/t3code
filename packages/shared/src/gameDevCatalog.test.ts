import { describe, expect, it } from "vite-plus/test";

import {
  compareEngineVersions,
  engineAvailability,
  engineForProjectFiles,
  findSha256,
  installerPlan,
  parseBlenderFolderVersion,
  parseBlenderReleaseIndex,
  parseBlenderVersionOutput,
  parseLauncherInstalled,
  parseOsRelease,
  parseUnityLtsRelease,
  parseUnityProjectVersion,
  parseUnrealBuildVersion,
  parseUnrealInstallIni,
  parseUProject,
  versionRelation,
} from "./gameDevCatalog.ts";

const ubuntu = parseOsRelease('NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n');
const fedora = parseOsRelease('ID=fedora\nVERSION_ID=43\nPRETTY_NAME="Fedora Linux 43 (Workstation Edition)"\n');
const nixos = parseOsRelease('ID=nixos\nVERSION_ID="26.05"\nPRETTY_NAME="NixOS 26.05 (Yarara)"\n');

describe("engine availability", () => {
  it("offers Roblox Studio locally only on Windows and macOS", () => {
    expect(engineAvailability("roblox", "win32", "x64").availability).toBe("local");
    expect(engineAvailability("roblox", "darwin", "arm64").availability).toBe("local");
    expect(engineAvailability("roblox", "linux", "x64").availability).toBe("remote-only");
    expect(engineAvailability("unity", "linux", "arm64").availability).toBe("remote-only");
    expect(engineAvailability("unreal", "linux", "x64").availability).toBe("local");
  });
});

describe("installer plans", () => {
  it("resolves the vendor installer for the OS and architecture", () => {
    const context = { distro: null } as const;
    expect(installerPlan("unity-hub", { ...context, platform: "win32", arch: "arm64" }).url).toBe(
      "https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup-arm64.exe",
    );
    expect(installerPlan("unity-hub", { ...context, platform: "darwin", arch: "x64" }).fileName).toBe(
      "UnityHubSetup-x64.dmg",
    );
    expect(installerPlan("roblox", { ...context, platform: "win32", arch: "x64" })).toMatchObject({
      kind: "download-and-run",
      url: "https://setup.rbxcdn.com/RobloxStudioInstaller.exe",
      requiresSignIn: true,
    });
    expect(installerPlan("roblox", { ...context, platform: "linux", arch: "x64" }).kind).toBe("unavailable");
    expect(installerPlan("epic-launcher", { ...context, platform: "linux", arch: "x64" }).kind).toBe("unavailable");
  });

  it("uses each distribution's supported route and marks unsupported ones", () => {
    const apt = installerPlan("unity-hub", { platform: "linux", arch: "x64", distro: ubuntu });
    expect(apt).toMatchObject({ kind: "package-manager", official: true, requiresAdmin: true });
    expect(apt.commands.join("\n")).toContain("hub.unity3d.com/linux/repos/deb");
    const rpm = installerPlan("unity-hub", { platform: "linux", arch: "x64", distro: fedora });
    expect(rpm).toMatchObject({ kind: "package-manager", official: false });
    expect(rpm.note).toContain("Fedora");
    expect(installerPlan("unity-hub", { platform: "linux", arch: "x64", distro: nixos }).official).toBe(false);
    expect(installerPlan("unreal", { platform: "linux", arch: "x64", distro: ubuntu })).toMatchObject({
      kind: "browser-handoff",
      official: true,
    });
    expect(installerPlan("unreal", { platform: "linux", arch: "x64", distro: fedora }).official).toBe(false);
  });

  it("pins Unity editor installs to the project's version and changeset", () => {
    expect(
      installerPlan("unity", {
        platform: "win32",
        arch: "x64",
        distro: null,
        version: "2022.3.20f1",
        sha256: "61c2feb0970d",
      }).url,
    ).toBe("unityhub://2022.3.20f1/61c2feb0970d");
  });

  it("builds Blender download URLs from the release index", () => {
    const index = '<a href="Blender4.5/">x</a><a href="Blender5.3/">x</a><a href="Blender5.10/">';
    expect(parseBlenderReleaseIndex(index)).toBe("5.10");
    expect(parseBlenderFolderVersion('blender-5.3.0-linux-x64.tar.xz blender-5.3.1-linux-x64.tar.xz')).toBe("5.3.1");
    const linux = installerPlan("blender", { platform: "linux", arch: "x64", distro: nixos, version: "5.3.0" });
    expect(linux).toMatchObject({
      kind: "download-and-extract",
      url: "https://download.blender.org/release/Blender5.3/blender-5.3.0-linux-x64.tar.xz",
    });
    // Blender 5 ships no Intel macOS build.
    expect(installerPlan("blender", { platform: "darwin", arch: "x64", distro: null, version: "5.3.0" }).kind).toBe(
      "browser-handoff",
    );
    expect(findSha256(`${"a".repeat(64)}  blender-5.3.0-linux-x64.tar.xz\n`, "blender-5.3.0-linux-x64.tar.xz")).toBe(
      "a".repeat(64),
    );
    expect(parseBlenderVersionOutput("Blender 4.2.3 LTS\n\tbuild date: x")).toBe("4.2.3");
  });
});

describe("versions", () => {
  it("orders Unity and Unreal versions like their vendors", () => {
    const sorted = ["6000.0.58f2", "2022.3.20f1", "2022.3.9f1", "2022.3.20b1", "6000.3.29f1"].sort(
      compareEngineVersions,
    );
    expect(sorted).toEqual(["2022.3.9f1", "2022.3.20b1", "2022.3.20f1", "6000.0.58f2", "6000.3.29f1"]);
    expect(versionRelation("unreal", "5.4.4", "5.4")).toBe("same");
    expect(versionRelation("unreal", "5.6.1", "5.4")).toBe("upgrade");
    expect(versionRelation("unity", "2021.3.1f1", "2022.3.20f1")).toBe("downgrade");
    expect(versionRelation("unity", "2022.3.20f1", null)).toBe("unknown");
  });
});

describe("project and install files", () => {
  it("reads pinned versions", () => {
    expect(
      parseUnityProjectVersion("m_EditorVersion: 2022.3.20f1\nm_EditorVersionWithRevision: 2022.3.20f1 (61c2feb0970d)\n"),
    ).toEqual({ version: "2022.3.20f1", revision: "61c2feb0970d" });
    expect(parseUnityProjectVersion("m_EditorVersion: 6000.0.58f2\n")).toEqual({ version: "6000.0.58f2", revision: null });
    expect(parseUProject('{"EngineAssociation":"5.4","Modules":[{"Name":"Game"}],"Plugins":[{"Name":"PythonScriptPlugin","Enabled":true}]}')).toEqual({
      engineAssociation: "5.4",
      plugins: [{ name: "PythonScriptPlugin", enabled: true }],
      hasModules: true,
    });
    // A source build's association is a GUID, which is still the project's pin.
    expect(parseUProject('{"EngineAssociation":"{1A2B}"}')?.engineAssociation).toBe("{1A2B}");
    expect(parseUProject("not json")).toBeNull();
  });

  it("finds Unreal installs from the launcher and Install.ini", () => {
    expect(parseUnrealBuildVersion('{"MajorVersion":5,"MinorVersion":4,"PatchVersion":4}')).toBe("5.4.4");
    expect(
      parseLauncherInstalled(
        JSON.stringify({
          InstallationList: [
            { AppName: "UE_5.4", InstallLocation: "C:\\Program Files\\Epic Games\\UE_5.4" },
            { AppName: "Fortnite", InstallLocation: "C:\\Games\\Fortnite" },
          ],
        }),
      ),
    ).toEqual([{ version: "5.4", location: "C:\\Program Files\\Epic Games\\UE_5.4" }]);
    expect(parseUnrealInstallIni("[Installations]\n{ABC}=/home/me/UnrealEngine\n[Other]\nx=y\n")).toEqual([
      "/home/me/UnrealEngine",
    ]);
    expect(
      parseUnityLtsRelease({ results: [{ version: "6000.3.29f1", shortRevision: "96d2fe17529c" }] }),
    ).toEqual({ version: "6000.3.29f1", revision: "96d2fe17529c" });
  });

  it("recognizes engine projects from their root files", () => {
    expect(engineForProjectFiles(["Assets", "ProjectSettings", "Packages"]).map((entry) => entry.engine)).toEqual([
      "unity",
    ]);
    expect(engineForProjectFiles(["Shooter.uproject", "Content"])).toEqual([
      { engine: "unreal", projectFile: "Shooter.uproject" },
    ]);
    expect(engineForProjectFiles(["default.project.json", "src"])).toEqual([
      { engine: "roblox", projectFile: "default.project.json" },
    ]);
    expect(engineForProjectFiles(["README.md"])).toEqual([]);
  });
});

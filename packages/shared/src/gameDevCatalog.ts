import type {
  GameEngineAvailability,
  GameEngineId,
  GameInstallTarget,
  GameInstallerPlan,
} from "@t3tools/contracts";

/**
 * What Continuum knows about each game editor: where it runs, how it installs, where an
 * existing install lives, and what the bridge plugin inside it can do. Pure data and parsers,
 * so the server, the web client, and tests agree.
 */

export type HostPlatform = "win32" | "darwin" | "linux" | (string & {});
export type HostArch = "x64" | "arm64" | (string & {});

export interface LinuxDistro {
  readonly id: string;
  readonly idLike: ReadonlyArray<string>;
  readonly versionId: string | null;
  readonly prettyName: string;
}

export function parseOsRelease(text: string): LinuxDistro {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1]!, match[2]!.replace(/^"(.*)"$/, "$1"));
  }
  return {
    id: (values.get("ID") ?? "linux").toLowerCase(),
    idLike: (values.get("ID_LIKE") ?? "").toLowerCase().split(/\s+/).filter(Boolean),
    versionId: values.get("VERSION_ID") ?? null,
    prettyName: values.get("PRETTY_NAME") ?? "Linux",
  };
}

export type LinuxFamily = "debian" | "rhel" | "fedora" | "nixos" | "arch" | "other";

export function linuxFamily(distro: LinuxDistro | null): LinuxFamily {
  if (distro === null) return "other";
  const ids = [distro.id, ...distro.idLike];
  if (distro.id === "nixos") return "nixos";
  if (distro.id === "fedora") return "fedora";
  if (ids.some((id) => id === "debian" || id === "ubuntu")) return "debian";
  if (ids.some((id) => id === "rhel" || id === "centos")) return "rhel";
  if (ids.includes("arch")) return "arch";
  return "other";
}

// Operations ---------------------------------------------------------------------------------

export interface GameOperationSpec {
  readonly description: string;
  /** Needs the user's approval in Continuum before the bridge runs it. */
  readonly approval: boolean;
  /** Changes the project or the open scene. */
  readonly writes: boolean;
}

/**
 * The shared capability interface. Each adapter advertises the subset it implements at
 * connect time, and agents only see operations the connected editor advertised.
 */
export const GAME_OPERATIONS = {
  "scene.tree": {
    description: "List the scene hierarchy (DataModel, scene GameObjects, or level actors).",
    approval: false,
    writes: false,
  },
  "selection.get": { description: "Read what is selected in the editor.", approval: false, writes: false },
  "object.get": {
    description: "Read one object's properties, components, attributes, and tags.",
    approval: false,
    writes: false,
  },
  "object.create": { description: "Create an object with properties.", approval: false, writes: true },
  "object.update": { description: "Set properties on an object.", approval: false, writes: true },
  "object.delete": { description: "Delete an object and its children.", approval: true, writes: true },
  "script.read": { description: "Read a script's source.", approval: false, writes: false },
  "script.write": {
    description: "Create or replace a script's source (Luau, C#, or editor Python).",
    approval: false,
    writes: true,
  },
  "asset.list": { description: "List project assets under a folder.", approval: false, writes: false },
  "asset.update": {
    description: "Set properties on an asset (material, ScriptableObject, Data Asset).",
    approval: false,
    writes: true,
  },
  "asset.import": {
    description: "Import a model or image file into the project and optionally place it.",
    approval: false,
    writes: true,
  },
  "blueprint.set_defaults": {
    description: "Set default property values on a Blueprint class and compile it.",
    approval: false,
    writes: true,
  },
  "build.status": { description: "Report compile errors and warnings.", approval: false, writes: false },
  "build.compile": { description: "Compile scripts or C++ and report errors.", approval: false, writes: false },
  "playtest.start": { description: "Start a playtest (Play/Run/PIE).", approval: false, writes: false },
  "playtest.stop": { description: "Stop the playtest.", approval: false, writes: false },
  "playtest.status": { description: "Report whether a playtest is running.", approval: false, writes: false },
  "tests.run": { description: "Run project tests and report results.", approval: false, writes: false },
  "viewport.capture": { description: "Capture the editor or game viewport as an image.", approval: false, writes: false },
  "viewport.focus": {
    description: "Move the editor camera to frame an object (opt-in in Settings).",
    approval: false,
    writes: false,
  },
  "snapshot.capture": {
    description: "Capture scripts and properties under the given roots for a checkpoint.",
    approval: false,
    writes: false,
  },
  "snapshot.restore": { description: "Restore a captured snapshot.", approval: true, writes: true },
  "editor.undo": { description: "Undo the last editor change.", approval: false, writes: true },
  "project.save": { description: "Save open scenes, levels, and assets.", approval: false, writes: true },
  "project.publish": { description: "Publish or upload the project.", approval: true, writes: true },
} as const satisfies Record<string, GameOperationSpec>;

export type GameOperation = keyof typeof GAME_OPERATIONS;

export function isGameOperation(value: string): value is GameOperation {
  return Object.hasOwn(GAME_OPERATIONS, value);
}

export function operationNeedsApproval(operation: string): boolean {
  return isGameOperation(operation) && GAME_OPERATIONS[operation].approval;
}

// Engines ------------------------------------------------------------------------------------

export interface GameEngineSpec {
  readonly engine: GameEngineId;
  readonly displayName: string;
  readonly platforms: ReadonlyArray<HostPlatform>;
  /** What the bridge plugin is called and where Continuum puts it. */
  readonly bridge: string;
  readonly controls: ReadonlyArray<string>;
  /** Operations the bundled bridge implements; the live editor's advertisement is authoritative. */
  readonly operations: ReadonlyArray<GameOperation>;
}

export const GAME_ENGINES: Record<GameEngineId, GameEngineSpec> = {
  roblox: {
    engine: "roblox",
    displayName: "Roblox Studio",
    platforms: ["win32", "darwin"],
    bridge: "Continuum Bridge plugin in Studio's local Plugins folder",
    controls: [
      "Inspect the DataModel and the selection",
      "Create and edit instances and Luau scripts",
      "Run playtests and Luau test specs",
      "Read the Output window",
      "Capture the Studio window (Windows and macOS)",
    ],
    operations: [
      "scene.tree",
      "selection.get",
      "object.get",
      "object.create",
      "object.update",
      "object.delete",
      "script.read",
      "script.write",
      "asset.import",
      "playtest.start",
      "playtest.stop",
      "playtest.status",
      "tests.run",
      "viewport.focus",
      "snapshot.capture",
      "snapshot.restore",
      "editor.undo",
    ],
  },
  unity: {
    engine: "unity",
    displayName: "Unity",
    platforms: ["win32", "darwin", "linux"],
    bridge: "com.continuum.bridge Editor package in the project's Packages folder",
    controls: [
      "Inspect scenes, GameObjects, and components",
      "Edit components and assets with undo",
      "Write C# scripts and report compiler errors",
      "Run Edit Mode and Play Mode tests",
      "Enter and exit Play Mode",
      "Capture the Scene or Game view",
    ],
    operations: [
      "scene.tree",
      "selection.get",
      "object.get",
      "object.create",
      "object.update",
      "object.delete",
      "script.read",
      "script.write",
      "asset.list",
      "asset.update",
      "asset.import",
      "build.status",
      "build.compile",
      "playtest.start",
      "playtest.stop",
      "playtest.status",
      "tests.run",
      "viewport.capture",
      "viewport.focus",
      "editor.undo",
      "project.save",
    ],
  },
  unreal: {
    engine: "unreal",
    displayName: "Unreal Engine",
    platforms: ["win32", "darwin", "linux"],
    bridge: "ContinuumBridge editor plugin (Python) in the project's Plugins folder",
    controls: [
      "Inspect levels, actors, and components",
      "Edit actor and asset properties with undo",
      "Set Blueprint class defaults and compile them",
      "Build C++ and report compile errors",
      "Start and stop Play In Editor",
      "Run automation tests",
      "Capture the level viewport",
    ],
    operations: [
      "scene.tree",
      "selection.get",
      "object.get",
      "object.create",
      "object.update",
      "object.delete",
      "script.read",
      "script.write",
      "asset.list",
      "asset.update",
      "asset.import",
      "blueprint.set_defaults",
      "build.status",
      "build.compile",
      "playtest.start",
      "playtest.stop",
      "playtest.status",
      "tests.run",
      "viewport.capture",
      "viewport.focus",
      "editor.undo",
      "project.save",
    ],
  },
};

export function engineAvailability(
  engine: GameEngineId,
  platform: HostPlatform,
  arch: HostArch,
): { readonly availability: GameEngineAvailability; readonly reason: string } {
  const spec = GAME_ENGINES[engine];
  if (!spec.platforms.includes(platform)) {
    return {
      availability: "remote-only",
      reason: `${spec.displayName} has no editor for ${platformLabel(platform)}. Run it on a Windows or macOS computer with Continuum and connect that computer under Settings → Environments.`,
    };
  }
  if (engine === "unity" && platform === "linux" && arch !== "x64") {
    return { availability: "remote-only", reason: "The Unity Editor for Linux is x64 only." };
  }
  if (engine === "unreal" && platform === "linux" && arch !== "x64") {
    return { availability: "remote-only", reason: "Unreal Engine for Linux is x64 only." };
  }
  if (engine === "roblox" && platform === "win32" && arch === "arm64") {
    return {
      availability: "local",
      reason: "Roblox Studio runs on Windows on Arm through x64 emulation.",
    };
  }
  return { availability: "local", reason: `${spec.displayName} runs on this computer.` };
}

export function platformLabel(platform: HostPlatform): string {
  return platform === "win32"
    ? "Windows"
    : platform === "darwin"
      ? "macOS"
      : platform === "linux"
        ? "Linux"
        : platform;
}

// Installers ---------------------------------------------------------------------------------

const UNITY_HUB_CDN = "https://public-cdn.cloud.unity3d.com/hub/prod";
const EPIC_INSTALLER = "https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download";
export const UNITY_RELEASES_API =
  "https://services.api.unity.com/unity/editor/release/v1/releases?limit=1&stream=LTS";
export const ROBLOX_STUDIO_VERSION_API = "https://clientsettingscdn.roblox.com/v2/client-version";
export const BLENDER_RELEASES = "https://download.blender.org/release";

const UNITY_APT_COMMANDS = [
  "wget -qO - https://hub.unity3d.com/linux/keys/public | gpg --dearmor | sudo tee /usr/share/keyrings/Unity_Technologies_ApS.gpg > /dev/null",
  'sudo sh -c \'echo "deb [signed-by=/usr/share/keyrings/Unity_Technologies_ApS.gpg] https://hub.unity3d.com/linux/repos/deb stable main" > /etc/apt/sources.list.d/unityhub.list\'',
  "sudo apt update && sudo apt-get install -y unityhub",
];
const UNITY_RPM_COMMANDS = [
  'sudo sh -c \'printf "[unityhub]\\nname=Unity Hub\\nbaseurl=https://hub.unity3d.com/linux/repos/rpm/stable\\nenabled=1\\ngpgcheck=1\\ngpgkey=https://hub.unity3d.com/linux/repos/rpm/stable/repodata/repomd.xml.key\\nrepo_gpgcheck=1\\n" > /etc/yum.repos.d/unityhub.repo\'',
  "sudo dnf install -y unityhub",
];

interface PlanContext {
  readonly platform: HostPlatform;
  readonly arch: HostArch;
  readonly distro: LinuxDistro | null;
  /** The resolved version, when the server looked it up (Blender, Unity LTS). */
  readonly version?: string | null;
  readonly sha256?: string | null;
}

const plan = (
  target: GameInstallTarget,
  fields: Partial<GameInstallerPlan> & Pick<GameInstallerPlan, "kind" | "title" | "source">,
): GameInstallerPlan => ({
  target,
  version: null,
  url: null,
  fileName: null,
  sha256: null,
  commands: [],
  steps: [],
  requiresAdmin: false,
  requiresSignIn: false,
  official: true,
  note: null,
  ...fields,
});

export function installerPlan(target: GameInstallTarget, context: PlanContext): GameInstallerPlan {
  const { platform, arch } = context;
  const family = platform === "linux" ? linuxFamily(context.distro) : null;
  switch (target) {
    case "roblox": {
      if (platform === "win32") {
        return plan(target, {
          kind: "download-and-run",
          title: "Roblox Studio installer for Windows",
          source: "Roblox (setup.rbxcdn.com)",
          url: "https://setup.rbxcdn.com/RobloxStudioInstaller.exe",
          fileName: "RobloxStudioInstaller.exe",
          version: context.version ?? "Latest (Studio updates itself)",
          steps: ["Sign in to Roblox in Studio when it opens."],
          requiresSignIn: true,
        });
      }
      if (platform === "darwin") {
        return plan(target, {
          kind: "download-and-open",
          title: "Roblox Studio for macOS",
          source: "Roblox (setup.rbxcdn.com)",
          url: "https://setup.rbxcdn.com/mac/RobloxStudio.dmg",
          fileName: "RobloxStudio.dmg",
          version: context.version ?? "Latest (Studio updates itself)",
          steps: [
            "Open the disk image and run the Roblox Studio installer.",
            "Sign in to Roblox in Studio when it opens.",
          ],
          requiresSignIn: true,
        });
      }
      return plan(target, {
        kind: "unavailable",
        title: "Roblox Studio is not available on this OS",
        source: "Roblox supports Windows and macOS only",
        official: false,
        note: "Run Studio on a Windows or macOS computer with Continuum and connect to it.",
      });
    }
    case "unity-hub": {
      if (platform === "win32") {
        const file = arch === "arm64" ? "UnityHubSetup-arm64.exe" : "UnityHubSetup-x64.exe";
        return plan(target, {
          kind: "download-and-run",
          title: "Unity Hub for Windows",
          source: "Unity (public-cdn.cloud.unity3d.com)",
          url: `${UNITY_HUB_CDN}/${file}`,
          fileName: file,
          steps: [
            "Windows asks for administrator approval to install Unity Hub.",
            "Sign in with a Unity ID and activate a license (Personal is free) in Unity Hub.",
          ],
          requiresAdmin: true,
          requiresSignIn: true,
        });
      }
      if (platform === "darwin") {
        const file = arch === "arm64" ? "UnityHubSetup-arm64.dmg" : "UnityHubSetup-x64.dmg";
        return plan(target, {
          kind: "download-and-open",
          title: "Unity Hub for macOS",
          source: "Unity (public-cdn.cloud.unity3d.com)",
          url: `${UNITY_HUB_CDN}/${file}`,
          fileName: file,
          steps: [
            "Drag Unity Hub into Applications.",
            "Sign in with a Unity ID and activate a license (Personal is free) in Unity Hub.",
          ],
          requiresSignIn: true,
        });
      }
      if (platform === "linux" && arch === "x64") {
        if (family === "debian") {
          return plan(target, {
            kind: "package-manager",
            title: "Unity Hub from Unity's apt repository",
            source: "Unity (hub.unity3d.com/linux/repos/deb)",
            commands: UNITY_APT_COMMANDS,
            steps: [
              "Run these commands in a terminal; they need sudo.",
              "Sign in with a Unity ID and activate a license in Unity Hub.",
            ],
            requiresAdmin: true,
            requiresSignIn: true,
          });
        }
        if (family === "rhel" || family === "fedora") {
          return plan(target, {
            kind: "package-manager",
            title: "Unity Hub from Unity's RPM repository",
            source: "Unity (hub.unity3d.com/linux/repos/rpm)",
            commands: UNITY_RPM_COMMANDS,
            steps: [
              "Run these commands in a terminal; they need sudo.",
              "Sign in with a Unity ID and activate a license in Unity Hub.",
            ],
            requiresAdmin: true,
            requiresSignIn: true,
            official: family === "rhel",
            note:
              family === "fedora"
                ? "Unity supports Ubuntu and RHEL. Fedora uses the RHEL package and is not supported by Unity."
                : null,
          });
        }
        if (family === "nixos") {
          return plan(target, {
            kind: "package-manager",
            title: "Unity Hub from nixpkgs",
            source: "nixpkgs (community package, unfree)",
            commands: ["NIXPKGS_ALLOW_UNFREE=1 nix profile add --impure nixpkgs#unityhub"],
            steps: ["Sign in with a Unity ID and activate a license in Unity Hub."],
            requiresSignIn: true,
            official: false,
            note: "Unity does not support NixOS; the nixpkgs package wraps Unity Hub in an FHS environment.",
          });
        }
      }
      return plan(target, {
        kind: "unavailable",
        title: "Unity Hub is not available here",
        source: "Unity supports Windows, macOS, and x64 Linux",
        official: false,
      });
    }
    case "unity": {
      const version = context.version ?? null;
      return plan(target, {
        kind: "vendor-launcher",
        title: version ? `Unity ${version} through Unity Hub` : "Unity Editor through Unity Hub",
        source: "Unity Hub (download.unity3d.com)",
        version,
        url: version && context.sha256 ? `unityhub://${version}/${context.sha256}` : null,
        steps: [
          "Unity Hub must be installed and signed in.",
          "Continuum asks Unity Hub to install this version; Hub shows the download.",
        ],
        requiresSignIn: true,
        official: platform !== "linux" || family === "debian" || family === "rhel",
      });
    }
    case "epic-launcher": {
      if (platform === "win32" || platform === "darwin") {
        const file =
          platform === "win32" ? "EpicGamesLauncherInstaller.msi" : "EpicGamesLauncher.dmg";
        return plan(target, {
          kind: platform === "win32" ? "download-and-run" : "download-and-open",
          title: `Epic Games Launcher for ${platformLabel(platform)}`,
          source: "Epic Games (launcher-public-service-prod06.ol.epicgames.com)",
          url: `${EPIC_INSTALLER}/${file}`,
          fileName: file,
          steps: [
            "Sign in to the Epic Games Launcher.",
            "Open Unreal Engine → Library and add the engine version you need.",
          ],
          requiresAdmin: platform === "win32",
          requiresSignIn: true,
        });
      }
      return plan(target, {
        kind: "unavailable",
        title: "The Epic Games Launcher is not available on Linux",
        source: "Epic Games",
        official: false,
        note: "Install Unreal Engine for Linux from unrealengine.com instead.",
      });
    }
    case "unreal": {
      if (platform === "linux") {
        return plan(target, {
          kind: "browser-handoff",
          title: "Unreal Engine for Linux",
          source: "Epic Games (unrealengine.com/linux, sign-in required)",
          url: "https://www.unrealengine.com/en-US/linux",
          steps: [
            "Sign in with an Epic Games account and download the Linux build.",
            "Unzip it, then choose Locate in Continuum and pick the folder.",
          ],
          requiresSignIn: true,
          official: arch === "x64" && family === "debian",
          note:
            family === "debian"
              ? null
              : "Epic builds and tests Unreal for Linux on Ubuntu; other distributions are best effort.",
        });
      }
      return plan(target, {
        kind: "vendor-launcher",
        title: "Unreal Engine through the Epic Games Launcher",
        source: "Epic Games Launcher",
        url: "com.epicgames.launcher://ue/library",
        steps: [
          "Sign in to the Epic Games Launcher.",
          "Open Unreal Engine → Library, choose +, and pick the version the project uses.",
        ],
        requiresSignIn: true,
      });
    }
    case "blender": {
      const version = context.version ?? null;
      const file = version ? blenderAssetName(version, platform, arch) : null;
      if (version === null || file === null) {
        return plan(target, {
          kind: "browser-handoff",
          title: "Blender",
          source: "Blender Foundation (blender.org)",
          url: "https://www.blender.org/download/",
          official: version === null,
          note: version === null ? null : `No official Blender ${version} build for ${platform}-${arch}.`,
        });
      }
      const url = `${BLENDER_RELEASES}/Blender${majorMinor(version)}/${file}`;
      return plan(target, {
        kind: platform === "darwin" ? "download-and-open" : "download-and-extract",
        title: `Blender ${version}`,
        source: "Blender Foundation (download.blender.org)",
        version,
        url,
        fileName: file,
        sha256: context.sha256 ?? null,
        steps:
          platform === "darwin"
            ? ["Drag Blender into Applications, then choose Refresh."]
            : ["Continuum unpacks a portable Blender into its tools folder. Nothing system-wide changes."],
      });
    }
  }
}

function majorMinor(version: string): string {
  const [major = "0", minor = "0"] = version.split(".");
  return `${major}.${minor}`;
}

export function blenderAssetName(
  version: string,
  platform: HostPlatform,
  arch: HostArch,
): string | null {
  if (platform === "linux" && arch === "x64") return `blender-${version}-linux-x64.tar.xz`;
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) {
    return `blender-${version}-windows-${arch}.zip`;
  }
  if (platform === "darwin" && arch === "arm64") return `blender-${version}-macos-arm64.dmg`;
  return null;
}

/** The newest `BlenderX.Y/` folder in download.blender.org's release index. */
export function parseBlenderReleaseIndex(html: string): string | null {
  const folders = [...html.matchAll(/href="Blender(\d+)\.(\d+)\/"/g)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ]);
  folders.sort((left, right) => left[0]! - right[0]! || left[1]! - right[1]!);
  const newest = folders.at(-1);
  return newest ? `${newest[0]}.${newest[1]}` : null;
}

/** The newest full version (`5.3.1`) in one release folder's listing. */
export function parseBlenderFolderVersion(html: string): string | null {
  const versions = [...html.matchAll(/blender-(\d+\.\d+\.\d+)-/g)].map((match) => match[1]!);
  return versions.sort(compareEngineVersions).at(-1) ?? null;
}

export function findSha256(sums: string, fileName: string): string | null {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match && match[2] === fileName) return match[1]!.toLowerCase();
  }
  return null;
}

// Versions -----------------------------------------------------------------------------------

/** Orders `2022.3.20f1`, `6000.0.58f2`, `5.4.4`, and `5.3` the way their vendors do. */
export function compareEngineVersions(left: string, right: string): number {
  const parse = (value: string) =>
    value
      .split(/[.\s]/)
      .flatMap((part) => {
        const match = /^(\d+)([a-z])?(\d+)?/i.exec(part);
        if (!match) return [];
        const stage = match[2] ? "abfp".indexOf(match[2].toLowerCase()) : 3;
        return [Number(match[1]), stage, Number(match[3] ?? 0)];
      });
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Unreal treats `5.4` and `5.4.4` as one engine association. */
export function sameEngineLine(engine: GameEngineId, installed: string, pinned: string): boolean {
  if (engine === "unreal") return majorMinor(installed) === majorMinor(pinned);
  return installed === pinned;
}

export type VersionRelation = "same" | "upgrade" | "downgrade" | "unknown";

export function versionRelation(
  engine: GameEngineId,
  editor: string,
  pinned: string | null,
): VersionRelation {
  if (pinned === null || pinned === "") return "unknown";
  if (sameEngineLine(engine, editor, pinned)) return "same";
  return compareEngineVersions(editor, pinned) > 0 ? "upgrade" : "downgrade";
}

// Project and install file parsers ---------------------------------------------------------

export function parseUnityProjectVersion(
  text: string,
): { readonly version: string; readonly revision: string | null } | null {
  const withRevision = /m_EditorVersionWithRevision:\s*(\S+)\s*\(([0-9a-f]+)\)/.exec(text);
  if (withRevision) return { version: withRevision[1]!, revision: withRevision[2]! };
  const plain = /m_EditorVersion:\s*(\S+)/.exec(text);
  return plain ? { version: plain[1]!, revision: null } : null;
}

export function parseUProject(text: string): {
  readonly engineAssociation: string | null;
  readonly plugins: ReadonlyArray<{ readonly name: string; readonly enabled: boolean }>;
  readonly hasModules: boolean;
} | null {
  try {
    const value = JSON.parse(text) as {
      EngineAssociation?: unknown;
      Plugins?: Array<{ Name?: unknown; Enabled?: unknown }>;
      Modules?: unknown[];
    };
    return {
      engineAssociation:
        typeof value.EngineAssociation === "string" && value.EngineAssociation !== ""
          ? value.EngineAssociation
          : null,
      plugins: (value.Plugins ?? []).flatMap((plugin) =>
        typeof plugin.Name === "string" ? [{ name: plugin.Name, enabled: plugin.Enabled !== false }] : [],
      ),
      hasModules: Array.isArray(value.Modules) && value.Modules.length > 0,
    };
  } catch {
    return null;
  }
}

/** `Engine/Build/Build.version` in an Unreal install. */
export function parseUnrealBuildVersion(text: string): string | null {
  try {
    const value = JSON.parse(text) as { MajorVersion?: number; MinorVersion?: number; PatchVersion?: number };
    if (typeof value.MajorVersion !== "number" || typeof value.MinorVersion !== "number") return null;
    return `${value.MajorVersion}.${value.MinorVersion}.${value.PatchVersion ?? 0}`;
  } catch {
    return null;
  }
}

/** The Epic Games Launcher's `LauncherInstalled.dat` (JSON despite the name). */
export function parseLauncherInstalled(
  text: string,
): ReadonlyArray<{ readonly version: string; readonly location: string }> {
  try {
    const value = JSON.parse(text) as {
      InstallationList?: Array<{ AppName?: string; InstallLocation?: string; AppVersion?: string }>;
    };
    return (value.InstallationList ?? []).flatMap((entry) => {
      const match = /^UE_(\d+\.\d+)$/.exec(entry.AppName ?? "");
      return match && entry.InstallLocation ? [{ version: match[1]!, location: entry.InstallLocation }] : [];
    });
  } catch {
    return [];
  }
}

/** `~/.config/Epic/UnrealEngine/Install.ini`: source and Linux builds register here. */
export function parseUnrealInstallIni(text: string): ReadonlyArray<string> {
  let inSection = false;
  const paths: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inSection = line === "[Installations]";
      continue;
    }
    const match = inSection ? /^[^=]+=(.+)$/.exec(line) : null;
    if (match) paths.push(match[1]!.trim());
  }
  return paths;
}

/** Unity Hub's `secondaryInstallPath.json` is a JSON string, often empty. */
export function parseUnityHubSecondaryPath(text: string): string | null {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  } catch {
    return null;
  }
}

export function parseUnityLtsRelease(
  json: unknown,
): { readonly version: string; readonly revision: string | null } | null {
  const results = (json as { results?: Array<{ version?: unknown; shortRevision?: unknown }> })?.results;
  const first = Array.isArray(results) ? results[0] : undefined;
  return typeof first?.version === "string"
    ? {
        version: first.version,
        revision: typeof first.shortRevision === "string" ? first.shortRevision : null,
      }
    : null;
}

// Install locations --------------------------------------------------------------------------

export interface HostPaths {
  readonly home: string;
  readonly localAppData?: string | undefined;
  readonly appData?: string | undefined;
  readonly programFiles?: string | undefined;
  readonly programData?: string | undefined;
}

const join = (platform: HostPlatform, ...parts: ReadonlyArray<string>) =>
  parts.join(platform === "win32" ? "\\" : "/").replace(/[\\/]+/g, platform === "win32" ? "\\" : "/");

export function unityHubEditorRoots(platform: HostPlatform, paths: HostPaths): ReadonlyArray<string> {
  if (platform === "win32") {
    return [join(platform, paths.programFiles ?? "C:\\Program Files", "Unity", "Hub", "Editor")];
  }
  if (platform === "darwin") return ["/Applications/Unity/Hub/Editor"];
  return [join(platform, paths.home, "Unity", "Hub", "Editor")];
}

export function unityHubConfigDir(platform: HostPlatform, paths: HostPaths): string {
  if (platform === "win32") return join(platform, paths.appData ?? `${paths.home}\\AppData\\Roaming`, "UnityHub");
  if (platform === "darwin") return `${paths.home}/Library/Application Support/UnityHub`;
  return `${paths.home}/.config/UnityHub`;
}

export function unityEditorExecutable(platform: HostPlatform, versionRoot: string): string {
  if (platform === "win32") return join(platform, versionRoot, "Editor", "Unity.exe");
  if (platform === "darwin") return `${versionRoot}/Unity.app/Contents/MacOS/Unity`;
  return `${versionRoot}/Editor/Unity`;
}

export function unityHubExecutableCandidates(
  platform: HostPlatform,
  paths: HostPaths,
): ReadonlyArray<string> {
  if (platform === "win32") {
    return [join(platform, paths.programFiles ?? "C:\\Program Files", "Unity Hub", "Unity Hub.exe")];
  }
  if (platform === "darwin") return ["/Applications/Unity Hub.app/Contents/MacOS/Unity Hub"];
  return ["/opt/unityhub/unityhub", "/usr/bin/unityhub", `${paths.home}/.nix-profile/bin/unityhub`];
}

export function unrealLauncherDataFile(platform: HostPlatform, paths: HostPaths): string | null {
  if (platform === "win32") {
    return join(platform, paths.programData ?? "C:\\ProgramData", "Epic", "UnrealEngineLauncher", "LauncherInstalled.dat");
  }
  if (platform === "darwin") {
    return `${paths.home}/Library/Application Support/Epic/UnrealEngineLauncher/LauncherInstalled.dat`;
  }
  return null;
}

export function unrealDefaultRoots(platform: HostPlatform, paths: HostPaths): ReadonlyArray<string> {
  if (platform === "win32") return [join(platform, paths.programFiles ?? "C:\\Program Files", "Epic Games")];
  if (platform === "darwin") return ["/Users/Shared/Epic Games"];
  return [`${paths.home}/UnrealEngine`, `${paths.home}/Unreal Engine`, "/opt/unreal-engine", "/opt/UnrealEngine"];
}

export function unrealEditorExecutable(platform: HostPlatform, engineRoot: string): string {
  if (platform === "win32") return join(platform, engineRoot, "Engine", "Binaries", "Win64", "UnrealEditor.exe");
  if (platform === "darwin") {
    return `${engineRoot}/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor`;
  }
  return `${engineRoot}/Engine/Binaries/Linux/UnrealEditor`;
}

export function unrealBuildScript(platform: HostPlatform, engineRoot: string): string {
  if (platform === "win32") return join(platform, engineRoot, "Engine", "Build", "BatchFiles", "Build.bat");
  if (platform === "darwin") return `${engineRoot}/Engine/Build/BatchFiles/Mac/Build.sh`;
  return `${engineRoot}/Engine/Build/BatchFiles/Linux/Build.sh`;
}

export function robloxStudioRoots(platform: HostPlatform, paths: HostPaths): ReadonlyArray<string> {
  if (platform === "win32") {
    return [
      join(platform, paths.localAppData ?? `${paths.home}\\AppData\\Local`, "Roblox", "Versions"),
      join(platform, "C:\\Program Files (x86)", "Roblox", "Versions"),
    ];
  }
  if (platform === "darwin") return ["/Applications/RobloxStudio.app", `${paths.home}/Applications/RobloxStudio.app`];
  return [];
}

export function robloxPluginsDir(platform: HostPlatform, paths: HostPaths): string | null {
  if (platform === "win32") return join(platform, paths.localAppData ?? `${paths.home}\\AppData\\Local`, "Roblox", "Plugins");
  if (platform === "darwin") return `${paths.home}/Documents/Roblox/Plugins`;
  return null;
}

export function blenderExecutableCandidates(
  platform: HostPlatform,
  paths: HostPaths,
): ReadonlyArray<string> {
  if (platform === "win32") {
    return [join(platform, paths.programFiles ?? "C:\\Program Files", "Blender Foundation")];
  }
  if (platform === "darwin") {
    return ["/Applications/Blender.app/Contents/MacOS/Blender", `${paths.home}/Applications/Blender.app/Contents/MacOS/Blender`];
  }
  return [
    "/usr/bin/blender",
    "/usr/local/bin/blender",
    "/snap/bin/blender",
    "/var/lib/flatpak/exports/bin/org.blender.Blender",
    `${paths.home}/.local/share/flatpak/exports/bin/org.blender.Blender`,
    `${paths.home}/.nix-profile/bin/blender`,
    "/run/current-system/sw/bin/blender",
  ];
}

/** `Blender 5.3.0` / `Blender 4.2.3 LTS` from `blender --version`. */
export function parseBlenderVersionOutput(text: string): string | null {
  return /Blender\s+(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1] ?? null;
}

// Projects -----------------------------------------------------------------------------------

/** How Continuum recognizes an engine project from the files at its root. */
export function engineForProjectFiles(names: ReadonlyArray<string>): ReadonlyArray<{
  readonly engine: GameEngineId;
  readonly projectFile: string;
}> {
  const found: Array<{ engine: GameEngineId; projectFile: string }> = [];
  const uproject = names.find((name) => name.toLowerCase().endsWith(".uproject"));
  if (uproject) found.push({ engine: "unreal", projectFile: uproject });
  if (names.includes("ProjectSettings") && names.includes("Assets")) {
    found.push({ engine: "unity", projectFile: "ProjectSettings/ProjectVersion.txt" });
  }
  const place = names.find((name) => /\.rbxlx?$/i.test(name));
  const rojo = names.find((name) => name === "default.project.json" || name.endsWith(".project.json"));
  if (place || rojo) found.push({ engine: "roblox", projectFile: (place ?? rojo)! });
  return found;
}

/** Where each bridge lives inside a project, relative to its root. */
export const BRIDGE_PROJECT_PATHS: Record<GameEngineId, string | null> = {
  unity: "Packages/com.continuum.bridge",
  unreal: "Plugins/ContinuumBridge",
  // Studio loads plugins from a per-user folder, not from the project.
  roblox: null,
};

export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_PLUGIN_VERSION = "1.0.0";

/** Default checkpoint coverage per engine, relative to the project root. */
export const CHECKPOINT_DEFAULT_PATHS: Record<GameEngineId, ReadonlyArray<string>> = {
  unity: ["Assets", "ProjectSettings", "Packages/manifest.json"],
  unreal: ["Config", "Source", "Content", "*.uproject"],
  roblox: ["src", "default.project.json", "*.rbxl", "*.rbxlx"],
};

/** Folders a checkpoint never copies: caches and build products the editor regenerates. */
export const CHECKPOINT_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "Library",
  "Temp",
  "Logs",
  "obj",
  "Build",
  "Builds",
  "Intermediate",
  "Saved",
  "DerivedDataCache",
  "Binaries",
  ".git",
  ".continuum",
  "node_modules",
]);

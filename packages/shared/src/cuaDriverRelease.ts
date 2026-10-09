/**
 * The Cua Driver release T3 ships and installs. Desktop builds bundle it, and
 * a standalone server downloads the same archive when computer use is turned
 * on. The version must match the `@trycua/cua-driver` SDK in the catalog,
 * because the SDK and the executable speak one private protocol.
 *
 * To bump: change the version, then replace every byte count and SHA-256 from
 * the release's `checksums.txt` and its asset sizes.
 */
export const CUA_DRIVER_VERSION = "0.34.1";

const ARCHIVES = {
  "darwin-universal": {
    archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal-binary.tar.gz`,
    bytes: 47_101_654,
    sha256: "52de49b5046df19245ad02ff9aa89ce9caf69e84988e1d0fac677611dd83e48c",
  },
  "linux-x64": {
    archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-linux-x86_64-binary.tar.gz`,
    bytes: 34_991_293,
    sha256: "a41fe2bdcbeea4501dc594c074f16b0975728e0cc7b08b90acea8564d48fafee",
  },
  "linux-arm64": {
    archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-linux-arm64-binary.tar.gz`,
    bytes: 34_722_300,
    sha256: "1c839d35401bbdea20f3e1cf50ace926ef17be6f32cea7e821b02b263c4933dc",
  },
  "win32-x64": {
    archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-x86_64-binary.zip`,
    bytes: 31_346_745,
    sha256: "021bc2e5330c80a6c5e2c347c305fafbd4defe195d6282e0d20436f2f13c19bb",
  },
  "win32-arm64": {
    archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-arm64-binary.zip`,
    bytes: 29_462_652,
    sha256: "21820a2ae20cb4bb998a340ff87c11007b9eb5cec8d1b8338c7b0d6dc88b01a6",
  },
} as const;

export interface CuaDriverRelease {
  readonly version: string;
  readonly archiveName: string;
  readonly format: "tar.gz" | "zip";
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Executable name at the archive root. */
  readonly executable: string;
  /** Files the archive must contain for the driver and its SDK to run. */
  readonly requiredFiles: ReadonlyArray<string>;
}

/** The archive for a host, or null where Cua publishes no driver. macOS uses one universal build. */
export function cuaDriverRelease(platform: NodeJS.Platform, arch: string): CuaDriverRelease | null {
  const key =
    platform === "darwin" && (arch === "arm64" || arch === "x64")
      ? "darwin-universal"
      : (platform === "linux" || platform === "win32") && (arch === "x64" || arch === "arm64")
        ? (`${platform}-${arch}` as const)
        : null;
  if (key === null) return null;
  const archive = ARCHIVES[key];
  const windows = platform === "win32";
  return {
    version: CUA_DRIVER_VERSION,
    ...archive,
    format: windows ? "zip" : "tar.gz",
    url: `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/${archive.archiveName}`,
    executable: windows ? "cua-driver.exe" : "cua-driver",
    requiredFiles: windows
      ? ["cua-driver.exe", "cua-driver-uia.exe", "cua-cursor-theme.exe"]
      : platform === "linux"
        ? ["cua-driver", "cua-cursor-theme", "wayland-helper/winrects@cua/extension.js"]
        : ["cua-driver", "cua-cursor-theme"],
  };
}

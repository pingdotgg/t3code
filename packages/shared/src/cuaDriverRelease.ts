/**
 * The Cua Driver release T3 ships and installs. Desktop builds bundle it, and
 * a standalone server downloads the same archive when computer use is turned
 * on. The version must match the `@trycua/cua-driver` SDK in the catalog,
 * because the SDK and the executable speak one private protocol.
 *
 * To bump: change the version, then replace every byte count and SHA-256 from
 * the release's `checksums.txt` and its asset sizes.
 */
export const CUA_DRIVER_VERSION = "0.34.0";

const ARCHIVES = {
  "darwin-universal": {
    archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal-binary.tar.gz`,
    bytes: 47_108_179,
    sha256: "940dc008e0f7c5d217d14c0f247d1ebab91b1bac965f4a649d19e8c789bdfd81",
  },
  "linux-x64": {
    archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-linux-x86_64-binary.tar.gz`,
    bytes: 34_818_314,
    sha256: "629ac96eff829d4dfd5cf221f3f2165c2d813aed91e5efb7b20777a741cd70a7",
  },
  "linux-arm64": {
    archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-linux-arm64-binary.tar.gz`,
    bytes: 34_607_515,
    sha256: "9db8b9084add57eb97be8164367b24b6be54ed4f3dc01213e64b72d7fc09fddb",
  },
  "win32-x64": {
    archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-x86_64-binary.zip`,
    bytes: 31_314_221,
    sha256: "bcc520e50861c7092cf775846fec76ae386d7dcd6b5b408608b0ea4423a8b888",
  },
  "win32-arm64": {
    archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-arm64-binary.zip`,
    bytes: 29_454_268,
    sha256: "df5786c6e7841d2f0d88f31c627c487181463ed99614b03efc0e907acfc698c3",
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

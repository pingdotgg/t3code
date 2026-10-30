/**
 * The Cua Driver release T3 bundles and downloads. The catalog's SDK may trail it; it checks only
 * contract and protocol versions. To bump, copy each size and SHA-256 from the release assets.
 */
export const CUA_DRIVER_VERSION = "0.38.0";

const ARCHIVES = {
  "darwin-universal": {
    archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal-binary.tar.gz`,
    bytes: 53_208_248,
    sha256: "2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732",
  },
  "linux-x64": {
    archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-linux-x86_64-binary.tar.gz`,
    bytes: 37_183_089,
    sha256: "31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd",
  },
  "linux-arm64": {
    archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-linux-arm64-binary.tar.gz`,
    bytes: 36_674_648,
    sha256: "80c9ae66bc7322052dd426c6133c96086b33894bf06c972bca8215384400b33d",
  },
  "win32-x64": {
    archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-x86_64-binary.zip`,
    bytes: 35_890_999,
    sha256: "5edaa74d0afa1b55a9668dbc4f32736507bd2bd4d75b18ca1dc8881bb12402b5",
  },
  "win32-arm64": {
    archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-arm64-binary.zip`,
    bytes: 33_682_556,
    sha256: "d25c8ebfffb34e4c095ea170baf47b87c35dc0d1116f42e46b39df2bcbff8700",
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

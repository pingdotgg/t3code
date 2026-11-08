// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  desktopMcpPathOverride,
  MUNIM_COMPUTER_USE_EXTENSION_DIR,
  MUNIM_COMPUTER_USE_RESOURCE_DIR,
  munimComputerUseAssetKey,
  munimComputerUseCacheDir,
  munimComputerUseCheckoutBinaries,
  munimComputerUseExecutableName,
  parseMunimComputerUseManifest,
  type MunimComputerUseAssetKey,
  type MunimComputerUsePlatform,
} from "@t3tools/shared/munimComputerUse";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

function hostPlatform(): MunimComputerUsePlatform | undefined {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Resolved once at startup, outside any Effect runtime.
  const platform = process.platform;
  return platform === "darwin" || platform === "win32" || platform === "linux"
    ? platform
    : undefined;
}

/** A local munim-computer-use checkout (dev): `$MUNIM_COMPUTER_USE_CHECKOUT` or `~/computer-use`. */
function checkoutRoot(): string {
  return (
    process.env.MUNIM_COMPUTER_USE_CHECKOUT?.trim() ||
    NodePath.join(NodeOS.homedir(), "computer-use")
  );
}

/** Cache dir of the pinned release the desktop build fetched, when run from a checkout. */
function fetchedCacheDir(key: MunimComputerUseAssetKey): string | undefined {
  const candidates = [
    NodePath.resolve(here, "../../../../native/munim-computer-use.json"),
    NodePath.resolve(here, "../../../native/munim-computer-use.json"),
  ];
  for (const manifestPath of candidates) {
    try {
      const { version } = parseMunimComputerUseManifest(NodeFS.readFileSync(manifestPath, "utf8"));
      return munimComputerUseCacheDir({
        environment: process.env,
        homeDir: NodeOS.homedir(),
        version,
        key,
        join: NodePath.join,
      });
    } catch {
      // Not a checkout, or no manifest: nothing was fetched.
    }
  }
  return undefined;
}

/** `…/Resources/munim-computer-use` in a packaged app. */
function packagedDir(): string | undefined {
  return process.resourcesPath
    ? NodePath.join(process.resourcesPath, MUNIM_COMPUTER_USE_RESOURCE_DIR)
    : undefined;
}

/**
 * Locate the munim-computer-use binary for Electron main (Computer History,
 * Chrome native-host registration). Same order as the server's resolver:
 * `MTCODE_DESKTOP_MCP_PATH` (then the deprecated `T3CODE_DESKTOP_MCP_PATH`),
 * the packaged copy, a local checkout build, the fetched release.
 */
export function resolveDesktopMcpBinaryPathSync(): string | undefined {
  const platform = hostPlatform();
  if (!platform) return undefined;
  const executable = munimComputerUseExecutableName(platform);

  const override = desktopMcpPathOverride(process.env);
  const packaged = packagedDir();
  const fetched = fetchedCacheDir(
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Resolved once at startup, outside any Effect runtime.
    munimComputerUseAssetKey(platform, process.arch === "arm64" ? "arm64" : "x64"),
  );
  const candidates = [
    ...(override ? [override] : []),
    ...(packaged ? [NodePath.join(packaged, executable)] : []),
    ...munimComputerUseCheckoutBinaries(platform).map((parts) =>
      NodePath.join(checkoutRoot(), ...parts),
    ),
    ...(fetched ? [NodePath.join(fetched, executable)] : []),
  ];

  for (const candidate of candidates) {
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return undefined;
}

let stableExtensionDir: string | undefined;

/**
 * Keep a copy of the bundled extension at `<stateDir>/chrome-extension` and
 * have Chrome load that one. Chrome remembers an unpacked extension by path,
 * and the bundled path is not stable everywhere (a Linux AppImage mounts at a
 * new /tmp path each launch; moving MT Code.app moves it too). Refreshed on
 * every launch, so an MT Code update reaches Chrome on its next restart.
 */
export function syncChromeExtensionCopySync(stateDir: string): string | undefined {
  const source = bundledChromeExtensionDirSync();
  if (!source) return undefined;
  const destination = NodePath.join(stateDir, MUNIM_COMPUTER_USE_EXTENSION_DIR);
  try {
    if (treeDigest(source) !== treeDigest(destination)) {
      NodeFS.mkdirSync(destination, { recursive: true });
      NodeFS.cpSync(source, destination, { recursive: true, force: true });
      removeExtraEntries(source, destination);
    }
    stableExtensionDir = destination;
    return destination;
  } catch (error) {
    process.stderr.write(`[computer-use] could not copy the Chrome extension: ${String(error)}\n`);
    return undefined;
  }
}

/** Relative path + content of every file under `root`, or "" when it is missing. */
function treeDigest(root: string): string {
  const hash = NodeCrypto.createHash("sha256");
  const walk = (directory: string, prefix: string) => {
    const entries = NodeFS.readdirSync(directory, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const relative = `${prefix}${entry.name}`;
      const full = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) walk(full, `${relative}/`);
      else if (entry.isFile()) {
        hash.update(relative);
        hash.update("\0");
        hash.update(NodeFS.readFileSync(full));
        hash.update("\0");
      }
    }
  };
  try {
    walk(root, "");
  } catch {
    return "";
  }
  return hash.digest("hex");
}

/** Delete what an older MT Code shipped in the copy but this one no longer does. */
function removeExtraEntries(source: string, destination: string) {
  for (const entry of NodeFS.readdirSync(destination, { withFileTypes: true })) {
    const inSource = NodePath.join(source, entry.name);
    const inDestination = NodePath.join(destination, entry.name);
    if (!NodeFS.existsSync(inSource)) {
      NodeFS.rmSync(inDestination, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      removeExtraEntries(inSource, inDestination);
    }
  }
}

/**
 * The unpacked Chrome extension the user loads in chrome://extensions: the
 * stable copy once {@link syncChromeExtensionCopySync} made it, else the
 * bundled one.
 */
export function resolveChromeExtensionDirSync(): string | undefined {
  return stableExtensionDir ?? bundledChromeExtensionDirSync();
}

/** The copy packaged beside the binary, else the fetched release, else a checkout. */
function bundledChromeExtensionDirSync(): string | undefined {
  const packaged = packagedDir();
  const fetched = fetchedCacheDir("chrome-extension");
  const candidates = [
    ...(packaged ? [NodePath.join(packaged, MUNIM_COMPUTER_USE_EXTENSION_DIR)] : []),
    ...(fetched ? [fetched] : []),
    NodePath.join(checkoutRoot(), MUNIM_COMPUTER_USE_EXTENSION_DIR),
  ];
  for (const candidate of candidates) {
    if (NodeFS.existsSync(NodePath.join(candidate, "manifest.json"))) return candidate;
  }
  return undefined;
}

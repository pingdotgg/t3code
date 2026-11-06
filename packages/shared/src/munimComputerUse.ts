// @effect-diagnostics extendsNativeError:off - plain parse helper shared with build scripts and Electron main, outside any Effect runtime.
/**
 * MT Code runs its desktop-control MCP server from the open-source
 * munim-computer-use project (github.com/munimtechnologies/munim-computer-use)
 * instead of carrying its own copy. This module is the one place that names
 * it: the shipped executable, the MT identity the binary is run under, the
 * release pin format, and where a dev checkout finds a binary.
 *
 * Shared by the desktop build (scripts/build-desktop-artifact.ts), the server
 * (MCP injection) and Electron main (Computer History, Chrome native host).
 */

/** Executable name, as published by the munim-computer-use release. */
const MUNIM_COMPUTER_USE_EXECUTABLE = "munim-computer-use";

/** Directory under the app's Resources that holds the binary and the extension. */
export const MUNIM_COMPUTER_USE_RESOURCE_DIR = "munim-computer-use";

/** Chrome extension directory inside {@link MUNIM_COMPUTER_USE_RESOURCE_DIR}. */
export const MUNIM_COMPUTER_USE_EXTENSION_DIR = "chrome-extension";

/** Points MT Code at a specific binary (dev builds, local testing). */
const MTCODE_DESKTOP_MCP_PATH_ENV = "MTCODE_DESKTOP_MCP_PATH";

/**
 * Pre-rename override, still honoured so existing setups keep working.
 * @deprecated use {@link MTCODE_DESKTOP_MCP_PATH_ENV}.
 */
const LEGACY_DESKTOP_MCP_PATH_ENV = "T3CODE_DESKTOP_MCP_PATH";

export type MunimComputerUsePlatform = "darwin" | "win32" | "linux";

export function munimComputerUseExecutableName(platform: MunimComputerUsePlatform): string {
  return platform === "win32"
    ? `${MUNIM_COMPUTER_USE_EXECUTABLE}.exe`
    : MUNIM_COMPUTER_USE_EXECUTABLE;
}

/** The binary's explicit-path override, preferring the MT name over the legacy one. */
export function desktopMcpPathOverride(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value =
    environment[MTCODE_DESKTOP_MCP_PATH_ENV]?.trim() ||
    environment[LEGACY_DESKTOP_MCP_PATH_ENV]?.trim();
  return value ? value : undefined;
}

// ── MT identity ─────────────────────────────────────────────────────────────

/** Chrome extension id, pinned by the `key` in the extension's manifest. */
export const MTCODE_CHROME_EXTENSION_ID = "kgdolgnijopbghhomnblabjkmjhnoage";

/** Native-messaging host MT Code registers for that extension. */
export const MTCODE_CHROME_NATIVE_HOST = "com.munim.mtcode.desktop";

/**
 * Agent-cursor overlay app. The overlay needs no TCC grant (it only draws a
 * window), so it carries MT's own bundle id rather than the standalone
 * server's `com.munimtech.computer-use.agent-cursor`.
 */
export const MTCODE_AGENT_CURSOR_NAME = "MTCodeAgentCursor";
export const MTCODE_AGENT_CURSOR_BUNDLE_ID = "com.munim.mtcode.agent-cursor";

/** Prefix of MT's tunables (`MTCODE_DESKTOP_BROWSER=0`, `MTCODE_DESKTOP_AGENT_CURSOR=0`, …). */
export const MTCODE_DESKTOP_ENV_PREFIX = "MTCODE_DESKTOP_";

/**
 * The identity MT Code runs munim-computer-use under (see "Embedding" in the
 * munim-computer-use README). `name` moves the bridge socket, support dir and
 * Windows pipe under `mtcode-desktop`, so MT Code never shares a browser
 * bridge with a standalone munim-computer-use install on the same machine.
 */
export const MTCODE_DESKTOP_PROFILE = {
  name: "mtcode-desktop",
  envPrefix: MTCODE_DESKTOP_ENV_PREFIX,
  agentCursorName: MTCODE_AGENT_CURSOR_NAME,
  agentCursorBundleId: MTCODE_AGENT_CURSOR_BUNDLE_ID,
  nativeHostNames: [MTCODE_CHROME_NATIVE_HOST],
  extensionIds: [MTCODE_CHROME_EXTENSION_ID],
  nativeHostDescription: "MT Code desktop control bridge",
} as const;

/** Environment that puts a munim-computer-use process under the MT identity. */
export function mtcodeDesktopProfileEnv(): { readonly COMPUTER_USE_PROFILE: string } {
  return { COMPUTER_USE_PROFILE: JSON.stringify(MTCODE_DESKTOP_PROFILE) };
}

// ── release pin (native/munim-computer-use.json) ────────────────────────────

/** Release asset for one platform/arch, or the extension. */
export interface MunimComputerUseAsset {
  readonly name: string;
  readonly sha256: string;
}

export interface MunimComputerUseManifest {
  readonly repository: string;
  readonly version: string;
  readonly assets: Readonly<Record<string, MunimComputerUseAsset>>;
}

/** Asset keys used in the manifest. */
export type MunimComputerUseAssetKey =
  | "darwin-universal"
  | "win32-x64"
  | "win32-arm64"
  | "linux-x64"
  | "linux-arm64"
  | "chrome-extension";

/**
 * The manifest ships with this marker until the munim-computer-use release it
 * pins exists; the desktop build refuses to run against it.
 */
const MUNIM_COMPUTER_USE_PLACEHOLDER = "FILL-AT-RELEASE";

/** macOS ships one universal binary; everything else is per-arch. */
export function munimComputerUseAssetKey(
  platform: MunimComputerUsePlatform,
  arch: "x64" | "arm64" | "universal",
): MunimComputerUseAssetKey {
  if (platform === "darwin") return "darwin-universal";
  const concreteArch = arch === "arm64" ? "arm64" : "x64";
  return `${platform}-${concreteArch}`;
}

class MunimComputerUseManifestError extends Error {}

export function parseMunimComputerUseManifest(text: string): MunimComputerUseManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new MunimComputerUseManifestError(
      `munim-computer-use.json is not JSON: ${String(error)}`,
    );
  }
  const object = raw as Partial<MunimComputerUseManifest> | null;
  if (
    !object ||
    typeof object.repository !== "string" ||
    typeof object.version !== "string" ||
    typeof object.assets !== "object" ||
    object.assets === null
  ) {
    throw new MunimComputerUseManifestError(
      "munim-computer-use.json needs string `repository`, string `version` and an `assets` object",
    );
  }
  for (const [key, asset] of Object.entries(object.assets)) {
    if (
      !asset ||
      typeof asset.name !== "string" ||
      typeof asset.sha256 !== "string" ||
      asset.name.length === 0
    ) {
      throw new MunimComputerUseManifestError(
        `munim-computer-use.json asset ${key} needs string \`name\` and \`sha256\``,
      );
    }
  }
  return object as MunimComputerUseManifest;
}

/**
 * Reasons the pin cannot be used for a release build: an unfilled placeholder
 * or a malformed hash. Empty when the pin is complete for the requested keys.
 */
export function munimComputerUsePinProblems(
  manifest: MunimComputerUseManifest,
  keys: ReadonlyArray<MunimComputerUseAssetKey>,
): string[] {
  const problems: string[] = [];
  if (manifest.version.includes(MUNIM_COMPUTER_USE_PLACEHOLDER)) {
    problems.push(`version is the placeholder "${manifest.version}"`);
  }
  for (const key of keys) {
    const asset = manifest.assets[key];
    if (!asset) {
      problems.push(`no asset pinned for ${key}`);
      continue;
    }
    if (!/^[0-9a-f]{64}$/.test(asset.sha256)) {
      problems.push(
        asset.sha256.includes(MUNIM_COMPUTER_USE_PLACEHOLDER)
          ? `sha256 for ${key} (${asset.name}) is the placeholder`
          : `sha256 for ${key} (${asset.name}) is not a lowercase hex sha256`,
      );
    }
  }
  return problems;
}

export function munimComputerUseAssetUrl(
  manifest: MunimComputerUseManifest,
  asset: MunimComputerUseAsset,
): string {
  return `https://github.com/${manifest.repository}/releases/download/v${manifest.version}/${asset.name}`;
}

/**
 * Where fetched release assets are unpacked, shared by every checkout and
 * worktree: `$MTCODE_COMPUTER_USE_CACHE`, else `$XDG_CACHE_HOME/mtcode/…`,
 * else `~/.cache/mtcode/munim-computer-use/<version>/<asset key>`.
 */
export function munimComputerUseCacheDir(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly version: string;
  readonly key: MunimComputerUseAssetKey;
  readonly join: (...parts: string[]) => string;
}): string {
  const explicit = input.environment.MTCODE_COMPUTER_USE_CACHE?.trim();
  const root =
    explicit ||
    input.join(
      input.environment.XDG_CACHE_HOME?.trim() || input.join(input.homeDir, ".cache"),
      "mtcode",
      "munim-computer-use",
    );
  return input.join(root, input.version, input.key);
}

/**
 * Binaries a local munim-computer-use checkout produces, relative to it, for
 * dev mode (`~/computer-use` by default, `$MUNIM_COMPUTER_USE_CHECKOUT` to move it).
 */
export function munimComputerUseCheckoutBinaries(
  platform: MunimComputerUsePlatform,
): ReadonlyArray<ReadonlyArray<string>> {
  const executable = munimComputerUseExecutableName(platform);
  if (platform === "darwin") {
    return [
      ["macos", ".build", "out", "Products", "Release", executable],
      ["macos", ".build", "apple", "Products", "Release", executable],
      ["macos", ".build", "release", executable],
    ];
  }
  return [["windows-linux", "target", "release", executable]];
}

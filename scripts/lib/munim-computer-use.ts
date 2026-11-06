// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off extendsNativeError:off - release fetch/verify/extract is plain file work, run outside any Effect runtime.
/**
 * Fetch, verify and stage munim-computer-use, the desktop-control MCP server
 * MT Code ships (github.com/munimtechnologies/munim-computer-use).
 *
 * MT Code does not build it. The desktop build downloads the release pinned
 * by version + sha256 in `native/munim-computer-use.json`, unpacks it into a
 * cache shared by every checkout, and copies the platform binary plus the
 * Chrome extension into the app's Resources. `node scripts/fetch-munim-computer-use.ts`
 * does the fetch alone so a dev checkout can run Computer Use too.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";

import {
  MTCODE_AGENT_CURSOR_BUNDLE_ID,
  MTCODE_AGENT_CURSOR_NAME,
  MUNIM_COMPUTER_USE_EXTENSION_DIR,
  munimComputerUseAssetKey,
  munimComputerUseAssetUrl,
  munimComputerUseCacheDir,
  munimComputerUseExecutableName,
  munimComputerUsePinProblems,
  parseMunimComputerUseManifest,
  type MunimComputerUseAssetKey,
  type MunimComputerUseManifest,
  type MunimComputerUsePlatform,
} from "@t3tools/shared/munimComputerUse";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const MUNIM_COMPUTER_USE_MANIFEST_PATH = "native/munim-computer-use.json";

/** Stage a local binary instead of the pinned release (testing an unreleased build). */
const LOCAL_BINARY_ENV = "MTCODE_COMPUTER_USE_BINARY";
/** Stage a local unpacked extension instead of the pinned release. */
const LOCAL_EXTENSION_ENV = "MTCODE_COMPUTER_USE_EXTENSION_DIR";

/** Marker written after a verified unpack; its content is the archive's sha256. */
const VERIFIED_MARKER = ".verified-sha256";

class MunimComputerUseError extends Schema.TaggedError<MunimComputerUseError>()(
  "MunimComputerUseError",
  { message: Schema.String },
) {}

export async function readManifest(repoRoot: string): Promise<MunimComputerUseManifest> {
  const text = await NodeFSP.readFile(
    NodePath.join(repoRoot, MUNIM_COMPUTER_USE_MANIFEST_PATH),
    "utf8",
  );
  return parseMunimComputerUseManifest(text);
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = NodeCrypto.createHash("sha256");
    NodeFS.createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export interface FetchOptions {
  readonly manifest: MunimComputerUseManifest;
  readonly key: MunimComputerUseAssetKey;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  /** Injectable for tests; defaults to downloading the release asset. */
  readonly download?: (url: string, destination: string) => Promise<void>;
  readonly log?: (message: string) => void;
}

/**
 * Make the pinned asset for `key` available unpacked in the cache and return
 * its directory. Refuses an unfilled pin, and any archive whose sha256 does
 * not match it.
 */
export async function fetchPinnedAsset(options: FetchOptions): Promise<string> {
  const { manifest, key } = options;
  const problems = munimComputerUsePinProblems(manifest, [key]);
  if (problems.length > 0) {
    throw new MunimComputerUseError({
      message:
        `${MUNIM_COMPUTER_USE_MANIFEST_PATH} is not filled in for ${key}: ${problems.join("; ")}. ` +
        `Publish the munim-computer-use release first and pin its version and SHA256SUMS here, ` +
        `or stage a local build with ${LOCAL_BINARY_ENV} / ${LOCAL_EXTENSION_ENV}.`,
    });
  }
  const asset = manifest.assets[key]!;
  const cacheDir = munimComputerUseCacheDir({
    environment: options.environment,
    homeDir: options.homeDir ?? NodeOS.homedir(),
    version: manifest.version,
    key,
    join: NodePath.join,
  });

  const marker = NodePath.join(cacheDir, VERIFIED_MARKER);
  const cached = await NodeFSP.readFile(marker, "utf8").catch(() => undefined);
  if (cached?.trim() === asset.sha256) return cacheDir;

  await NodeFSP.mkdir(NodePath.dirname(cacheDir), { recursive: true });
  const archive = NodePath.join(
    NodePath.dirname(cacheDir),
    `.${key}-${process.pid}-${Date.now()}-${asset.name}`,
  );
  try {
    const url = munimComputerUseAssetUrl(manifest, asset);
    options.log?.(`fetching ${url}`);
    await (options.download ?? downloadTo)(url, archive);
    const actual = await sha256File(archive);
    if (actual !== asset.sha256) {
      throw new MunimComputerUseError({
        message: `${asset.name} sha256 mismatch: pinned ${asset.sha256}, downloaded ${actual}`,
      });
    }
    await NodeFSP.rm(cacheDir, { recursive: true, force: true });
    await NodeFSP.mkdir(cacheDir, { recursive: true });
    await extractArchive(archive, asset.name, cacheDir);
    await NodeFSP.writeFile(marker, `${asset.sha256}\n`);
    return cacheDir;
  } finally {
    await NodeFSP.rm(archive, { force: true });
  }
}

async function downloadTo(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new MunimComputerUseError({
      message: `GET ${url} failed: ${response.status} ${response.statusText}`,
    });
  }
  await NodeFSP.writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

/**
 * Unpack a release archive. bsdtar (macOS, and Windows' tar.exe) reads zip and
 * tar.gz alike; GNU tar on Linux does not read zip, so zips go to unzip there.
 */
async function extractArchive(archive: string, name: string, destination: string) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone build script has no Effect runtime.
  if (name.endsWith(".zip") && process.platform === "linux") {
    await execFile("unzip", ["-o", "-q", archive, "-d", destination]);
    return;
  }
  await execFile("tar", ["-xf", archive, "-C", destination]);
}

export interface StageOptions {
  readonly repoRoot: string;
  readonly platform: MunimComputerUsePlatform;
  readonly arch: "x64" | "arm64" | "universal";
  /** `…/prod-resources/munim-computer-use`; replaced wholesale. */
  readonly destination: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly download?: FetchOptions["download"];
  readonly log?: (message: string) => void;
}

/**
 * Stage the binary, the Chrome extension, and on macOS the agent-cursor
 * overlay app, into `destination`. Returns the staged binary path.
 */
export async function stageMunimComputerUse(options: StageOptions): Promise<string> {
  const executable = munimComputerUseExecutableName(options.platform);
  const localBinary = options.environment[LOCAL_BINARY_ENV]?.trim();
  const localExtension = options.environment[LOCAL_EXTENSION_ENV]?.trim();
  const manifest = localBinary && localExtension ? undefined : await readManifest(options.repoRoot);
  const fetchAsset = (key: MunimComputerUseAssetKey) =>
    fetchPinnedAsset({
      manifest: manifest!,
      key,
      environment: options.environment,
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      ...(options.download ? { download: options.download } : {}),
      ...(options.log ? { log: options.log } : {}),
    });

  let binarySource: string;
  if (localBinary) {
    options.log?.(`staging local munim-computer-use binary ${localBinary} (${LOCAL_BINARY_ENV})`);
    binarySource = localBinary;
  } else {
    const key = munimComputerUseAssetKey(options.platform, options.arch);
    binarySource = NodePath.join(await fetchAsset(key), executable);
  }
  let extensionSource: string;
  if (localExtension) {
    options.log?.(`staging local Chrome extension ${localExtension} (${LOCAL_EXTENSION_ENV})`);
    extensionSource = localExtension;
  } else {
    extensionSource = await fetchAsset("chrome-extension");
  }
  for (const [label, path] of [
    ["binary", binarySource],
    ["extension manifest", NodePath.join(extensionSource, "manifest.json")],
  ] as const) {
    if (!NodeFS.existsSync(path)) {
      throw new MunimComputerUseError({
        message: `munim-computer-use ${label} not found at ${path}`,
      });
    }
  }

  await NodeFSP.rm(options.destination, { recursive: true, force: true });
  await NodeFSP.mkdir(options.destination, { recursive: true });
  const stagedBinary = NodePath.join(options.destination, executable);
  await NodeFSP.copyFile(binarySource, stagedBinary);
  if (options.platform !== "win32") await NodeFSP.chmod(stagedBinary, 0o755);
  await NodeFSP.cp(
    extensionSource,
    NodePath.join(options.destination, MUNIM_COMPUTER_USE_EXTENSION_DIR),
    {
      recursive: true,
      filter: (source) => NodePath.basename(source) !== VERIFIED_MARKER,
    },
  );
  if (options.platform === "darwin") {
    await stageAgentCursorApp(stagedBinary, options.destination);
  }
  return stagedBinary;
}

/**
 * The agent pointer needs a real .app for AppKit to put its window up. The MCP
 * server stays a bare executable so it inherits MT Code's TCC grants; only the
 * overlay gets a bundle, named by MT's identity (the server looks for
 * `<agentCursorName>.app` beside itself and would otherwise materialise one
 * under Application Support). Same binary, different launch path.
 */
async function stageAgentCursorApp(binary: string, destination: string) {
  const contents = NodePath.join(destination, `${MTCODE_AGENT_CURSOR_NAME}.app`, "Contents");
  const macOS = NodePath.join(contents, "MacOS");
  await NodeFSP.mkdir(macOS, { recursive: true });
  const executable = NodePath.join(macOS, MTCODE_AGENT_CURSOR_NAME);
  await NodeFSP.copyFile(binary, executable);
  await NodeFSP.chmod(executable, 0o755);
  await NodeFSP.writeFile(NodePath.join(contents, "Info.plist"), agentCursorInfoPlist());
}

function agentCursorInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleExecutable</key>
	<string>${MTCODE_AGENT_CURSOR_NAME}</string>
	<key>CFBundleIdentifier</key>
	<string>${MTCODE_AGENT_CURSOR_BUNDLE_ID}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>MT Code Agent Cursor</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>14.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSPrincipalClass</key>
	<string>NSApplication</string>
</dict>
</plist>
`;
}

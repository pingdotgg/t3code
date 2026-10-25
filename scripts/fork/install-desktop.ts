// @effect-diagnostics nodeBuiltinImport:off globalConsole:off extendsNativeError:off globalFetch:off globalDate:off - runs before `vp i`, so only Node built-ins exist.
/**
 * `node scripts/fork/install-desktop.ts [--version <version> | --from-source]` installs a fork
 * release checked against its SHA256SUMS, or builds this commit. SSH hosts install the server
 * matching the app's version, so a source build takes the version of its commit's release.
 * See docs/operations/fork-desktop-build.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

const repoRoot = NodePath.resolve(import.meta.dirname, "..", "..");
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone script has no Effect runtime.
const platform = process.platform;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone script has no Effect runtime.
const arch = process.arch;

const RELEASE_REPOSITORY = "martinothamar/t3code";

/**
 * The desktop builds a release carries, by Node's platform and arch, with the
 * arch name electron-builder gives each file (`T3-Code-<version>-<arch>.<ext>`).
 */
const DESKTOP_TARGETS: Partial<
  Record<
    NodeJS.Platform,
    { script: string; extension: string; arches: Partial<Record<string, string>> }
  >
> = {
  linux: {
    script: "dist:desktop:artifact --platform linux --target AppImage",
    extension: ".AppImage",
    arches: { x64: "x86_64", arm64: "arm64" },
  },
  darwin: { script: "dist:desktop:dmg", extension: ".dmg", arches: { x64: "x64", arm64: "arm64" } },
  win32: { script: "dist:desktop:win", extension: ".exe", arches: { x64: "x64", arm64: "arm64" } },
};

// Only the version of T3CODE_DESKTOP_* passes; the rest move output or add a feed. CARGO_TARGET_DIR
// hides the native helpers the build copies. GITHUB_REPOSITORY adds an update feed that would
// replace the app with upstream's, and without a feed a publish token fails electron-builder.
const REMOVED_BUILD_ENV = new Set([
  "CARGO_TARGET_DIR",
  "GITHUB_REPOSITORY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "KEYGEN_TOKEN",
  "BITBUCKET_TOKEN",
]);

// Homebrew casks and the app bundle each one installs into /Applications.
const UPSTREAM_CASKS: Record<string, string> = {
  "t3-code": "T3 Code (Beta).app",
  "t3-code@nightly": "T3 Code (Nightly).app",
};

class InstallError extends Error {}

function fail(message: string): never {
  throw new InstallError(message);
}

function log(message: string): void {
  console.log(`[install-desktop] ${message}`);
}

/** The build's environment: the version set, and nothing that moves output or adds an update feed. */
export function buildEnvironment(env: NodeJS.ProcessEnv, version: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    // Windows environment names are case-insensitive.
    const name = key.toUpperCase();
    if (name.startsWith("T3CODE_DESKTOP_") || REMOVED_BUILD_ENV.has(name)) continue;
    result[key] = value;
  }
  result.T3CODE_DESKTOP_VERSION = version;
  return result;
}

/**
 * The version of a source build no release was published from: the form the
 * Fork release workflow gives its releases (scripts/resolve-nightly-release.ts
 * --channel preview), with run 0, which no workflow run has. As a preview
 * version it gets no update feed.
 */
export function localBuildVersion(packageVersion: string, date: Date): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(packageVersion);
  if (!match) fail(`apps/desktop/package.json has the version ${packageVersion}, not x.y.z.`);
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}-preview.${day}.0`;
}

/** The untranslated `Name` of a .desktop file's `[Desktop Entry]` group. */
export function parseDesktopEntryName(text: string): string | undefined {
  let inEntry = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inEntry = line === "[Desktop Entry]";
    } else if (inEntry && /^Name\s*=/.test(line)) {
      return line.slice(line.indexOf("=") + 1).trim();
    }
  }
  return undefined;
}

// Matches the escaping in apps/desktop/src/app/DesktopLinuxUrlHandler.ts: Exec
// arguments are quoted, then the general string escaping applies on top.
function escapeDesktopEntryString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\t", "\\t");
}

function escapeDesktopEntryExecArgument(value: string): string {
  if (/^[\w./+@:,-]+$/.test(value)) return value;
  const quoted = value.replace(/[\\`$"]/g, (char) => `\\${char}`).replaceAll("%", "%%");
  return escapeDesktopEntryString(`"${quoted}"`);
}

/** The launcher at ~/.local/share/applications/t3code.desktop. */
export function renderLauncher(input: {
  name: string;
  execPath: string;
  iconPath: string;
}): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeDesktopEntryString(input.name)}`,
    `Exec=${escapeDesktopEntryExecArgument(input.execPath)} %U`,
    `Icon=${escapeDesktopEntryString(input.iconPath)}`,
    "Terminal=false",
    "Categories=Development;",
    "StartupWMClass=t3code",
    "",
  ].join("\n");
}

function git(args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    fail(`git ${args.join(" ")} failed: ${(result.stderr || result.error?.message || "").trim()}`);
  }
  return result.stdout.trimEnd();
}

// `shell` resolves `vp` through PATH, including Windows command shims.
function runVp(command: string, env: NodeJS.ProcessEnv = process.env): void {
  const result = NodeChildProcess.spawnSync(`vp ${command}`, {
    cwd: repoRoot,
    env,
    shell: true,
    stdio: "inherit",
  });
  if (result.status !== 0) fail(`vp ${command} exited with code ${result.status ?? "unknown"}.`);
}

const BUILD_TOOLS = [
  { command: "vp", install: "https://viteplus.dev/guide/" },
  { command: "cargo", install: "https://rustup.rs" },
];

// `shell` resolves Windows command shims, as in `runVp`.
function onPath(command: string): boolean {
  const result = NodeChildProcess.spawnSync(`${command} --version`, {
    shell: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

function run(command: string, args: ReadonlyArray<string>, cwd = repoRoot): void {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.error) fail(`${command} could not run: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with code ${result.status ?? "unknown"}.`);
}

function succeeds(command: string, args: ReadonlyArray<string>): string | undefined {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout : undefined;
}

/** The release asset holding the desktop app for a platform and arch, if the fork builds one. */
export function releaseAssetName(
  version: string,
  targetPlatform: NodeJS.Platform,
  targetArch: string,
): string | undefined {
  const target = DESKTOP_TARGETS[targetPlatform];
  const assetArch = target?.arches[targetArch];
  return target && assetArch ? `T3-Code-${version}-${assetArch}${target.extension}` : undefined;
}

/** `sha256sum` output: one `<hex>  <name>` line per file, `*` before binary-mode names. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trim());
    if (match) sums.set(match[2]!, match[1]!.toLowerCase());
  }
  return sums;
}

export interface InstallOptions {
  readonly fromSource: boolean;
  readonly version?: string;
}

export function parseArguments(args: ReadonlyArray<string>): InstallOptions {
  let fromSource = false;
  let version: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--from-source") fromSource = true;
    else if (arg === "--version" && value && !value.startsWith("-")) {
      version = value.replace(/^v/, "");
      index += 1;
    } else fail(`Unknown argument ${arg}. Use --version <version> or --from-source.`);
  }
  if (fromSource && version) fail("--from-source builds the checked-out commit, not a version.");
  return { fromSource, ...(version ? { version } : {}) };
}

interface Release {
  readonly tag_name: string;
  readonly target_commitish: string;
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { "User-Agent": "t3code-fork-install-desktop" },
  }).catch((error: unknown) =>
    fail(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`),
  );
  if (!response.ok) fail(`${url} answered HTTP ${response.status}.`);
  return response;
}

const versionOf = (release: Release) => release.tag_name.replace(/^v/, "");

/** The latest release, which only runs on `main` publish. */
async function latestVersion(): Promise<string> {
  const response = await fetchOk(
    `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`,
  );
  return versionOf((await response.json()) as Release);
}

/** The version of the release published from `sha`, if there is one. */
async function releasedVersion(sha: string): Promise<string | undefined> {
  const response = await fetchOk(
    `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=100`,
  );
  const release = ((await response.json()) as Array<Release>).find(
    (candidate) => candidate.target_commitish === sha,
  );
  return release && versionOf(release);
}

/** Downloads a release asset into `dir` and checks it against the release's SHA256SUMS. */
async function downloadAsset(version: string, name: string, dir: string): Promise<string> {
  const base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}`;
  const sums = parseChecksums(await (await fetchOk(`${base}/SHA256SUMS`)).text());
  const expected = sums.get(name);
  if (!expected) fail(`Release v${version} has no ${name}.`);
  const destination = NodePath.join(dir, name);
  const response = await fetchOk(`${base}/${encodeURIComponent(name)}`);
  log(`Downloading ${name}...`);
  const hash = NodeCrypto.createHash("sha256");
  await NodeStreamPromises.pipeline(
    NodeStream.Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    new NodeStream.Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    NodeFS.createWriteStream(destination),
  );
  const actual = hash.digest("hex");
  if (actual !== expected) fail(`${name} does not match SHA256SUMS (got ${actual}).`);
  // An AppImage is run to install it, and so is the Windows installer.
  NodeFS.chmodSync(destination, 0o755);
  return destination;
}

function restoreTrackedFiles(): void {
  const changed = git(["diff", "--name-only", "-z", "HEAD"]).split("\0").filter(Boolean);
  if (changed.length === 0) return;
  git(["--literal-pathspecs", "checkout", "HEAD", "--", ...changed]);
  log(
    `Restored tracked files the build changed:\n${changed.map((file) => `  ${file}`).join("\n")}`,
  );
}

function findArtifact(version: string, extension: string): string {
  const releaseDir = NodePath.join(repoRoot, "release");
  const [newest] = NodeFS.readdirSync(releaseDir)
    .filter((name) => name.startsWith(`T3-Code-${version}-`) && name.endsWith(extension))
    .map((name) => NodePath.join(releaseDir, name))
    .map((path) => ({ path, mtimeMs: NodeFS.statSync(path).mtimeMs }))
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  if (!newest) {
    fail(`The build wrote no T3-Code-${version}-*${extension} to ${releaseDir}.`);
  }
  return newest.path;
}

/**
 * Writes next to the destination and renames over it, so a running copy keeps
 * its file. A directory, which cannot be renamed over, is moved aside first and
 * put back if the new one cannot take its place.
 */
export function replace(destination: string, write: (staged: string) => void): void {
  NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
  const sibling = (suffix: string) =>
    NodePath.join(
      NodePath.dirname(destination),
      `.${NodePath.basename(destination)}.${suffix}-${process.pid}`,
    );
  const staged = sibling("installing");
  const previous = NodeFS.statSync(destination, { throwIfNoEntry: false })?.isDirectory()
    ? sibling("previous")
    : undefined;
  try {
    write(staged);
    if (previous) NodeFS.renameSync(destination, previous);
    try {
      NodeFS.renameSync(staged, destination);
    } catch (error) {
      if (previous) NodeFS.renameSync(previous, destination);
      throw error;
    }
  } catch (error) {
    NodeFS.rmSync(staged, { recursive: true, force: true });
    throw error;
  }
  if (previous) NodeFS.rmSync(previous, { recursive: true, force: true });
}

/**
 * Where downloads go: the user's cache directory rather than the temp
 * directory, which may be mounted noexec.
 */
export function cacheDirectory(
  targetPlatform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  const base =
    targetPlatform === "win32"
      ? env.LOCALAPPDATA || NodePath.join(home, "AppData", "Local")
      : targetPlatform === "darwin"
        ? NodePath.join(home, "Library", "Caches")
        : env.XDG_CACHE_HOME || NodePath.join(home, ".cache");
  return NodePath.join(base, "t3code-fork-install");
}

/**
 * Removes a temporary directory, retrying while Windows Defender still holds a
 * file it scans, and only logs a failure: the install has already happened.
 */
function removeLeftover(dir: string): void {
  try {
    NodeFS.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (error) {
    log(`Could not remove ${dir}; delete it yourself. ${(error as Error).message}`);
  }
}

function installFile(source: string, destination: string, mode: number): void {
  replace(destination, (staged) => {
    NodeFS.copyFileSync(source, staged);
    NodeFS.chmodSync(staged, mode);
  });
}

function installLinux(appImage: string): void {
  const home = NodeOS.homedir();
  const execPath = NodePath.join(home, ".local", "bin", "t3code");
  const iconPath = NodePath.join(home, ".local", "share", "icons", "t3code.png");
  const applicationsDir = NodePath.join(home, ".local", "share", "applications");
  const launcherPath = NodePath.join(applicationsDir, "t3code.desktop");

  const extractDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-install-"));
  try {
    const extract = (path: string) => run(appImage, ["--appimage-extract", path], extractDir);
    const root = NodePath.join(extractDir, "squashfs-root");
    const dirIcon = NodePath.join(root, ".DirIcon");
    extract("*.desktop");
    extract(".DirIcon");
    if (NodeFS.lstatSync(dirIcon).isSymbolicLink()) extract(NodeFS.readlinkSync(dirIcon));
    const entry = NodeFS.readdirSync(root).find((file) => file.endsWith(".desktop"));
    const name = entry
      ? parseDesktopEntryName(NodeFS.readFileSync(NodePath.join(root, entry), "utf8"))
      : undefined;
    if (!name) fail(`${appImage} has no desktop entry with a Name.`);
    installFile(NodeFS.realpathSync(dirIcon), iconPath, 0o644);
    installFile(appImage, execPath, 0o755);
    replace(launcherPath, (staged) =>
      NodeFS.writeFileSync(staged, renderLauncher({ name, execPath, iconPath }), { mode: 0o644 }),
    );
    log(`Installed ${name}:\n  ${execPath}\n  ${launcherPath}\n  ${iconPath}`);
  } finally {
    removeLeftover(extractDir);
  }
  if (succeeds("update-desktop-database", [applicationsDir]) === undefined) {
    log("update-desktop-database is unavailable or failed; skipped refreshing the desktop cache.");
  }
}

function installMac(dmg: string): void {
  const applicationsDir = NodePath.join(NodeOS.homedir(), "Applications");
  const mountPoint = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-dmg-"));
  run("hdiutil", [
    "attach",
    dmg,
    "-nobrowse",
    "-readonly",
    "-noautoopen",
    "-mountpoint",
    mountPoint,
  ]);
  try {
    const app = NodeFS.readdirSync(mountPoint, { withFileTypes: true }).find(
      (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
    );
    if (!app) fail(`${dmg} contains no .app.`);
    const target = NodePath.join(applicationsDir, app.name);
    // ditto keeps the bundle's symlinks, extended attributes and signature intact.
    replace(target, (staged) => run("ditto", [NodePath.join(mountPoint, app.name), staged]));
    log(`Installed ${target}`);
    for (const name of ["T3 Code (Nightly).app", "T3 Code (Alpha).app"]) {
      const previous = NodePath.join(applicationsDir, name);
      if (previous !== target && NodeFS.existsSync(previous)) {
        log(`An earlier fork build is still installed as ${previous}; move it to the Trash.`);
      }
    }
  } finally {
    const detach = (...flags: Array<string>) =>
      NodeChildProcess.spawnSync("hdiutil", ["detach", ...flags, mountPoint], { stdio: "ignore" })
        .status === 0;
    if (detach() || detach("-force")) NodeFS.rmSync(mountPoint, { recursive: true, force: true });
    else log(`Could not detach ${mountPoint}; eject it in Finder.`);
  }
}

function installWindows(installer: string): void {
  // The NSIS installer installs per user; /S runs it without a window.
  run(installer, ["/S"]);
  log(`Installed ${NodePath.basename(installer)}.`);
}

interface UpstreamInstall {
  readonly hint: string;
  /** The fork's installer would uninstall it, so the script must not run. */
  readonly replacedByInstaller?: boolean;
}

/** Upstream installs, which update themselves to upstream builds, and how to remove them. */
function findUpstreamInstalls(): Array<UpstreamInstall> {
  if (platform === "linux") {
    const hints: Array<UpstreamInstall> = [];
    for (const pkg of ["t3code-bin", "t3code-nightly-bin"]) {
      if (succeeds("pacman", ["-Q", pkg]) !== undefined) {
        hints.push({ hint: `${pkg} (AUR): sudo pacman -R ${pkg}` });
      }
    }
    if (
      succeeds("dpkg-query", ["-W", "-f", "${db:Status-Status}", "t3code"])?.trim() === "installed"
    ) {
      hints.push({ hint: "t3code (.deb): sudo apt remove t3code" });
    }
    return hints;
  }

  if (platform === "darwin") {
    const installedCasks = new Set(succeeds("brew", ["list", "--cask", "-1"])?.split("\n"));
    const casks = Object.keys(UPSTREAM_CASKS).filter((cask) => installedCasks.has(cask));
    const caskApps = new Set(casks.map((cask) => UPSTREAM_CASKS[cask]));
    // Upstream builds ship an update feed; the fork's build has none.
    const apps = NodeFS.readdirSync("/Applications").filter(
      (app) =>
        app.startsWith("T3 Code") &&
        !caskApps.has(app) &&
        NodeFS.existsSync(NodePath.join("/Applications", app, "Contents/Resources/app-update.yml")),
    );
    return [
      // A cask's zap stanza deletes ~/.t3/userdata, so never suggest --zap.
      ...casks.map((cask) => ({ hint: `${cask} (Homebrew): brew uninstall --cask ${cask}` })),
      ...apps.map((app) => ({ hint: `/Applications/${app}: move it to the Trash` })),
    ];
  }

  if (platform === "win32") {
    const keys = ["HKCU:\\Software", "HKLM:\\Software", "HKLM:\\Software\\WOW6432Node"]
      .map((root) => `'${root}\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'`)
      .join(",");
    const output = succeeds("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `ConvertTo-Json -Compress -InputObject @(Get-ItemProperty ${keys} -ErrorAction SilentlyContinue | ` +
        `Where-Object { $_.DisplayName -like 'T3 Code*' } | Select-Object DisplayName, UninstallString, PSPath)`,
    ]);
    let entries: Array<{ DisplayName?: string; UninstallString?: string; PSPath?: string }>;
    try {
      entries = JSON.parse(output ?? "");
    } catch {
      // Without the list the installer could silently replace an upstream install.
      fail("Could not read the installed apps from the registry with powershell.exe.");
    }
    return entries.flatMap(({ DisplayName, UninstallString, PSPath }) => {
      const uninstaller = /^"([^"]+)"/.exec(UninstallString ?? "")?.[1];
      if (!uninstaller) return [];
      const updateFeed = NodePath.join(
        NodePath.dirname(uninstaller),
        "resources",
        "app-update.yml",
      );
      if (!NodeFS.existsSync(updateFeed)) return [];
      // The per-user installer only uninstalls a per-user install with its app ID.
      const perUser = PSPath?.includes("HKEY_CURRENT_USER") ?? false;
      return [
        {
          hint: `${DisplayName}${perUser ? "" : " (all users)"}: uninstall it in Settings > Apps > Installed apps, or run ${UninstallString}`,
          replacedByInstaller: perUser,
        },
      ];
    });
  }

  return [];
}

/**
 * The version a source build of HEAD carries: that of the release published
 * from it, whose server SSH hosts can install, or else a local one, for which
 * no server exists.
 */
async function sourceBuildVersion(sha: string): Promise<string> {
  const released = await releasedVersion(sha).catch((error: unknown) => {
    if (!(error instanceof InstallError)) throw error;
    log(`Could not look up a release of HEAD: ${error.message}`);
    return undefined;
  });
  if (released) return released;
  const packageJson = NodePath.join(repoRoot, "apps", "desktop", "package.json");
  const version = localBuildVersion(
    (JSON.parse(NodeFS.readFileSync(packageJson, "utf8")) as { version: string }).version,
    new Date(),
  );
  log(
    `No release was published from ${sha.slice(0, 12)}, so SSH hosts have no server of ${version}. ` +
      "To use SSH environments with this build, start it with T3CODE_REMOTE_SERVER_VERSION set " +
      "to a published release, or to the one scripts/fork/seed-sandbox-server.ts installs in a " +
      "Sandbox from a Fork release run.",
  );
  return version;
}

/** Builds HEAD as `version` and returns the artifact the build wrote. */
function buildFromSource(version: string, script: string, extension: string): string {
  runVp("i");
  // Ctrl+C also reaches the build; ignoring it here lets the restore run.
  const ignoreInterrupt = () => {};
  process.on("SIGINT", ignoreInterrupt);
  try {
    runVp(`run ${script} --arch ${arch}`, buildEnvironment(process.env, version));
  } finally {
    process.off("SIGINT", ignoreInterrupt);
    restoreTrackedFiles();
  }
  const artifact = findArtifact(version, extension);
  log(`Built ${NodePath.relative(repoRoot, artifact)}.`);
  return artifact;
}

function install(artifact: string): void {
  if (platform === "linux") installLinux(artifact);
  else if (platform === "darwin") installMac(artifact);
  else installWindows(artifact);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const target = DESKTOP_TARGETS[platform];
  if (!target || !releaseAssetName("0.0.0", platform, arch)) {
    fail(`The fork has no desktop build for ${platform} ${arch}.`);
  }

  const upstream = findUpstreamInstalls();
  const listed = (installs: Array<UpstreamInstall>) =>
    installs.map(({ hint }) => `  ${hint}`).join("\n");
  // The fork's NSIS installer shares upstream's app ID, so it would uninstall
  // a per-user upstream install before installing.
  const replaced = upstream.filter((install) => install.replacedByInstaller);
  if (replaced.length > 0) {
    fail(
      "Upstream T3 Code is installed, and the fork's installer would replace it. " +
        `Remove it first:\n${listed(replaced)}`,
    );
  }

  if (options.fromSource) {
    const missing = BUILD_TOOLS.filter(({ command }) => !onPath(command));
    if (missing.length > 0) {
      fail(
        "Building from source needs tools that are not on PATH. Install them, or drop " +
          `--from-source to install the latest release:\n` +
          missing.map(({ command, install }) => `  ${command}: ${install}`).join("\n"),
      );
    }
    if (git(["status", "--porcelain"]) !== "") {
      fail(
        "The working tree has uncommitted changes. Commit or stash them, so the build matches a ref.",
      );
    }
    const sha = git(["rev-parse", "HEAD"]);
    const version = await sourceBuildVersion(sha);
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const commit = sha.slice(0, 10);
    log(`Building ${branch === "HEAD" ? commit : `${branch} at ${commit}`} as ${version}.`);
    install(buildFromSource(version, target.script, target.extension));
  } else {
    const version = options.version ?? (await latestVersion());
    log(`Installing release v${version}.`);
    // The download is run to install it, so it goes where the user may run files.
    const cacheDir = cacheDirectory(platform, process.env, NodeOS.homedir());
    NodeFS.mkdirSync(cacheDir, { recursive: true });
    const downloadDir = NodeFS.mkdtempSync(NodePath.join(cacheDir, "release-"));
    try {
      install(
        await downloadAsset(version, releaseAssetName(version, platform, arch)!, downloadDir),
      );
    } finally {
      removeLeftover(downloadDir);
    }
  }

  if (upstream.length > 0) {
    log(
      "Upstream T3 Code is also installed and updates itself to upstream builds. " +
        `This script leaves it alone; remove it yourself if you want only the fork:\n${listed(upstream)}`,
    );
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    if (!(error instanceof InstallError)) throw error;
    console.error(`[install-desktop] ${error.message}`);
    process.exit(1);
  });
}

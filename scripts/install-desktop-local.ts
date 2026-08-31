#!/usr/bin/env node
/**
 * Build an unsigned macOS desktop app and install it under /Applications.
 *
 * This is the repeatable local loop for branch builds (currently packaged as
 * "T3 Pear"): build → quit running app → replace /Applications/*.app → optional open.
 *
 * Usage (from repo root):
 *   node scripts/install-desktop-local.ts
 *   node scripts/install-desktop-local.ts --skip-build
 *   node scripts/install-desktop-local.ts --open --enable-p2p
 *   node scripts/install-desktop-local.ts --arch arm64 --verbose
 *
 * Prefer invoking the node file directly. Passing flags after `vp run … --`
 * can be forwarded as positionals to Effect CLIs used underneath.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { resolveDesktopProductName } from "./build-desktop-artifact.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

export type InstallDesktopLocalOptions = {
  readonly arch: "arm64" | "x64" | "universal";
  readonly applicationsDir: string;
  readonly releaseDir: string;
  readonly skipBuild: boolean;
  readonly open: boolean;
  readonly enableP2p: boolean;
  readonly verbose: boolean;
  readonly help: boolean;
};

export type ParsedArgs = InstallDesktopLocalOptions | { readonly error: string };

const DMG_NAME_PATTERN = /^T3-Pear-.*\.dmg$/u;

export function defaultArch(): InstallDesktopLocalOptions["arch"] {
  return NodeOS.arch() === "x64" ? "x64" : "arm64";
}

export function parseInstallDesktopLocalArgs(
  argv: ReadonlyArray<string>,
  defaults: {
    readonly arch: InstallDesktopLocalOptions["arch"];
    readonly applicationsDir: string;
    readonly releaseDir: string;
  },
): ParsedArgs {
  let arch = defaults.arch;
  let applicationsDir = defaults.applicationsDir;
  let releaseDir = defaults.releaseDir;
  let skipBuild = false;
  let open = false;
  let enableP2p = false;
  let verbose = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (arg === "--open") {
      open = true;
      continue;
    }
    if (arg === "--enable-p2p") {
      enableP2p = true;
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    if (arg === "--arch") {
      const value = argv[index + 1];
      if (value !== "arm64" && value !== "x64" && value !== "universal") {
        return { error: `--arch requires arm64, x64, or universal (got ${value ?? "nothing"})` };
      }
      arch = value;
      index += 1;
      continue;
    }
    if (arg === "--applications-dir") {
      const value = argv[index + 1];
      if (!value) return { error: "--applications-dir requires a path" };
      applicationsDir = value;
      index += 1;
      continue;
    }
    if (arg === "--release-dir") {
      const value = argv[index + 1];
      if (!value) return { error: "--release-dir requires a path" };
      releaseDir = value;
      index += 1;
      continue;
    }
    if (arg === "--") {
      continue;
    }
    return { error: `Unexpected argument: ${arg}` };
  }

  return {
    arch,
    applicationsDir,
    releaseDir,
    skipBuild,
    open,
    enableP2p,
    verbose,
    help,
  };
}

export function findLatestDesktopDmg(
  entries: ReadonlyArray<{ readonly name: string; readonly mtimeMs: number }>,
): string | undefined {
  const matches = entries
    .filter((entry) => DMG_NAME_PATTERN.test(entry.name))
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
  return matches[0]?.name;
}

export function resolveInstalledAppPath(input: {
  readonly applicationsDir: string;
  readonly productName: string;
}): string {
  return NodePath.join(input.applicationsDir, `${input.productName}.app`);
}

export function mergeP2pEnabledSetting(settings: Record<string, unknown>): Record<string, unknown> {
  const remoteAccess =
    typeof settings.remoteAccess === "object" &&
    settings.remoteAccess !== null &&
    !Array.isArray(settings.remoteAccess)
      ? { ...(settings.remoteAccess as Record<string, unknown>) }
      : {};
  return {
    ...settings,
    remoteAccess: {
      ...remoteAccess,
      p2pEnabled: true,
    },
  };
}

function printHelp(): void {
  process.stdout.write(`Build and install an unsigned local desktop app.

Usage:
  node scripts/install-desktop-local.ts [flags]

Flags:
  --arch <arm64|x64|universal>   Build arch (default: host)
  --applications-dir <path>      Install destination (default: /Applications)
  --release-dir <path>           Artifact directory (default: ./release)
  --skip-build                   Install the newest T3-Pear-*.dmg already in release/
  --open                         Launch the app after install
  --enable-p2p                   Set remoteAccess.p2pEnabled in ~/.t3-pear settings
  --verbose                      Stream the desktop artifact build
  --help, -h                     Show this help

Examples:
  node scripts/install-desktop-local.ts --open --enable-p2p
  node scripts/install-desktop-local.ts --skip-build --open
`);
}

function run(command: string, args: ReadonlyArray<string>, options: { readonly verbose: boolean }) {
  if (options.verbose) {
    process.stdout.write(`$ ${command} ${args.join(" ")}\n`);
  }
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${String(result.status ?? "unknown")}`);
  }
}

function runCapture(command: string, args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with code ${String(result.status ?? "unknown")}: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function readDesktopVersion(): string {
  const packageJsonPath = NodePath.join(repoRoot, "apps/desktop/package.json");
  const packageJson = JSON.parse(NodeFS.readFileSync(packageJsonPath, "utf8")) as {
    version?: string;
  };
  if (!packageJson.version?.trim()) {
    throw new Error(`Missing version in ${packageJsonPath}`);
  }
  return packageJson.version.trim();
}

function resolveLatestDmgPath(releaseDir: string): string {
  const entries = NodeFS.readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const fullPath = NodePath.join(releaseDir, entry.name);
      return {
        name: entry.name,
        mtimeMs: NodeFS.statSync(fullPath).mtimeMs,
      };
    });
  const latest = findLatestDesktopDmg(entries);
  if (!latest) {
    throw new Error(`No T3-Pear-*.dmg found in ${releaseDir}`);
  }
  return NodePath.join(releaseDir, latest);
}

function quitRunningApp(productName: string): void {
  NodeChildProcess.spawnSync("osascript", ["-e", `tell application "${productName}" to quit`], {
    stdio: "ignore",
  });
  // Give Electron a moment to release the .app bundle before replacing it.
  NodeChildProcess.spawnSync("sleep", ["2"]);
}

function attachDmg(dmgPath: string): { readonly device: string; readonly mountPoint: string } {
  const output = runCapture("hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly", "-plist"]);
  const mountPoints = [
    ...output.matchAll(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/gu),
  ].map((match) => match[1]!);
  const devices = [...output.matchAll(/<key>dev-entry<\/key>\s*<string>([^<]+)<\/string>/gu)].map(
    (match) => match[1]!,
  );
  const mountPoint = mountPoints.at(-1);
  const device = devices[0];
  if (!mountPoint || !device) {
    throw new Error(`Could not parse hdiutil attach output for ${dmgPath}`);
  }
  return { device, mountPoint };
}

function findAppBundle(mountPoint: string): string {
  const entries = NodeFS.readdirSync(mountPoint).filter((name) => name.endsWith(".app"));
  if (entries.length !== 1 || entries[0] === undefined) {
    throw new Error(
      `Expected exactly one .app in ${mountPoint}, found: ${entries.join(", ") || "(none)"}`,
    );
  }
  return NodePath.join(mountPoint, entries[0]);
}

function installAppBundle(sourceApp: string, destinationApp: string): void {
  NodeFS.mkdirSync(NodePath.dirname(destinationApp), { recursive: true });
  if (NodeFS.existsSync(destinationApp)) {
    NodeFS.rmSync(destinationApp, { recursive: true, force: true });
  }
  run("ditto", [sourceApp, destinationApp], { verbose: true });
  // Unsigned local builds need Gatekeeper quarantine cleared or first launch fails.
  NodeChildProcess.spawnSync("xattr", ["-cr", destinationApp], { stdio: "ignore" });
}

function enableP2pInPearHome(): string {
  const settingsPath = NodePath.join(NodeOS.homedir(), ".t3-pear", "userdata", "settings.json");
  NodeFS.mkdirSync(NodePath.dirname(settingsPath), { recursive: true });
  const existing = NodeFS.existsSync(settingsPath)
    ? (JSON.parse(NodeFS.readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
    : {};
  const next = mergeP2pEnabledSetting(existing);
  NodeFS.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return settingsPath;
}

function main(): void {
  if (process.platform !== "darwin") {
    throw new Error("install-desktop-local only supports macOS");
  }

  const parsed = parseInstallDesktopLocalArgs(process.argv.slice(2), {
    arch: defaultArch(),
    applicationsDir: "/Applications",
    releaseDir: NodePath.join(repoRoot, "release"),
  });
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 1;
    return;
  }
  if (parsed.help) {
    printHelp();
    return;
  }

  const productName = resolveDesktopProductName(readDesktopVersion());
  const destinationApp = resolveInstalledAppPath({
    applicationsDir: parsed.applicationsDir,
    productName,
  });

  if (!parsed.skipBuild) {
    const buildArgs = [
      NodePath.join(repoRoot, "scripts/build-desktop-artifact.ts"),
      "--platform",
      "mac",
      "--target",
      "dmg",
      "--arch",
      parsed.arch,
    ];
    if (parsed.verbose) buildArgs.push("--verbose");
    process.stdout.write(`[install-desktop-local] Building unsigned ${parsed.arch} DMG…\n`);
    run(process.execPath, buildArgs, { verbose: true });
  }

  const dmgPath = resolveLatestDmgPath(parsed.releaseDir);
  process.stdout.write(`[install-desktop-local] Installing from ${dmgPath}\n`);

  quitRunningApp(productName);

  const attached = attachDmg(dmgPath);
  try {
    const sourceApp = findAppBundle(attached.mountPoint);
    installAppBundle(sourceApp, destinationApp);
  } finally {
    NodeChildProcess.spawnSync("hdiutil", ["detach", attached.device, "-quiet"], {
      stdio: "ignore",
    });
  }

  if (parsed.enableP2p) {
    const settingsPath = enableP2pInPearHome();
    process.stdout.write(`[install-desktop-local] Enabled p2p in ${settingsPath}\n`);
  }

  process.stdout.write(`[install-desktop-local] Installed ${destinationApp}\n`);
  process.stdout.write(
    "[install-desktop-local] First launch of an unsigned build: right-click the app → Open if Gatekeeper blocks it.\n",
  );

  if (parsed.open) {
    run("open", [destinationApp], { verbose: true });
  }
}

const isMain = process.argv[1]
  ? NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href === import.meta.url
  : false;

if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `[install-desktop-local] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

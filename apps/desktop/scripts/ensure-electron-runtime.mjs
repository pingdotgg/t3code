import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";

const require = NodeModule.createRequire(import.meta.url);
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone repair script has no Effect runtime.
const hostPlatform = NodeOS.platform();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone repair script has no Effect runtime.
const hostArch = NodeOS.arch();

function getPlatformPath() {
  switch (hostPlatform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron builds are not available on platform: ${hostPlatform}`);
  }
}

function ensureExecutable(filePath) {
  if (hostPlatform !== "win32") {
    NodeFS.chmodSync(filePath, 0o755);
  }
}

function repairPathFile(electronDir, platformPath) {
  const pathFile = NodePath.join(electronDir, "path.txt");
  const currentPath = NodeFS.existsSync(pathFile)
    ? NodeFS.readFileSync(pathFile, "utf8")
    : undefined;

  if (currentPath !== platformPath) {
    NodeFS.writeFileSync(pathFile, platformPath);
  }
}

function getRequiredRuntimePaths(electronDir, platformPath) {
  const paths = [NodePath.join(electronDir, "dist", platformPath)];

  if (hostPlatform === "darwin") {
    paths.push(
      NodePath.join(electronDir, "dist", "Electron.app", "Contents", "Info.plist"),
      NodePath.join(
        electronDir,
        "dist",
        "Electron.app",
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
        "Electron Framework",
      ),
    );
  }

  return paths;
}

function isMachO(filePath) {
  if (hostPlatform !== "darwin") {
    return true;
  }

  const result = NodeChildProcess.spawnSync("file", ["-b", filePath], {
    encoding: "utf8",
  });

  return result.status === 0 && result.stdout.includes("Mach-O");
}

function missingRuntimePaths(electronDir, platformPath) {
  return getRequiredRuntimePaths(electronDir, platformPath).filter((runtimePath) => {
    return !NodeFS.existsSync(runtimePath);
  });
}

function invalidRuntimePaths(electronDir, platformPath) {
  if (hostPlatform !== "darwin") {
    return [];
  }

  return [
    NodePath.join(electronDir, "dist", platformPath),
    NodePath.join(
      electronDir,
      "dist",
      "Electron.app",
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Electron Framework",
    ),
  ].filter((runtimePath) => NodeFS.existsSync(runtimePath) && !isMachO(runtimePath));
}

function runChecked(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: "inherit",
  });

  if (result.status === 0) {
    return;
  }

  throw new Error(
    `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`,
  );
}

// electron's own installer goes through @electron/get, which reuses its
// download cache (~/.cache/electron, ~/Library/Caches/electron) and verifies
// the bundled checksums. pnpm 11 never runs it because electron has no
// install script, so a new worktree would otherwise download 130 MB again.
function installFromElectronCache(electronDir) {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(electronDir, "install.js")],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (result.status === 0) {
    return true;
  }
  process.stderr.write(
    `electron install.js failed with exit code ${result.status ?? "unknown"}, downloading with curl instead\n`,
  );
  return false;
}

function downloadElectronRuntime(electronDir, version) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-electron-"));
  const zipPath = NodePath.join(tempDir, `electron-v${version}-${hostPlatform}-${hostArch}.zip`);

  try {
    runChecked("curl", [
      "-fsSL",
      "--retry",
      "3",
      "--retry-all-errors",
      "--connect-timeout",
      "30",
      "--max-time",
      "300",
      `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-${hostPlatform}-${hostArch}.zip`,
      "-o",
      zipPath,
    ]);
    if (hostPlatform === "darwin") {
      runChecked("ditto", ["-x", "-k", zipPath, NodePath.join(electronDir, "dist")]);
    } else {
      runChecked("python3", [
        "-c",
        "import os, sys, zipfile; os.makedirs(sys.argv[2], exist_ok=True); zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
        zipPath,
        NodePath.join(electronDir, "dist"),
      ]);
    }
  } finally {
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }
}

function resetRuntime(electronDir) {
  NodeFS.rmSync(NodePath.join(electronDir, "dist"), { recursive: true, force: true });
  NodeFS.rmSync(NodePath.join(electronDir, "path.txt"), { force: true });
}

export function ensureElectronRuntime() {
  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronPackageJson = JSON.parse(NodeFS.readFileSync(electronPackageJsonPath, "utf8"));
  const electronDir = NodePath.dirname(electronPackageJsonPath);
  const platformPath = getPlatformPath();
  const electronPath = NodePath.join(electronDir, "dist", platformPath);
  const needsInstall = () =>
    missingRuntimePaths(electronDir, platformPath).length > 0 ||
    invalidRuntimePaths(electronDir, platformPath).length > 0;

  if (needsInstall()) {
    resetRuntime(electronDir);
    if (!installFromElectronCache(electronDir) || needsInstall()) {
      resetRuntime(electronDir);
      downloadElectronRuntime(electronDir, electronPackageJson.version);
    }
  }

  const missingAfterInstall = missingRuntimePaths(electronDir, platformPath);
  const invalidAfterInstall = invalidRuntimePaths(electronDir, platformPath);
  if (missingAfterInstall.length > 0 || invalidAfterInstall.length > 0) {
    throw new Error(
      `Electron runtime is incomplete after install.\nMissing:\n${missingAfterInstall
        .map((runtimePath) => `- ${runtimePath}`)
        .join("\n")}\nInvalid:\n${invalidAfterInstall
        .map((runtimePath) => `- ${runtimePath}`)
        .join("\n")}`,
    );
  }

  ensureExecutable(electronPath);
  repairPathFile(electronDir, platformPath);

  return electronPath;
}

// `file://${argv[1]}` never matches on Windows (drive letters need `file:///C:/`).
if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const electronPath = ensureElectronRuntime();
  process.stdout.write(`${electronPath}\n`);
}

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

function getPlatformPath() {
  switch (process.platform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron builds are not available on platform: ${process.platform}`);
  }
}

function ensureExecutable(filePath) {
  if (process.platform !== "win32") {
    chmodSync(filePath, 0o755);
  }
}

function repairPathFile(electronDir, platformPath) {
  const pathFile = join(electronDir, "path.txt");
  const currentPath = existsSync(pathFile) ? readFileSync(pathFile, "utf8") : undefined;

  if (currentPath !== platformPath) {
    writeFileSync(pathFile, platformPath);
  }
}

function getRequiredRuntimePaths(electronDir, platformPath) {
  const paths = [join(electronDir, "dist", platformPath)];

  if (process.platform === "darwin") {
    paths.push(
      join(electronDir, "dist", "Electron.app", "Contents", "Info.plist"),
      join(
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
  if (process.platform !== "darwin") {
    return true;
  }

  const result = spawnSync("file", ["-b", filePath], {
    encoding: "utf8",
  });

  return result.status === 0 && result.stdout.includes("Mach-O");
}

function missingRuntimePaths(electronDir, platformPath) {
  return getRequiredRuntimePaths(electronDir, platformPath).filter((runtimePath) => {
    return !existsSync(runtimePath);
  });
}

function invalidRuntimePaths(electronDir, platformPath) {
  if (process.platform !== "darwin") {
    return [];
  }

  return [
    join(electronDir, "dist", platformPath),
    join(
      electronDir,
      "dist",
      "Electron.app",
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Electron Framework",
    ),
  ].filter((runtimePath) => existsSync(runtimePath) && !isMachO(runtimePath));
}

function runChecked(command, args) {
  const result = spawnSync(command, args, {
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

function installElectronRuntime(electronDir, version) {
  const tempDir = mkdtempSync(join(tmpdir(), "t3-electron-"));
  const zipPath = join(tempDir, `electron-v${version}-${process.platform}-${process.arch}.zip`);

  try {
    runChecked("curl", [
      "-fsSL",
      `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-${process.platform}-${process.arch}.zip`,
      "-o",
      zipPath,
    ]);
    if (process.platform === "darwin") {
      runChecked("ditto", ["-x", "-k", zipPath, join(electronDir, "dist")]);
    } else {
      runChecked("python3", [
        "-c",
        "import os, sys, zipfile; os.makedirs(sys.argv[2], exist_ok=True); zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
        zipPath,
        join(electronDir, "dist"),
      ]);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function ensureElectronRuntime() {
  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronPackageJson = JSON.parse(readFileSync(electronPackageJsonPath, "utf8"));
  const electronDir = dirname(electronPackageJsonPath);
  const platformPath = getPlatformPath();
  const electronPath = join(electronDir, "dist", platformPath);
  const missingBeforeInstall = missingRuntimePaths(electronDir, platformPath);
  const invalidBeforeInstall = invalidRuntimePaths(electronDir, platformPath);

  if (missingBeforeInstall.length > 0 || invalidBeforeInstall.length > 0) {
    if (existsSync(join(electronDir, "dist"))) {
      rmSync(join(electronDir, "dist"), { recursive: true, force: true });
    }
    rmSync(join(electronDir, "path.txt"), { force: true });
    installElectronRuntime(electronDir, electronPackageJson.version);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const electronPath = ensureElectronRuntime();
  process.stdout.write(`${electronPath}\n`);
}

import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { fileURLToPath } from "node:url";

const require = NodeModule.createRequire(import.meta.url);
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone repair script has no Effect runtime.
const hostPlatform = NodeOS.platform();

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

function runChecked(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.status === 0) {
    return;
  }

  const cause = result.error ? `: ${result.error.message}` : "";
  throw new Error(
    `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}${cause}`,
  );
}

export function createElectronInstallInvocation(electronDir, env = process.env) {
  const installScript = NodePath.join(electronDir, "install.js");
  if (!NodeFS.existsSync(installScript)) {
    throw new Error(`Electron installer script is missing: ${installScript}`);
  }

  // This function is itself the recovery path for an intentionally skipped or
  // incomplete Electron postinstall. Do not let a stale skip flag suppress the
  // explicit repair attempt. Mirrors/proxies remain inherited.
  const repairEnv = { ...env };
  delete repairEnv.ELECTRON_SKIP_BINARY_DOWNLOAD;

  return {
    command: process.execPath,
    args: [installScript],
    cwd: electronDir,
    env: repairEnv,
  };
}

function installElectronRuntime(electronDir) {
  const invocation = createElectronInstallInvocation(electronDir);
  runChecked(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
  });
}

export function ensureElectronRuntime() {
  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronDir = NodePath.dirname(electronPackageJsonPath);
  const platformPath = getPlatformPath();
  const electronPath = NodePath.join(electronDir, "dist", platformPath);
  const missingBeforeInstall = missingRuntimePaths(electronDir, platformPath);
  const invalidBeforeInstall = invalidRuntimePaths(electronDir, platformPath);

  if (missingBeforeInstall.length > 0 || invalidBeforeInstall.length > 0) {
    if (NodeFS.existsSync(NodePath.join(electronDir, "dist"))) {
      NodeFS.rmSync(NodePath.join(electronDir, "dist"), { recursive: true, force: true });
    }
    NodeFS.rmSync(NodePath.join(electronDir, "path.txt"), { force: true });
    installElectronRuntime(electronDir);
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

const scriptPath = fileURLToPath(import.meta.url);

if (process.argv[1] && NodePath.resolve(process.argv[1]) === scriptPath) {
  const electronPath = ensureElectronRuntime();
  process.stdout.write(`${electronPath}\n`);
}

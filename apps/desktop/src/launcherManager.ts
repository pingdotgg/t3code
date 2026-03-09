import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import type { DesktopLauncherInstallResult, DesktopLauncherState } from "@t3tools/contracts";
import {
  buildPathExportSnippet,
  hasManagedPathSnippet,
  isCommandAvailable,
  resolveCompatibilityLauncherPaths,
  isDirectoryOnPath,
  resolveManagedLauncherBinDir,
  resolveManagedLauncherPath,
  resolvePathUpdateTarget,
  resolveShellProfilePath,
  writeDesktopLauncherMetadata,
} from "@t3tools/shared/launcher";

interface LauncherEnvironment {
  readonly stateDir: string;
  readonly executablePath: string;
  readonly serverEntryPath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly shell?: string | undefined;
}

interface InstallLauncherOptions extends LauncherEnvironment {
  readonly updatePath: boolean;
  readonly execFileSync?: typeof ChildProcess.execFileSync;
}

const WINDOWS_PATH_SCOPE = "User";

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function createLauncherState(
  input: Pick<DesktopLauncherState, "status" | "installDir" | "launcherPath" | "message"> & {
    readonly platform: NodeJS.Platform;
    readonly shell: string | undefined;
    readonly homeDir: string;
    readonly env: NodeJS.ProcessEnv;
  },
): DesktopLauncherState {
  return {
    command: "t3",
    status: input.status,
    installDir: input.installDir,
    launcherPath: input.launcherPath,
    pathConfigured: isDirectoryOnPath(input.installDir, input.env, input.platform),
    pathUpdateTarget: resolvePathUpdateTarget({
      platform: input.platform,
      shell: input.shell,
      homeDir: input.homeDir,
    }),
    message: input.message,
  } satisfies DesktopLauncherState;
}

function ensureDirectoryOnPath(
  directory: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): void {
  if (isDirectoryOnPath(directory, env, platform)) {
    return;
  }

  const key = platform === "win32" ? "Path" : "PATH";
  const existing = env[key] ?? env.PATH ?? env.Path ?? env.path ?? "";
  env[key] = existing.length > 0 ? `${directory}${pathDelimiter(platform)}${existing}` : directory;
  if (platform === "win32") {
    env.PATH = env[key];
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function renderPosixLauncherScript(executablePath: string, serverEntryPath: string): string {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    "export ELECTRON_RUN_AS_NODE=1",
    `exec ${shellQuote(executablePath)} ${shellQuote(serverEntryPath)} "$@"`,
    "",
  ].join("\n");
}

function escapeWindowsDoubleQuotes(value: string): string {
  return value.replaceAll('"', '""');
}

function renderWindowsLauncherScript(executablePath: string, serverEntryPath: string): string {
  const escapedExecutablePath = escapeWindowsDoubleQuotes(executablePath);
  const escapedServerEntryPath = escapeWindowsDoubleQuotes(serverEntryPath);

  return [
    "@echo off",
    "setlocal",
    "set ELECTRON_RUN_AS_NODE=1",
    `"${escapedExecutablePath}" "${escapedServerEntryPath}" %*`,
    "",
  ].join("\r\n");
}

function renderPosixCompatibilityLauncherScript(targetLauncherPath: string): string {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    `exec ${shellQuote(targetLauncherPath)} "$@"`,
    "",
  ].join("\n");
}

function renderWindowsCompatibilityLauncherScript(targetLauncherPath: string): string {
  const escapedTargetPath = escapeWindowsDoubleQuotes(targetLauncherPath);
  return [
    "@echo off",
    "setlocal",
    `"${escapedTargetPath}" %*`,
    "",
  ].join("\r\n");
}

function applyPosixPathUpdate(
  installDir: string,
  platform: NodeJS.Platform,
  shell: string | undefined,
  homeDir: string,
): void {
  const profilePath = resolveShellProfilePath({ platform, shell, homeDir });
  if (!profilePath) {
    throw new Error("Unable to determine a shell profile to update.");
  }

  const existingContent = FS.existsSync(profilePath) ? FS.readFileSync(profilePath, "utf8") : "";
  if (
    hasManagedPathSnippet(existingContent) ||
    existingContent.includes(`"${installDir}"`) ||
    existingContent.includes(`"${installDir}:`)
  ) {
    return;
  }

  FS.mkdirSync(Path.dirname(profilePath), { recursive: true });
  const prefix = existingContent.length > 0 && !existingContent.endsWith("\n") ? "\n" : "";
  FS.appendFileSync(
    profilePath,
    `${prefix}${buildPathExportSnippet(installDir, { platform, shell, homeDir })}`,
    "utf8",
  );
}

function escapePowerShellSingleQuotes(value: string): string {
  return value.replaceAll("'", "''");
}

function applyWindowsPathUpdate(
  installDir: string,
  execFileSync: typeof ChildProcess.execFileSync,
): void {
  const escapedInstallDir = escapePowerShellSingleQuotes(installDir);
  const script = [
    `$target = '${escapedInstallDir}'`,
    `$current = [Environment]::GetEnvironmentVariable('Path', '${WINDOWS_PATH_SCOPE}')`,
    "if ([string]::IsNullOrWhiteSpace($current)) {",
    "  $next = $target",
    "} else {",
    "  $parts = $current.Split(';') | Where-Object { $_ -and $_.Trim().Length -gt 0 }",
    "  if ($parts -contains $target) {",
    "    $next = $current",
    "  } else {",
    '    $next = "$target;$current"',
    "  }",
    "}",
    `[Environment]::SetEnvironmentVariable('Path', $next, '${WINDOWS_PATH_SCOPE}')`,
  ].join("\n");

  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    stdio: "ignore",
    windowsHide: true,
  });
}

function applyPathUpdate(
  installDir: string,
  platform: NodeJS.Platform,
  shell: string | undefined,
  homeDir: string,
  execFileSync: typeof ChildProcess.execFileSync,
): void {
  if (platform === "win32") {
    applyWindowsPathUpdate(installDir, execFileSync);
    return;
  }

  applyPosixPathUpdate(installDir, platform, shell, homeDir);
}

export function getDesktopLauncherState(options: LauncherEnvironment): DesktopLauncherState {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? OS.homedir();
  const shell = options.shell ?? env.SHELL;
  const installDir = resolveManagedLauncherBinDir({ platform, env, homeDir });
  const launcherPath = resolveManagedLauncherPath({ platform, env, homeDir });
  const launcherExists = FS.existsSync(launcherPath);
  const commandAvailable = isCommandAvailable("t3", { platform, env });

  if (commandAvailable) {
    return createLauncherState({
      status: "installed",
      installDir,
      launcherPath,
      message: null,
      platform,
      shell,
      homeDir,
      env,
    });
  }

  if (launcherExists) {
    return createLauncherState({
      status: "needs-path",
      installDir,
      launcherPath,
      message: `Add ${installDir} to PATH to use t3 in new terminals.`,
      platform,
      shell,
      homeDir,
      env,
    });
  }

  return createLauncherState({
    status: "missing",
    installDir,
    launcherPath,
    message: "Install the t3 command to open projects from your terminal.",
    platform,
    shell,
    homeDir,
    env,
  });
}

export function publishDesktopLauncherMetadata(options: LauncherEnvironment): void {
  writeDesktopLauncherMetadata(
    {
      version: 1,
      executablePath: options.executablePath,
      serverEntryPath: options.serverEntryPath,
      updatedAt: new Date().toISOString(),
    },
    options.stateDir,
  );
}

export function installDesktopLauncher(
  options: InstallLauncherOptions,
): DesktopLauncherInstallResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? OS.homedir();
  const shell = options.shell ?? env.SHELL;
  const installDir = resolveManagedLauncherBinDir({ platform, env, homeDir });
  const launcherPath = resolveManagedLauncherPath({ platform, env, homeDir });
  const compatibilityLauncherPaths = resolveCompatibilityLauncherPaths({ platform, env, homeDir });
  const execFileSync = options.execFileSync ?? ChildProcess.execFileSync;
  const installDirAlreadyOnPath = isDirectoryOnPath(installDir, env, platform);

  try {
    publishDesktopLauncherMetadata(options);

    FS.mkdirSync(installDir, { recursive: true });
    const contents =
      platform === "win32"
        ? renderWindowsLauncherScript(options.executablePath, options.serverEntryPath)
        : renderPosixLauncherScript(options.executablePath, options.serverEntryPath);
    FS.writeFileSync(launcherPath, contents, "utf8");
    if (platform !== "win32") {
      FS.chmodSync(launcherPath, 0o755);
    }

    for (const compatibilityLauncherPath of compatibilityLauncherPaths) {
      FS.mkdirSync(Path.dirname(compatibilityLauncherPath), { recursive: true });
      const compatibilityContents =
        platform === "win32"
          ? renderWindowsCompatibilityLauncherScript(launcherPath)
          : renderPosixCompatibilityLauncherScript(launcherPath);
      FS.writeFileSync(compatibilityLauncherPath, compatibilityContents, "utf8");
      if (platform !== "win32") {
        FS.chmodSync(compatibilityLauncherPath, 0o755);
      }
    }

    if (options.updatePath && !installDirAlreadyOnPath) {
      applyPathUpdate(installDir, platform, shell, homeDir, execFileSync);
      ensureDirectoryOnPath(installDir, env, platform);
    }

    const state = getDesktopLauncherState({
      ...options,
      env,
      platform,
      homeDir,
      shell,
    });
    return {
      completed: true,
      state,
    } satisfies DesktopLauncherInstallResult;
  } catch (error) {
    return {
      completed: false,
      state: createLauncherState({
        status: "error",
        installDir,
        launcherPath,
        message: error instanceof Error ? error.message : "Failed to install the t3 command.",
        platform,
        shell,
        homeDir,
        env,
      }),
    } satisfies DesktopLauncherInstallResult;
  }
}

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Node 20.12+ cannot spawn Windows launcher scripts without a shell; the SDK cannot use these as executables. */
const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"]);

export const isWindowsClaudeLauncherShimPath = (filePath: string): boolean =>
  WINDOWS_SHIM_EXTENSIONS.has(NodePath.win32.extname(filePath).toLowerCase());

/** New packages provide bin/claude.exe; older packages need a JavaScript runtime for cli.js. */
const NPM_PACKAGE_ENTRY_CANDIDATES = [
  ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
  ["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
] as const;

const WINGET_PACKAGE_ENTRY = [
  "Microsoft",
  "WinGet",
  "Packages",
  "Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe",
  "claude.exe",
] as const;

function resolveWinGetExecutablePath(shimPath: string, environment: NodeJS.ProcessEnv) {
  const localAppData = Object.entries(environment).find(
    ([key]) => key.toUpperCase() === "LOCALAPPDATA",
  )?.[1];
  if (!localAppData || !NodePath.win32.isAbsolute(localAppData)) return undefined;
  const launcherPath = NodePath.win32.join(
    localAppData,
    "Microsoft",
    "WinGet",
    "Links",
    "claude.cmd",
  );
  try {
    if (
      NodePath.win32.normalize(shimPath).toLowerCase() !== launcherPath.toLowerCase() &&
      NodeFS.realpathSync.native(shimPath).toLowerCase() !==
        NodeFS.realpathSync.native(launcherPath).toLowerCase()
    )
      return undefined;
    const launcher = NodeFS.readFileSync(shimPath, "utf8").replaceAll("\r\n", "\n").trim();
    const expectedLauncher = `@echo off\n"%LOCALAPPDATA%\\${WINGET_PACKAGE_ENTRY.join("\\")}" %*`;
    if (launcher.toLowerCase() !== expectedLauncher.toLowerCase()) return undefined;
    return NodePath.win32.join(localAppData, ...WINGET_PACKAGE_ENTRY);
  } catch {
    return undefined;
  }
}

export type ExecutableFileCheck = (filePath: string) => boolean;

function isExistingFile(filePath: string): boolean {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export const ClaudeExecutableFileCheck = Context.Reference<ExecutableFileCheck>(
  "server/provider/Drivers/ClaudeExecutableFileCheck",
  {
    defaultValue: () => isExistingFile,
  },
);

/** On Windows the SDK skips shell and PATH/PATHEXT lookup: bare names and .cmd shims fail. */
export const resolveClaudeSdkExecutablePath = Effect.fn("resolveClaudeSdkExecutablePath")(
  function* (binaryPath: string, environment: NodeJS.ProcessEnv): Effect.fn.Return<string> {
    const platform = yield* HostProcess.Platform;
    if (platform !== "win32") {
      return binaryPath;
    }

    const resolveExecutable = yield* SpawnExecutableResolution;
    const isFile = yield* ClaudeExecutableFileCheck;
    const resolved = resolveExecutable(binaryPath, platform, environment) ?? binaryPath;
    const extension = NodePath.win32.extname(resolved).toLowerCase();
    if (!WINDOWS_SHIM_EXTENSIONS.has(extension)) {
      return resolved;
    }

    const shimDirectory = NodePath.win32.dirname(resolved);
    for (const entrySegments of NPM_PACKAGE_ENTRY_CANDIDATES) {
      const candidate = NodePath.win32.join(shimDirectory, ...entrySegments);
      if (isFile(candidate)) {
        return candidate;
      }
    }

    const winGetExecutable = resolveWinGetExecutablePath(resolved, environment);
    if (winGetExecutable && isFile(winGetExecutable)) {
      return winGetExecutable;
    }

    yield* Effect.logWarning(
      "Claude launcher shim resolved but no known package entry was found; the Claude Agent SDK cannot spawn launcher scripts directly.",
      { binaryPath, resolvedShimPath: resolved },
    );
    return binaryPath;
  },
);

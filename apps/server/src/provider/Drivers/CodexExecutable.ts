// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

const DEFAULT_CODEX_COMMANDS: ReadonlySet<string> = new Set(["codex", "codex.exe"]);

interface CodexDesktopDirectoryEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

interface CodexDesktopFileInfo {
  readonly isFile: boolean;
  readonly modifiedAt: number;
}

export interface CodexDesktopFileSystem {
  readonly readDirectory: (directoryPath: string) => ReadonlyArray<CodexDesktopDirectoryEntry>;
  readonly statFile: (filePath: string) => CodexDesktopFileInfo | undefined;
}

const nodeCodexDesktopFileSystem: CodexDesktopFileSystem = {
  readDirectory: (directoryPath) => {
    try {
      return NodeFS.readdirSync(directoryPath, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));
    } catch {
      return [];
    }
  },
  statFile: (filePath) => {
    try {
      const stat = NodeFS.statSync(filePath);
      return {
        isFile: stat.isFile(),
        modifiedAt: stat.mtimeMs,
      };
    } catch {
      return undefined;
    }
  },
};

/**
 * Finds the newest usable Codex CLI extracted by Codex Desktop.
 *
 * Microsoft Store installs do not expose their packaged executable on the
 * normal user PATH. Codex Desktop keeps a launchable copy under the user's
 * local app data directory, with a version-specific directory name.
 */
export function findCodexDesktopBinary(
  localAppData: string,
  fileSystem: CodexDesktopFileSystem = nodeCodexDesktopFileSystem,
): string | undefined {
  const binaryRoot = NodePath.win32.join(localAppData, "OpenAI", "Codex", "bin");
  const candidates = fileSystem
    .readDirectory(binaryRoot)
    .filter((entry) => entry.isDirectory)
    .flatMap((entry) => {
      const binaryPath = NodePath.win32.join(binaryRoot, entry.name, "codex.exe");
      const info = fileSystem.statFile(binaryPath);
      return info?.isFile ? [{ binaryPath, modifiedAt: info.modifiedAt }] : [];
    })
    .sort(
      (left, right) =>
        right.modifiedAt - left.modifiedAt || left.binaryPath.localeCompare(right.binaryPath),
    );

  return candidates[0]?.binaryPath;
}

export type CodexDesktopBinaryDiscovery = (localAppData: string) => string | undefined;

/** Injectable discovery hook so resolver tests never inspect the host machine. */
export const CodexDesktopBinaryDiscovery = Context.Reference<CodexDesktopBinaryDiscovery>(
  "server/provider/Drivers/CodexDesktopBinaryDiscovery",
  {
    defaultValue: () => findCodexDesktopBinary,
  },
);

/**
 * Resolves Codex exactly once for every provider instance so probes, sessions,
 * and text generation all use the same executable.
 *
 * A configured path or normal PATH installation always wins. The Codex
 * Desktop runtime is only considered for the default bare command on Windows.
 */
export const resolveCodexExecutablePath = Effect.fn("resolveCodexExecutablePath")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string> {
  const platform = yield* HostProcessPlatform;
  if (platform !== "win32") {
    return binaryPath;
  }

  const resolveExecutable = yield* SpawnExecutableResolution;
  const resolved = resolveExecutable(binaryPath, platform, environment);
  if (resolved) {
    return resolved;
  }

  if (!DEFAULT_CODEX_COMMANDS.has(binaryPath.trim().toLowerCase())) {
    return binaryPath;
  }

  const localAppData = environment.LOCALAPPDATA?.trim();
  if (!localAppData) {
    return binaryPath;
  }

  const discoverDesktopBinary = yield* CodexDesktopBinaryDiscovery;
  return discoverDesktopBinary(localAppData) ?? binaryPath;
});

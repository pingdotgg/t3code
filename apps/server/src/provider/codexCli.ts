// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const CODEX_CLI_COMMAND = "codex";

// `codex-cli 0.159.0`, `codex-cli 0.160.0-alpha.1` or the npm CLI's bare `0.1.4161006`.
// Keep a prerelease suffix so compatibility stays unknown for it, as it does for `initialize`.
const CODEX_CLI_VERSION_PATTERN = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/u;

export function parseCodexCliVersion(output: string): string | null {
  return CODEX_CLI_VERSION_PATTERN.exec(output)?.[1] ?? null;
}

/** The Windows user data root that contains the ChatGPT/Codex desktop app files. */
const codexDesktopUserDataRoot = (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | null => {
  if (platform !== "win32") return null;
  const localAppData = environment.LOCALAPPDATA?.trim() || environment.LocalAppData?.trim();
  return localAppData || null;
};

const fileStat = (filePath: string) => {
  try {
    const stat = NodeFS.statSync(filePath);
    return stat.isFile() && stat.size > 0 ? stat : null;
  } catch {
    return null;
  }
};

/**
 * Find the CLI bundled with the ChatGPT/Codex desktop app on Windows. The app
 * keeps it under a versioned LocalAppData directory and does not add that
 * directory to the persistent user PATH.
 */
export const resolveCodexDesktopCliPath = (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | null => {
  const userDataRoot = codexDesktopUserDataRoot(platform, environment);
  if (userDataRoot === null) return null;

  const binDirectory = NodePath.join(userDataRoot, "OpenAI", "Codex", "bin");
  let entries: ReadonlyArray<string>;
  try {
    entries = NodeFS.readdirSync(binDirectory);
  } catch {
    return null;
  }

  const candidates: Array<{ readonly executablePath: string; readonly modifiedAt: number }> = [];
  for (const entry of entries) {
    const directory = NodePath.join(binDirectory, entry);
    const executablePath = NodePath.join(directory, "codex.exe");
    const executable = fileStat(executablePath);
    const host = fileStat(NodePath.join(directory, "codex-code-mode-host.exe"));
    if (executable === null || host === null) continue;
    candidates.push({ executablePath, modifiedAt: executable.mtimeMs });
  }

  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return candidates[0]?.executablePath ?? null;
};

/** Resolve the default `codex` command, including the Windows desktop app copy. */
export const resolveCodexCliPath = Effect.fn("resolveCodexCliPath")(function* (input: {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  if (input.binaryPath !== CODEX_CLI_COMMAND) return input.binaryPath;

  const platform = yield* HostProcess.Platform;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fromPath = yield* resolveCommandPath(CODEX_CLI_COMMAND, { env: input.environment }).pipe(
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );
  if (fromPath !== null) return fromPath;

  return resolveCodexDesktopCliPath(platform, input.environment) ?? input.binaryPath;
});

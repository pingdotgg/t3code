/**
 * Shell discovery for the terminal surface.
 *
 * Enumerates the shells a host exposes so the UI can offer a picker (VS Code
 * style) and so a configured default can be resolved. Detection is best-effort:
 * a listed shell may still fail to spawn in a given environment, in which case
 * the terminal manager falls back through its candidate chain.
 */
import { TerminalDescribedShell } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Known Windows shells, ordered roughly by preference. */
const WINDOWS_SHELLS: ReadonlyArray<TerminalDescribedShell> = [
  {
    id: "pwsh",
    label: "PowerShell (pwsh)",
    executable: "pwsh.exe",
  },
  {
    id: "powershell",
    label: "Windows PowerShell",
    executable: "powershell.exe",
  },
  {
    id: "cmd",
    label: "Command Prompt",
    executable: "cmd.exe",
  },
  {
    id: "git-bash",
    label: "Git Bash",
    executable: "bash.exe",
  },
];

/** Known POSIX shells, ordered roughly by preference. */
const POSIX_SHELLS: ReadonlyArray<TerminalDescribedShell> = [
  {
    id: "zsh",
    label: "Zsh",
    executable: "zsh",
  },
  {
    id: "bash",
    label: "Bash",
    executable: "bash",
  },
  {
    id: "sh",
    label: "Sh",
    executable: "sh",
  },
];

function defaultShellForPlatform(platform: NodeJS.Platform): string {
  return platform === "win32" ? "pwsh.exe" : "/bin/bash";
}

/**
 * Discover the shells available on the host plus the configured default.
 *
 * Shell executables are probed with `isCommandAvailable`. On Windows, Git Bash
 * lives under the user's `%ProgramFiles%\Git` (or `%LOCALAPPDATA%\Programs\Git`)
 * tree which is usually already on PATH when installed with its default options;
 * we probe both the bare command and the canonical install locations so a
 * partially-PATH'd Git still shows up.
 *
 * `defaultShell` is derived from `resolveDefaultShell` when provided so it
 * matches the shell the terminal manager actually launches (e.g. a host whose
 * `SHELL` is `/bin/zsh`), falling back to the platform default otherwise.
 */
export const listAvailableShells = (options?: { resolveDefaultShell?: () => string }) =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const env: NodeJS.ProcessEnv = yield* HostProcessEnvironment;
    const detected: TerminalDescribedShell[] = [];

    if (platform === "win32") {
      for (const candidate of WINDOWS_SHELLS) {
        const executable = yield* resolveWindowsShellExecutable(candidate.executable, env);
        if (executable) {
          detected.push({ ...candidate, executable });
        }
      }
    } else {
      for (const candidate of POSIX_SHELLS) {
        if (yield* isCommandAvailable(candidate.executable, { env })) {
          detected.push(candidate);
        }
      }
    }

    const resolvedDefault = options?.resolveDefaultShell?.()?.trim();
    const defaultShell =
      resolvedDefault && resolvedDefault.length > 0
        ? resolvedDefault
        : defaultShellForPlatform(platform);

    return { shells: detected, defaultShell };
  });

const WINDOWS_SHELL_CANDIDATES_BY_COMMAND = new Map<
  string,
  ReadonlyArray<(env: NodeJS.ProcessEnv) => string>
>([
  [
    "pwsh.exe",
    [(env) => (env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\pwsh.exe` : "")],
  ],
  [
    "powershell.exe",
    [
      (env) =>
        (env.SystemRoot ?? env.windir ?? "C:\\Windows") +
        "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ],
  ],
  ["cmd.exe", [(env) => (env.SystemRoot ?? env.windir ?? "C:\\Windows") + "\\System32\\cmd.exe"]],
  [
    "bash.exe",
    [
      (env) => (env.ProgramFiles ?? "C:\\Program Files") + "\\Git\\bin\\bash.exe",
      (env) => (env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe` : ""),
    ],
  ],
]);

function resolveWindowsShellExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const explicitPaths = WINDOWS_SHELL_CANDIDATES_BY_COMMAND.get(command) ?? [];
    for (const buildPath of explicitPaths) {
      const candidatePath = buildPath(env);
      if (!candidatePath) continue;
      if (yield* isCommandAvailable(candidatePath, { env })) {
        return candidatePath;
      }
    }
    if (yield* isCommandAvailable(command, { env })) {
      return command;
    }
    return null;
  });
}

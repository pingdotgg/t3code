import type { TerminalShellProfile } from "@t3tools/contracts";

export interface ShellCandidate {
  shell: string;
  args?: string[];
  /** Name shown to users; defaults to the command line when absent. */
  label?: string;
}

export function basenameForPlatform(command: string, platform: NodeJS.Platform): string {
  const normalized =
    platform === "win32" ? command.replaceAll("/", "\\") : command.replaceAll("\\", "/");
  const parts = normalized
    .split(platform === "win32" ? /\\+/ : /\/+/)
    .filter((part) => part.length > 0);
  return parts.at(-1) ?? normalized;
}

function joinWindowsPath(...parts: ReadonlyArray<string>): string {
  return parts
    .map((part, index) => {
      if (index === 0) return part.replace(/[\\/]+$/g, "");
      return part.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .filter((part) => part.length > 0)
    .join("\\");
}

export function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = basenameForPlatform(command, platform).toLowerCase();
  if (platform === "win32" && (shellName === "pwsh.exe" || shellName === "powershell.exe")) {
    return { shell: command, args: ["-NoLogo"] };
  }
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
}

export function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(
    windowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export function windowsCmdPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(windowsSystemRoot(env), "System32", "cmd.exe");
}

export interface ShellDetectionInput {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly fileExists: (path: string) => boolean;
  /** Contents of /etc/shells, or null when unreadable. Unused on Windows. */
  readonly etcShells: string | null;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : env[key]?.trim();
  return value ? value : undefined;
}

function windowsParentDirectory(directory: string): string | null {
  const trimmed = directory.replace(/[\\/]+$/g, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return index > 0 ? trimmed.slice(0, index) : null;
}

function detectWindowsShells(input: ShellDetectionInput): TerminalShellProfile[] {
  const { env, fileExists } = input;
  const pathDirectories = (envValue(env, "PATH") ?? "")
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => entry.length > 0);
  const findOnPath = (executable: string) =>
    pathDirectories
      .map((directory) => joinWindowsPath(directory, executable))
      .find((candidate) => fileExists(candidate));
  const firstExisting = (candidates: ReadonlyArray<string | undefined>) =>
    candidates.find(
      (candidate): candidate is string => candidate !== undefined && fileExists(candidate),
    );
  const programFiles = [
    envValue(env, "ProgramFiles"),
    envValue(env, "ProgramW6432"),
    envValue(env, "ProgramFiles(x86)"),
  ];
  const profiles: TerminalShellProfile[] = [];

  const pwsh = firstExisting([
    findOnPath("pwsh.exe"),
    ...programFiles.map((root) =>
      root === undefined ? undefined : joinWindowsPath(root, "PowerShell", "7", "pwsh.exe"),
    ),
  ]);
  if (pwsh !== undefined) {
    profiles.push({ id: "pwsh", label: "PowerShell 7", command: pwsh, args: ["-NoLogo"] });
  }

  const powershell = windowsPowerShellPath(env);
  if (fileExists(powershell)) {
    profiles.push({
      id: "powershell",
      label: "Windows PowerShell",
      command: powershell,
      args: ["-NoLogo"],
    });
  }

  const cmd = firstExisting([envValue(env, "ComSpec"), windowsCmdPath(env)]);
  if (cmd !== undefined) {
    profiles.push({ id: "cmd", label: "Command Prompt", command: cmd, args: [] });
  }

  // git.exe sits in `<Git>\cmd` or `<Git>\mingw64\bin`; bash.exe is in `<Git>\bin`.
  const gitExecutable = findOnPath("git.exe");
  const gitDirectory = gitExecutable ? windowsParentDirectory(gitExecutable) : null;
  const gitRoot = gitDirectory ? windowsParentDirectory(gitDirectory) : null;
  const gitRoots = [
    ...programFiles.map((root) => (root === undefined ? undefined : joinWindowsPath(root, "Git"))),
    (() => {
      const localAppData = envValue(env, "LocalAppData");
      return localAppData === undefined
        ? undefined
        : joinWindowsPath(localAppData, "Programs", "Git");
    })(),
    gitRoot ?? undefined,
    gitRoot ? (windowsParentDirectory(gitRoot) ?? undefined) : undefined,
  ];
  const bash = firstExisting(
    gitRoots.map((root) =>
      root === undefined ? undefined : joinWindowsPath(root, "bin", "bash.exe"),
    ),
  );
  if (bash !== undefined) {
    profiles.push({ id: "bash", label: "Git Bash", command: bash, args: ["--login", "-i"] });
  }

  return profiles;
}

const UNUSABLE_UNIX_SHELLS = new Set(["nologin", "false", "git-shell"]);

function detectUnixShells(input: ShellDetectionInput): TerminalShellProfile[] {
  const listed = (input.etcShells ?? "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/"));
  const fromEnv = envValue(input.env, "SHELL");
  const commands = listed.length > 0 ? listed : fromEnv ? [fromEnv] : [];

  const profiles: TerminalShellProfile[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    const id = basenameForPlatform(command, input.platform);
    if (id.length === 0 || seen.has(id) || UNUSABLE_UNIX_SHELLS.has(id)) continue;
    if (!input.fileExists(command)) continue;
    seen.add(id);
    profiles.push({
      id,
      label: id,
      command,
      args: shellCandidateFromCommand(command, input.platform)?.args ?? [],
    });
  }
  return profiles;
}

export function detectShellProfiles(input: ShellDetectionInput): TerminalShellProfile[] {
  return input.platform === "win32" ? detectWindowsShells(input) : detectUnixShells(input);
}

export function candidateFromProfile(profile: TerminalShellProfile): ShellCandidate {
  return { shell: profile.command, args: [...profile.args], label: profile.label };
}

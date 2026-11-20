import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export function defaultShellResolver(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    return "pwsh.exe";
  }
  return env.SHELL ?? "bash";
}

const normalizeShellCommand = Effect.fn("terminal.normalizeShellCommand")(function* (
  value: string | undefined,
  platform: NodeJS.Platform,
) {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (platform === "win32") {
    return trimmed;
  }

  const quoted = /^(['"])(.*?)\1(?:\s|$)/.exec(trimmed);
  if (quoted) return quoted[2] || null;

  if (trimmed.startsWith("/") && /\s/.test(trimmed)) {
    const fs = yield* FileSystem.FileSystem;
    const ends = [...trimmed.matchAll(/\s+/g)].map((match) => match.index);
    // Unquoted paths are ambiguous; prefer the longest existing file over flag syntax.
    for (const end of [trimmed.length, ...ends.reverse()]) {
      const candidate = trimmed.slice(0, end);
      const info = yield* fs
        .stat(candidate)
        .pipe(Effect.catchTags({ PlatformError: () => Effect.succeed(null) }));
      if (info?.type === "File") return candidate;
    }
  }

  return trimmed.split(/\s+(?=-)/)[0]?.replace(/^['"]|['"]$/g, "") || null;
});

function basenameForPlatform(command: string, platform: NodeJS.Platform): string {
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

// PowerShell decodes native output with the console code page (often OEM 437), mangling UTF-8.
const POWERSHELL_UTF8_SETUP =
  "[Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new()";

function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = basenameForPlatform(command, platform).toLowerCase();
  if (platform === "win32" && (shellName === "pwsh.exe" || shellName === "powershell.exe")) {
    return { shell: command, args: ["-NoLogo", "-NoExit", "-Command", POWERSHELL_UTF8_SETUP] };
  }
  if (platform === "win32" && (shellName === "bash.exe" || shellName === "bash")) {
    return { shell: command, args: ["--login", "-i"] };
  }
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  // Login shells load ~/.bash_profile, matching macOS terminal startup.
  if (platform === "darwin" && shellName === "bash") {
    return { shell: command, args: ["-l"] };
  }
  return { shell: command };
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(
    windowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsCmdPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(windowsSystemRoot(env), "System32", "cmd.exe");
}

export function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

export const resolveShellCandidates = Effect.fn("terminal.resolveShellCandidates")(function* (
  shellResolver: () => string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  terminalShell: string | undefined,
) {
  // This is an executable path, not a command line; spaces belong to the path.
  const configured = shellCandidateFromCommand(terminalShell?.trim() || null, platform);
  const requested = shellCandidateFromCommand(
    yield* normalizeShellCommand(shellResolver(), platform),
    platform,
  );

  if (platform === "win32") {
    return uniqueShellCandidates([
      configured,
      requested,
      shellCandidateFromCommand("pwsh.exe", platform),
      shellCandidateFromCommand(windowsPowerShellPath(env), platform),
      shellCandidateFromCommand("powershell.exe", platform),
      shellCandidateFromCommand(env.ComSpec ?? null, platform),
      shellCandidateFromCommand(windowsCmdPath(env), platform),
      shellCandidateFromCommand("cmd.exe", platform),
    ]);
  }

  return uniqueShellCandidates([
    configured,
    requested,
    shellCandidateFromCommand(yield* normalizeShellCommand(env.SHELL, platform), platform),
    shellCandidateFromCommand("/bin/zsh", platform),
    shellCandidateFromCommand("/bin/bash", platform),
    shellCandidateFromCommand("/bin/sh", platform),
    shellCandidateFromCommand("zsh", platform),
    shellCandidateFromCommand("bash", platform),
    shellCandidateFromCommand("sh", platform),
  ]);
});

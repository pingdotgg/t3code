import path from "node:path";

import {
  type ServerTerminal,
  type ServerTerminalDiscoveredShell,
  type TerminalProfileSettings,
} from "@t3tools/contracts";

import { type ShellCandidate } from "./Services/Manager";

export type TerminalPlatform = NodeJS.Platform;

export interface ResolveTerminalShellSpawnConfigInput {
  platform: TerminalPlatform;
  processEnv: NodeJS.ProcessEnv;
  shellResolver: () => string;
  profile: TerminalProfileSettings | null | undefined;
}

export interface ResolvedTerminalShellSpawnConfig {
  shellCandidates: ShellCandidate[];
  profileEnv: Record<string, string> | null;
}

export type TerminalShellPathProbe = (candidatePath: string) => Promise<boolean>;

export interface WindowsTerminalShellDiscovery {
  cmd: { available: boolean; path: string | null };
  powershell: { available: boolean; path: string | null };
  gitBash: { available: boolean; path: string | null };
  wsl: { available: boolean; path: string | null };
}

export function resolveCurrentShell(
  platform: TerminalPlatform,
  processEnv: NodeJS.ProcessEnv,
): string {
  if (platform === "win32") {
    return processEnv.ComSpec ?? "cmd.exe";
  }
  return processEnv.SHELL ?? "bash";
}

function createDiscoveredShell(
  id: ServerTerminalDiscoveredShell["id"],
  label: string,
  shell: { available: boolean; path: string | null },
): ServerTerminalDiscoveredShell {
  return {
    id,
    label,
    available: shell.available,
    path: shell.path,
  };
}

function normalizeShellCommand(
  value: string | undefined,
  platform: TerminalPlatform,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function shellCandidateFromCommand(
  command: string | null,
  platform: TerminalPlatform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = path.basename(command).toLowerCase();
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function formatShellCandidate(candidate: ShellCandidate): string {
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

function resolveDefaultShellCandidates(input: {
  platform: TerminalPlatform;
  processEnv: NodeJS.ProcessEnv;
  shellResolver: () => string;
}): ShellCandidate[] {
  const requested = shellCandidateFromCommand(
    normalizeShellCommand(input.shellResolver(), input.platform),
    input.platform,
  );

  if (input.platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand(input.processEnv.ComSpec ?? null, input.platform),
      shellCandidateFromCommand("powershell.exe", input.platform),
      shellCandidateFromCommand("cmd.exe", input.platform),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(
      normalizeShellCommand(input.processEnv.SHELL, input.platform),
      input.platform,
    ),
    shellCandidateFromCommand("/bin/zsh", input.platform),
    shellCandidateFromCommand("/bin/bash", input.platform),
    shellCandidateFromCommand("/bin/sh", input.platform),
    shellCandidateFromCommand("zsh", input.platform),
    shellCandidateFromCommand("bash", input.platform),
    shellCandidateFromCommand("sh", input.platform),
  ]);
}

function normalizeShellArgs(shellArgs: ReadonlyArray<string> | undefined): string[] {
  if (!shellArgs || shellArgs.length === 0) return [];
  return shellArgs.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
}

function normalizeTerminalProfileEnv(
  env: TerminalProfileSettings["env"] | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env)
    .map(([key, value]) => [key.trim(), value] as const)
    .filter(([key]) => key.length > 0);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries);
}

export function resolveTerminalShellSpawnConfig(
  input: ResolveTerminalShellSpawnConfigInput,
): ResolvedTerminalShellSpawnConfig {
  const shellPath = normalizeShellCommand(input.profile?.shellPath, input.platform);
  const shellArgs = normalizeShellArgs(input.profile?.shellArgs);
  const profileEnv = normalizeTerminalProfileEnv(input.profile?.env);

  if (shellPath) {
    return {
      shellCandidates: uniqueShellCandidates([
        {
          shell: shellPath,
          ...(shellArgs.length > 0 ? { args: shellArgs } : {}),
        },
      ]),
      profileEnv,
    };
  }

  const shellCandidates = resolveDefaultShellCandidates(input);
  if (shellArgs.length === 0) {
    return { shellCandidates, profileEnv };
  }

  return {
    shellCandidates: shellCandidates.map((candidate, index) =>
      index === 0 ? { shell: candidate.shell, args: shellArgs } : candidate,
    ),
    profileEnv,
  };
}

async function firstExistingPath(
  candidates: string[],
  probe: TerminalShellPathProbe,
): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      if (await probe(candidate)) {
        return candidate;
      }
    } catch {
      // Discovery is best-effort; treat probe failures as unavailable paths.
    }
  }
  return null;
}

export async function discoverWindowsTerminalShells(input: {
  env: NodeJS.ProcessEnv;
  probe: TerminalShellPathProbe;
}): Promise<WindowsTerminalShellDiscovery> {
  const systemRoot = input.env.SystemRoot ?? "C:\\Windows";
  const cmdPath = await firstExistingPath(
    [input.env.ComSpec ?? path.win32.join(systemRoot, "System32", "cmd.exe")],
    input.probe,
  );
  const powershellPath = await firstExistingPath(
    [path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")],
    input.probe,
  );
  const gitBashPath = await firstExistingPath(
    [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
    ],
    input.probe,
  );
  const wslPath = await firstExistingPath(
    [path.win32.join(systemRoot, "System32", "wsl.exe")],
    input.probe,
  );

  return {
    cmd: { available: cmdPath !== null, path: cmdPath },
    powershell: { available: powershellPath !== null, path: powershellPath },
    gitBash: { available: gitBashPath !== null, path: gitBashPath },
    wsl: { available: wslPath !== null, path: wslPath },
  };
}

export async function discoverTerminalShells(input: {
  platform: TerminalPlatform;
  env: NodeJS.ProcessEnv;
  probe: TerminalShellPathProbe;
}): Promise<ServerTerminal> {
  if (input.platform !== "win32") {
    return {
      platform: input.platform,
      currentShell: resolveCurrentShell(input.platform, input.env),
      discoveredShells: [],
    };
  }

  const windowsShells = await discoverWindowsTerminalShells({
    env: input.env,
    probe: input.probe,
  });

  return {
    platform: input.platform,
    currentShell: resolveCurrentShell(input.platform, input.env),
    discoveredShells: [
      createDiscoveredShell("powershell", "PowerShell", windowsShells.powershell),
      createDiscoveredShell("cmd", "Command Prompt", windowsShells.cmd),
      createDiscoveredShell("gitBash", "Git Bash", windowsShells.gitBash),
      createDiscoveredShell("wsl", "WSL", windowsShells.wsl),
    ],
  };
}

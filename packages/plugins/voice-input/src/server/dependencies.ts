// @effect-diagnostics nodeBuiltinImport:off

import { execFile } from "node:child_process";
import * as NodePath from "node:path";
import { promisify } from "node:util";

import type { VoiceInputDependencyCheck } from "../shared/schema.ts";

const execFileAsync = promisify(execFile);
const CHECK_TIMEOUT_MS = 5_000;
const WINDOWS_PYTHON_LAUNCHER_COMMAND = "py -3";

export interface PythonCommandInvocation {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}

function posixShellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function windowsCommandQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}

function commandQuote(value: string): string {
  return process.platform === "win32" ? windowsCommandQuote(value) : posixShellQuote(value);
}

export function pythonCommandInvocation(pythonCommand: string): PythonCommandInvocation {
  return pythonCommand.trim() === WINDOWS_PYTHON_LAUNCHER_COMMAND
    ? { executable: "py", args: ["-3"] }
    : { executable: pythonCommand, args: [] };
}

function pythonCommandShellText(pythonCommand: string): string {
  return pythonCommand.trim() === WINDOWS_PYTHON_LAUNCHER_COMMAND
    ? WINDOWS_PYTHON_LAUNCHER_COMMAND
    : commandQuote(pythonCommand);
}

export function fasterWhisperInstallCommand(pythonCommand: string | null = null): string {
  const command =
    pythonCommand === null
      ? process.platform === "win32"
        ? WINDOWS_PYTHON_LAUNCHER_COMMAND
        : "python3"
      : pythonCommandShellText(pythonCommand);
  return `${command} -m pip install --upgrade faster-whisper`;
}

export function formatFasterWhisperUnavailableDetail(
  pythonCommand: string | null,
  installCommand = fasterWhisperInstallCommand(pythonCommand),
): string {
  const runtime = pythonCommand ?? "Python";
  return `faster-whisper is not installed for ${runtime}. Install with: ${installCommand}`;
}

export const FASTER_WHISPER_INSTALL_COMMAND = fasterWhisperInstallCommand();

export function localWhisperVenvPath(dataDir: string): string {
  return NodePath.join(dataDir, "local-whisper-venv");
}

export function localWhisperVenvPythonCommand(dataDir: string): string {
  return NodePath.join(
    localWhisperVenvPath(dataDir),
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
}

export function localWhisperVenvSetupCommand(dataDir: string): string {
  const venvPath = localWhisperVenvPath(dataDir);
  const venvPythonCommand = localWhisperVenvPythonCommand(dataDir);
  const pythonLauncher = process.platform === "win32" ? WINDOWS_PYTHON_LAUNCHER_COMMAND : "python3";
  return [
    `${pythonLauncher} -m venv ${commandQuote(venvPath)}`,
    `${commandQuote(venvPythonCommand)} -m pip install --upgrade pip faster-whisper`,
  ].join(" && ");
}

async function probeExecutable(command: string, args: ReadonlyArray<string>): Promise<string> {
  const result = await execFileAsync(command, [...args], {
    timeout: CHECK_TIMEOUT_MS,
    maxBuffer: 128 * 1024,
  });
  return `${result.stdout}${result.stderr}`.trim();
}

async function probePython(command: string, args: ReadonlyArray<string>): Promise<string> {
  const invocation = pythonCommandInvocation(command);
  return probeExecutable(invocation.executable, [...invocation.args, ...args]);
}

export async function findPythonCommand(
  input: {
    readonly configuredCommand?: string;
    readonly venvPythonCommand?: string;
  } = {},
): Promise<{
  readonly check: VoiceInputDependencyCheck;
  readonly command: string | null;
}> {
  const configuredCommand = input.configuredCommand?.trim();
  const defaultCandidates =
    process.platform === "win32"
      ? [input.venvPythonCommand, WINDOWS_PYTHON_LAUNCHER_COMMAND, "python", "python3"]
      : [input.venvPythonCommand, "python3", "python"];
  const candidates = (
    configuredCommand && configuredCommand.length > 0 ? [configuredCommand] : defaultCandidates
  ).filter(
    (command, index, commands): command is string =>
      typeof command === "string" && command.length > 0 && commands.indexOf(command) === index,
  );

  for (const command of candidates) {
    try {
      const output = await probePython(command, ["--version"]);
      return {
        check: {
          available: true,
          detail: `${output || "Python"} (${command})`,
        },
        command,
      };
    } catch {
      continue;
    }
  }

  return {
    check: {
      available: false,
      detail: configuredCommand
        ? `Configured Python executable could not be run: ${configuredCommand}`
        : "Python was not found on PATH.",
    },
    command: null,
  };
}

export async function checkFasterWhisper(
  pythonCommand: string | null,
  installCommand = fasterWhisperInstallCommand(pythonCommand),
): Promise<VoiceInputDependencyCheck> {
  if (!pythonCommand) {
    return {
      available: false,
      detail: "Python is required before faster-whisper can be checked.",
    };
  }

  try {
    await probePython(pythonCommand, ["-c", "import faster_whisper"]);
    return { available: true, detail: "faster-whisper is importable." };
  } catch {
    return {
      available: false,
      detail: formatFasterWhisperUnavailableDetail(pythonCommand, installCommand),
    };
  }
}

export async function checkFfmpeg(): Promise<VoiceInputDependencyCheck> {
  try {
    const output = await probeExecutable("ffmpeg", ["-version"]);
    return {
      available: true,
      detail: output.split("\n")[0] ?? "ffmpeg is available.",
    };
  } catch {
    return {
      available: false,
      detail: "ffmpeg was not found on PATH. Browser WebM recordings may still work.",
    };
  }
}

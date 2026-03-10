import { spawn } from "node:child_process";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "./provider/codexCliVersion";

export const DEFAULT_CODEX_CLI_TIMEOUT_MS = 15_000;
export const DEFAULT_CODEX_CLI_TIMEOUT_RETRY_COUNT = 1;

export interface CodexCliCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly timedOut?: boolean;
}

export interface CodexCliCommandInput {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly homePath?: string;
  readonly timeoutMs?: number;
  readonly retryCount?: number;
}

export type CodexCliCommandRunner = (
  input: CodexCliCommandInput,
) => Promise<CodexCliCommandResult>;

function isCommandMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return (
    lower.includes("command not found") ||
    (lower.includes("spawn") && lower.includes("enoent")) ||
    lower.includes("not found")
  );
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.toLowerCase().includes("etimedout");
}

export async function runCodexCliCommand(
  input: CodexCliCommandInput,
): Promise<CodexCliCommandResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_CODEX_CLI_TIMEOUT_MS;

  return await new Promise<CodexCliCommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(input.binaryPath, [...input.args], {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      env: {
        ...process.env,
        ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
      },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.removeAllListeners("error");
      child.removeAllListeners("close");
      callback();
    };

    child.stdout?.on("data", (chunk: string | Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      finish(() => reject(error));
    });

    child.once("close", (code, signal) => {
      if (typeof code !== "number") {
        finish(() =>
          reject(
            new Error(
              signal
                ? `Codex CLI process exited from signal ${signal} without an exit code.`
                : "Codex CLI process exited without an exit code.",
            ),
          ),
        );
        return;
      }

      finish(() =>
        resolve({
          stdout,
          stderr,
          code,
        }),
      );
    });

    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best-effort cleanup only.
      }

      finish(() =>
        resolve({
          stdout,
          stderr,
          code: 124,
          timedOut: true,
        }),
      );
    }, timeoutMs);
  });
}

export async function runCodexCliCommandWithRetry(
  input: CodexCliCommandInput,
  runCommand: CodexCliCommandRunner = runCodexCliCommand,
): Promise<CodexCliCommandResult> {
  const retryCount = input.retryCount ?? DEFAULT_CODEX_CLI_TIMEOUT_RETRY_COUNT;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      const result = await runCommand(input);
      if (!result.timedOut || attempt === retryCount) {
        return result;
      }
    } catch (error) {
      if (!isTimeoutError(error) || attempt === retryCount) {
        throw error;
      }
    }
  }

  return {
    stdout: "",
    stderr: "",
    code: 124,
    timedOut: true,
  };
}

function detailFromResult(result: CodexCliCommandResult): string {
  if (result.timedOut) return "Timed out while running command.";

  const stderr = result.stderr.trim();
  if (stderr.length > 0) return stderr;

  const stdout = result.stdout.trim();
  if (stdout.length > 0) return stdout;

  return `Command exited with code ${result.code}.`;
}

export async function assertSupportedCodexCliVersion(
  input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly homePath?: string;
  },
  runCommand: CodexCliCommandRunner = runCodexCliCommand,
): Promise<void> {
  let result: CodexCliCommandResult;
  try {
    result = await runCodexCliCommandWithRetry(
      {
        binaryPath: input.binaryPath,
        args: ["--version"],
        cwd: input.cwd,
        ...(input.homePath ? { homePath: input.homePath } : {}),
      },
      runCommand,
    );
  } catch (error) {
    if (isCommandMissingError(error)) {
      throw new Error(`Codex CLI (${input.binaryPath}) is not installed or not executable.`, {
        cause: error,
      });
    }
    throw new Error(
      `Failed to execute Codex CLI version check: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }

  if (result.timedOut) {
    throw new Error(`Failed to execute Codex CLI version check: ${detailFromResult(result)}`);
  }

  if (result.code !== 0) {
    throw new Error(`Codex CLI version check failed. ${detailFromResult(result)}`);
  }

  const parsedVersion = parseCodexCliVersion(`${result.stdout}\n${result.stderr}`);
  if (!parsedVersion) {
    throw new Error("Codex CLI version check failed. Could not parse Codex CLI version from output.");
  }

  if (!isCodexCliVersionSupported(parsedVersion)) {
    throw new Error(formatCodexCliUpgradeMessage(parsedVersion));
  }
}

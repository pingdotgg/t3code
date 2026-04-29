import { execFile } from "node:child_process";

import type { WslDistribution } from "@t3tools/contracts";
import { Effect, Schema } from "effect";

import { runProcess, type ProcessRunResult } from "../processRunner.ts";
import type { WslTarget } from "./WslTarget.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER_BYTES = 512 * 1024;

export class WslCliError extends Schema.TaggedErrorClass<WslCliError>()("WslCliError", {
  operation: Schema.String,
  distroName: Schema.optional(Schema.String),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export function buildWslExecArgs(
  target: WslTarget,
  cwd: string | undefined,
  program: string,
  args: ReadonlyArray<string> = [],
): string[] {
  return [
    "--distribution",
    target.distroName,
    ...(target.user ? ["--user", target.user] : []),
    ...(cwd ? ["--cd", cwd] : []),
    "--exec",
    program,
    ...args,
  ];
}

export function buildWslShellArgs(
  target: WslTarget,
  cwd: string | undefined,
  script: string,
): string[] {
  return buildWslExecArgs(target, cwd, "sh", ["-lc", script]);
}

export function buildWslShellCommandArgs(
  target: WslTarget,
  cwd: string | undefined,
  script: string,
  args: ReadonlyArray<string> = [],
): string[] {
  return buildWslExecArgs(target, cwd, "sh", ["-lc", script, "t3-wsl-shell", ...args]);
}

export function isWslAvailable(): Effect.Effect<boolean> {
  if (process.platform !== "win32") {
    return Effect.succeed(false);
  }
  return Effect.tryPromise({
    try: () =>
      runProcess("wsl.exe", ["--status"], {
        timeoutMs: 2_500,
        allowNonZeroExit: true,
        maxBufferBytes: 32_768,
        outputMode: "truncate",
      }),
    catch: (cause) =>
      new WslCliError({
        operation: "wsl.status",
        message: "Failed to check WSL availability.",
        cause,
      }),
  }).pipe(
    Effect.map(() => true),
    Effect.catch(() => Effect.succeed(false)),
  );
}

export function runWsl(
  target: WslTarget,
  cwd: string | undefined,
  program: string,
  args: ReadonlyArray<string> = [],
  options?: { readonly timeoutMs?: number; readonly operation?: string },
): Effect.Effect<ProcessRunResult, WslCliError> {
  const operation = options?.operation ?? program;
  return Effect.tryPromise({
    try: () =>
      runProcess("wsl.exe", buildWslExecArgs(target, cwd, program, args), {
        timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        allowNonZeroExit: true,
        maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
        outputMode: "truncate",
        shell: false,
      }),
    catch: (cause) =>
      new WslCliError({
        operation,
        distroName: target.distroName,
        message: `Failed to run ${operation} in WSL distro '${target.distroName}'.`,
        cause,
      }),
  });
}

export function runWslShell(
  target: WslTarget,
  cwd: string | undefined,
  script: string,
  options?: { readonly timeoutMs?: number; readonly operation?: string },
): Effect.Effect<ProcessRunResult, WslCliError> {
  return runWsl(target, cwd, "sh", ["-lc", script], options);
}

export function runWslShellCommand(
  target: WslTarget,
  cwd: string | undefined,
  script: string,
  args: ReadonlyArray<string> = [],
  options?: { readonly timeoutMs?: number; readonly operation?: string },
): Effect.Effect<ProcessRunResult, WslCliError> {
  return runWsl(target, cwd, "sh", ["-lc", script, "t3-wsl-shell", ...args], options);
}

export function listWslDistributions(): Effect.Effect<WslDistribution[], WslCliError> {
  return Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        execFile(
          "wsl.exe",
          ["--list", "--verbose"],
          { timeout: DEFAULT_TIMEOUT_MS },
          (error, stdout) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(stdout);
          },
        );
      }),
    catch: (cause) =>
      new WslCliError({
        operation: "wsl.listDistributions",
        message: "Failed to list WSL distributions.",
        cause,
      }),
  }).pipe(Effect.map(parseWslListVerbose));
}

export function parseWslListVerbose(output: string): WslDistribution[] {
  return output
    .replaceAll("\u0000", "")
    .split(/\r?\n/g)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): WslDistribution | null => {
      const isDefault = line.startsWith("*");
      const cleaned = isDefault ? line.slice(1).trim() : line;
      const match = cleaned.match(/^(.+?)\s+(Running|Stopped)\s+(\d+)\s*$/i);
      if (!match) return null;
      return {
        name: match[1]!.trim(),
        default: isDefault,
        running: match[2]!.toLowerCase() === "running",
        version: Number(match[3]),
      };
    })
    .filter((entry): entry is WslDistribution => entry !== null);
}

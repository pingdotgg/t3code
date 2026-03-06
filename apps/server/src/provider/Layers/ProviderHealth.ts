/**
 * ProviderHealthLive - Startup-time provider health checks.
 *
 * Performs one-time provider readiness probes when the server starts and
 * keeps the resulting snapshot in memory for `server.getConfig`.
 *
 * Uses the shared process runner to run CLI probes natively.
 *
 * @module ProviderHealthLive
 */
import type {
  ServerProviderAuthStatus,
  ServerProviderStatus,
  ServerProviderStatusState,
} from "@t3tools/contracts";
import { Data, Effect, Layer, Result } from "effect";

import { runProcess } from "../../processRunner";
import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";

const DEFAULT_TIMEOUT_MS = 4_000;
const CODEX_PROVIDER = "codex" as const;

class ProviderHealthCommandError extends Data.TaggedError("ProviderHealthCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ── Pure helpers ────────────────────────────────────────────────────

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly timedOut?: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  return String(error);
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isCommandMissingCause(error: unknown): boolean {
  const lower = errorMessage(error).toLowerCase();
  return (
    lower.includes("command not found: codex") ||
    lower.includes("spawn codex enoent") ||
    lower.includes("enoent") ||
    lower.includes("notfound")
  );
}

function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code === null) {
    return result.signal
      ? `Command exited from signal ${result.signal}.`
      : "Command exited without an exit code.";
  }
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

function extractAuthBoolean(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function parseAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  if (result.timedOut) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Timed out while checking Codex authentication status.",
    };
  }

  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Codex CLI authentication status command is unavailable in this Codex version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", authStatus: "authenticated" };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Codex authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Codex authentication status. ${detail}`
      : "Could not verify Codex authentication status.",
  };
}

export type RunProviderHealthCommand = (
  args: ReadonlyArray<string>,
) => Promise<CommandResult>;

const defaultRunCodexCommand: RunProviderHealthCommand = async (args) => {
  const result = await runProcess("codex", [...args], {
    allowNonZeroExit: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBufferBytes: 262_144,
    outputMode: "truncate",
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
  } satisfies CommandResult;
};

// ── Health check ────────────────────────────────────────────────────

export const checkCodexProviderStatus = (
  runCodexCommand: RunProviderHealthCommand = defaultRunCodexCommand,
): Effect.Effect<ServerProviderStatus> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();

    // Probe 1: `codex --version` — is the CLI reachable?
    const versionProbe = yield* Effect.tryPromise({
      try: () => runCodexCommand(["--version"]),
      catch: (error) =>
        new ProviderHealthCommandError({
          message: errorMessage(error),
          ...(error !== undefined ? { cause: error } : {}),
        }),
    }).pipe(Effect.result);

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: isCommandMissingCause(error)
          ? "Codex CLI (`codex`) is not installed or not on PATH."
          : `Failed to execute Codex CLI health check: ${errorMessage(error)}.`,
      };
    }

    const version = versionProbe.success;
    if (version.timedOut || version.code !== 0) {
      const detail = detailFromResult(version);
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Codex CLI is installed but failed to run. ${detail}`
          : "Codex CLI is installed but failed to run.",
      };
    }

    // Probe 2: `codex login status` — is the user authenticated?
    const authProbe = yield* Effect.tryPromise({
      try: () => runCodexCommand(["login", "status"]),
      catch: (error) =>
        new ProviderHealthCommandError({
          message: errorMessage(error),
          ...(error !== undefined ? { cause: error } : {}),
        }),
    }).pipe(Effect.result);

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CODEX_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          errorMessage(error).length > 0
            ? `Could not verify Codex authentication status: ${errorMessage(error)}.`
            : "Could not verify Codex authentication status.",
      };
    }

    const parsed = parseAuthStatusFromOutput(authProbe.success);
    return {
      provider: CODEX_PROVIDER,
      status: parsed.status,
      available: true,
      authStatus: parsed.authStatus,
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
    } satisfies ServerProviderStatus;
  });

// ── Layer ───────────────────────────────────────────────────────────

export const ProviderHealthLive = Layer.effect(
  ProviderHealth,
  Effect.gen(function* () {
    const codexStatus = yield* checkCodexProviderStatus();
    return {
      getStatuses: Effect.succeed([codexStatus]),
    } satisfies ProviderHealthShape;
  }),
);

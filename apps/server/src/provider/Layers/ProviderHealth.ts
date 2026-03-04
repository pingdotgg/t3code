/**
 * ProviderHealthLive - Startup-time provider health checks.
 *
 * Performs one-time provider readiness probes when the server starts and
 * keeps the resulting snapshot in memory for `server.getConfig`.
 *
 * @module ProviderHealthLive
 */
import type {
  ServerProviderAuthStatus,
  ServerProviderStatus,
  ServerProviderStatusState,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { type ProcessRunOptions, type ProcessRunResult, runProcess } from "../../processRunner";
import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";

type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: ProcessRunOptions,
) => Promise<ProcessRunResult>;

const DEFAULT_TIMEOUT_MS = 4_000;
const CODEX_PROVIDER = "codex" as const;

function nonEmptyMessage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isCommandMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return (
    lower.includes("command not found: codex") ||
    lower.includes("spawn codex enoent") ||
    lower.includes("enoent")
  );
}

function detailFromResult(result: ProcessRunResult): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyMessage(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyMessage(result.stdout);
  if (stdout) return stdout;
  if (result.code !== null && result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

function extractAuthBoolean(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) {
        return nested;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const directCandidates = [
    "authenticated",
    "isAuthenticated",
    "loggedIn",
    "isLoggedIn",
  ] as const;
  for (const key of directCandidates) {
    const candidate = record[key];
    if (typeof candidate === "boolean") {
      return candidate;
    }
  }

  const nestedCandidates = ["auth", "status", "session", "account"] as const;
  for (const key of nestedCandidates) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function parseAuthStatusFromOutput(
  result: ProcessRunResult,
): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const unknownCommand =
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument");
  if (unknownCommand) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Codex CLI authentication status command is unavailable in this Codex version.",
    };
  }

  const unauthenticatedSignal =
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login");
  if (unauthenticatedSignal) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const parsedAuth =
    (() => {
      const trimmed = result.stdout.trim();
      if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
        return {
          attemptedJsonParse: false as const,
          auth: undefined as boolean | undefined,
        };
      }
      try {
        return {
          attemptedJsonParse: true as const,
          auth: extractAuthBoolean(JSON.parse(trimmed)),
        };
      } catch {
        return {
          attemptedJsonParse: false as const,
          auth: undefined as boolean | undefined,
        };
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
    // Successful command with no explicit auth marker is still a pass.
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    ...(detail
      ? { message: `Could not verify Codex authentication status. ${detail}` }
      : { message: "Could not verify Codex authentication status." }),
  };
}

async function checkCodexProviderStatus(run: CommandRunner): Promise<ServerProviderStatus> {
  const checkedAt = new Date().toISOString();

  try {
    const version = await run("codex", ["--version"], {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      allowNonZeroExit: true,
      outputMode: "truncate",
    });

    if (version.code !== 0 || version.timedOut) {
      const detail = detailFromResult(version);
      return {
        provider: CODEX_PROVIDER,
        status: "error",
        available: false,
        authStatus: "unknown",
        checkedAt,
        message:
          detail !== undefined
            ? `Codex CLI is installed but failed to run. ${detail}`
            : "Codex CLI is installed but failed to run.",
      };
    }
  } catch (error) {
    return {
      provider: CODEX_PROVIDER,
      status: "error",
      available: false,
      authStatus: "unknown",
      checkedAt,
      message: isCommandMissingError(error)
        ? "Codex CLI (`codex`) is not installed or not on PATH."
        : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  try {
    const auth = await run("codex", ["auth", "status", "--json"], {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      allowNonZeroExit: true,
      outputMode: "truncate",
    });
    const parsed = parseAuthStatusFromOutput(auth);
    return {
      provider: CODEX_PROVIDER,
      status: parsed.status,
      available: true,
      authStatus: parsed.authStatus,
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
    };
  } catch (error) {
    return {
      provider: CODEX_PROVIDER,
      status: "warning",
      available: true,
      authStatus: "unknown",
      checkedAt,
      message:
        error instanceof Error
          ? `Could not verify Codex authentication status: ${error.message}.`
          : "Could not verify Codex authentication status.",
    };
  }
}

export async function checkProviderStatusesOnStartup(
  run: CommandRunner = runProcess,
): Promise<ReadonlyArray<ServerProviderStatus>> {
  return [await checkCodexProviderStatus(run)];
}

const makeProviderHealth = (run: CommandRunner = runProcess) =>
  Effect.gen(function* () {
    const statuses = yield* Effect.promise(() => checkProviderStatusesOnStartup(run));

    return {
      getStatuses: Effect.succeed(statuses),
    } satisfies ProviderHealthShape;
  });

export const ProviderHealthLive = Layer.effect(ProviderHealth, makeProviderHealth());

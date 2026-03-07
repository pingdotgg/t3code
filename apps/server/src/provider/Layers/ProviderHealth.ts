/**
 * ProviderHealthLive - Startup-time provider health checks.
 *
 * Performs one-time provider readiness checks when the server starts and
 * keeps the resulting snapshot in memory for `server.getConfig`.
 *
 * Startup checks must stay non-interactive. We only verify local CLI
 * availability here and defer real authentication/runtime failures to the
 * first provider session/turn.
 *
 * @module ProviderHealthLive
 */
import type {
  ServerProviderAuthStatus,
  ServerProviderStatus,
  ServerProviderStatusState,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { isCodexCliAvailable, isGeminiCliAvailable } from "../../cliEnvironment";
import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";

const CODEX_PROVIDER = "codex" as const;
const GEMINI_PROVIDER = "gemini" as const;

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function detailFromResult(result: CommandResult & { readonly timedOut?: boolean }): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
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

export const checkCodexProviderStatus: Effect.Effect<ServerProviderStatus, never> = Effect.sync(() => {
  const checkedAt = new Date().toISOString();

  if (!isCodexCliAvailable()) {
    return {
      provider: CODEX_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Codex CLI (`codex`) is not installed or not on PATH.",
    };
  }

  return {
    provider: CODEX_PROVIDER,
    status: "ready" as const,
    available: true,
    authStatus: "unknown" as const,
    checkedAt,
  } satisfies ServerProviderStatus;
});

export const checkGeminiProviderStatus: Effect.Effect<ServerProviderStatus, never> = Effect.sync(() => {
  const checkedAt = new Date().toISOString();

  if (!isGeminiCliAvailable()) {
    return {
      provider: GEMINI_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Gemini CLI (`gemini`) is not installed or not on PATH.",
    };
  }

  return {
    provider: GEMINI_PROVIDER,
    status: "ready" as const,
    available: true,
    authStatus: process.env.GEMINI_API_KEY ? "authenticated" : "unknown",
    checkedAt,
  };
});

export const ProviderHealthLive = Layer.effect(
  ProviderHealth,
  Effect.gen(function* () {
    const [codexStatus, geminiStatus] = yield* Effect.all(
      [checkCodexProviderStatus, checkGeminiProviderStatus],
      { concurrency: 2 },
    );

    return {
      getStatuses: Effect.succeed([codexStatus, geminiStatus]),
    } satisfies ProviderHealthShape;
  }),
);

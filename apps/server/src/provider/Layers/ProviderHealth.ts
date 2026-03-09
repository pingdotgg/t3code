/**
 * ProviderHealthLive - Startup-time provider health checks.
 *
 * Performs one-time provider readiness probes when the server starts and
 * keeps the resulting snapshot in memory for `server.getConfig`.
 *
 * Uses effect's ChildProcessSpawner to run CLI probes natively.
 *
 * @module ProviderHealthLive
 */
import type {
  ServerProviderAuthStatus,
  ServerProviderModel,
  ServerProviderQuotaSnapshot,
  ServerProviderStatus,
  ServerProviderStatusState,
} from "@t3tools/contracts";
import { CopilotClient, type ModelInfo } from "@github/copilot-sdk";
import { Effect, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveBundledCopilotCliPath } from "./copilotCliPath.ts";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../codexCliVersion";
import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";

const DEFAULT_TIMEOUT_MS = 4_000;
const CODEX_PROVIDER = "codex" as const;
const GEMINI_CLI_PROVIDER = "geminiCli" as const;
const COPILOT_PROVIDER = "copilot" as const;

// ── Pure helpers ────────────────────────────────────────────────────

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

function isCommandMissingCause(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
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

// ── Effect-native command execution ─────────────────────────────────

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

const runCodexCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("codex", [...args], {
      shell: process.platform === "win32",
    });

    const child = yield* spawner.spawn(command);

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

// ── Health check ────────────────────────────────────────────────────

export const checkCodexProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();

  // Probe 1: `codex --version` — is the CLI reachable?
  const versionProbe = yield* runCodexCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

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
        : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  if (Option.isNone(versionProbe.success)) {
    return {
      provider: CODEX_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Codex CLI is installed but failed to run. Timed out while running command.",
    };
  }

  const version = versionProbe.success.value;
  if (version.code !== 0) {
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

  const parsedVersion = parseCodexCliVersion(`${version.stdout}\n${version.stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    return {
      provider: CODEX_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: formatCodexCliUpgradeMessage(parsedVersion),
    };
  }

  // Probe 2: `codex login status` — is the user authenticated?
  const authProbe = yield* runCodexCommand(["login", "status"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(authProbe)) {
    const error = authProbe.failure;
    return {
      provider: CODEX_PROVIDER,
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      message:
        error instanceof Error
          ? `Could not verify Codex authentication status: ${error.message}.`
          : "Could not verify Codex authentication status.",
    };
  }

  if (Option.isNone(authProbe.success)) {
    return {
      provider: CODEX_PROVIDER,
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Could not verify Codex authentication status. Timed out while running command.",
    };
  }

  const parsed = parseAuthStatusFromOutput(authProbe.success.value);
  return {
    provider: CODEX_PROVIDER,
    status: parsed.status,
    available: true,
    authStatus: parsed.authStatus,
    checkedAt,
    ...(parsed.message ? { message: parsed.message } : {}),
  } satisfies ServerProviderStatus;
});

// ── Gemini CLI health check ──────────────────────────────────────────

const runGeminiCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("gemini", [...args], {
      shell: process.platform === "win32",
    });

    const child = yield* spawner.spawn(command);

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

export const checkGeminiCliProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();

  const versionProbe = yield* runGeminiCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    const lower = error instanceof Error ? error.message.toLowerCase() : "";
    const isMissing =
      lower.includes("enoent") ||
      lower.includes("notfound") ||
      lower.includes("command not found");
    return {
      provider: GEMINI_CLI_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: isMissing
        ? "Gemini CLI (`gemini`) is not installed or not on PATH."
        : `Failed to execute Gemini CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  if (Option.isNone(versionProbe.success)) {
    return {
      provider: GEMINI_CLI_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Gemini CLI is installed but timed out while running --version.",
    };
  }

  const version = versionProbe.success.value;
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return {
      provider: GEMINI_CLI_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: detail
        ? `Gemini CLI is installed but failed to run. ${detail}`
        : "Gemini CLI is installed but failed to run.",
    };
  }

  return {
    provider: GEMINI_CLI_PROVIDER,
    status: "ready" as const,
    available: true,
    authStatus: "unknown" as const,
    checkedAt,
  };
});

// ── Copilot health check ─────────────────────────────────────────────

interface CopilotHealthProbeError {
  readonly _tag: "CopilotHealthProbeError";
  readonly cause: unknown;
}

const COPILOT_QUOTA_PRIORITY = ["premium_interactions", "chat", "completions"] as const;

export function mapCopilotModel(model: ModelInfo): ServerProviderModel {
  return {
    id: model.id,
    name: model.name,
    supportsReasoningEffort: (model.supportedReasoningEfforts?.length ?? 0) > 0,
    ...(model.supportedReasoningEfforts && model.supportedReasoningEfforts.length > 0
      ? { supportedReasoningEfforts: [...model.supportedReasoningEfforts] }
      : {}),
    ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
    ...(typeof model.billing?.multiplier === "number"
      ? { billingMultiplier: model.billing.multiplier }
      : {}),
  } satisfies ServerProviderModel;
}

interface CopilotQuotaSnapshotInfo {
  readonly entitlementRequests: number;
  readonly usedRequests: number;
  readonly remainingPercentage: number;
  readonly overage: number;
  readonly overageAllowedWithExhaustedQuota: boolean;
  readonly resetDate?: string;
}

function compareCopilotQuotaKeys(left: string, right: string): number {
  const leftPriority = COPILOT_QUOTA_PRIORITY.indexOf(left as (typeof COPILOT_QUOTA_PRIORITY)[number]);
  const rightPriority = COPILOT_QUOTA_PRIORITY.indexOf(right as (typeof COPILOT_QUOTA_PRIORITY)[number]);
  const normalizedLeftPriority = leftPriority === -1 ? Number.POSITIVE_INFINITY : leftPriority;
  const normalizedRightPriority = rightPriority === -1 ? Number.POSITIVE_INFINITY : rightPriority;
  return normalizedLeftPriority - normalizedRightPriority || left.localeCompare(right);
}

export function mapCopilotQuotaSnapshots(
  quotaSnapshots: Record<string, CopilotQuotaSnapshotInfo> | undefined,
): ReadonlyArray<ServerProviderQuotaSnapshot> {
  if (!quotaSnapshots) return [];
  return Object.entries(quotaSnapshots)
    .toSorted(([leftKey], [rightKey]) => compareCopilotQuotaKeys(leftKey, rightKey))
    .map(([key, snapshot]) => {
      const entitlementRequests = Math.max(0, Math.trunc(snapshot.entitlementRequests));
      const usedRequests = Math.max(0, Math.trunc(snapshot.usedRequests));
      const base = {
        key,
        entitlementRequests,
        usedRequests,
        remainingRequests: Math.max(0, entitlementRequests - usedRequests),
        remainingPercentage: Math.max(0, Math.min(100, snapshot.remainingPercentage)),
        overage: Math.max(0, Math.trunc(snapshot.overage)),
        overageAllowedWithExhaustedQuota: snapshot.overageAllowedWithExhaustedQuota,
      };
      return (snapshot.resetDate
        ? Object.assign(base, { resetDate: snapshot.resetDate })
        : base) satisfies ServerProviderQuotaSnapshot;
    });
}

export const checkCopilotProviderStatus: Effect.Effect<ServerProviderStatus, never> = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();
  const cliPath = resolveBundledCopilotCliPath();

  const probeResult = yield* Effect.tryPromise({
    try: async () => {
      const client = new CopilotClient({
        ...(cliPath ? { cliPath } : {}),
        logLevel: "error",
      });
      try {
        await client.start();
        const models = await client.listModels();
        const quota = await (client as unknown as { rpc: { account: { getQuota: () => Promise<{ quotaSnapshots?: unknown }> } } }).rpc.account.getQuota().catch(() => undefined);
        const quotaSnapshots = quota?.quotaSnapshots as Record<string, CopilotQuotaSnapshotInfo> | undefined;
        return { models, quotaSnapshots } as {
          models: ModelInfo[];
          quotaSnapshots: Record<string, CopilotQuotaSnapshotInfo> | undefined;
        };
      } finally {
        await client.stop().catch(() => undefined);
      }
    },
    catch: (cause): CopilotHealthProbeError => ({ _tag: "CopilotHealthProbeError", cause }),
  }).pipe(Effect.timeout(10_000), Effect.option);

  if (Option.isNone(probeResult)) {
    return {
      provider: COPILOT_PROVIDER,
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      message: "GitHub Copilot health probe timed out or failed.",
    };
  }

  const { models, quotaSnapshots } = probeResult.value;
  return {
    provider: COPILOT_PROVIDER,
    status: "ready" as const,
    available: true,
    authStatus: "authenticated" as const,
    checkedAt,
    models: models.map(mapCopilotModel),
    quotaSnapshots: mapCopilotQuotaSnapshots(quotaSnapshots),
  };
});

// ── Layer ───────────────────────────────────────────────────────────

export const ProviderHealthLive = Layer.effect(
  ProviderHealth,
  Effect.gen(function* () {
    const [codexStatus, geminiCliStatus, copilotStatus] = yield* Effect.all(
      [checkCodexProviderStatus, checkGeminiCliProviderStatus, checkCopilotProviderStatus],
      { concurrency: "unbounded" },
    );
    return {
      getStatuses: Effect.succeed([codexStatus, geminiCliStatus, copilotStatus]),
    } satisfies ProviderHealthShape;
  }),
);

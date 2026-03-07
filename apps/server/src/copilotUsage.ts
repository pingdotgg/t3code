import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ServerCopilotUsage } from "@t3tools/contracts";

const COPILOT_CONFIG_PATH = join(homedir(), ".copilot", "config.json");
const COPILOT_USAGE_API_VERSION = "2025-04-01";
const COPILOT_USAGE_CACHE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 4_000;
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

type FetchLike = typeof fetch;

type CopilotCliConfig = {
  readonly host: string | null;
  readonly login: string | null;
};

export interface CopilotUsageDependencies {
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  readonly readCliConfig?: () => Promise<CopilotCliConfig | null>;
  readonly resolveGitHubToken?: (hostname: string | null) => Promise<string | null>;
}

const execFileAsync = promisify(execFile);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function clampNonNegative(value: number): number {
  return value < 0 ? 0 : value;
}

function normalizeIsoDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function normalizeHostUrl(host: string | null | undefined): URL | null {
  if (!host) return null;
  const trimmed = host.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
}

export function buildGitHubApiBaseUrl(host: string | null | undefined): string {
  const normalizedHost = normalizeHostUrl(host);
  if (!normalizedHost) {
    return DEFAULT_GITHUB_API_BASE_URL;
  }

  if (normalizedHost.hostname === "github.com") {
    return DEFAULT_GITHUB_API_BASE_URL;
  }

  const apiHost = normalizedHost.hostname.startsWith("api.")
    ? normalizedHost.hostname
    : `api.${normalizedHost.hostname}`;
  return `${normalizedHost.protocol}//${apiHost}${normalizedHost.port ? `:${normalizedHost.port}` : ""}`;
}

function extractHostname(host: string | null | undefined): string | null {
  return normalizeHostUrl(host)?.hostname ?? null;
}

function readCopilotAuthEnvValue(): string | null {
  for (const envKey of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const) {
    const value = process.env[envKey]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

async function defaultReadCliConfig(): Promise<CopilotCliConfig | null> {
  try {
    const raw = await readFile(COPILOT_CONFIG_PATH, "utf8");
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed) return null;
    const lastLoggedInUser = asRecord(parsed.last_logged_in_user);
    return {
      host: readString(lastLoggedInUser?.host) ?? null,
      login: readString(lastLoggedInUser?.login) ?? null,
    } satisfies CopilotCliConfig;
  } catch {
    return null;
  }
}

async function defaultResolveGitHubToken(hostname: string | null): Promise<string | null> {
  const envToken = readCopilotAuthEnvValue();
  if (envToken) {
    return envToken;
  }

  try {
    const args =
      hostname && hostname !== "github.com"
        ? (["auth", "token", "--hostname", hostname] as const)
        : (["auth", "token"] as const);
    const { stdout } = await execFileAsync("gh", [...args], {
      timeout: REQUEST_TIMEOUT_MS,
      env: {
        ...process.env,
        GH_PAGER: "cat",
      },
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function parseCopilotUsageResponse(raw: unknown, fetchedAt: string): ServerCopilotUsage | null {
  const payload = asRecord(raw);
  if (!payload) return null;

  const quotaSnapshots = asRecord(payload.quota_snapshots);
  const premiumInteractions = asRecord(quotaSnapshots?.premium_interactions);
  if (!premiumInteractions) return null;

  const login = readString(payload.login);
  const resetAt =
    normalizeIsoDate(readString(payload.quota_reset_date_utc)) ??
    normalizeIsoDate(readString(payload.quota_reset_date));
  const entitlement = readNumber(premiumInteractions.entitlement);
  const remaining =
    readNumber(premiumInteractions.remaining) ?? readNumber(premiumInteractions.quota_remaining);

  if (login === null || resetAt === null || entitlement === null || remaining === null) {
    return null;
  }

  const used = clampNonNegative(entitlement - remaining);
  const percentRemaining =
    readNumber(premiumInteractions.percent_remaining) ??
    (entitlement > 0 ? Number(((remaining / entitlement) * 100).toFixed(1)) : 0);

  return {
    status: "available",
    source: "copilot_internal_user",
    fetchedAt,
    login,
    ...(readString(payload.copilot_plan) ? { plan: readString(payload.copilot_plan)! } : {}),
    entitlement: clampNonNegative(entitlement),
    remaining: clampNonNegative(remaining),
    used,
    percentRemaining,
    overagePermitted: readBoolean(premiumInteractions.overage_permitted) ?? false,
    overageCount: clampNonNegative(readNumber(premiumInteractions.overage_count) ?? 0),
    unlimited: readBoolean(premiumInteractions.unlimited) ?? false,
    resetAt,
  } satisfies ServerCopilotUsage;
}

async function fetchCopilotInternalUser(params: {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly fetchImpl: FetchLike;
}): Promise<Response> {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      : null;

  return params.fetchImpl(`${params.apiBaseUrl}/copilot_internal/user`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `token ${params.token}`,
      "User-Agent": "t3code",
      "X-GitHub-Api-Version": COPILOT_USAGE_API_VERSION,
    },
    signal,
  });
}

function buildUnavailableUsage(input: {
  readonly status: "requires-auth" | "unavailable";
  readonly fetchedAt: string;
  readonly message: string;
  readonly source?: "copilot_internal_user";
}): ServerCopilotUsage {
  return {
    status: input.status,
    fetchedAt: input.fetchedAt,
    ...(input.source ? { source: input.source } : {}),
    message: input.message,
  } satisfies ServerCopilotUsage;
}

export async function fetchCopilotUsageSummary(
  deps: CopilotUsageDependencies = {},
): Promise<ServerCopilotUsage> {
  const now = deps.now?.() ?? new Date();
  const fetchedAt = now.toISOString();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const readCliConfig = deps.readCliConfig ?? defaultReadCliConfig;
  const resolveGitHubToken = deps.resolveGitHubToken ?? defaultResolveGitHubToken;

  const cliConfig = await readCliConfig();
  const hostname = extractHostname(cliConfig?.host);
  const token = await resolveGitHubToken(hostname);

  if (!token) {
    return buildUnavailableUsage({
      status: "requires-auth",
      fetchedAt,
      message:
        "GitHub Copilot quota is unavailable because no reusable GitHub token was found. Run `gh auth login` or set GH_TOKEN / COPILOT_GITHUB_TOKEN.",
    });
  }

  try {
    const response = await fetchCopilotInternalUser({
      apiBaseUrl: buildGitHubApiBaseUrl(cliConfig?.host),
      token,
      fetchImpl,
    });

    if (!response.ok) {
      const detail = (await response.text()).trim();
      return buildUnavailableUsage({
        status: response.status === 401 || response.status === 403 ? "requires-auth" : "unavailable",
        fetchedAt,
        source: "copilot_internal_user",
        message:
          detail.length > 0
            ? `GitHub Copilot quota request failed: ${detail}`
            : `GitHub Copilot quota request failed with status ${response.status}.`,
      });
    }

    const parsed = parseCopilotUsageResponse(await response.json(), fetchedAt);
    if (parsed) {
      return parsed;
    }

    return buildUnavailableUsage({
      status: "unavailable",
      fetchedAt,
      source: "copilot_internal_user",
      message: "GitHub Copilot returned quota data in an unexpected format.",
    });
  } catch (error) {
    return buildUnavailableUsage({
      status: "unavailable",
      fetchedAt,
      source: "copilot_internal_user",
      message:
        error instanceof Error && error.message.trim().length > 0
          ? `GitHub Copilot quota request failed: ${error.message}`
          : "GitHub Copilot quota request failed.",
    });
  }
}

export function createCopilotUsageReader(deps: CopilotUsageDependencies = {}) {
  let cached: { expiresAtMs: number; value: ServerCopilotUsage } | null = null;
  let inFlight: Promise<ServerCopilotUsage> | null = null;

  return async function readCopilotUsage(): Promise<ServerCopilotUsage> {
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.value;
    }

    if (inFlight) {
      return inFlight;
    }

    inFlight = fetchCopilotUsageSummary(deps)
      .then((value) => {
        cached = {
          expiresAtMs: (deps.now?.() ?? new Date()).getTime() + COPILOT_USAGE_CACHE_TTL_MS,
          value,
        };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };
}

export { COPILOT_USAGE_CACHE_TTL_MS };

import { execFile } from "node:child_process";
import { homedir, platform } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

import type { ProviderUsageQuota, ProviderUsageResult } from "@t3tools/contracts";

// Security note: This module accesses Cursor auth data (including access
// tokens from the macOS Keychain and auth.json). Auth tokens MUST NOT be
// logged or included in error messages. The keychain access is gated behind
// a platform check and gracefully falls back when unavailable.

const PROVIDER = "cursor" as const;
const CURSOR_AUTH_NAMESPACE = "cursor";
const CURSOR_API_BASE_URL = process.env.CURSOR_API_BASE_URL?.trim() || "https://api2.cursor.sh";
const CURSOR_KEYCHAIN_ACCOUNT = "cursor-user";
const CURSOR_KEYCHAIN_ACCESS_TOKEN_SERVICE = "cursor-access-token";
const CURSOR_KEYCHAIN_API_KEY_SERVICE = "cursor-api-key";
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;

interface CursorAuthData {
  readonly accessToken?: string;
  readonly apiKey?: string;
}

interface CursorPlanInfoResponse {
  readonly planInfo?: {
    readonly planName?: string;
    readonly billingCycleEnd?: string;
  };
}

interface CursorCurrentPeriodUsageResponse {
  readonly billingCycleEnd?: string;
  readonly planUsage?: {
    readonly totalPercentUsed?: number;
    readonly apiPercentUsed?: number;
  };
}

interface CursorBillingCycleResponse {
  readonly endDateEpochMillis?: string;
}

function execFileText(command: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { env: process.env }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function decodeJwtExpirationMs(token: string): number | undefined {
  try {
    const [, payloadSegment] = token.split(".");
    if (!payloadSegment) {
      return undefined;
    }
    const payloadJson = Buffer.from(payloadSegment, "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function hasFreshAccessToken(token: string | undefined): token is string {
  if (!token) {
    return false;
  }
  const expirationMs = decodeJwtExpirationMs(token);
  if (expirationMs === undefined) {
    return true;
  }
  return expirationMs - Date.now() > ACCESS_TOKEN_REFRESH_BUFFER_MS;
}

function cursorAuthFilePath(): string {
  switch (platform()) {
    case "win32": {
      const appData = process.env.APPDATA || path.join(homedir(), "AppData", "Roaming");
      return path.join(appData, "Cursor", "auth.json");
    }
    case "darwin":
      return path.join(homedir(), `.${CURSOR_AUTH_NAMESPACE}`, "auth.json");
    default: {
      const configHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
      return path.join(configHome, CURSOR_AUTH_NAMESPACE, "auth.json");
    }
  }
}

async function readCursorAuthFile(): Promise<CursorAuthData> {
  try {
    const raw = await readFile(cursorAuthFilePath(), "utf8");
    const parsed = JSON.parse(raw) as {
      accessToken?: unknown;
      apiKey?: unknown;
    };
    const accessToken = normalizeNonEmptyString(parsed.accessToken);
    const apiKey = normalizeNonEmptyString(parsed.apiKey);
    const auth: { accessToken?: string; apiKey?: string } = {};
    if (accessToken !== undefined) {
      auth.accessToken = accessToken;
    }
    if (apiKey !== undefined) {
      auth.apiKey = apiKey;
    }
    return auth;
  } catch {
    return {};
  }
}

async function readMacOsKeychainSecret(service: string): Promise<string | undefined> {
  if (platform() !== "darwin") {
    return undefined;
  }
  try {
    const stdout = await execFileText("security", [
      "find-generic-password",
      "-a",
      CURSOR_KEYCHAIN_ACCOUNT,
      "-s",
      service,
      "-w",
    ]);
    return normalizeNonEmptyString(stdout);
  } catch {
    return undefined;
  }
}

async function readCursorAuthData(): Promise<CursorAuthData> {
  const fileAuth = await readCursorAuthFile();
  if (hasFreshAccessToken(fileAuth.accessToken)) {
    return fileAuth;
  }
  const [accessToken, apiKey] = await Promise.all([
    readMacOsKeychainSecret(CURSOR_KEYCHAIN_ACCESS_TOKEN_SERVICE),
    readMacOsKeychainSecret(CURSOR_KEYCHAIN_API_KEY_SERVICE),
  ]);
  return {
    ...(fileAuth.accessToken ? { accessToken: fileAuth.accessToken } : {}),
    ...(fileAuth.apiKey ? { apiKey: fileAuth.apiKey } : {}),
    ...(accessToken ? { accessToken } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

async function exchangeCursorApiKey(apiKey: string): Promise<string | undefined> {
  const response = await fetch(`${CURSOR_API_BASE_URL}/auth/exchange_user_api_key`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    return undefined;
  }
  const parsed = (await response.json()) as {
    accessToken?: unknown;
  };
  return normalizeNonEmptyString(parsed.accessToken);
}

async function resolveCursorAccessToken(): Promise<string | undefined> {
  const auth = await readCursorAuthData();
  if (hasFreshAccessToken(auth.accessToken)) {
    return auth.accessToken;
  }
  if (auth.apiKey) {
    return exchangeCursorApiKey(auth.apiKey);
  }
  return auth.accessToken;
}

async function postCursorDashboard<TResponse>(
  method: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<TResponse> {
  const response = await fetch(`${CURSOR_API_BASE_URL}/aiserver.v1.DashboardService/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Cursor dashboard ${method} failed with status ${response.status}.`);
  }
  return (await response.json()) as TResponse;
}

function epochMillisToIsoString(value: unknown): string | undefined {
  const raw =
    typeof value === "string"
      ? Number(value)
      : typeof value === "number"
        ? value
        : undefined;
  if (raw === undefined || !Number.isFinite(raw)) {
    return undefined;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, value));
}

export function parseCursorUsageQuota(input: {
  readonly planInfo?: CursorPlanInfoResponse | null;
  readonly currentPeriod?: CursorCurrentPeriodUsageResponse | null;
  readonly billingCycle?: CursorBillingCycleResponse | null;
}): ProviderUsageQuota | undefined {
  const percentUsed = normalizePercent(input.currentPeriod?.planUsage?.totalPercentUsed);
  if (percentUsed === undefined) {
    return undefined;
  }
  const plan = normalizeNonEmptyString(input.planInfo?.planInfo?.planName);
  const resetDate =
    epochMillisToIsoString(input.currentPeriod?.billingCycleEnd) ??
    epochMillisToIsoString(input.planInfo?.planInfo?.billingCycleEnd) ??
    epochMillisToIsoString(input.billingCycle?.endDateEpochMillis);
  return {
    ...(plan ? { plan } : {}),
    percentUsed,
    ...(resetDate ? { resetDate } : {}),
  };
}

export async function fetchCursorUsage(): Promise<ProviderUsageResult> {
  const accessToken = await resolveCursorAccessToken();
  if (!accessToken) {
    return { provider: PROVIDER };
  }

  const [planInfo, currentPeriod, billingCycle] = await Promise.all([
    postCursorDashboard<CursorPlanInfoResponse>("GetPlanInfo", accessToken, {}).catch(() => null),
    postCursorDashboard<CursorCurrentPeriodUsageResponse>("GetCurrentPeriodUsage", accessToken, {}).catch(
      () => null,
    ),
    postCursorDashboard<CursorBillingCycleResponse>("GetCurrentBillingCycle", accessToken, {}).catch(
      () => null,
    ),
  ]);

  const quota = parseCursorUsageQuota({ planInfo, currentPeriod, billingCycle });
  return {
    provider: PROVIDER,
    ...(quota ? { quota } : {}),
  };
}

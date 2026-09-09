/**
 * Google Antigravity subscription usage and quota limits.
 *
 * Maps Google Code Assist / Antigravity tier responses and turn-driven quota
 * updates into T3 Code's unified ServerProviderUsageLimits contract.
 *
 * @module provider/Layers/antigravityUsageLimits
 */
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { clampPercent, makeUsageLimits } from "../providerUsageLimits.ts";

export interface QuotaSummaryBucket {
  readonly bucketId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly description?: string | undefined;
  readonly window?: string | undefined;
  readonly remainingFraction?: number | undefined;
  readonly remainingAmount?: number | undefined;
  readonly disabled?: boolean | undefined;
  readonly resetTime?: string | undefined;
}

export interface QuotaSummaryGroup {
  readonly displayName?: string | undefined;
  readonly description?: string | undefined;
  readonly buckets?: ReadonlyArray<QuotaSummaryBucket> | undefined;
}

export interface RetrieveUserQuotaSummaryResponse {
  readonly groups?: ReadonlyArray<QuotaSummaryGroup> | undefined;
  readonly description?: string | undefined;
}

export interface AntigravityQuotaWindow {
  readonly id: string;
  readonly label: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly usedPercent: number;
  readonly resetsAt?: string | null | undefined;
  readonly windowDurationMins?: number | null | undefined;
}

export interface AntigravityTierInfo {
  readonly id?: string | null | undefined;
  readonly name?: string | null | undefined;
  readonly description?: string | null | undefined;
}

export interface AntigravityQuotaSnapshot {
  readonly quotaSummary?: RetrieveUserQuotaSummaryResponse | null | undefined;
  readonly tier?: AntigravityTierInfo | null | undefined;
  readonly allowedTiers?: ReadonlyArray<AntigravityTierInfo> | null | undefined;
  readonly windows?: ReadonlyArray<AntigravityQuotaWindow> | null | undefined;
  readonly monthlyPromptCredits?: number | null | undefined;
  readonly availablePromptCredits?: number | null | undefined;
  readonly monthlyFlowCredits?: number | null | undefined;
  readonly availableFlowCredits?: number | null | undefined;
}

const MONTH_MINS = 30 * 24 * 60;
const WEEK_MINS = 7 * 24 * 60;
const FIVE_HOUR_MINS = 5 * 60;

const TokenFileSchema = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.String,
  refresh_token: Schema.String,
  token_uri: Schema.String,
});

const decodeTokenFile = Schema.decodeUnknownEffect(Schema.fromJsonString(TokenFileSchema));

function isSafeGoogleOAuthUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "oauth2.googleapis.com" ||
        parsed.hostname === "accounts.google.com" ||
        parsed.hostname.endsWith(".googleapis.com"))
    );
  } catch {
    return false;
  }
}

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value || typeof value !== "string") return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) && DateTime.toEpochMillis(dt.value) > 0
    ? DateTime.formatIso(dt.value)
    : undefined;
}

export function quotaSummaryToWindows(
  response: RetrieveUserQuotaSummaryResponse | null | undefined,
): ReadonlyArray<ServerProviderUsageWindow> {
  if (!response || typeof response !== "object") return [];
  const windows: ServerProviderUsageWindow[] = [];
  const rawGroups = Array.isArray(response.groups) ? response.groups : [];
  const groups = [...rawGroups].sort((a, b) => {
    const aGemini = /gemini/i.test(a?.displayName ?? "") ? 0 : 1;
    const bGemini = /gemini/i.test(b?.displayName ?? "") ? 0 : 1;
    return aGemini - bGemini;
  });

  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const isGemini = /gemini/i.test(group.displayName ?? "");
    const is3P = /claude|gpt/i.test(group.displayName ?? "");
    const prefix = isGemini ? "Gemini" : is3P ? "Claude & GPT" : (group.displayName ?? "Model");

    const rawBuckets = Array.isArray(group.buckets) ? group.buckets : [];
    const buckets = [...rawBuckets].sort((a, b) => {
      const aIs5h = a?.window === "5h" || /five hour|5h/i.test(a?.displayName ?? "");
      const bIs5h = b?.window === "5h" || /five hour|5h/i.test(b?.displayName ?? "");
      return (aIs5h ? 0 : 1) - (bIs5h ? 0 : 1);
    });

    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== "object" || bucket.disabled) continue;
      const is5h = bucket.window === "5h" || /five hour|5h/i.test(bucket.displayName ?? "");
      const isWeekly = bucket.window === "weekly" || /weekly/i.test(bucket.displayName ?? "");
      const isMonthly = bucket.window === "monthly" || /monthly/i.test(bucket.displayName ?? "");

      const windowSuffix = is5h
        ? "5-hour"
        : isWeekly
          ? "Weekly"
          : isMonthly
            ? "Monthly"
            : bucket.window || bucket.displayName || "Window";
      const label = `${prefix} (${windowSuffix})`;
      const kind = is5h ? "session" : isWeekly ? "weekly" : isMonthly ? "monthly" : "session";
      const windowDurationMins = is5h
        ? FIVE_HOUR_MINS
        : isWeekly
          ? WEEK_MINS
          : isMonthly
            ? MONTH_MINS
            : undefined;

      const remainingFraction =
        typeof bucket.remainingFraction === "number" && Number.isFinite(bucket.remainingFraction)
          ? bucket.remainingFraction
          : 1;
      const usedPercent = clampPercent(Math.round((1 - remainingFraction) * 100));
      const resetsAt = isoFromString(bucket.resetTime);

      windows.push({
        id:
          bucket.bucketId ||
          `${prefix.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${windowSuffix.toLowerCase()}`,
        label,
        kind,
        usedPercent,
        ...(windowDurationMins ? { windowDurationMins } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  return windows;
}

export function antigravityRateLimitsToWindows(
  snapshot: AntigravityQuotaSnapshot,
): ReadonlyArray<ServerProviderUsageWindow> {
  if (snapshot.quotaSummary) {
    const windows = quotaSummaryToWindows(snapshot.quotaSummary);
    if (windows.length > 0) return windows;
  }

  const windows: ServerProviderUsageWindow[] = [];

  if (snapshot.windows && snapshot.windows.length > 0) {
    for (const w of snapshot.windows) {
      windows.push({
        id: w.id,
        kind: w.kind,
        label: w.label,
        usedPercent: clampPercent(w.usedPercent),
        ...(typeof w.windowDurationMins === "number"
          ? { windowDurationMins: w.windowDurationMins }
          : {}),
        ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
      });
    }
    return windows;
  }

  if (
    typeof snapshot.monthlyPromptCredits === "number" &&
    typeof snapshot.availablePromptCredits === "number" &&
    snapshot.monthlyPromptCredits > 0
  ) {
    const used = snapshot.monthlyPromptCredits - snapshot.availablePromptCredits;
    const usedPercent = (used / snapshot.monthlyPromptCredits) * 100;
    windows.push({
      id: "prompt_credits",
      kind: "monthly",
      label: "Prompt Credits",
      usedPercent: clampPercent(usedPercent),
      windowDurationMins: MONTH_MINS,
    });
  }

  if (
    typeof snapshot.monthlyFlowCredits === "number" &&
    typeof snapshot.availableFlowCredits === "number" &&
    snapshot.monthlyFlowCredits > 0
  ) {
    const used = snapshot.monthlyFlowCredits - snapshot.availableFlowCredits;
    const usedPercent = (used / snapshot.monthlyFlowCredits) * 100;
    windows.push({
      id: "flow_credits",
      kind: "monthly",
      label: "Flow Credits",
      usedPercent: clampPercent(usedPercent),
      windowDurationMins: MONTH_MINS,
    });
  }

  if (
    windows.length === 0 &&
    (snapshot.tier || (snapshot.allowedTiers && snapshot.allowedTiers.length > 0))
  ) {
    const tier = snapshot.tier ?? snapshot.allowedTiers?.[0];
    const label = tier?.name ? `${tier.name}` : "Antigravity Plan";
    windows.push({
      id: "plan_allowance",
      kind: "session",
      label,
      usedPercent: 0,
    });
  }

  return windows;
}

export function antigravityRateLimitsToLimits(input: {
  readonly snapshot: AntigravityQuotaSnapshot;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const windows = antigravityRateLimitsToWindows(input.snapshot);
  return makeUsageLimits({
    checkedAt: input.checkedAt,
    windows,
  });
}

export function antigravityRateLimitsToUpdate(
  snapshot: AntigravityQuotaSnapshot,
): ProviderUsageLimitsUpdate | undefined {
  const windows = antigravityRateLimitsToWindows(snapshot);
  return windows.length > 0 ? { windows } : undefined;
}

/**
 * Probes Google Antigravity quota / tier info using the profile's stored OAuth credentials.
 */
export const probeAntigravityUsageLimits = (input: {
  readonly profileDirectory: string;
  readonly checkedAt: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const client = yield* HttpClient.HttpClient;

    const tokenPath = path.join(input.profileDirectory, "antigravity-acp", "acp_token.json");
    if (!(yield* fs.exists(tokenPath))) {
      return undefined;
    }

    const token = yield* fs
      .readFileString(tokenPath)
      .pipe(Effect.flatMap(decodeTokenFile), Effect.option);
    if (Option.isNone(token) || !isSafeGoogleOAuthUri(token.value.token_uri)) {
      return undefined;
    }

    // Exchange refresh token for access token
    const tokenRequest = HttpClientRequest.post(token.value.token_uri).pipe(
      HttpClientRequest.bodyUrlParams({
        client_id: token.value.client_id,
        client_secret: token.value.client_secret,
        refresh_token: token.value.refresh_token,
        grant_type: "refresh_token",
      }),
    );

    const tokenResponse = yield* client.execute(tokenRequest).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((res) => res.json),
      Effect.timeout("10 seconds"),
      Effect.option,
    );
    if (Option.isNone(tokenResponse)) return undefined;

    const accessToken = (tokenResponse.value as { access_token?: string })?.access_token;
    if (!accessToken || typeof accessToken !== "string") return undefined;

    // 1. Probe granular multi-group quota buckets (Gemini & Claude/GPT models with 5h and weekly limits)
    const quotaEndpoints = [
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    ];

    for (const endpoint of quotaEndpoints) {
      const quotaRequest = HttpClientRequest.post(endpoint).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
        HttpClientRequest.setHeader("Content-Type", "application/json"),
        HttpClientRequest.setHeader("User-Agent", "antigravity/1.1.28"),
        HttpClientRequest.bodyJsonUnsafe({ project: "default-cli-project" }),
      );

      const quotaResponse = yield* client.execute(quotaRequest).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((res) => res.json),
        Effect.timeout("5 seconds"),
        Effect.option,
      );

      if (Option.isSome(quotaResponse)) {
        const windows = quotaSummaryToWindows(
          quotaResponse.value as RetrieveUserQuotaSummaryResponse,
        );
        if (windows.length > 0) {
          return makeUsageLimits({
            checkedAt: input.checkedAt,
            windows,
          });
        }
      }
    }

    // 2. Fall back to loadCodeAssist endpoint for tier and credit state
    const apiRequest = HttpClientRequest.post(
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    ).pipe(
      HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setHeader("User-Agent", "antigravity/1.1.28"),
      HttpClientRequest.bodyJsonUnsafe({
        metadata: {
          ideType: "ANTIGRAVITY",
          ideVersion: "1.0.0",
        },
      }),
    );

    const apiResponse = yield* client.execute(apiRequest).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((res) => res.json),
      Effect.timeout("10 seconds"),
      Effect.option,
    );

    if (Option.isNone(apiResponse)) return undefined;

    const response = apiResponse.value as {
      allowedTiers?: ReadonlyArray<AntigravityTierInfo>;
      quotaManagerState?: {
        monthlyPromptCredits?: number;
        availablePromptCredits?: number;
        monthlyFlowCredits?: number;
        availableFlowCredits?: number;
      };
    };

    const snapshot: AntigravityQuotaSnapshot = {
      allowedTiers: response.allowedTiers,
      monthlyPromptCredits: response.quotaManagerState?.monthlyPromptCredits,
      availablePromptCredits: response.quotaManagerState?.availablePromptCredits,
      monthlyFlowCredits: response.quotaManagerState?.monthlyFlowCredits,
      availableFlowCredits: response.quotaManagerState?.availableFlowCredits,
    };

    return antigravityRateLimitsToLimits({
      snapshot,
      checkedAt: input.checkedAt,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logDebug("Antigravity usage-limit probe failed", { cause }).pipe(
        Effect.as(undefined),
      ),
    ),
  );

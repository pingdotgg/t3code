/**
 * Antigravity subscription usage. The health check must not spawn the ACP
 * agent (a ~1 GB unpack per launch), so this reads the instance's stored
 * Google token and calls Cloud Code the same way the `agy` CLI does.
 *
 * @module provider/Layers/antigravityUsageLimits
 */
import type { AntigravityAuthMethod, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

/** `cloudcode-pa` answers the same RPC with remainingFraction 1 on every bucket. */
const QUOTA_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

const OAuthToken = Schema.Struct({
  access_token: Schema.optional(Schema.String),
});
const TokenFile = Schema.Struct({
  token: Schema.optional(Schema.Union([OAuthToken, Schema.String])),
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  client_id: Schema.optional(Schema.String),
  client_secret: Schema.optional(Schema.String),
  token_uri: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
  scopes: Schema.optional(Schema.Unknown),
});
const decodeTokenFile = Schema.decodeEffect(Schema.fromJsonString(TokenFile));

const Remaining = Schema.Struct({
  remainingFraction: Schema.optional(Schema.Finite),
});
const QuotaBucket = Schema.Struct({
  bucketId: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  resetTime: Schema.optional(Schema.String),
  remainingFraction: Schema.optional(Schema.Finite),
  remaining: Schema.optional(Remaining),
});
const QuotaGroup = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  buckets: Schema.optional(Schema.Array(QuotaBucket)),
});
const QuotaSummary = Schema.Struct({
  groups: Schema.optional(Schema.Array(QuotaGroup)),
  buckets: Schema.optional(Schema.Array(QuotaBucket)),
});

function finiteNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function accessTokenFromFile(file: typeof TokenFile.Type): string | undefined {
  if (typeof file.token === "string") {
    const token = file.token.trim();
    return token.length > 0 ? token : undefined;
  }
  const nested = file.token?.access_token?.trim();
  if (nested) return nested;
  const flat = file.access_token?.trim();
  return flat && flat.length > 0 ? flat : undefined;
}

/** Refresh POSTs client_secret, so the URI must be Google's token endpoint. */
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

const refreshAccessToken = Effect.fn("refreshAntigravityAccessToken")(function* (
  file: typeof TokenFile.Type,
) {
  const refreshToken = file.refresh_token?.trim();
  const clientId = file.client_id?.trim();
  const clientSecret = file.client_secret?.trim();
  const tokenUri = file.token_uri?.trim();
  if (!refreshToken || !clientId || !clientSecret || !tokenUri || !isSafeGoogleOAuthUri(tokenUri)) {
    return undefined;
  }
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.post(tokenUri).pipe(
      HttpClientRequest.bodyUrlParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    ),
  );
  const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(OAuthToken)),
  );
  const token = body.access_token?.trim();
  return token && token.length > 0 ? token : undefined;
});

/** Subscription windows come from Google OAuth, not API keys or Vertex ADC. */
export function antigravityUsageLimitsSupported(authMethod: AntigravityAuthMethod): boolean {
  return authMethod === "oauth-personal" || authMethod === "oauth-business";
}

function remainingFractionOf(bucket: typeof QuotaBucket.Type): number | undefined {
  return (
    finiteNumber(bucket.remainingFraction) ?? finiteNumber(bucket.remaining?.remainingFraction)
  );
}

function usedPercentFromRemaining(remainingFraction: number): number {
  const remainingPercent = remainingFraction > 1 ? remainingFraction : remainingFraction * 100;
  return clampPercent(100 - remainingPercent);
}

function periodOf(bucket: typeof QuotaBucket.Type): "session" | "weekly" | undefined {
  const raw = (bucket.window ?? bucket.bucketId?.split("-").at(-1) ?? "").trim().toLowerCase();
  if (raw === "5h" || raw === "five_hour" || raw === "five-hour" || raw === "session") {
    return "session";
  }
  if (raw === "7d" || raw === "weekly" || raw === "week" || raw === "wk" || raw === "168h") {
    return "weekly";
  }
  return undefined;
}

function groupSlug(group: typeof QuotaGroup.Type): string {
  for (const bucket of group.buckets ?? []) {
    const id = bucket.bucketId?.trim();
    if (!id) continue;
    const separator = id.lastIndexOf("-");
    if (separator <= 0) continue;
    const suffix = id.slice(separator + 1).toLowerCase();
    if (suffix === "weekly" || suffix === "5h" || suffix === "7d" || suffix === "wk") {
      return id.slice(0, separator).toLowerCase();
    }
  }
  return group.displayName?.trim().split(/\s+/)[0]?.toLowerCase() || "group";
}

function isGeminiSlug(slug: string): boolean {
  return slug === "gemini" || slug.startsWith("gemini-") || slug.startsWith("gemini_");
}

function isoFromResetTime(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function windowFromBucket(
  bucket: typeof QuotaBucket.Type,
  slug: string,
): ServerProviderUsageWindow | undefined {
  const remainingFraction = remainingFractionOf(bucket);
  const period = periodOf(bucket);
  if (!isGeminiSlug(slug) || remainingFraction === undefined || period === undefined) {
    return undefined;
  }
  const resetsAt = isoFromResetTime(bucket.resetTime);
  return {
    id: period === "session" ? "gemini_five_hour" : "gemini_seven_day",
    kind: period,
    label: period === "session" ? "Gemini · Session" : "Gemini · Weekly",
    usedPercent: usedPercentFromRemaining(remainingFraction),
    windowDurationMins: period === "session" ? SESSION_MINS : WEEK_MINS,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/** Maps a Cloud Code quota summary onto the windows Usage → Limits already renders. */
export function antigravityQuotaSummaryToLimits(
  summary: typeof QuotaSummary.Type,
  checkedAt: string,
) {
  const windows: ServerProviderUsageWindow[] = [];
  const seen = new Set<string>();
  const add = (bucket: typeof QuotaBucket.Type, slug: string) => {
    const window = windowFromBucket(bucket, slug);
    if (!window || seen.has(window.id)) return;
    seen.add(window.id);
    windows.push(window);
  };
  for (const group of summary.groups ?? []) {
    const slug = groupSlug(group);
    for (const bucket of group.buckets ?? []) add(bucket, slug);
  }
  if (windows.length === 0) {
    for (const bucket of summary.buckets ?? []) {
      const slug =
        bucket.bucketId
          ?.trim()
          .replace(/-(?:weekly|5h|7d|wk)$/i, "")
          .toLowerCase() || "group";
      add(bucket, slug);
    }
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

export const readAntigravityUsageLimits = Effect.fn("readAntigravityUsageLimits")(
  function* (input: {
    readonly enabled: boolean;
    readonly authMethod: AntigravityAuthMethod;
    readonly tokenPath: string;
    readonly gcpProject?: string;
  }) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    if (!input.enabled || !antigravityUsageLimitsSupported(input.authMethod)) {
      return unsupported;
    }

    return yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const contents = yield* fs.readFileString(input.tokenPath).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
        }),
      );
      if (!contents.trim()) return unsupported;
      const file = yield* decodeTokenFile(contents);
      const token = accessTokenFromFile(file) ?? (yield* refreshAccessToken(file));
      if (!token) return unsupported;

      const client = yield* HttpClient.HttpClient;
      const project = input.gcpProject?.trim();
      const response = yield* client.execute(
        HttpClientRequest.post(QUOTA_URL).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeaders({
            "user-agent": "antigravity",
            "content-type": "application/json",
          }),
          HttpClientRequest.bodyJsonUnsafe(project ? { project } : {}),
        ),
      );
      if (response.status === 403) return unsupported;
      const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(QuotaSummary)),
      );
      return antigravityQuotaSummaryToLimits(body, checkedAt);
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.orElseSucceed(() =>
        makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Antigravity could not read usage limits.",
        }),
      ),
    );
  },
);

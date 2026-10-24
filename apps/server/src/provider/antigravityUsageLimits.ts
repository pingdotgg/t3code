import type { AntigravitySettings, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

const ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
const TokenFile = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  project_id: Schema.optional(Schema.String),
});
const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
});
const UserInfo = Schema.Struct({ id: Schema.NonEmptyString });
const Quota = Schema.Struct({
  remainingFraction: Schema.optional(Schema.Number),
  resetTime: Schema.optional(Schema.String),
});
const Bucket = Schema.Struct({
  ...Quota.fields,
  bucketId: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});
const Summary = Schema.Struct({
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        displayName: Schema.optional(Schema.String),
        buckets: Schema.optional(Schema.Array(Bucket)),
      }),
    ),
  ),
  buckets: Schema.optional(Schema.Array(Bucket)),
});
const Models = Schema.Struct({
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      modelProvider: Schema.optional(Schema.String),
      quotaInfo: Schema.optional(Quota),
      weeklyQuotaInfo: Schema.optional(Quota),
    }),
  ),
});

const decodeTokenFile = Schema.decodeEffect(Schema.fromJsonString(TokenFile));
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
const decodeUserInfo = Schema.decodeUnknownEffect(UserInfo);
const decodeSummary = Schema.decodeUnknownEffect(Summary);
const decodeModels = Schema.decodeUnknownEffect(Models);

function iso(value: string | undefined): string | undefined {
  const parsed = value ? DateTime.make(value) : Option.none();
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function parseResetTimeFromDescription(
  description: string | undefined,
  now: number,
): string | undefined {
  if (!description) return undefined;
  const match = /refresh(?:es)? in\s+([^.]+)/i.exec(description);
  if (!match?.[1]) return undefined;
  const clause = match[1];
  const days = Number(/(\d+)\s*d(?:ay)?s?/i.exec(clause)?.[1] ?? 0);
  const hours = Number(/(\d+)\s*h(?:our|r)?s?/i.exec(clause)?.[1] ?? 0);
  const minutes = Number(/(\d+)\s*m(?:in(?:ute)?s?)?/i.exec(clause)?.[1] ?? 0);
  const totalMs = ((days * 24 + hours) * 60 + minutes) * 60_000;
  if (totalMs <= 0) return undefined;
  return DateTime.formatIso(DateTime.makeUnsafe(now + totalMs));
}

function quotaWindow(
  id: string,
  label: string,
  quota: typeof Quota.Type,
  kind: ServerProviderUsageWindow["kind"] = "other",
  windowDurationMins?: number,
): ServerProviderUsageWindow | undefined {
  if (quota.remainingFraction === undefined || !Number.isFinite(quota.remainingFraction)) {
    return undefined;
  }
  const resetsAt = iso(quota.resetTime);
  return {
    id,
    label,
    kind,
    usedPercent: (1 - Math.max(0, Math.min(1, quota.remainingFraction))) * 100,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

function summaryWindows(summary: typeof Summary.Type, now: number) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  const groups = [
    ...(summary.groups ?? []),
    ...(summary.buckets?.length ? [{ displayName: "", buckets: summary.buckets }] : []),
  ];
  for (const group of groups) {
    const groupName = group.displayName?.trim() ?? "";
    const groupPrefix = /gemini/i.test(groupName)
      ? "gemini"
      : /claude|gpt|3p/i.test(groupName)
        ? "3p"
        : undefined;
    for (const bucket of group.buckets ?? []) {
      if (bucket.disabled) continue;
      const rawId = bucket.bucketId?.trim() ?? "";
      const rawWindow = bucket.window?.trim().toLowerCase() ?? "";
      const displayName = bucket.displayName?.trim() ?? "";
      const description = bucket.description?.trim() ?? "";
      const weekly = rawWindow === "weekly" || /weekly/i.test(rawId) || /weekly/i.test(displayName);
      const session =
        rawWindow === "5h" ||
        rawWindow === "5-hour" ||
        rawWindow === "five_hour" ||
        /5h|5-hour|five.?hour/i.test(rawId) ||
        /5-hour|five.?hour|5 hour/i.test(displayName);
      const bucketId =
        rawId ||
        (groupPrefix && (weekly || session)
          ? `${groupPrefix}-${weekly ? "weekly" : "5h"}`
          : undefined);
      if (!bucketId) continue;
      const family = bucketId.startsWith("gemini-")
        ? "Gemini"
        : bucketId.startsWith("3p-")
          ? "Claude & GPT (shared)"
          : groupName || bucketId;
      const inferredFraction =
        bucket.remainingFraction !== undefined
          ? bucket.remainingFraction
          : /hit your .* limit|limit reached/i.test(description) ||
              ((weekly || session) && (Boolean(displayName) || Boolean(description)))
            ? 0
            : undefined;
      const inferredResetTime = bucket.resetTime ?? parseResetTimeFromDescription(description, now);
      const effectiveQuota = {
        ...bucket,
        ...(inferredFraction !== undefined ? { remainingFraction: inferredFraction } : {}),
        ...(inferredResetTime !== undefined ? { resetTime: inferredResetTime } : {}),
      };
      const window = quotaWindow(
        bucketId,
        `${family} · ${weekly ? "Weekly" : session ? "5-hour" : displayName || "Quota"}`,
        effectiveQuota,
        weekly ? "weekly" : session ? "session" : "other",
        weekly ? 7 * 24 * 60 : session ? 5 * 60 : undefined,
      );
      if (window) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}

function extractCompanionProject(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const raw = (response as { cloudaicompanionProject?: unknown }).cloudaicompanionProject;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (raw && typeof raw === "object") {
    const id = (raw as { id?: unknown }).id;
    if (typeof id === "string" && id.trim().length > 0) return id.trim();
  }
  return undefined;
}

/** Older accounts expose model quotas without a window length. Do not invent a reset cadence. */
function modelWindows(
  models: typeof Models.Type,
  options?: {
    readonly hasWeeklySummary?: boolean;
    readonly hasShared3pSummary?: boolean;
  },
) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const [modelId, model] of Object.entries(models.models)) {
    const family =
      model.modelProvider === "MODEL_PROVIDER_GOOGLE" || modelId.startsWith("gemini-")
        ? "Gemini"
        : model.modelProvider === "MODEL_PROVIDER_ANTHROPIC" || modelId.startsWith("claude-")
          ? "Claude"
          : model.modelProvider === "MODEL_PROVIDER_OPENAI" || modelId.startsWith("gpt-")
            ? "GPT"
            : undefined;
    if (!family) continue;
    const isShared3p =
      options?.hasShared3pSummary === true && (family === "Claude" || family === "GPT");
    const isFiveHourQuota =
      model.weeklyQuotaInfo !== undefined || options?.hasWeeklySummary === true;
    const idPrefix = isShared3p ? "3p" : family.toLowerCase();
    const displayFamily = isShared3p ? "Claude & GPT (shared)" : family;
    for (const [suffix, quota] of [
      [isFiveHourQuota ? "5h" : "quota", model.quotaInfo],
      ["weekly", model.weeklyQuotaInfo],
    ] as const) {
      if (!quota) continue;
      const window = quotaWindow(
        `${idPrefix}-${suffix}`,
        `${displayFamily} · ${suffix === "weekly" ? "Weekly" : suffix === "5h" ? "5-hour" : "Reported quota"}`,
        quota,
        suffix === "weekly" ? "weekly" : suffix === "5h" ? "session" : "other",
        suffix === "weekly" ? 7 * 24 * 60 : suffix === "5h" ? 5 * 60 : undefined,
      );
      if (!window) continue;
      const previous = windows.get(window.id);
      if (!previous || window.usedPercent > previous.usedPercent) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}

export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* (input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravitySettings["authMethod"];
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const osType = platform === "win32" ? "windows" : platform;
  const arch = architecture === "x64" ? "amd64" : architecture;
  const userAgent = `antigravity/hub/2.24.0 (aidev_client; os_type=${osType}; arch=${arch}; cl=963137146)`;
  const tokenPath = path.join(input.profileDirectory, "antigravity-acp", "acp_token.json");
  let cached:
    | { fingerprint: string; account: string; accessToken: string; expiresAt: number }
    | undefined;
  let generation = 0;

  const sha256 = (text: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(text))
      .pipe(
        Effect.map((digest) =>
          Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        ),
      );

  const request = (request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout("10 seconds"),
    );
  const read = Effect.gen(function* () {
    const startedGeneration = generation;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (input.authMethod !== "oauth-personal" && input.authMethod !== "oauth-business") {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    if (!(yield* fs.exists(tokenPath))) {
      cached = undefined;
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Sign in with Google to see Antigravity limits.",
      });
    }
    const token = yield* fs.readFileString(tokenPath).pipe(Effect.flatMap(decodeTokenFile));
    const fingerprint = yield* sha256(
      `${token.client_id}\0${token.refresh_token}\0${token.project_id ?? ""}`,
    );
    const now = yield* Clock.currentTimeMillis;
    let accessToken: string;
    let account: string;
    if (cached?.fingerprint !== fingerprint || cached.expiresAt <= now + 60_000) {
      cached = undefined;
      const refreshed = yield* request(
        HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: token.client_id,
            client_secret: token.client_secret,
            refresh_token: token.refresh_token,
            grant_type: "refresh_token",
          }),
        ),
      ).pipe(Effect.flatMap(decodeTokenResponse));
      accessToken = refreshed.access_token;
      // Each machine's sign-in has its own refresh token, so the Google
      // account id is what lets clients merge one account across environments.
      account = yield* request(
        HttpClientRequest.get("https://www.googleapis.com/oauth2/v2/userinfo").pipe(
          HttpClientRequest.setHeaders({ Authorization: `Bearer ${accessToken}` }),
        ),
      ).pipe(
        Effect.flatMap(decodeUserInfo),
        Effect.flatMap((info) => sha256(`google-account\0${info.id}`)),
        Effect.orElseSucceed(() => fingerprint),
      );
      if (generation === startedGeneration) {
        cached = {
          fingerprint,
          account,
          accessToken,
          expiresAt: now + refreshed.expires_in * 1000,
        };
      }
    } else {
      accessToken = cached.accessToken;
      account = cached.account;
    }
    const needsProjectResolution = !token.project_id || token.project_id === "aicode-consumers";
    let resolvedCompanionProject: string | undefined;
    if (needsProjectResolution) {
      for (const endpoint of ENDPOINTS) {
        resolvedCompanionProject = yield* request(
          HttpClientRequest.post(`${endpoint}/v1internal:loadCodeAssist`).pipe(
            HttpClientRequest.setHeaders({
              Authorization: `Bearer ${accessToken}`,
              "User-Agent": userAgent,
            }),
            HttpClientRequest.bodyJsonUnsafe({ metadata: { ideType: "ANTIGRAVITY" } }),
          ),
        ).pipe(
          Effect.map(extractCompanionProject),
          Effect.orElseSucceed(() => undefined),
        );
        if (resolvedCompanionProject) break;
      }
    }
    const projectCandidates = needsProjectResolution
      ? [
          ...new Set([
            ...(resolvedCompanionProject ? [resolvedCompanionProject] : []),
            ...(token.project_id ? [token.project_id] : []),
            "",
          ]),
        ]
      : [token.project_id!];
    // Endpoints can report different quota groups (the daily endpoint has
    // returned the Claude/GPT group without Gemini), so merge every endpoint's
    // windows. The most-used reading of a bucket wins, as in modelWindows.
    const fetchWindows = Effect.fn("AntigravityUsageProbe.fetchWindows")(function* <E>(
      operation: string,
      parse: (response: unknown) => Effect.Effect<ServerProviderUsageWindow[], E>,
    ) {
      const responses = yield* Effect.forEach(
        ENDPOINTS,
        Effect.fnUntraced(function* (endpoint) {
          for (const projectId of projectCandidates) {
            const windows = yield* request(
              HttpClientRequest.post(`${endpoint}/v1internal:${operation}`).pipe(
                HttpClientRequest.setHeaders({
                  Authorization: `Bearer ${accessToken}`,
                  "User-Agent": userAgent,
                }),
                HttpClientRequest.bodyJsonUnsafe(projectId ? { project: projectId } : {}),
              ),
            ).pipe(
              Effect.flatMap(parse),
              Effect.orElseSucceed(() => []),
            );
            if (windows.length > 0) return windows;
          }
          return [];
        }),
        { concurrency: "unbounded" },
      );
      const windows = new Map<string, ServerProviderUsageWindow>();
      for (const window of responses.flat()) {
        const previous = windows.get(window.id);
        if (!previous || window.usedPercent > previous.usedPercent) windows.set(window.id, window);
      }
      return [...windows.values()];
    });
    const summary = yield* fetchWindows("retrieveUserQuotaSummary", (response) =>
      decodeSummary(response).pipe(Effect.map((summary) => summaryWindows(summary, now))),
    );
    const hasGemini5h = summary.some((window) => window.id === "gemini-5h");
    const hasWeeklySummary = summary.some((window) => window.kind === "weekly");
    const hasShared3pSummary = summary.some((window) => window.id.startsWith("3p-"));
    const hasAll5h =
      hasGemini5h && (!hasShared3pSummary || summary.some((window) => window.id === "3p-5h"));
    const fallbackModels =
      summary.length > 0 && hasAll5h
        ? []
        : yield* fetchWindows("fetchAvailableModels", (response) =>
            decodeModels(response).pipe(
              Effect.map((models) =>
                modelWindows(models, { hasWeeklySummary, hasShared3pSummary }),
              ),
            ),
          );
    const windows =
      summary.length === 0
        ? fallbackModels
        : hasAll5h
          ? summary
          : [
              ...summary,
              ...fallbackModels.filter(
                (window) => !summary.some((existing) => existing.id === window.id),
              ),
            ];
    if (windows.length === 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity did not return usable quota information.",
      });
    }
    return { ...makeUsageLimits({ checkedAt, windows }), credentialFingerprint: account };
  });
  const probe = read.pipe(
    Effect.timeout("30 seconds"),
    Effect.catch(() =>
      Effect.gen(function* () {
        return makeUnavailableUsageLimits({
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          reason: "probeFailed",
          message: "Could not read Antigravity limits. Refresh provider status to retry.",
        });
      }),
    ),
  );
  return {
    probe,
    clear: Effect.sync(() => {
      cached = undefined;
      generation++;
    }),
  };
});

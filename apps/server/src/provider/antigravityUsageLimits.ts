import type { AntigravitySettings, ServerProviderUsageWindow } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { resolveAntigravityReleaseAsset } from "./antigravityRelease.ts";

const QUOTA_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
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
const Quota = Schema.Struct({
  remainingFraction: Schema.optional(Schema.Number),
  resetTime: Schema.optional(Schema.String),
});
const Bucket = Schema.Struct({
  ...Quota.fields,
  bucketId: Schema.NonEmptyString,
  window: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
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
const decodeTokenFile = Schema.decodeEffect(Schema.fromJsonString(TokenFile));
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
const decodeSummary = Schema.decodeUnknownEffect(Summary);

function iso(value: string | undefined): string | undefined {
  const parsed = value ? DateTime.make(value) : Option.none();
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function quotaWindow(
  id: string,
  label: string,
  quota: typeof Quota.Type,
  kind: ServerProviderUsageWindow["kind"] = "other",
  windowDurationMins?: number,
): ServerProviderUsageWindow | undefined {
  // Protobuf JSON omits scalar zero values: an omitted fraction is exhausted.
  const fraction = quota.remainingFraction ?? 0;
  if (!Number.isFinite(fraction)) {
    return undefined;
  }
  const resetsAt = iso(quota.resetTime);
  return {
    id,
    label,
    kind,
    usedPercent: (1 - Math.max(0, Math.min(1, fraction))) * 100,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

/** The summary names the actual shared buckets; Claude and GPT consume one allowance. */
function summaryWindows(summary: typeof Summary.Type) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  const groups = summary.groups?.some((group) => group.buckets?.length)
    ? summary.groups
    : [{ buckets: summary.buckets }];
  for (const group of groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (bucket.disabled) continue;
      const family = bucket.bucketId.startsWith("gemini-")
        ? "Gemini"
        : bucket.bucketId.startsWith("3p-")
          ? "Claude & GPT (shared)"
          : group.displayName?.trim() || bucket.bucketId;
      const weekly = bucket.window === "weekly";
      const session = bucket.window === "5h";
      const window = quotaWindow(
        bucket.bucketId,
        `${family} · ${weekly ? "Weekly" : session ? "5-hour" : bucket.displayName?.trim() || "Quota"}`,
        bucket,
        weekly ? "weekly" : session ? "session" : "other",
        weekly ? 7 * 24 * 60 : session ? 5 * 60 : undefined,
      );
      if (window) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}

/** Reads this instance's Google profile, with a memory-only access token and no credential writes. */
export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* (input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravitySettings["authMethod"];
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const runtimeVersion =
    resolveAntigravityReleaseAsset(platform, architecture)?.version ?? "unknown";
  const tokenPath = path.join(input.profileDirectory, "antigravity-acp", "acp_token.json");
  let cached: { fingerprint: string; accessToken: string; expiresAt: number } | undefined;
  let generation = 0;

  const request = (request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout("10 seconds"),
    );
  const read = Effect.gen(function* () {
    const startedGeneration = generation;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (input.authMethod !== "oauth-personal") {
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
    const fingerprint = Array.from(
      yield* crypto.digest(
        "SHA-256",
        new TextEncoder().encode(
          `${token.client_id}\0${token.refresh_token}\0${token.project_id ?? ""}`,
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const now = yield* Clock.currentTimeMillis;
    let accessToken: string;
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
      ).pipe(Effect.flatMap(decodeTokenResponse), Effect.option);
      if (Option.isNone(refreshed)) {
        return {
          ...makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: "Could not refresh Antigravity quota access.",
          }),
          credentialFingerprint: fingerprint,
        };
      }
      accessToken = refreshed.value.access_token;
      if (generation === startedGeneration) {
        cached = { fingerprint, accessToken, expiresAt: now + refreshed.value.expires_in * 1000 };
      }
    } else {
      accessToken = cached.accessToken;
    }
    const windows = yield* request(
      HttpClientRequest.post(QUOTA_ENDPOINT).pipe(
        HttpClientRequest.setHeaders({
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": `antigravity/acp/${runtimeVersion} (aidev_client; os_type=${platform === "win32" ? "windows" : platform}; arch=${architecture === "x64" ? "amd64" : architecture}; host_path=t3-code/0.0.0; proxy_client=antigravity/sdk)`,
        }),
        HttpClientRequest.bodyJsonUnsafe(token.project_id ? { project: token.project_id } : {}),
      ),
    ).pipe(
      Effect.flatMap(decodeSummary),
      Effect.map(summaryWindows),
      Effect.orElseSucceed(() => []),
    );
    if (windows.length === 0) {
      return {
        ...makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Antigravity did not return usable quota information.",
        }),
        credentialFingerprint: fingerprint,
      };
    }
    return { ...makeUsageLimits({ checkedAt, windows }), credentialFingerprint: fingerprint };
  });
  const probe = read.pipe(
    Effect.timeout("15 seconds"),
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

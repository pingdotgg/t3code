import type { AntigravityAuthMethod, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { makeUnavailableUsageLimits, makeUsageLimits } from "../providerUsageLimits.ts";

// The CLI's quota backend. The production cloudcode host can return placeholder
// fractions; do not fall back to it and present those as a fresh allowance.
const QUOTA_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TokenFile = Schema.Struct({
  token: Schema.optional(
    Schema.Union([Schema.String, Schema.Struct({ access_token: Schema.optional(Schema.String) })]),
  ),
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  client_id: Schema.optional(Schema.String),
  client_secret: Schema.optional(Schema.String),
});
const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
});
const QuotaSummary = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      displayName: Schema.optional(Schema.String),
      buckets: Schema.Array(
        Schema.Struct({
          bucketId: Schema.NonEmptyString,
          window: Schema.String,
          remainingFraction: Schema.optional(
            Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
          ),
          resetTime: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});
const decodeTokenFile = Schema.decodeUnknownEffect(Schema.fromJsonString(TokenFile));

/** Keep model families separate: their allowances cannot be spent interchangeably. */
export function antigravityQuotaSummaryToLimits(
  summary: typeof QuotaSummary.Type,
  checkedAt: string,
) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const group of summary.groups) {
    for (const bucket of group.buckets) {
      const kind =
        bucket.window === "5h" ? "session" : bucket.window === "weekly" ? "weekly" : undefined;
      if (kind === undefined || bucket.remainingFraction === undefined) continue;
      const family = bucket.bucketId.startsWith("gemini-")
        ? "Gemini"
        : bucket.bucketId.startsWith("3p-")
          ? "Claude/GPT"
          : group.displayName?.trim() || bucket.bucketId;
      const reset = bucket.resetTime ? DateTime.make(bucket.resetTime) : Option.none();
      windows.set(bucket.bucketId, {
        id: bucket.bucketId,
        kind,
        label: `${family} · ${kind === "session" ? "5 hours" : "Weekly"}`,
        usedPercent: (1 - bucket.remainingFraction) * 100,
        windowDurationMins: kind === "session" ? 300 : 10_080,
        ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
      });
    }
  }
  return windows.size > 0
    ? makeUsageLimits({ checkedAt, windows: windows.values() })
    : makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity did not report subscription quota windows.",
      });
}

/** Reads only this instance's ACP profile; refreshed credentials stay in memory. */
export const makeAntigravityUsageLimits = Effect.fn("makeAntigravityUsageLimits")(
  function* (input: {
    readonly enabled: boolean;
    readonly authMethod: AntigravityAuthMethod;
    readonly tokenPath: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const cachedToken = yield* Ref.make<
      { readonly source: string; readonly token: string; readonly expiresAt: number } | undefined
    >(undefined);
    const fingerprint = Effect.fn("antigravityCredentialFingerprint")(function* (
      file: typeof TokenFile.Type,
    ) {
      const identity =
        file.refresh_token?.trim() ||
        (typeof file.token === "string" ? file.token : file.token?.access_token)?.trim() ||
        file.access_token?.trim();
      return identity
        ? Encoding.encodeHex(yield* crypto.digest("SHA-256", new TextEncoder().encode(identity)))
        : undefined;
    });
    // Account identity must be available even when the quota backend is down.
    const credentialFingerprint = Effect.gen(function* () {
      if (!input.enabled || input.authMethod !== "oauth-personal") return undefined;
      const source = yield* fs.readFileString(input.tokenPath);
      return yield* fingerprint(yield* decodeTokenFile(source));
    }).pipe(
      Effect.timeout("2 seconds"),
      Effect.orElseSucceed(() => undefined),
    );
    const read = Effect.gen(function* () {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      if (!input.enabled || input.authMethod !== "oauth-personal") {
        return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
      }
      return yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const source = yield* fs.readFileString(input.tokenPath).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
          }),
        );
        if (!source.trim()) {
          yield* Ref.set(cachedToken, undefined);
          return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
        }
        const file = yield* decodeTokenFile(source);
        const identity = yield* fingerprint(file);
        return yield* Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const cached = yield* Ref.get(cachedToken);
          const stored =
            (typeof file.token === "string" ? file.token : file.token?.access_token)?.trim() ||
            file.access_token?.trim();
          const refresh = Effect.gen(function* () {
            if (!file.refresh_token || !file.client_id || !file.client_secret) return undefined;
            const response = yield* client.execute(
              HttpClientRequest.post(TOKEN_URL).pipe(
                HttpClientRequest.bodyUrlParams({
                  grant_type: "refresh_token",
                  refresh_token: file.refresh_token,
                  client_id: file.client_id,
                  client_secret: file.client_secret,
                }),
              ),
            );
            const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenResponse)),
            );
            yield* Ref.set(cachedToken, {
              source,
              token: body.access_token,
              expiresAt: (yield* Clock.currentTimeMillis) + body.expires_in * 1000,
            });
            return body.access_token;
          });
          const token =
            cached?.source === source && cached.expiresAt > now + 60_000
              ? cached.token
              : stored || (yield* refresh);
          if (!token) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
          const request = (accessToken: string) =>
            client.execute(
              HttpClientRequest.post(QUOTA_URL).pipe(
                HttpClientRequest.bearerToken(accessToken),
                HttpClientRequest.setHeader("user-agent", "antigravity"),
                HttpClientRequest.bodyJsonUnsafe({}),
              ),
            );
          const first = yield* request(token);
          const response =
            first.status === 401
              ? yield* refresh.pipe(
                  Effect.flatMap((next) => (next ? request(next) : Effect.succeed(first))),
                )
              : first;
          const summary = yield* HttpClientResponse.filterStatusOk(response).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(QuotaSummary)),
          );
          return antigravityQuotaSummaryToLimits(summary, checkedAt);
        }).pipe(
          Effect.timeout("15 seconds"),
          Effect.orElseSucceed(() =>
            makeUnavailableUsageLimits({
              checkedAt,
              reason: "probeFailed",
              message: "Antigravity could not read usage limits.",
            }),
          ),
          Effect.map((limits) =>
            identity ? { ...limits, credentialFingerprint: identity } : limits,
          ),
        );
      }).pipe(
        // HTTP and schema failures may contain credentials. Publish a fixed message.
        Effect.orElseSucceed(() =>
          makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: "Antigravity could not read usage limits.",
          }),
        ),
      );
    });
    return { read, credentialFingerprint };
  },
);

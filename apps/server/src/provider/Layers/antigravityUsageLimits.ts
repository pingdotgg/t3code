import * as NodeCrypto from "node:crypto";

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

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const QUOTA_SUMMARY_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const WEEK_MINS = 7 * 24 * 60;

const AcpToken = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.String,
  refresh_token: Schema.String,
});
const decodeAcpToken = Schema.decodeEffect(Schema.fromJsonString(AcpToken));
const AccessToken = Schema.Struct({
  access_token: Schema.String,
  id_token: Schema.optional(Schema.String),
});
const decodeIdTokenClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ sub: Schema.String })),
);

function googleAccountFingerprint(idToken: string | undefined) {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  const claims = decodeIdTokenClaims(Buffer.from(payload, "base64url").toString("utf8"));
  return Option.isSome(claims)
    ? NodeCrypto.createHash("sha256").update("antigravity\0").update(claims.value.sub).digest("hex")
    : undefined;
}

const QuotaSummary = Schema.Struct({
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        displayName: Schema.optional(Schema.String),
        buckets: Schema.optional(
          Schema.Array(
            Schema.Struct({
              bucketId: Schema.optional(Schema.String),
              window: Schema.optional(Schema.String),
              resetTime: Schema.optional(Schema.String),
              remainingFraction: Schema.optional(Schema.Number),
            }),
          ),
        ),
      }),
    ),
  ),
});

function antigravityQuotaSummaryToLimits(
  summary: typeof QuotaSummary.Type,
  checkedAt: string,
  credentialFingerprint: string | undefined,
) {
  const windows = (summary.groups ?? []).flatMap((group) => {
    const scope = group.displayName?.replace(/\s+models$/i, "").trim();
    return (group.buckets ?? []).flatMap((bucket): ServerProviderUsageWindow[] => {
      const id = bucket.bucketId?.trim();
      const remaining = bucket.remainingFraction;
      if (!id || remaining === undefined || !Number.isFinite(remaining)) return [];
      const kind =
        bucket.window === "weekly" ? "weekly" : bucket.window === "monthly" ? "monthly" : "other";
      const period = kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : bucket.window;
      const reset = bucket.resetTime ? DateTime.make(bucket.resetTime) : Option.none();
      return [
        {
          id,
          kind,
          label: [period, scope].filter(Boolean).join(" · ") || id,
          usedPercent: clampPercent((1 - remaining) * 100),
          ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
          ...(kind === "weekly" ? { windowDurationMins: WEEK_MINS } : {}),
        },
      ];
    });
  });
  return windows.length > 0
    ? {
        ...makeUsageLimits({ checkedAt, windows }),
        ...(credentialFingerprint ? { credentialFingerprint } : {}),
      }
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

export const readAntigravityUsageLimits = Effect.fn("readAntigravityUsageLimits")(
  function* (input: { readonly authMethod: AntigravityAuthMethod; readonly tokenPath: string }) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (input.authMethod !== "oauth-personal") {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    return yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(input.tokenPath))) return undefined;
      const credential = yield* decodeAcpToken(yield* fs.readFileString(input.tokenPath));
      const client = yield* HttpClient.HttpClient;
      const token = yield* client
        .execute(
          HttpClientRequest.post(GOOGLE_TOKEN_URL).pipe(
            HttpClientRequest.bodyUrlParams({
              client_id: credential.client_id,
              client_secret: credential.client_secret,
              refresh_token: credential.refresh_token,
              grant_type: "refresh_token",
            }),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(AccessToken)),
        );
      const summary = yield* client
        .execute(
          HttpClientRequest.post(QUOTA_SUMMARY_URL).pipe(
            HttpClientRequest.bearerToken(token.access_token),
            HttpClientRequest.setHeader("user-agent", "antigravity"),
            HttpClientRequest.bodyJsonUnsafe({}),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(QuotaSummary)),
        );
      return antigravityQuotaSummaryToLimits(
        summary,
        checkedAt,
        googleAccountFingerprint(token.id_token),
      );
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

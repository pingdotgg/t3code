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
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const QUOTA_SUMMARY_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const BUCKET_WINDOWS: Record<
  string,
  Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins">
> = {
  "5h": { kind: "session", label: "Session", windowDurationMins: 5 * 60 },
  weekly: { kind: "weekly", label: "Weekly", windowDurationMins: 7 * 24 * 60 },
  monthly: { kind: "monthly", label: "Monthly" },
};

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
const GoogleUserInfo = Schema.Struct({ id: Schema.String });
const decodeIdTokenClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ sub: Schema.String })),
);

function idTokenSubject(idToken: string | undefined) {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  const claims = decodeIdTokenClaims(Buffer.from(payload, "base64url").toString("utf8"));
  return Option.isSome(claims) ? claims.value.sub : undefined;
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
  credentialFingerprint: string,
) {
  const windows = (summary.groups ?? []).flatMap((group) => {
    const scope = group.displayName?.replace(/\s+models$/i, "").trim();
    return (group.buckets ?? []).flatMap((bucket): ServerProviderUsageWindow[] => {
      const id = bucket.bucketId?.trim();
      const remaining = bucket.remainingFraction;
      if (!id || remaining === undefined || !Number.isFinite(remaining)) return [];
      const window = bucket.window ? BUCKET_WINDOWS[bucket.window] : undefined;
      const reset = bucket.resetTime ? DateTime.make(bucket.resetTime) : Option.none();
      return [
        {
          id,
          kind: window?.kind ?? "other",
          label: [window?.label ?? bucket.window, scope].filter(Boolean).join(" · ") || id,
          usedPercent: clampPercent((1 - remaining) * 100),
          ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
          ...(window?.windowDurationMins ? { windowDurationMins: window.windowDurationMins } : {}),
        },
      ];
    });
  });
  return windows.length > 0
    ? {
        ...makeUsageLimits({ checkedAt, windows }),
        credentialFingerprint,
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
            HttpClientRequest.bodyUrlParams({ ...credential, grant_type: "refresh_token" }),
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
      // Google sends an ID token only when the sign-in granted the openid scope. The userinfo `id`
      // is the same Google account ID as the ID token's `sub` claim.
      const accountId =
        idTokenSubject(token.id_token) ??
        (yield* client
          .execute(
            HttpClientRequest.get(GOOGLE_USERINFO_URL).pipe(
              HttpClientRequest.bearerToken(token.access_token),
            ),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(GoogleUserInfo)),
            Effect.map((user) => user.id),
          ));
      return antigravityQuotaSummaryToLimits(
        summary,
        checkedAt,
        NodeCrypto.createHash("sha256").update("antigravity\0").update(accountId).digest("hex"),
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

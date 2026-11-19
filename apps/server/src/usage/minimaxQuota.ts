import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type UsageLimitSourceAccount,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";

const optionalNumber = Schema.optional(Schema.Number);
const Response = Schema.Struct({
  model_remains: Schema.Array(
    Schema.Struct({
      model_name: Schema.String,
      current_interval_remaining_percent: optionalNumber,
      current_weekly_remaining_percent: optionalNumber,
      current_interval_total_count: optionalNumber,
      current_interval_usage_count: optionalNumber,
      current_weekly_total_count: optionalNumber,
      current_weekly_usage_count: optionalNumber,
      current_interval_status: optionalNumber,
      current_weekly_status: optionalNumber,
      end_time: optionalNumber,
      weekly_end_time: optionalNumber,
    }),
  ),
});

export function miniMaxWindows(body: typeof Response.Type): ServerProviderUsageWindow[] {
  const windows: ServerProviderUsageWindow[] = [];
  for (const model of body.model_remains) {
    if (!/^(general|chat|text)$|minimax-m/i.test(model.model_name)) continue;
    for (const weekly of [false, true]) {
      const prefix = weekly ? "current_weekly" : "current_interval";
      if (model[`${prefix}_status`] === 3) continue;
      const percent = model[`${prefix}_remaining_percent`];
      const total = model[`${prefix}_total_count`];
      const remaining = model[`${prefix}_usage_count`];
      const remainingPercent =
        percent ??
        (total !== undefined && total > 0 && remaining !== undefined
          ? (remaining / total) * 100
          : undefined);
      if (remainingPercent === undefined || !Number.isFinite(remainingPercent)) continue;
      const end = weekly ? model.weekly_end_time : model.end_time;
      windows.push({
        id: `${model.model_name}:${prefix}`,
        kind: weekly ? "weekly" : "session",
        label: `${model.model_name} ${weekly ? "weekly" : "session"}`,
        usedPercent: Math.max(0, Math.min(100, 100 - remainingPercent)),
        ...(end !== undefined && Number.isFinite(end) && end > 0 && end < 8640000000000000
          ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(end)) }
          : {}),
      });
    }
  }
  return windows;
}

/**
 * A MiniMax source carries no account e-mail, so two sources that use different keys would
 * otherwise share one account key and the second reading would replace the first. A digest of
 * the key gives each account its own identity without exposing the key itself.
 */
const miniMaxAccountFingerprint = Effect.fnUntraced(function* (key: string) {
  const digester = yield* Digest.Digest;
  return yield* digester
    .digest(Digest.sha256, new TextEncoder().encode(`minimax\0${key}`))
    .pipe(Effect.map(Hex.encode), Effect.orDie);
});

export const readMiniMaxQuota = Effect.fn("MiniMaxQuota.read")(function* (key: string) {
  const client = yield* HttpClient.HttpClient;
  const credentialFingerprint = yield* miniMaxAccountFingerprint(key);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const body = yield* client
    .execute(
      HttpClientRequest.get("https://www.minimax.io/v1/token_plan/remains").pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${key}`),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(Response)),
      Effect.timeout("15 seconds"),
      Effect.mapError(
        (cause) =>
          new UsageLimitSourceError({
            detail: "Could not read MiniMax quota. Check the Coding Plan key and try again.",
            cause,
          }),
      ),
    );
  const windows = miniMaxWindows(body);
  const accounts: ReadonlyArray<UsageLimitSourceAccount> = [
    {
      id: "minimax",
      driver: ProviderDriverKind.make("acpRegistry"),
      plan: "MiniMax Coding Plan",
      usageLimits: {
        checkedAt,
        windows,
        credentialFingerprint,
        ...(windows.length === 0
          ? {
              unavailable: {
                reason: "probeFailed" as const,
                message: "MiniMax returned no measurable quota windows.",
              },
            }
          : {}),
      },
    },
  ];
  return accounts;
});

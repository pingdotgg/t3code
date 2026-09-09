/**
 * OpenRouter credit reads for `usageLimitSources`.
 *
 * OpenRouter splits the balance across two endpoints by key type. `/credits`
 * reports the account (credits bought against credits spent) but accepts only a
 * provisioning key, answering an ordinary inference key with 403. `/key`
 * accepts any key and reports that key's own spend, plus a remaining figure
 * only when the key carries a spend limit.
 *
 * So we ask for the better answer first and fall back, rather than making the
 * user know which kind of key they pasted.
 *
 * @module usage/openrouterApi
 */
import {
  UsageLimitSourceError,
  type OpenRouterUsageLimitSourceConfig,
  type UsageLimitSourceCredits,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const BASE = "https://openrouter.ai/api/v1";

const CreditsResponse = Schema.Struct({
  data: Schema.Struct({
    total_credits: Schema.Number,
    total_usage: Schema.Number,
  }),
});
const KeyResponse = Schema.Struct({
  data: Schema.Struct({
    usage: Schema.Number,
    limit: Schema.optional(Schema.NullOr(Schema.Number)),
    limit_remaining: Schema.optional(Schema.NullOr(Schema.Number)),
    is_free_tier: Schema.optional(Schema.Boolean),
  }),
});

const decodeCredits = Schema.decodeUnknownEffect(CreditsResponse);
const decodeKey = Schema.decodeUnknownEffect(KeyResponse);

/**
 * Carries the HTTP status so `readCredits` can tell "wrong kind of key" (403,
 * worth a second try) from a real failure. Never leaves this module: the status
 * is an implementation detail of the fallback, not something a client acts on.
 */
class OpenRouterRequestError extends Data.TaggedError("OpenRouterRequestError")<{
  readonly detail: string;
  readonly status?: number;
}> {}

export const makeOpenRouterApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const request = Effect.fn("OpenRouterApi.request")(function* (
    config: OpenRouterUsageLimitSourceConfig,
    path: string,
  ) {
    const response = yield* client
      .execute(
        HttpClientRequest.get(`${BASE}${path}`).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${config.managementKey}`),
        ),
      )
      .pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(
          () => new OpenRouterRequestError({ detail: "Could not reach OpenRouter." }),
        ),
      );
    if (response.status < 200 || response.status >= 300) {
      return yield* new OpenRouterRequestError({
        status: response.status,
        detail:
          response.status === 401
            ? "OpenRouter rejected the API key."
            : `OpenRouter refused the request (HTTP ${response.status}).`,
      });
    }
    return yield* response.json.pipe(
      Effect.mapError(
        () => new OpenRouterRequestError({ detail: "OpenRouter returned an unreadable response." }),
      ),
    );
  });

  /** Account-wide balance. Only a provisioning key gets past OpenRouter's 403 here. */
  const readAccountCredits = Effect.fn("OpenRouterApi.readAccountCredits")(function* (
    config: OpenRouterUsageLimitSourceConfig,
  ) {
    const body = yield* request(config, "/credits");
    const { data } = yield* decodeCredits(body).pipe(
      Effect.mapError(
        () => new OpenRouterRequestError({ detail: "OpenRouter returned an unexpected balance." }),
      ),
    );
    return {
      scope: "account",
      usedUsd: data.total_usage,
      purchasedUsd: data.total_credits,
      remainingUsd: data.total_credits - data.total_usage,
    } as const satisfies UsageLimitSourceCredits;
  });

  /** This key's own allowance; `remainingUsd` exists only when the key is capped. */
  const readKeyCredits = Effect.fn("OpenRouterApi.readKeyCredits")(function* (
    config: OpenRouterUsageLimitSourceConfig,
  ) {
    const body = yield* request(config, "/key");
    const { data } = yield* decodeKey(body).pipe(
      Effect.mapError(
        () =>
          new OpenRouterRequestError({ detail: "OpenRouter returned an unexpected key report." }),
      ),
    );
    return {
      scope: "key",
      usedUsd: data.usage,
      ...(typeof data.limit === "number" ? { limitUsd: data.limit } : {}),
      ...(typeof data.limit_remaining === "number" ? { remainingUsd: data.limit_remaining } : {}),
      ...(data.is_free_tier === undefined ? {} : { isFreeTier: data.is_free_tier }),
    } satisfies UsageLimitSourceCredits;
  });

  /**
   * The best balance this key can see. A 403 from `/credits` means an ordinary
   * inference key, which `/key` still answers; any other failure there is worth
   * reporting rather than masking behind a narrower read.
   */
  const readCredits = Effect.fn("OpenRouterApi.readCredits")(function* (
    config: OpenRouterUsageLimitSourceConfig,
  ): Effect.fn.Return<UsageLimitSourceCredits, UsageLimitSourceError> {
    if (config.managementKey.length === 0) {
      return yield* new UsageLimitSourceError({ detail: "No API key configured." });
    }
    const account = yield* readAccountCredits(config).pipe(Effect.result);
    if (account._tag === "Success") return account.success;
    const credits =
      account.failure.status === 403 ? yield* readKeyCredits(config).pipe(Effect.result) : account;
    if (credits._tag === "Success") return credits.success;
    return yield* new UsageLimitSourceError({ detail: credits.failure.detail });
  });

  return { readCredits };
});

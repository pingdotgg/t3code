import { eq, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { relayUpstreamApiPauses } from "../persistence/schema.ts";

const CLOUDFLARE_API = "cloudflare";

// Every SqlClient's transaction connection lives under a key with this prefix.
// Matching by key name instead of `db.$client.transactionService` because the
// relay's database is an alchemy proxy, whose properties are proxies too, not
// the real key.
const SQL_TRANSACTION_KEY_PREFIX = "effect/sql/SqlClient/TransactionConnection/";

const withoutSqlTransaction = (context: Context.Context<never>): Context.Context<never> =>
  Context.makeUnsafe(
    new Map(
      Array.from(context.mapUnsafe).filter(([key]) => !key.startsWith(SQL_TRANSACTION_KEY_PREFIX)),
    ),
  );

/**
 * Cloudflare's API rate limit is per account, so a 429 seen by any isolate
 * applies to all of them. Both operations fail open: a pause that cannot be
 * read or recorded must not block provisioning.
 *
 * Both also run outside any ambient transaction. Provisioning calls Cloudflare
 * while holding an allocation row lock, and a 429 there rolls that transaction
 * back, which would drop the recorded pause; a failed read inside it would
 * abort the provision's own statements.
 */
export class CloudflareApiPause extends Context.Service<
  CloudflareApiPause,
  {
    /** Epoch milliseconds until which calls are paused, or 0. */
    readonly pausedUntilMillis: Effect.Effect<number>;
    readonly pauseUntil: (untilMillis: number) => Effect.Effect<void>;
  }
>()("t3code-relay/environments/CloudflareApiPause") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const outsideTransaction = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.updateContext(effect, withoutSqlTransaction);

  return CloudflareApiPause.of({
    pausedUntilMillis: db
      .select({ pausedUntilMs: relayUpstreamApiPauses.pausedUntilMs })
      .from(relayUpstreamApiPauses)
      .where(eq(relayUpstreamApiPauses.api, CLOUDFLARE_API))
      .limit(1)
      .pipe(
        Effect.map((rows) => rows[0]?.pausedUntilMs ?? 0),
        Effect.catch((cause) =>
          Effect.logWarning("Could not read the shared Cloudflare API pause", { cause }).pipe(
            Effect.as(0),
          ),
        ),
        outsideTransaction,
        Effect.withSpan("relay.cloudflare_api_pause.read"),
      ),
    pauseUntil: (untilMillis) =>
      db
        .insert(relayUpstreamApiPauses)
        .values({ api: CLOUDFLARE_API, pausedUntilMs: untilMillis })
        .onConflictDoUpdate({
          target: relayUpstreamApiPauses.api,
          set: {
            pausedUntilMs: sql`greatest(${relayUpstreamApiPauses.pausedUntilMs}, excluded.paused_until_ms)`,
          },
        })
        .pipe(
          Effect.asVoid,
          Effect.catch((cause) =>
            Effect.logWarning("Could not record the shared Cloudflare API pause", { cause }),
          ),
          outsideTransaction,
          Effect.withSpan("relay.cloudflare_api_pause.record"),
        ),
  });
});

export const layer = Layer.effect(CloudflareApiPause, make);

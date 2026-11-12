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
 * Cloudflare's account-wide 429 pause is shared across isolates and must fail open.
 * Run outside provisioning transactions: rollback would lose a recorded pause,
 * and a failed pause read would abort provisioning's own statements.
 */
export class CloudflareApiPause extends Context.Service<
  CloudflareApiPause,
  {
    /** Epoch milliseconds until which calls are paused, or 0. */
    readonly pausedUntilMillis: Effect.Effect<number>;
    readonly pauseUntil: (untilMillis: number) => Effect.Effect<void>;
  }
>()("t3code-relay/environments/CloudflareApiPause") {}

const make = Effect.gen(function* () {
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
    pauseUntil: Effect.fn("relay.cloudflare_api_pause.record")(function (untilMillis) {
      return db
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
        );
    }),
  });
});

export const layer = Layer.effect(CloudflareApiPause, make);

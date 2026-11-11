import * as Cloudflare from "@alchemy.run/cloudflare";
import { type LedgerRow, LedgerStore } from "@bank/domain/Ledger/LedgerStore";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { LedgerDatabase } from "./LedgerDatabase.ts";

/** The ledger in D1. */
export const D1LedgerStore = Layer.effect(
  LedgerStore,
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(yield* LedgerDatabase);
    return {
      record: (rows) =>
        rows.length === 0
          ? Effect.void
          : db
              .batch(
                rows.map((row) =>
                  db
                    .prepare(
                      "INSERT INTO ledger (id, account_id, kind, amount, balance_after, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
                    )
                    .bind(row.id, row.accountId, row.kind, row.amount, row.balanceAfter, row.at),
                ),
              )
              .pipe(Effect.asVoid),
      forAccount: (accountId) =>
        db
          .prepare(
            "SELECT id, account_id AS accountId, kind, amount, balance_after AS balanceAfter, at FROM ledger WHERE account_id = ? ORDER BY at, id",
          )
          .bind(accountId)
          .all<LedgerRow>()
          .pipe(Effect.map((result) => result.results)),
    };
  }),
);

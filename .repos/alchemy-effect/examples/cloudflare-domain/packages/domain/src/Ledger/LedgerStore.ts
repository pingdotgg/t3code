import type { RuntimeContext } from "alchemy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** One money movement on an account, as the ledger table stores it. */
export interface LedgerRow {
  /** `${stream}:${seq}`: the event it came from, so a replay upserts the same row. */
  readonly id: string;
  readonly accountId: string;
  readonly kind: string;
  readonly amount: number;
  readonly balanceAfter: number;
  /** Epoch milliseconds. */
  readonly at: number;
}

/**
 * Where the ledger lives. The projection depends on this port, not on a
 * database, so a story runs it against memory and the server against D1.
 */
export class LedgerStore extends Context.Service<
  LedgerStore,
  {
    readonly record: (rows: ReadonlyArray<LedgerRow>) => Effect.Effect<void, never, RuntimeContext>;
    readonly forAccount: (
      accountId: string,
    ) => Effect.Effect<ReadonlyArray<LedgerRow>, never, RuntimeContext>;
  }
>()("Bank/LedgerStore") {}

/** A ledger in memory, for stories and tests: its Layer, and a reader for assertions. */
export const memoryLedger = () => {
  const table = new Map<string, LedgerRow>();
  const forAccount = (accountId: string) =>
    Effect.sync(() => [...table.values()].filter((row) => row.accountId === accountId));
  return {
    layer: Layer.succeed(LedgerStore, {
      record: (rows) =>
        Effect.sync(() => {
          for (const row of rows) if (!table.has(row.id)) table.set(row.id, row);
        }),
      forAccount,
    }),
    forAccount,
  };
};

/** A fresh ledger in memory each time it is built. */
export const MemoryLedgerStore = Layer.suspend(() => memoryLedger().layer);
